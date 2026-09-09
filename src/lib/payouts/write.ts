import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

/** Matches MAX_REJECTION_REASON's role in src/lib/admin/moderation.ts: a
 *  typo guard on a free-text field, enforced by truncation rather than by
 *  refusal — an admin who pastes a long bank reference should not lose the
 *  payout they just sent. */
export const MAX_PAYOUT_NOTE = 500

export type PreparePayoutResult =
  | { ok: true; payoutId: string; netCentavos: number; lineCount: number }
  | { ok: false; reason: 'nothing_to_pay' }

type Line = {
  bookingId: string
  kind: 'payment' | 'clawback'
  net: number
  gross: number
  bookedOn: string
}

/**
 * Step one of two. Stamps the bookings this payout covers and locks its
 * amount; the money has not moved yet. markPayoutPaid() is step two.
 *
 * The transaction does two things atomically:
 *
 *   1. pg_advisory_xact_lock on the OWNER, so two admins preparing the same
 *      owner at once queue rather than collide mid-write. Keyed on the owner,
 *      so it never serializes unrelated admin traffic — the same shape and the
 *      same reasoning as createHold's per-player lock in
 *      src/lib/booking/hold.ts:143. Taken first, while holding nothing else,
 *      so it can never be one edge of a wait-for cycle.
 *   2. Resolve the lines, then insert. payout_bookings' (booking_id, kind)
 *      primary key is the real arbiter — the lock only makes the losing path
 *      a clean "nothing to pay" instead of a 23505.
 *
 * READ COMMITTED is required, not incidental: under REPEATABLE READ the
 * transaction's snapshot is fixed at the advisory-lock statement, taken
 * BEFORE the lock is granted, so a queued second prepare would still see the
 * pre-lock pool and stamp bookings the winner already took. Identical to the
 * reasoning pinned in src/lib/booking/hold.ts:123.
 *
 * Writes NOTHING when net <= 0 — including no clawback lines. An outstanding
 * clawback stays outstanding and reappears in every later computation until a
 * payout large enough to absorb it is actually prepared. A negative balance is
 * a standing adjustment, never a written-off one.
 */
export async function preparePayout(ownerId: string): Promise<PreparePayoutResult> {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'payout:' + ownerId}))`)

      const result = await tx.execute(sql`
        select bk.id as booking_id, 'payment' as kind,
               bk.owner_net_centavos as net, bk.total_charged_centavos as gross,
               to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as booked_on
        from bookings bk
        join branches b on b.id = bk.branch_id
        where b.owner_id = ${ownerId}::uuid
          and bk.status = 'completed'
          -- Manual rail exclusion: see the payable CTE in
          -- src/lib/payouts/ledger.ts for the full reasoning.
          and bk.payment_mode = 'automated'
          and not exists (
            select 1 from payout_bookings pb
            where pb.booking_id = bk.id and pb.kind = 'payment'
          )
        union all
        select bk.id, 'clawback',
               -bk.owner_net_centavos, -bk.total_charged_centavos,
               to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD')
        from bookings bk
        join branches b on b.id = bk.branch_id
        where b.owner_id = ${ownerId}::uuid
          and bk.status = 'refunded_manual'
          and exists (
            select 1 from payout_bookings pb
            where pb.booking_id = bk.id and pb.kind = 'payment'
          )
          and not exists (
            select 1 from payout_bookings pb
            where pb.booking_id = bk.id and pb.kind = 'clawback'
          )
      `)

      const lines: Line[] = result.rows.map((row) => ({
        bookingId: row.booking_id as string,
        kind: row.kind as 'payment' | 'clawback',
        net: Number(row.net),
        gross: Number(row.gross),
        bookedOn: row.booked_on as string,
      }))

      const net = lines.reduce((sum, l) => sum + l.net, 0)
      const gross = lines.reduce((sum, l) => sum + l.gross, 0)
      if (net <= 0) return { ok: false as const, reason: 'nothing_to_pay' as const }

      // Period spans the PAYMENT lines only. A clawback can be from any
      // earlier period and would stretch the label to mean nothing.
      //
      // A payment line is *expected* here — net > 0 is unreachable from
      // clawbacks alone, whose nets are -owner_net <= 0, which in turn holds
      // only because of bookings_owner_net_non_negative, a constraint that
      // ships in a DIFFERENT, in-flight slice. Rather than depend on another
      // slice's migration for correctness, check it: without this guard an
      // empty `dates` binds undefined into `period_start`, which is `not null`,
      // and the admin gets a 500 instead of an honest "nothing to pay".
      const dates = lines.filter((l) => l.kind === 'payment').map((l) => l.bookedOn).sort()
      if (dates.length === 0) return { ok: false as const, reason: 'nothing_to_pay' as const }

      const inserted = await tx.execute(sql`
        insert into payouts (
          owner_id, period_start, period_end, gross_centavos, fee_centavos, net_centavos
        ) values (
          ${ownerId}::uuid, ${dates[0]}::date, ${dates[dates.length - 1]}::date,
          ${gross}, ${gross - net}, ${net}
        )
        returning id
      `)
      const payoutId = inserted.rows[0].id as string

      const values = lines.map(
        (l) => sql`(${l.bookingId}::uuid, ${l.kind}::payout_line_kind, ${payoutId}::uuid, ${l.net})`,
      )
      await tx.execute(sql`
        insert into payout_bookings (booking_id, kind, payout_id, net_centavos)
        values ${sql.join(values, sql`, `)}
      `)

      return { ok: true as const, payoutId, netCentavos: net, lineCount: lines.length }
    },
    { isolationLevel: 'read committed' },
  )
}

export type MarkPaidResult = { ok: true } | { ok: false; reason: 'already_recorded' }

/**
 * Step two of two: the transfer has left, record it.
 *
 * Status-scoped, the shape all four of src/lib/admin/write.ts's court
 * transitions use — zero rows updated is a meaningful answer ("it already
 * moved"), not an error, so a double submit and an unknown id both land on
 * the same honest message rather than throwing.
 *
 * `returning id` + rows.length, not rowCount: an UPDATE without `returning`
 * reports zero rows regardless of what it touched, which would make every
 * successful call wrongly report already_recorded. Same trap documented at
 * length in updateOwnerFeeOverride (src/lib/admin/settings.ts).
 */
export async function markPayoutPaid(payoutId: string, note: string): Promise<MarkPaidResult> {
  const trimmed = note.trim().slice(0, MAX_PAYOUT_NOTE)
  const result = await db.execute(sql`
    update payouts
    set status = 'paid'::payout_status, paid_at = now(),
        note = ${trimmed.length > 0 ? trimmed : null}
    where id = ${payoutId}::uuid and status = 'pending'
    returning id
  `)
  return result.rows.length === 0 ? { ok: false, reason: 'already_recorded' } : { ok: true }
}
