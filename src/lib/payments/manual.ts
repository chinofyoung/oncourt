import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { createHold, type HoldResult } from '@/lib/booking/hold'
import { enqueueEmail, type SqlExecutor } from '@/lib/email/outbox'
import type { BookingEmailFacts } from '@/lib/email/payload'
import type { StorageClient } from '@/lib/listings/storage'
import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES, PHOTO_EXTENSIONS } from '@/lib/photos'

export const PROOF_BUCKET = 'payment-proofs' as const

export type SubmitProofInput = {
  courtId: string
  branchId: string
  playerId: string
  date: string
  startHour: number
  endHour: number
  paymentMethodId: string
  file: { bytes: Uint8Array; contentType: string }
  referenceNote?: string
}

/**
 * Derived from HoldResult's own failure union, rather than retyped here by
 * hand -- if createHold ever grows or renames a failure reason, this type
 * (and every switch over it) follows automatically instead of silently
 * drifting out of sync with the function it wraps.
 */
type HoldFailureReason = Extract<HoldResult, { ok: false }>['reason']

export type SubmitProofResult =
  | { ok: true; bookingId: string; proofId: string; expiresAt: Date }
  | {
      ok: false
      reason:
        | HoldFailureReason
        | 'not_manual'
        | 'unknown_method'
        | 'no_file'
        | 'bad_type'
        | 'too_large'
        | 'upload_failed'
    }

/**
 * The manual rail's entry point: the player has already paid the owner
 * directly and is handing us the receipt.
 *
 * Order is validate -> upload -> hold+insert -> compensate on failure, the
 * same shape addPhoto (src/lib/listings/photos.ts) uses, and for the same
 * reason: storage has no rollback, so the object must exist before the row
 * that points at it, and a failed row has to take the object back down. The
 * alternative -- insert first -- leaves a proof row pointing at nothing,
 * which is worse: a reviewer sees a booking claiming a screenshot that will
 * never load.
 *
 * The slot race is arbitrated by bookings_no_overlap inside createHold, not
 * by anything here. Uploading before knowing we won costs one wasted object
 * on a lost race, which the remove() below cleans up.
 */
export async function submitManualProof(
  input: SubmitProofInput,
  storage: StorageClient,
): Promise<SubmitProofResult> {
  // 1. Cheap checks first -- never touch storage for input we already know is
  //    bad. Same gates as addPhoto, same constants.
  if (input.file.bytes.byteLength === 0) return { ok: false, reason: 'no_file' }
  if (!(ALLOWED_PHOTO_TYPES as readonly string[]).includes(input.file.contentType)) {
    return { ok: false, reason: 'bad_type' }
  }
  if (input.file.bytes.byteLength > MAX_PHOTO_BYTES) return { ok: false, reason: 'too_large' }

  // 2. The court's owner must actually be on the manual rail, and the chosen
  //    method must be theirs. Both are read from the court's branch, never
  //    from the caller: a player posting another owner's method id must not
  //    be able to produce a booking that says it was paid somewhere it
  //    wasn't.
  //
  //    Two queries, not one LEFT JOIN casting paymentMethodId alongside the
  //    rail check: an automated-rail court must refuse before this input is
  //    ever interpreted as a uuid at all -- a non-manual court's checkout
  //    form never renders a method picker, so a caller on that rail may well
  //    pass a placeholder that isn't a uuid shape, and that must come back as
  //    'not_manual', not a database error.
  const owner = await db.execute(sql`
    select p.id as owner_id, p.payment_mode::text as rail
    from branches b join profiles p on p.id = b.owner_id
    where b.id = ${input.branchId}::uuid
  `)
  const ownerRow = owner.rows[0]
  if (!ownerRow || ownerRow.rail !== 'manual') return { ok: false, reason: 'not_manual' }

  const method = await db.execute(sql`
    select kind::text as kind, institution, account_name, account_number
    from owner_payment_methods
    where id = ${input.paymentMethodId}::uuid and owner_id = ${ownerRow.owner_id}::uuid
  `)
  const methodRow = method.rows[0]
  if (!methodRow) return { ok: false, reason: 'unknown_method' }

  const paidTo = {
    kind: methodRow.kind as string,
    institution: methodRow.institution as string,
    accountName: methodRow.account_name as string,
    accountNumber: methodRow.account_number as string,
  }

  // 3. Upload. UUID filename, never the uploaded one -- same reasoning as
  //    addPhoto: a user-supplied name in a path is a path-traversal question
  //    nobody needs to answer, and two receipts named the same thing would
  //    otherwise collide.
  const extension = PHOTO_EXTENSIONS[input.file.contentType]
  const path = `${input.playerId}/${crypto.randomUUID()}.${extension}`
  const uploaded = await storage.upload(
    PROOF_BUCKET,
    path,
    input.file.bytes,
    input.file.contentType,
  )
  if (uploaded.error) return { ok: false, reason: 'upload_failed' }

  // 4. The hold. createHold owns the advisory lock, the hours check, the
  //    sweep, the ceiling, the pricing and the exclusion constraint -- this
  //    rail gets all of it for free rather than reimplementing any of it.
  const hold = await createHold({
    courtId: input.courtId,
    branchId: input.branchId,
    playerId: input.playerId,
    date: input.date,
    startHour: input.startHour,
    endHour: input.endHour,
  })

  if (!hold.ok) {
    await storage.remove(PROOF_BUCKET, [path])
    return { ok: false, reason: hold.reason }
  }
  // createHold read the rail itself, under its own lock; if it disagrees
  // with step 2 above, the owner flipped rails mid-request. Treat the hold
  // as authoritative and back out -- the booking it created stays on the
  // automated rail (pending_payment) and is left for that rail's own sweep
  // to expire, rather than this function reaching into a booking it isn't
  // the owner of.
  if (hold.paymentMode !== 'manual') {
    await storage.remove(PROOF_BUCKET, [path])
    return { ok: false, reason: 'not_manual' }
  }

  const note = input.referenceNote?.trim()

  try {
    const proofId = await db.transaction(
      async (tx) => {
        const inserted = await tx.execute(sql`
          insert into manual_payment_proofs (
            booking_id, owner_payment_method_id, paid_to_snapshot,
            storage_path, reference_note
          ) values (
            ${hold.bookingId}::uuid, ${input.paymentMethodId}::uuid,
            ${JSON.stringify(paidTo)}::jsonb, ${path}, ${note && note.length > 0 ? note : null}
          )
          returning id
        `)

        // The owner has no other signal that anything is waiting. Enqueued
        // inside the transaction via enqueueEmail (never a raw insert:
        // email_outbox.payload is `jsonb not null` and typed by the
        // discriminated union in src/lib/email/payload.ts), so the proof row
        // and the "come review this" email commit or fail together, and are
        // sent by the drain worker -- exactly like the webhook's
        // booking_new. Read in the same statement as the branch/court names,
        // matching src/lib/payments/webhook.ts's handlePaidEvent.
        const facts = await tx.execute(sql`
          select
            to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as booked_on,
            extract(hour from (bk.starts_at at time zone 'Asia/Manila'))::int as start_hour,
            case
              when (bk.ends_at at time zone 'Asia/Manila')
                   = date_trunc('day', bk.ends_at at time zone 'Asia/Manila')
                then 24
              else extract(hour from (bk.ends_at at time zone 'Asia/Manila'))::int
            end as end_hour,
            bk.total_charged_centavos,
            br.name as branch_name, c.name as court_name,
            player.full_name as player_name,
            owner.email as owner_email, owner.business_name, owner.full_name as owner_full_name
          from bookings bk
          join courts c on c.id = bk.court_id
          join branches br on br.id = bk.branch_id
          join profiles player on player.id = bk.player_id
          join profiles owner on owner.id = br.owner_id
          where bk.id = ${hold.bookingId}::uuid
        `)
        // Structurally guaranteed by the insert above (bookings, courts,
        // branches, profiles are all NOT NULL FKs) -- guarded explicitly
        // anyway rather than trusting that invariant silently, matching
        // webhook.ts's identical guard: the alternative is a bare TypeError
        // a few lines down, inside a transaction that already inserted the
        // proof row.
        if (facts.rows.length === 0) {
          throw new Error(`Booking ${hold.bookingId} has no email facts row`)
        }
        const factsRow = facts.rows[0]
        const bookingFacts: BookingEmailFacts = {
          playerName: factsRow.player_name as string | null,
          branchName: factsRow.branch_name as string,
          courtName: factsRow.court_name as string,
          bookedOn: factsRow.booked_on as string,
          startHour: Number(factsRow.start_hour),
          endHour: Number(factsRow.end_hour),
          totalChargedCentavos: Number(factsRow.total_charged_centavos),
          bookingId: hold.bookingId,
        }

        await enqueueEmail(tx, {
          payload: {
            kind: 'manual_proof_submitted',
            ownerName: (factsRow.business_name ?? factsRow.owner_full_name ?? null) as
              | string
              | null,
            booking: bookingFacts,
          },
          recipient: factsRow.owner_email as string,
          bookingId: hold.bookingId,
        })

        return inserted.rows[0].id as string
      },
      { isolationLevel: 'read committed' },
    )

    return { ok: true, bookingId: hold.bookingId, proofId, expiresAt: hold.expiresAt }
  } catch (error) {
    // The hold's own booking row survives this catch -- only the proof and
    // the object it points at are backed out. A player who hits this can
    // retry: createHold sees its own pending_verification booking still
    // live and, on retry, would collide with it via bookings_no_overlap --
    // out of scope for this task (see task-8-report.md for any follow-up).
    await storage.remove(PROOF_BUCKET, [path])
    throw error
  }
}

/**
 * The facts an email snapshots, read inside the CALLER's transaction --
 * never a fresh `db` call, so a reviewer decision and the receipt it
 * produces are read from the same in-flight state.
 *
 * BookingEmailFacts is FACTS, not references (see src/lib/email/payload.ts):
 * a receipt must not change when a court is renamed. Three of this task's
 * enqueues need exactly this shape (approve, reject, and cancel's reuse of
 * refund_recorded), so this is one select, not three copies of it.
 *
 * Same Manila-time arithmetic as submitManualProof's own facts query above
 * and handlePaidEvent's in payments/webhook.ts: to_char at time zone
 * 'Asia/Manila' for the calendar date, extract(hour ...) for the start hour,
 * and the midnight special case for the end hour (a booking that runs to
 * local midnight reads as hour 24, not 0, so closing time never looks like
 * opening time).
 */
async function bookingFactsFor(
  tx: SqlExecutor,
  bookingId: string,
): Promise<{ facts: BookingEmailFacts; playerEmail: string }> {
  const result = await tx.execute(sql`
    select
      to_char(b.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as booked_on,
      extract(hour from (b.starts_at at time zone 'Asia/Manila'))::int as start_hour,
      case
        when (b.ends_at at time zone 'Asia/Manila')
             = date_trunc('day', b.ends_at at time zone 'Asia/Manila')
          then 24
        else extract(hour from (b.ends_at at time zone 'Asia/Manila'))::int
      end as end_hour,
      b.total_charged_centavos,
      br.name as branch_name, c.name as court_name,
      pl.full_name as player_name, pl.email as player_email
    from bookings b
    join courts c on c.id = b.court_id
    join branches br on br.id = b.branch_id
    join profiles pl on pl.id = b.player_id
    where b.id = ${bookingId}::uuid
  `)
  // Structurally guaranteed by bookings' own NOT NULL FKs (court_id,
  // branch_id, player_id) into profiles' NOT NULL email -- guarded anyway,
  // matching submitManualProof's and handlePaidEvent's identical guards:
  // the alternative is a bare TypeError inside a transaction that has
  // already committed a review decision.
  if (result.rows.length === 0) {
    throw new Error(`Booking ${bookingId} has no email facts row`)
  }
  const row = result.rows[0]
  return {
    facts: {
      playerName: row.player_name as string | null,
      branchName: row.branch_name as string,
      courtName: row.court_name as string,
      bookedOn: row.booked_on as string,
      startHour: Number(row.start_hour),
      endHour: Number(row.end_hour),
      totalChargedCentavos: Number(row.total_charged_centavos),
      bookingId,
    },
    playerEmail: row.player_email as string,
  }
}

export type ReviewResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'already_reviewed' | 'slot_elapsed' | 'needs_reason' }

/**
 * The owner says the money arrived.
 *
 * This is the SECOND writer of `confirmed` in this codebase -- see the note
 * now added to handlePaidEvent's doc comment in payments/webhook.ts, which was
 * the only one until this rail existed. It deliberately mirrors that
 * function's discipline:
 *
 *  - one READ COMMITTED transaction
 *  - `for update` on the booking before deciding anything
 *  - slot_elapsed read in SQL, never from a JS clock: a skewed Node clock must
 *    not be able to confirm a slot that has already run
 *  - the UPDATE is status-scoped, so zero rows means "it already moved"
 *    (someone else approved it, or the sweep expired it) rather than an error
 *  - the confirmation email is enqueued INSIDE the transaction; the network
 *    send happens later in the drain worker
 *
 * No money moves here. There is nothing to capture, refund or reconcile -- the
 * player already paid the owner directly, which is the whole point of the rail.
 */
export async function approveManualProof(
  bookingId: string,
  reviewerId: string,
): Promise<ReviewResult> {
  return db.transaction(
    async (tx) => {
      const current = await tx.execute(sql`
        select status::text as status, (ends_at <= now()) as slot_elapsed
        from bookings where id = ${bookingId}::uuid
        for update
      `)
      const row = current.rows[0]
      if (!row) return { ok: false as const, reason: 'not_found' as const }
      if (row.status !== 'pending_verification') {
        return { ok: false as const, reason: 'already_reviewed' as const }
      }
      if (row.slot_elapsed === true) return { ok: false as const, reason: 'slot_elapsed' as const }

      const updated = await tx.execute(sql`
        update bookings set status = 'confirmed', expires_at = null
        where id = ${bookingId}::uuid and status = 'pending_verification'
        returning id
      `)
      if (updated.rows.length === 0) {
        return { ok: false as const, reason: 'already_reviewed' as const }
      }

      await tx.execute(sql`
        update manual_payment_proofs
        set status = 'approved', reviewed_at = now(), reviewed_by = ${reviewerId}::uuid
        where booking_id = ${bookingId}::uuid and status = 'pending'
      `)

      // enqueueEmail, never a raw insert -- email_outbox.payload is
      // `jsonb not null` and typed by the union in src/lib/email/payload.ts.
      // 'booking_confirmed' already exists there with a BookingEmailFacts
      // payload, so this rail reuses it unchanged: the player is being told
      // exactly what the automated rail tells them.
      const { facts, playerEmail } = await bookingFactsFor(tx, bookingId)
      await enqueueEmail(tx, {
        payload: { kind: 'booking_confirmed', booking: facts },
        recipient: playerEmail,
        bookingId,
      })

      return { ok: true as const }
    },
    { isolationLevel: 'read committed' },
  )
}

/**
 * The owner cannot find the money.
 *
 * The booking goes to `expired`, not to a status of its own: `expired` already
 * means "this hold is over, the slot is back on sale", it is already excluded
 * from bookings_no_overlap, and adding a parallel status would mean touching
 * that constraint and every query that lists live bookings. What tells the
 * player *why* is the proof row's rejection_reason, which their booking page
 * reads -- so `expired` never has to carry two meanings for a human.
 *
 * No `for update` pre-read here, unlike approve: there is no slot_elapsed
 * gate to evaluate (a stale proof is exactly as rejectable after the slot has
 * passed as before it), so the status-scoped UPDATE alone is the whole
 * decision, atomically. Zero rows is then disambiguated by a second, lock-free
 * read purely for the caller's error message.
 */
export async function rejectManualProof(
  bookingId: string,
  reviewerId: string,
  reason: string,
): Promise<ReviewResult> {
  const trimmed = reason.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'needs_reason' }

  return db.transaction(
    async (tx) => {
      const updated = await tx.execute(sql`
        update bookings set status = 'expired', expires_at = null
        where id = ${bookingId}::uuid and status = 'pending_verification'
        returning id
      `)
      if (updated.rows.length === 0) {
        const exists = await tx.execute(
          sql`select 1 from bookings where id = ${bookingId}::uuid`,
        )
        return exists.rows.length === 0
          ? { ok: false as const, reason: 'not_found' as const }
          : { ok: false as const, reason: 'already_reviewed' as const }
      }

      await tx.execute(sql`
        update manual_payment_proofs
        set status = 'rejected', reviewed_at = now(), reviewed_by = ${reviewerId}::uuid,
            rejection_reason = ${trimmed}
        where booking_id = ${bookingId}::uuid and status = 'pending'
      `)

      const { facts, playerEmail } = await bookingFactsFor(tx, bookingId)
      await enqueueEmail(tx, {
        payload: {
          kind: 'manual_proof_rejected',
          booking: facts,
          rejectionReason: trimmed,
        },
        recipient: playerEmail,
        bookingId,
      })

      return { ok: true as const }
    },
    { isolationLevel: 'read committed' },
  )
}

export type PendingProof = {
  bookingId: string
  proofId: string
  storagePath: string
  playerName: string | null
  playerEmail: string
  branchName: string
  courtName: string
  startsAt: Date
  expiresAt: Date
  amountCentavos: number
  referenceNote: string | null
  paidTo: { kind: string; institution: string; accountName: string; accountNumber: string }
}

/**
 * The owner's review queue, oldest deadline first -- the one about to expire
 * is the one that needs attention.
 *
 * Branch-scoped, never owner-scoped: branch staff with the right grant review
 * too, and loadDashboardAccess/branchIdsWith is what decides which branch ids
 * reach this function. An empty list returns nothing rather than everything --
 * `= any ('{}'::uuid[])` is well-defined and always false, but the early
 * return skips a database round trip for the common case (an owner/staff
 * member with no manual-rail branches at all).
 */
export async function listPendingProofs(branchIds: string[]): Promise<PendingProof[]> {
  if (branchIds.length === 0) return []
  const result = await db.execute(sql`
    select p.id as proof_id, p.storage_path, p.reference_note, p.paid_to_snapshot,
           b.id as booking_id, b.starts_at, b.expires_at, b.total_charged_centavos,
           br.name as branch_name, c.name as court_name,
           pl.full_name as player_name, pl.email as player_email
    from manual_payment_proofs p
    join bookings b on b.id = p.booking_id
    join branches br on br.id = b.branch_id
    join courts c on c.id = b.court_id
    join profiles pl on pl.id = b.player_id
    where p.status = 'pending'
      and b.status = 'pending_verification'
      and b.branch_id = any (${sql.param(branchIds)}::uuid[])
    order by b.expires_at, b.id
  `)
  return result.rows.map((row) => ({
    bookingId: row.booking_id as string,
    proofId: row.proof_id as string,
    storagePath: row.storage_path as string,
    playerName: (row.player_name as string | null) ?? null,
    playerEmail: row.player_email as string,
    branchName: row.branch_name as string,
    courtName: row.court_name as string,
    startsAt: new Date(row.starts_at as string),
    expiresAt: new Date(row.expires_at as string),
    amountCentavos: Number(row.total_charged_centavos),
    referenceNote: (row.reference_note as string | null) ?? null,
    paidTo: row.paid_to_snapshot as PendingProof['paidTo'],
  }))
}

export type CancelResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_cancellable' | 'not_manual' | 'needs_reason' }

/**
 * The owner calls off a confirmed (or completed) manual booking.
 *
 * Bookkeeping only, and deliberately so: OnCourt never held this money -- the
 * player paid the owner directly -- so there is nothing here to capture,
 * refund or reconcile. The owner settles with the player on the same channel
 * they were paid, and `note` (bookings.note, added for owner blocks in
 * 20260805090100_branch_staff_and_blocks.sql and free of any CHECK
 * constraint tying it to that use) is where that settlement gets written
 * down -- "Court flooded, refunded via GCash", not a payment record.
 *
 * Reuses `refunded_manual`, whose name is literally what this is, and which
 * is already excluded from bookings_no_overlap (20260908000300) so the slot
 * goes back on sale the instant this commits.
 *
 * Manual-rail only (`payment_mode = 'manual'`, resolved once at hold time and
 * never re-derived, per the migration's own comment). The automated rail's
 * refunds are PAYMENT-scoped and go through recordPaymentRefund() in
 * src/lib/refunds/write.ts, which starts from a `payments` row -- a row a
 * manual booking never has, because no payment was ever taken through this
 * app. That is also why the admin refunds queue needs no filter to keep
 * manual bookings out of it: there is no payments row for one to ever match.
 *
 * Status-scoped like every other transition in this codebase: zero rows means
 * "it already moved", not an error.
 */
export async function cancelManualBooking(
  bookingId: string,
  actorId: string,
  note: string,
): Promise<CancelResult> {
  const trimmed = note.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'needs_reason' }

  return db.transaction(
    async (tx) => {
      const current = await tx.execute(sql`
        select status::text as status, payment_mode::text as rail
        from bookings where id = ${bookingId}::uuid
        for update
      `)
      const row = current.rows[0]
      if (!row) return { ok: false as const, reason: 'not_found' as const }
      if (row.rail !== 'manual') return { ok: false as const, reason: 'not_manual' as const }
      if (row.status !== 'confirmed' && row.status !== 'completed') {
        return { ok: false as const, reason: 'not_cancellable' as const }
      }

      const updated = await tx.execute(sql`
        update bookings set status = 'refunded_manual', note = ${trimmed}
        where id = ${bookingId}::uuid and status in ('confirmed', 'completed')
        returning id
      `)
      if (updated.rows.length === 0) {
        return { ok: false as const, reason: 'not_cancellable' as const }
      }

      // 'refund_recorded' already exists in the EmailPayload union with
      // exactly the right shape (playerName, branchName, courtName, bookedOn,
      // amountCentavos, bookingCancelled) -- reused rather than adding a
      // fourth kind, because the player is being told the same thing
      // recordPaymentRefund's identical enqueue (src/lib/refunds/write.ts)
      // tells them on the automated rail.
      //
      // Note this kind is EXCLUDED from email_outbox_booking_kind_idx
      // (20260812010000), so enqueueEmail's targetless `on conflict do
      // nothing` cannot dedupe it. That is correct here for the same reason it
      // is correct there: idempotency lives one layer up, in this function's
      // own status-scoped UPDATE, which returns zero rows on a replay and
      // never reaches this line.
      const { facts, playerEmail } = await bookingFactsFor(tx, bookingId)
      await enqueueEmail(tx, {
        payload: {
          kind: 'refund_recorded',
          playerName: facts.playerName,
          branchName: facts.branchName,
          courtName: facts.courtName,
          bookedOn: facts.bookedOn,
          amountCentavos: facts.totalChargedCentavos,
          bookingCancelled: true,
        },
        recipient: playerEmail,
        bookingId,
      })

      return { ok: true as const }
    },
    { isolationLevel: 'read committed' },
  )
}
