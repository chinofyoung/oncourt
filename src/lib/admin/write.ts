import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { MAX_REJECTION_REASON, type CourtModerationResult } from '@/lib/admin/moderation'
import { enqueueEmail } from '@/lib/email/outbox'
import {
  courtScheduleWarning,
  type OperatingHoursDay,
  type RateBand,
} from '@/lib/listings/schedule'

/**
 * The four admin status transitions. Exported for src/app/admin/actions.ts,
 * which is the only production caller.
 *
 * All four are STATUS-SCOPED — the shape requeueCourtSql() established in
 * src/lib/listings/write.ts — so the source status is part of the WHERE
 * clause and zero rows updated is a meaningful answer ("it already moved")
 * rather than an error or a race, and no transition can move a court from a
 * status it was not in when the admin looked at it. reject and suspend are a
 * single UPDATE statement; approve and unsuspend additionally gate on
 * courtScheduleWarning (see approveCourt's doc comment) and so run inside a
 * transaction with a `for update` pre-read of the same row:
 *
 *   approve:   pending   -> approved
 *   reject:    pending   -> rejected (+ rejection_reason)
 *   suspend:   approved  -> suspended
 *   unsuspend: suspended -> approved
 *
 * None of them touches `bookings`. Suspension takes a court off every public
 * surface (those reads filter to `approved`) and leaves its financial records
 * alone; cancelling or refunding is a different feature that this slice does
 * not have and must not grow by accident.
 *
 * Nor do they clear `rejection_reason` on the way in. They do not need to: the
 * only paths into `pending` are the column default on insert (null) and
 * requeueCourtSql, which nulls it — so a pending court's reason is already
 * null by construction. A suspended court's reason is null for the same
 * reason: the only path into `suspended` is from `approved`, whose own reason
 * is always null already, so there is nothing for suspend or unsuspend to
 * clear.
 */

export async function approveCourt(input: { courtId: string }): Promise<CourtModerationResult> {
  // One of the two transitions (with unsuspendCourt) whose decision depends on
  // more than the court's own status: a court whose rate bands do not exactly
  // tile its opening hours is live-but-unpriceable, and priceSlots() throws
  // "No rate band covers hour N" at whichever player finds the hole.
  // replaceOperatingHours deliberately allows an owner to reach that state
  // (refusing there would deadlock them — see its doc comment), so this is the
  // last gate before the market sees it.
  //
  // Inside ONE transaction, behind `for update` on the court row, exactly like
  // replaceRateBands. That lock is what makes the check trustworthy: the
  // owner's hours and bands writes take the same lock, so they cannot slip a
  // different schedule between this read and the UPDATE below.
  return db.transaction(
    async (tx) => {
      const court = await tx.execute(sql`
        select id from courts
        where id = ${input.courtId}::uuid and status = 'pending'
        for update
      `)
      if (court.rows.length === 0) return { ok: false as const, reason: 'stale' as const }

      const hourRows = await tx.execute(sql`
        select day_of_week, opens_hour, closes_hour from court_operating_hours
        where court_id = ${input.courtId}::uuid
      `)
      const bandRows = await tx.execute(sql`
        select start_hour, end_hour, price_centavos from court_rate_bands
        where court_id = ${input.courtId}::uuid
      `)

      const days: OperatingHoursDay[] = hourRows.rows.map((row) => ({
        dayOfWeek: Number(row.day_of_week),
        opensHour: Number(row.opens_hour),
        closesHour: Number(row.closes_hour),
      }))
      const bands: RateBand[] = bandRows.rows.map((row) => ({
        startHour: Number(row.start_hour),
        endHour: Number(row.end_hour),
        priceCentavos: Number(row.price_centavos),
      }))

      // The identical function getListingCourt uses for the owner's warning.
      const warning = courtScheduleWarning(days, bands)
      if (warning !== null) {
        return { ok: false as const, reason: 'schedule_incomplete' as const, warning }
      }

      const updated = await tx.execute(sql`
        update courts set status = 'approved'
        where id = ${input.courtId}::uuid and status = 'pending'
        returning id
      `)
      if (updated.rows.length === 0) return { ok: false as const, reason: 'stale' as const }

      // Enqueued (not sent) inside this same transaction, so the approval and
      // the owner's notification of it commit or fail together.
      const owner = await tx.execute(sql`
        select o.email as owner_email, o.full_name as owner_name,
               br.name as branch_name, c.name as court_name
        from courts c
        join branches br on br.id = c.branch_id
        join profiles o on o.id = br.owner_id
        where c.id = ${input.courtId}::uuid
      `)
      // courts.branch_id and branches.owner_id are both `not null` FKs, and
      // this court just came back from the UPDATE above — so this row is
      // structurally guaranteed. Guarded anyway: an unguarded `rows[0]` here
      // would surface as a bare TypeError inside a transaction that already
      // approved the court, rather than a diagnosable error.
      if (owner.rows.length === 0) {
        throw new Error(`Court ${input.courtId} approved but its owner lookup returned no row`)
      }
      const ownerRow = owner.rows[0]
      await enqueueEmail(tx, {
        payload: {
          kind: 'court_moderated',
          ownerName: ownerRow.owner_name as string | null,
          branchName: ownerRow.branch_name as string,
          courtName: ownerRow.court_name as string,
          approved: true,
          rejectionReason: null,
        },
        recipient: ownerRow.owner_email as string,
        courtId: input.courtId,
        bookingId: null,
      })

      return { ok: true as const }
    },
    { isolationLevel: 'read committed' },
  )
}

export async function rejectCourt(input: {
  courtId: string
  reason: string
}): Promise<CourtModerationResult> {
  // Checked before any SQL. The column is plain `text` with no constraint, so
  // nothing below this line would refuse an empty reason — and a rejection the
  // owner cannot act on is worse than no rejection, because their court is off
  // the market with no way back that they can see.
  const reason = input.reason.trim()
  if (reason.length === 0) return { ok: false, reason: 'empty_reason' }
  if (reason.length > MAX_REJECTION_REASON) return { ok: false, reason: 'reason_too_long' }

  // Wrapped in a transaction (unlike before this slice) so the enqueue below
  // joins the same commit as the UPDATE: the rejection and the owner's
  // notification of it succeed or fail together.
  return db.transaction(
    async (tx) => {
      const result = await tx.execute(sql`
        update courts set status = 'rejected', rejection_reason = ${reason}
        where id = ${input.courtId}::uuid and status = 'pending'
        returning id
      `)
      if (result.rows.length === 0) return { ok: false as const, reason: 'stale' as const }

      const owner = await tx.execute(sql`
        select o.email as owner_email, o.full_name as owner_name,
               br.name as branch_name, c.name as court_name
        from courts c
        join branches br on br.id = c.branch_id
        join profiles o on o.id = br.owner_id
        where c.id = ${input.courtId}::uuid
      `)
      // Same structural guarantee as approveCourt's identical lookup, guarded
      // for the same reason: a diagnosable error, not a bare TypeError inside
      // a transaction that already rejected the court.
      if (owner.rows.length === 0) {
        throw new Error(`Court ${input.courtId} rejected but its owner lookup returned no row`)
      }
      const ownerRow = owner.rows[0]
      // The payload type structurally allows rejectionReason: null with
      // approved: false, but court-moderated.tsx renders no reason line at
      // all in that combination — and this function already requires a real,
      // trimmed reason from its caller above, so it must carry it here rather
      // than passing null.
      await enqueueEmail(tx, {
        payload: {
          kind: 'court_moderated',
          ownerName: ownerRow.owner_name as string | null,
          branchName: ownerRow.branch_name as string,
          courtName: ownerRow.court_name as string,
          approved: false,
          rejectionReason: reason,
        },
        recipient: ownerRow.owner_email as string,
        courtId: input.courtId,
        bookingId: null,
      })

      return { ok: true as const }
    },
    { isolationLevel: 'read committed' },
  )
}

export async function suspendCourt(input: { courtId: string }): Promise<CourtModerationResult> {
  // Deliberately does not email: an enforcement action an admin normally
  // pairs with direct contact, and an automated "your court was suspended"
  // with no explanation would be worse than silence.
  const result = await db.execute(sql`
    update courts set status = 'suspended'
    where id = ${input.courtId}::uuid and status = 'approved'
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'stale' }
}

export async function unsuspendCourt(input: { courtId: string }): Promise<CourtModerationResult> {
  // Deliberately does not email, for the same reason suspendCourt above does
  // not: not one of the two transitions (approve/reject) the product spec's
  // notification table lists.
  //
  // Straight back to `approved`, not to `pending`: this reverses an admin's
  // own decision about a court that was already approved once, and routing it
  // through the queue would only ask the admin to re-approve their own undo.
  //
  // Gated on the same schedule check as approveCourt, for the same reason:
  // requeueCourtSql's predicate is `status in ('approved', 'rejected')`, so a
  // `suspended` court never re-queues, and an owner can still edit its hours
  // and bands while it is suspended (updateCourtFields/replaceOperatingHours/
  // replaceRateBands do not filter by status). A schedule that tiled cleanly
  // at approval time can go stale during the suspension, and unsuspending
  // without re-checking would put a live-but-unpriceable court straight back
  // on the market — the same failure approveCourt exists to prevent.
  return db.transaction(
    async (tx) => {
      const court = await tx.execute(sql`
        select id from courts
        where id = ${input.courtId}::uuid and status = 'suspended'
        for update
      `)
      if (court.rows.length === 0) return { ok: false as const, reason: 'stale' as const }

      const hourRows = await tx.execute(sql`
        select day_of_week, opens_hour, closes_hour from court_operating_hours
        where court_id = ${input.courtId}::uuid
      `)
      const bandRows = await tx.execute(sql`
        select start_hour, end_hour, price_centavos from court_rate_bands
        where court_id = ${input.courtId}::uuid
      `)

      const days: OperatingHoursDay[] = hourRows.rows.map((row) => ({
        dayOfWeek: Number(row.day_of_week),
        opensHour: Number(row.opens_hour),
        closesHour: Number(row.closes_hour),
      }))
      const bands: RateBand[] = bandRows.rows.map((row) => ({
        startHour: Number(row.start_hour),
        endHour: Number(row.end_hour),
        priceCentavos: Number(row.price_centavos),
      }))

      const warning = courtScheduleWarning(days, bands)
      if (warning !== null) {
        return { ok: false as const, reason: 'schedule_incomplete' as const, warning }
      }

      const updated = await tx.execute(sql`
        update courts set status = 'approved'
        where id = ${input.courtId}::uuid and status = 'suspended'
        returning id
      `)
      return updated.rows.length > 0
        ? { ok: true as const }
        : { ok: false as const, reason: 'stale' as const }
    },
    { isolationLevel: 'read committed' },
  )
}
