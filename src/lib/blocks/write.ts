import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { isValidCalendarDate } from '@/lib/date-manila'
import {
  PG_DEADLOCK_DETECTED,
  PG_EXCLUSION_VIOLATION,
  sqlStateOf,
} from '@/lib/db/sql-state'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * A note is a label on a grid cell ("Resurfacing", "Walk-in — Juan"), not a
 * description. Long enough for a real label, short enough that the cell and
 * the table row stay readable. Deliberately much shorter than a review body.
 */
const MAX_NOTE_LENGTH = 200

export type BlockFormInput = {
  courtId: string
  /** Calendar date in Asia/Manila, `YYYY-MM-DD`. */
  date: string
  startHour: number
  endHour: number
  note: string | null
}

/**
 * Validates the block form before any of it reaches SQL. Every rule here
 * corresponds to something that would otherwise raise and escape as an
 * unhandled exception:
 *   - a non-UUID courtId reaches a `::uuid` cast (22P02);
 *   - a shape-valid but nonexistent date like 2027-02-30 does NOT raise — it
 *     silently normalizes to March 2, landing the block on the wrong day, so
 *     isValidCalendarDate is the only thing that catches it (the same rule
 *     src/app/venues/[slug]/actions.ts applies to holds);
 *   - endHour <= startHour reaches `tstzrange(start, end, '[)')` reversed
 *     (22000, "range lower bound must be less than or equal to range upper
 *     bound").
 *
 * Hours run 0..24, not 0..23: a block ending at closing-time midnight has
 * endHour 24, which is a real Manila instant (see hold.ts's manilaInstant
 * docstring) and which court_operating_hours.closes_hour already permits.
 *
 * Exported for tests; src/app/dashboard/blocks/actions.ts is the only
 * production caller.
 */
export function parseBlockInput(formData: FormData): BlockFormInput | null {
  const courtId = String(formData.get('courtId') ?? '')
  const date = String(formData.get('date') ?? '')
  const startHour = Number(formData.get('startHour'))
  const endHour = Number(formData.get('endHour'))
  const rawNote = String(formData.get('note') ?? '').trim()

  if (!UUID_RE.test(courtId)) return null
  if (!isValidCalendarDate(date)) return null
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) return null
  if (startHour < 0 || endHour > 24 || endHour <= startHour) return null
  if (rawNote.length > MAX_NOTE_LENGTH) return null

  return { courtId, date, startHour, endHour, note: rawNote.length > 0 ? rawNote : null }
}

/** The delete form's only field. Shape-checked for the same 22P02 reason. */
export function parseBlockId(formData: FormData): string | null {
  const blockId = String(formData.get('blockId') ?? '')
  return UUID_RE.test(blockId) ? blockId : null
}

/**
 * The court's real branch, read from the database.
 *
 * This is what makes the action's guard trustworthy. If the form supplied a
 * branchId, an attacker would choose one value for requireBranchAccess and the
 * write would use another — a confused deputy. Reading it here means the guard
 * and the write always refer to the same branch, and it is why createBlock has
 * no `invalid_branch` failure reason at all.
 */
export async function branchIdOfCourt(courtId: string): Promise<string | null> {
  const result = await db.execute(sql`
    select branch_id from courts where id = ${courtId}::uuid
  `)
  return (result.rows[0]?.branch_id as string | undefined) ?? null
}

/**
 * The branch of a BLOCK, for the same reason as branchIdOfCourt.
 *
 * Filters `status = 'blocked'` here rather than in the delete: a caller that
 * passes a paid booking's id gets null and is refused before any guard runs,
 * so the delete path can never be pointed at a financial record. The parent
 * spec's "no DELETE on bookings" hardening note is carved out for `blocked`
 * rows only.
 */
export async function branchIdOfBlock(blockId: string): Promise<string | null> {
  const result = await db.execute(sql`
    select branch_id from bookings where id = ${blockId}::uuid and status = 'blocked'
  `)
  return (result.rows[0]?.branch_id as string | undefined) ?? null
}

export type CreateBlockResult =
  | { ok: true; blockId: string }
  | { ok: false; reason: 'slot_taken' | 'court_unavailable' | 'invalid_input' }

/** Manila is UTC+8 with no DST, so a fixed offset is correct and stable. */
function manilaInstant(date: string, hour: number): string | undefined {
  const instant = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+08:00`)
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString()
}

/**
 * Takes a slot off the market: a `bookings` row with status 'blocked', no
 * player, zero in every money column, and a null fee_config_snapshot. The
 * database enforces all four (bookings_player_unless_blocked,
 * bookings_blocked_is_free, bookings_blocked_has_creator,
 * bookings_snapshot_unless_blocked).
 *
 * `branchId` and `createdBy` come from the caller's guarded context, never from
 * a form — `branchId` from branchIdOfCourt above, `createdBy` from the session
 * requireBranchAccess just validated.
 *
 * DELIBERATE DIFFERENCES FROM createHold:
 *   - No operating-hours check. Maintenance happens when the venue is shut, so
 *     refusing a block outside opening hours would refuse the main use case.
 *     createHold's 'court_closed' has no analogue here.
 *   - No hold ceiling and no advisory lock. MAX_CONCURRENT_HOLDS protects
 *     against a player parking inventory they have not paid for; an owner
 *     blocking their own courts has nothing to abuse. The exclusion constraint
 *     is the only arbiter needed, and it needs no lock to be correct.
 *   - No pricing. There is no charge, and there is no cash bookkeeping for
 *     walk-ins in this product (see the spec's Out of scope).
 *
 * SAME AS createHold, and load-bearing: the stale-hold sweep. The exclusion
 * constraint's predicate cannot call now() (index predicates must be
 * immutable), so an expired-but-unswept hold still has status
 * 'pending_payment' and still blocks the slot. Sweeping the overlapping rows
 * inside this same transaction, before the insert, is what lets an owner
 * reclaim a slot whose checkout was abandoned without waiting for the
 * once-a-minute cron. Narrowed to overlapping rows so it never takes row locks
 * on bookings that have nothing to do with this request.
 */
export async function createBlock(
  input: BlockFormInput & { branchId: string; createdBy: string },
): Promise<CreateBlockResult> {
  const startsAt = manilaInstant(input.date, input.startHour)
  const endsAt = manilaInstant(input.date, input.endHour)
  // Checked explicitly rather than caught: this function promises a
  // CreateBlockResult, never a throw, for anything a caller can pass.
  if (startsAt === undefined || endsAt === undefined) {
    return { ok: false, reason: 'invalid_input' }
  }

  try {
    return await db.transaction(
      async (tx) => {
        // Approved only. A pending or suspended court has no column in the
        // grid and is not offered by getScheduleCourts, so a block on one
        // would occupy a slot while rendering nowhere — an invisible
        // unavailability nobody could later remove through the UI.
        const courtRows = await tx.execute(sql`
          select status from courts where id = ${input.courtId}::uuid
        `)
        const court = courtRows.rows[0]
        if (!court || court.status !== 'approved') {
          return { ok: false as const, reason: 'court_unavailable' as const }
        }

        await tx.execute(sql`
          update bookings set status = 'expired'
          where court_id = ${input.courtId}::uuid
            and status = 'pending_payment'
            and expires_at <= now()
            and slot && tstzrange(${startsAt}::timestamptz, ${endsAt}::timestamptz, '[)')
        `)

        const inserted = await tx.execute(sql`
          insert into bookings (
            court_id, branch_id, player_id, starts_at, ends_at, status,
            created_by, note,
            court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
            platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
            fee_config_snapshot
          ) values (
            ${input.courtId}::uuid, ${input.branchId}::uuid, null,
            ${startsAt}::timestamptz, ${endsAt}::timestamptz, 'blocked',
            ${input.createdBy}::uuid, ${input.note},
            0, 0, 0, 0, 0, 0, null::jsonb
          )
          returning id
        `)

        return { ok: true as const, blockId: inserted.rows[0].id as string }
      },
      // Pinned explicitly rather than inheriting default_transaction_isolation,
      // matching src/lib/booking/hold.ts: the sweep-then-insert sequence is
      // correct under READ COMMITTED because each statement takes its own
      // fresh snapshot.
      { isolationLevel: 'read committed' },
    )
  } catch (error) {
    const code = sqlStateOf(error)
    // 23P01: bookings_no_overlap refused the slot — a live hold, a booking, or
    // another block already has it. 40P01: two overlapping requests formed a
    // wait-for cycle the deadlock detector broke. Both mean "someone else has
    // this slot"; the loser may find it free on a retry, which is fail-safe
    // rather than maximally precise.
    if (code === PG_EXCLUSION_VIOLATION || code === PG_DEADLOCK_DETECTED) {
      return { ok: false, reason: 'slot_taken' }
    }
    throw error
  }
}

export type DeleteBlockResult = { ok: true } | { ok: false; reason: 'not_found' }

/**
 * Removes a block, freeing the slot.
 *
 * `status = 'blocked'` is in the WHERE clause, not checked beforehand: a
 * forged id belonging to a paid booking must delete nothing rather than be
 * rejected after a read, and a double-submit must report not_found rather than
 * race. Unlike a paid booking there is no audit-trail reason to keep a block
 * around, which is why this is a real DELETE (the parent spec's "no DELETE on
 * bookings" note is amended to carve out `blocked` rows).
 *
 * A block never has a review (reviews.booking_id references a completed,
 * player-owned booking), so no dependent row can block this delete.
 */
export async function deleteBlock(blockId: string): Promise<DeleteBlockResult> {
  const result = await db.execute(sql`
    delete from bookings where id = ${blockId}::uuid and status = 'blocked' returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'not_found' }
}
