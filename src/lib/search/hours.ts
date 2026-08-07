/**
 * The hour vocabulary behind the search bar's Time field — the start hours it
 * offers, the end hours that are legal for a given start, and the name of the
 * URL param the end select writes.
 *
 * Shared LOGIC, deliberately not a shared component. The same field is
 * rendered twice, in two visually incompatible skins: the home hero's selects
 * are white-on-glass over a photo (`[color-scheme:dark]`, white text,
 * transparent background), and `/search`'s float renders ink-on-panel. A
 * shared `<TimeRangeField>` would have to take a styling escape hatch — class
 * overrides for the wrapper, the label, each select and the separator — large
 * enough that nothing meaningful would be left inside it. What actually
 * duplicated (and drifted) between the two call sites was this list of hours,
 * so this is the part that moved.
 *
 * Both selects are plain `<select name>` controls, so the values below are
 * also the values `parseSearchParams` re-validates server-side. Nothing here
 * is a security boundary: the URL can be hand-edited, and the parser drops a
 * backwards or zero-width span regardless of what these lists contain.
 */

/** URL param carrying the EXCLUSIVE end of the requested span. */
export const UNTIL_PARAM = 'until'

/**
 * Selectable start hours, 7 AM through 11 PM.
 *
 * A product choice about when people look for a court, not a reading of any
 * branch's operating hours — this list is a filter vocabulary and does not
 * (and should not) track what any one venue happens to be open. An earlier
 * comment justified the range by naming seeded demo branches; those rows were
 * deleted from the shared database on 2026-08-07, and the range outlived them
 * because it was never really derived from them. 7 AM is early enough for a
 * before-work game and 11 PM late enough for the last bookable start of the
 * day, whose span still ends by midnight — the latest bound
 * `court_operating_hours.closes_hour` allows.
 */
export const HOUR_OPTIONS: readonly number[] = Array.from({ length: 17 }, (_, i) => i + 7)

/** Latest end bound: midnight, matching `closes_hour`'s maximum. */
export const LAST_END_HOUR = 24

/**
 * The end hours that make a valid span with `start`: every hour after it, up
 * to midnight. `until` is exclusive, so `start = 14, end = 17` is 2–5 PM.
 *
 * With no start chosen there is nothing to be after, so the full list (8 PM
 * … midnight's worth of hours, i.e. 8..24) comes back. The home hero renders
 * that unconditional list because it is a plain server-rendered GET form with
 * no client state to narrow it; `parseSearchParams` drops any pair the user
 * assembles that way. `/search`'s float is already a client component and
 * passes the chosen start, so its list narrows as the start moves.
 */
export function endHourOptions(start: number | undefined): readonly number[] {
  const first = (start ?? HOUR_OPTIONS[0]) + 1
  return Array.from({ length: Math.max(0, LAST_END_HOUR - first + 1) }, (_, i) => first + i)
}
