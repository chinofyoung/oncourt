/**
 * Manila calendar-date helpers. Manila is UTC+8 with no DST, so a fixed
 * offset is correct and stable.
 *
 * Consolidated from four call sites that each carried their own copy
 * (`src/lib/booking/hold.ts`, `src/lib/booking/availability.ts`,
 * `src/app/venues/[slug]/page.tsx`, `src/app/venues/[slug]/actions.ts`) —
 * `isRealCalendarDate` and `isValidCalendarDate` were the same function
 * under two names. See docs/foundation-review-notes.md, "Smaller deferred
 * items".
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Manila calendar date (`YYYY-MM-DD`) of an arbitrary instant — the same
 * "shift forward by +8h, then read UTC fields" move `manilaToday` and
 * `loadBranchDay`'s occupied-hours computation (src/lib/booking/
 * availability.ts) already use, generalized to take any instant rather than
 * only `Date.now()`. Added so a caller holding a `now()` read from the
 * database (preferred over the Node clock — see `manilaHourOf` below) can
 * derive "today" from THAT instant instead of re-reading the JS clock.
 */
export function manilaDateOf(at: Date): string {
  return new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 10)
}

/** Today's Manila calendar date as `YYYY-MM-DD`. */
export function manilaToday(): string {
  return manilaDateOf(new Date())
}

/**
 * Manila hour-of-day (0-23) of an arbitrary instant. Same shift-then-read
 * direction as `manilaDateOf`, and correct for the same reason: `at` is
 * already a real, unambiguous instant, so shifting it forward before reading
 * UTC fields yields the Manila wall-clock hour.
 *
 * Added for the past-slot booking fix: `loadBranchDay` needs "what Manila
 * hour is it right now" to compute how many of a given date's hours have
 * already fully elapsed, and must read that from the database's `now()`
 * rather than the Node process clock (same reasoning as
 * src/lib/payments/webhook.ts's handlePaidEvent, REVIEW FIX C-1).
 */
export function manilaHourOf(at: Date): number {
  return new Date(at.getTime() + 8 * 3_600_000).getUTCHours()
}

/**
 * Day-of-week (0=Sunday..6=Saturday) of the Manila calendar date itself.
 *
 * Parses the date's own y/m/d components into `Date.UTC`, treating them as a
 * plain calendar date with no timezone shift — which is what
 * `court_operating_hours.day_of_week` actually means.
 *
 * Do NOT rewrite this as `new Date(`${date}T00:00:00+08:00`).getUTCDay()`.
 * That is off by one on every day of the year: Manila midnight of `date` is
 * 16:00 UTC on the *previous* calendar day, so `getUTCDay()` returns the
 * earlier weekday. It would validate every booking against the wrong day's
 * operating hours.
 */
export function manilaWeekday(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * True only for a `YYYY-MM-DD` string naming a date that exists. The
 * round-trip through `Date.UTC` is what rejects `2026-02-30`, which the
 * regex alone accepts (`Date.UTC` rolls it over to March 2).
 */
export function isValidCalendarDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false
  const [year, month, day] = date.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  )
}

/**
 * Shifts a `YYYY-MM-DD` calendar date by `days`, with no timezone arithmetic
 * at all — a calendar date shift needs no notion of an offset.
 *
 * Do NOT rewrite this to parse `${date}T00:00:00+08:00` and shift with
 * `setUTCDate`. That is off by one in both directions: parsing with an
 * explicit +08:00 offset first converts to a UTC instant on the *previous*
 * calendar day, and reading the result back with `toISOString().slice(0, 10)`
 * never corrects for it.
 */
export function shiftDay(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}
