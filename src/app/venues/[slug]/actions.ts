'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createHold, type HoldResult } from '@/lib/booking/hold'
import { requirePlayer, AuthError } from '@/lib/auth/guards'
import { isValidCalendarDate } from '@/lib/date-manila'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SLUG_RE = /^[a-z0-9-]+$/

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
    // requirePlayer, not requireUser: roles are exclusive as of the
    // roles-and-staff slice. An owner account is a business account that can
    // never hold a paid booking — not on someone else's courts, and not on its
    // own (its own courts are taken off the market with `blocked` rows through
    // /dashboard/bookings instead). Admins are refused for the same reason.
    //
    // 401 and 403 must be told apart here: a signed-out visitor is mid-flow
    // and belongs at /login, while a signed-in owner needs an explanation, not
    // a login page they are already past.
    user = await requirePlayer()
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.status === 401) redirect('/login')
      return {
        error:
          "Owner and admin accounts can't book courts. To hold time on your own courts, use Bookings in your dashboard.",
      }
    }
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
  //     `isValidCalendarDate` below catches what `hold.ts`'s own
  //     `manilaInstant`/`manilaWeekday` explicitly do not (see that
  //     function's docstring) — without this, the hold silently lands on
  //     the normalized date (March 2nd) instead of erroring.
  // With all of these covered, a forged or corrupt request always comes
  // back as a normal `{ error }` result instead of an unhandled exception.
  if (
    !UUID_RE.test(courtId) ||
    !UUID_RE.test(branchId) ||
    !DATE_RE.test(date) ||
    !isValidCalendarDate(date) ||
    !SLUG_RE.test(slug) ||
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    endHour > 24 ||
    endHour <= startHour
  ) {
    return { error: "Something's off with that request. Please refresh the page and try again." }
  }

  // playerId comes from requirePlayer() above, never from the form — a
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

  // The grid must show the slot as taken when the player comes back, so the
  // branch page is revalidated even though we are navigating away from it.
  revalidatePath(`/venues/${slug}`)
  // The hold is live for 15 minutes; checkout is where it becomes a booking.
  redirect(`/bookings/${result.bookingId}/checkout`)
}
