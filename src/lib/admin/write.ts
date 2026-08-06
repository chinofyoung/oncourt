import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { MAX_REJECTION_REASON, type CourtModerationResult } from '@/lib/admin/moderation'
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
      return updated.rows.length > 0
        ? { ok: true as const }
        : { ok: false as const, reason: 'stale' as const }
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

  const result = await db.execute(sql`
    update courts set status = 'rejected', rejection_reason = ${reason}
    where id = ${input.courtId}::uuid and status = 'pending'
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'stale' }
}

export async function suspendCourt(input: { courtId: string }): Promise<CourtModerationResult> {
  const result = await db.execute(sql`
    update courts set status = 'suspended'
    where id = ${input.courtId}::uuid and status = 'approved'
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'stale' }
}

export async function unsuspendCourt(input: { courtId: string }): Promise<CourtModerationResult> {
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
