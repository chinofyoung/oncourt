import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'

export type RefundPayment = {
  paymentId: string
  amountCentavos: number
  paymentMethod: string | null
  status: 'pending' | 'paid' | 'failed'
  needsRefund: boolean
  /** Manila dates (`YYYY-MM-DD`), ready for formatDateLabel(). */
  paidOn: string | null
  refundedOn: string | null
  refundNote: string | null
}

export type RefundCandidate = {
  bookingId: string
  bookingStatus: string
  bookedOn: string
  branchName: string
  courtName: string
  playerEmail: string | null
  playerName: string | null
  totalChargedCentavos: number
  payments: RefundPayment[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Two queries stitched by booking id, not one join: a join multiplies the
 * booking row by its payment count, and total_charged_centavos would then
 * need de-duplicating before display. Same shape as getAdminOwners' follow-up
 * queries.
 *
 * player_id is left-joined, not inner: a `blocked` row has none. Blocks carry
 * no money and so can never be flagged, but the lookup accepts a raw booking
 * id and must not simply lose one.
 *
 * `limitClause` is a parameter rather than a constant because the two callers
 * need opposite things. The lookup caps at 50 — a support query, and a player
 * with hundreds of bookings does not need all of them on screen. The flagged
 * queue caps at NOTHING: it is a work list of money sitting in the wrong
 * place, and a silent truncation there would read as "that's all of them"
 * when it isn't. It should be short; if it ever isn't, that is precisely when
 * an admin must see every row.
 */
async function candidates(bookingFilter: SQL, limitClause: SQL): Promise<RefundCandidate[]> {
  const bookings = await db.execute(sql`
    select bk.id, bk.status::text as status,
           to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as booked_on,
           br.name as branch_name, c.name as court_name,
           p.email as player_email, p.full_name as player_name,
           bk.total_charged_centavos
    from bookings bk
    join branches br on br.id = bk.branch_id
    join courts c on c.id = bk.court_id
    left join profiles p on p.id = bk.player_id
    where ${bookingFilter}
    order by bk.starts_at desc, bk.id
    ${limitClause}
  `)
  if (bookings.rows.length === 0) return []

  const ids = bookings.rows.map((row) => row.id as string)
  const payments = await db.execute(sql`
    select id, booking_id, amount_centavos, payment_method, status::text as status,
           needs_refund,
           to_char(paid_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as paid_on,
           to_char(refunded_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as refunded_on,
           refund_note
    from payments
    where booking_id = any (${sql.param(ids)}::uuid[])
    order by created_at, id
  `)

  const byBooking = new Map<string, RefundPayment[]>()
  for (const row of payments.rows) {
    const list = byBooking.get(row.booking_id as string) ?? []
    list.push({
      paymentId: row.id as string,
      amountCentavos: Number(row.amount_centavos),
      paymentMethod: (row.payment_method as string | null) ?? null,
      status: row.status as 'pending' | 'paid' | 'failed',
      needsRefund: row.needs_refund === true,
      paidOn: (row.paid_on as string | null) ?? null,
      refundedOn: (row.refunded_on as string | null) ?? null,
      refundNote: (row.refund_note as string | null) ?? null,
    })
    byBooking.set(row.booking_id as string, list)
  }

  return bookings.rows.map((row) => ({
    bookingId: row.id as string,
    bookingStatus: row.status as string,
    bookedOn: row.booked_on as string,
    branchName: row.branch_name as string,
    courtName: row.court_name as string,
    playerEmail: (row.player_email as string | null) ?? null,
    playerName: (row.player_name as string | null) ?? null,
    totalChargedCentavos: Number(row.total_charged_centavos),
    payments: byBooking.get(row.id as string) ?? [],
  }))
}

/**
 * What the webhook flagged and nobody has resolved. This is the queue that
 * did not exist until now — 20260807090000_payments.sql:63 says so.
 */
export async function getFlaggedRefunds(): Promise<RefundCandidate[]> {
  return candidates(
    sql`exists (select 1 from payments pay where pay.booking_id = bk.id and pay.needs_refund)`,
    sql``,
  )
}

/**
 * The dispute path: a player emails support, the admin finds their booking.
 *
 * ONE input, not two. A value that parses as a uuid is a booking id;
 * everything else is treated as an email. The uuid shape check is not
 * cosmetic — feeding arbitrary text to a `::uuid` cast raises 22P02, which
 * would surface as a 500 on a typo.
 */
export async function findRefundCandidates(query: string): Promise<RefundCandidate[]> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []

  return candidates(
    UUID_RE.test(trimmed)
      ? sql`bk.id = ${trimmed}::uuid`
      : sql`exists (
          select 1 from profiles pl
          where pl.id = bk.player_id and lower(pl.email) = lower(${trimmed})
        )`,
    sql`limit 50`,
  )
}

/**
 * Just the number, for the nav badge — the full queue query is far heavier.
 *
 * DISTINCT BOOKINGS, not payments, because getFlaggedRefunds above renders one
 * card per BOOKING: a double charge flags two payments on one booking, and
 * `count(*)` over payments would badge "2" above a single card. The badge and
 * the queue it badges have to be counting the same thing.
 */
export async function getFlaggedRefundCount(): Promise<number> {
  const result = await db.execute(sql`
    select count(distinct booking_id)::int as count from payments where needs_refund
  `)
  return Number(result.rows[0].count)
}
