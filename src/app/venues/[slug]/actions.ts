'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createHold, type HoldResult } from '@/lib/booking/hold'
import { requireUser, AuthError } from '@/lib/auth/guards'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SLUG_RE = /^[a-z0-9-]+$/

/**
 * `DATE_RE` only checks shape (`\d{4}-\d{2}-\d{2}`) — it accepts a
 * shape-valid but calendar-nonexistent date like `2026-02-30`. `hold.ts`'s
 * `manilaInstant`/`manilaWeekday` do NOT catch this either (confirmed in
 * their own docstrings, task-8-report.md fix round 2/3): `Date`/`Date.UTC`
 * silently normalize day/month overflow into a real, *different* date
 * (Feb 30 becomes Mar 2) instead of failing — `hold.ts` explicitly
 * delegates full calendar validation to this Server Action, and it was
 * missing here in the previous round. A forged `2026-02-30` would
 * therefore create a real hold on March 2nd, a day the user never saw.
 *
 * Round-trips the parsed y/m/d through `Date.UTC` and compares the
 * normalized fields back against the input: a real calendar date is
 * unchanged by the round-trip, a nonexistent one is not.
 */
function isRealCalendarDate(date: string): boolean {
  const [year, month, day] = date.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  )
}

type FailureReason = Exclude<HoldResult, { ok: true }>['reason']

/**
 * Copy for every `HoldResult` failure reason, verified against
 * task-8-report.md's final table. The `never` default is a compile-time
 * guard: if `HoldResult`'s reason union ever grows, this function fails to
 * typecheck instead of silently falling through to a generic message for a
 * paying user.
 */
function messageFor(reason: FailureReason): string {
  switch (reason) {
    case 'slot_taken':
      return 'Sorry, that slot was just taken. The grid has been refreshed.'
    case 'too_many_holds':
      return 'You already have 3 slots on hold. Finish paying for those first.'
    case 'court_closed':
      return 'That court is not open for the hours you selected.'
    case 'invalid_branch':
      // courtId's actual branch_id does not match the branchId submitted —
      // a data-integrity mismatch, not something a normal user click causes.
      return "That court doesn't belong to this venue. Please refresh the page and try again."
    case 'court_unavailable':
      // Court exists and belongs to this branch, but its listing status
      // isn't 'approved' (pending, rejected, or suspended by an admin).
      return 'That court is not open for bookings right now.'
    case 'invalid_input':
      return "That date or time doesn't look right. Please refresh and try again."
    default: {
      const exhaustive: never = reason
      return exhaustive
    }
  }
}

export async function createHoldAction(formData: FormData): Promise<{ error: string } | never> {
  let user
  try {
    user = await requireUser()
  } catch (error) {
    if (error instanceof AuthError) redirect('/login')
    throw error
  }

  const courtId = String(formData.get('courtId') ?? '')
  const branchId = String(formData.get('branchId') ?? '')
  const slug = String(formData.get('slug') ?? '')
  const date = String(formData.get('date') ?? '')
  const startHour = Number(formData.get('startHour'))
  const endHour = Number(formData.get('endHour'))

  // Everything above is untrusted client input arriving via a plain form
  // POST — courtId/branchId/date/hours can all be forged, not just the
  // values the rendered grid actually offers. Three concrete crashes this
  // block closes, each confirmed live against the hosted DB before writing
  // this comment (see task-9-report.md fix round 1 for the exact
  // SQLSTATE/message of each):
  //   - courtId/branchId not UUID-shaped: createHold interpolates them
  //     straight into `::uuid` casts; Postgres raises 22P02, which
  //     createHold's catch does not recognize (it only recognizes
  //     23P01/40P01/PricingError), so it would escape uncaught.
  //   - endHour <= startHour (e.g. a forged startHour=15&endHour=11):
  //     createHold's operating-hours check does not catch this (it only
  //     checks the range against the court's window, not internal
  //     ordering), so it reaches the sweep's `tstzrange(start, end, '[)')`
  //     with a reversed range; Postgres raises 22000 "range lower bound
  //     must be less than or equal to range upper bound", again
  //     unrecognized by createHold's catch.
  //   - a shape-valid but calendar-nonexistent date (`2026-02-30`):
  //     `isRealCalendarDate` below catches what `hold.ts`'s own
  //     `manilaInstant`/`manilaWeekday` explicitly do not (see that
  //     function's docstring) — without this, the hold silently lands on
  //     the normalized date (March 2nd) instead of erroring.
  // With all of these covered, a forged or corrupt request always comes
  // back as a normal `{ error }` result instead of an unhandled exception.
  if (
    !UUID_RE.test(courtId) ||
    !UUID_RE.test(branchId) ||
    !DATE_RE.test(date) ||
    !isRealCalendarDate(date) ||
    !SLUG_RE.test(slug) ||
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    endHour > 24 ||
    endHour <= startHour
  ) {
    return { error: "Something's off with that request. Please refresh the page and try again." }
  }

  // playerId comes from requireUser() above, never from the form — a
  // playerId taken from client input would let anyone create holds as
  // anyone else (there is no RLS backstop; see CLAUDE.md).
  const result = await createHold({
    courtId,
    branchId,
    playerId: user.id,
    date,
    startHour,
    endHour,
  })

  if (!result.ok) {
    revalidatePath(`/venues/${slug}`)
    return { error: messageFor(result.reason) }
  }

  // Payment is the next slice; for now land back on the branch page.
  revalidatePath(`/venues/${slug}`)
  redirect(`/venues/${slug}?held=${result.bookingId}`)
}
