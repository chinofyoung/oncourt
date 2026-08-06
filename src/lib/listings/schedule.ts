/**
 * Operating-hours and rate-band rules.
 *
 * PURE on purpose — no `import 'server-only'`, no database, no session. Two
 * reasons: the court forms are client components and need WEEKDAY_LABELS and
 * the failure-message maps to render, and every rule below is cheap to
 * enumerate as a unit test precisely because nothing here can fail for an
 * environmental reason.
 *
 * These rules exist because the layer underneath them fails badly:
 *   - court_operating_hours' CHECKs (`opens_hour >= 0 and < 24`,
 *     `closes_hour > 0 and <= 24`, `closes_hour > opens_hour`) and its
 *     UNIQUE (court_id, day_of_week) raise 23514/23505, which reach a form
 *     as an unhandled exception;
 *   - court_rate_bands_no_overlap raises 23P01 for overlapping bands;
 *   - and a GAP in the bands raises nothing at all until a player is
 *     mid-checkout, when priceSlots() (src/lib/booking/pricing.ts) throws
 *     "No rate band covers hour N". That last one is why the tiling rule is
 *     enforced in TypeScript: the database deliberately does not, and says
 *     so in supabase/migrations/20260801063910_listings.sql's comment.
 */

export type OperatingHoursDay = { dayOfWeek: number; opensHour: number; closesHour: number }
export type RateBand = { startHour: number; endHour: number; priceCentavos: number }
export type HourSpan = { startHour: number; endHour: number }

/**
 * Index IS `court_operating_hours.day_of_week`: 0=Sunday..6=Saturday, the
 * same convention as manilaWeekday() and `extract(dow from ...)`. Do not
 * reorder to start on Monday without also remapping the column.
 */
export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

/**
 * The form asks for whole pesos; the column stores integer centavos.
 * Integer x 100 is exact in JS, which is the whole reason the field is not a
 * decimal one — see the money rule in the plan's Global Constraints.
 */
export const PESOS_TO_CENTAVOS = 100

export type HoursFailure = 'no_open_day' | 'invalid_window'
export type BandsFailure = 'no_bands' | 'invalid_band' | 'bands_do_not_tile'

export type ParsedHours =
  | { ok: true; days: OperatingHoursDay[] }
  | { ok: false; reason: HoursFailure }
export type ParsedBands = { ok: true; bands: RateBand[] } | { ok: false; reason: BandsFailure }

export const HOURS_FAILURE_MESSAGES: Record<HoursFailure, string> = {
  no_open_day: 'Open the court on at least one day of the week.',
  invalid_window:
    'Each open day needs one window with whole-hour opening and closing times, closing after it opens (midnight is 24).',
}

export const BANDS_FAILURE_MESSAGES: Record<BandsFailure, string> = {
  no_bands: 'Add at least one rate band.',
  invalid_band: 'Each band needs whole-hour start and end times and a whole-peso price above zero.',
  bands_do_not_tile:
    'The bands must cover every open hour exactly once — no gaps, no overlaps, and nothing outside your opening hours.',
}

/** Integer in [min, max], inclusive. The columns are `integer`, so 9.5 would truncate silently. */
function isHourInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max
}

/**
 * Per weekday: either closed (absent from the list) or exactly one window
 * `0 <= opens < closes <= 24`. At least one open weekday.
 *
 * The duplicate-weekday check mirrors court_operating_hours_unique_day: a
 * split day (open in the morning, closed midday, open again at night) is not
 * representable in this schema, and the spec puts multi-window days out of
 * scope. Catching it here turns a 23505 into a sentence.
 */
export function validateOperatingHours(days: OperatingHoursDay[]): HoursFailure | null {
  if (days.length === 0) return 'no_open_day'

  const seen = new Set<number>()
  for (const day of days) {
    if (!isHourInRange(day.dayOfWeek, 0, 6)) return 'invalid_window'
    if (seen.has(day.dayOfWeek)) return 'invalid_window'
    seen.add(day.dayOfWeek)
    // Mirrors the columns' own CHECKs exactly: opens_hour in [0, 23],
    // closes_hour in [1, 24], closes > opens.
    if (!isHourInRange(day.opensHour, 0, 23)) return 'invalid_window'
    if (!isHourInRange(day.closesHour, 1, 24)) return 'invalid_window'
    if (day.closesHour <= day.opensHour) return 'invalid_window'
  }
  return null
}

/**
 * Reads the seven weekday rows the hours form always renders.
 *
 * The `open-<d>` checkbox is the ONLY thing that decides whether a day is
 * open: an unchecked HTML checkbox submits nothing at all, while its
 * sibling number inputs still post their values. Deriving "closed" from a
 * blank hour instead would make a day silently closed the moment someone
 * cleared a field they meant to retype.
 */
export function parseOperatingHours(formData: FormData): ParsedHours {
  const days: OperatingHoursDay[] = []
  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek++) {
    if (formData.get(`open-${dayOfWeek}`) === null) continue
    days.push({
      dayOfWeek,
      // Number('') and Number(null) are both 0 — harmless here because
      // validateOperatingHours requires closes_hour >= 1, so a blank closing
      // time is rejected rather than stored as midnight.
      opensHour: Number(formData.get(`opens-${dayOfWeek}`)),
      closesHour: Number(formData.get(`closes-${dayOfWeek}`)),
    })
  }

  const failure = validateOperatingHours(days)
  return failure === null ? { ok: true, days } : { ok: false, reason: failure }
}

/**
 * The hour range the bands must tile: `[min(opens_hour), max(closes_hour)]`
 * across the whole week.
 *
 * Per COURT and per WEEK, not per day, because court_rate_bands has no
 * weekday column — one price schedule serves every open day. A court open
 * 11-22 on weekdays and 7-24 on Saturday must therefore price 7 through 24.
 */
export function operatingSpan(days: OperatingHoursDay[]): HourSpan | null {
  if (days.length === 0) return null
  return {
    startHour: Math.min(...days.map((day) => day.opensHour)),
    endHour: Math.max(...days.map((day) => day.closesHour)),
  }
}

/** Per-band rules only — the shape each row must have before tiling is even meaningful. */
export function validateBandShapes(bands: RateBand[]): BandsFailure | null {
  for (const band of bands) {
    if (!isHourInRange(band.startHour, 0, 23)) return 'invalid_band'
    if (!isHourInRange(band.endHour, 1, 24)) return 'invalid_band'
    if (band.endHour <= band.startHour) return 'invalid_band'
    if (!Number.isInteger(band.priceCentavos) || band.priceCentavos <= 0) return 'invalid_band'
  }
  return null
}

/**
 * The tiling rule: the bands must cover `span` exactly once — contiguous,
 * no gaps, no overlaps, nothing outside it.
 *
 * Sorting by start hour and walking the chain catches all three failures with
 * one pass: a gap or an overlap both show up as `next.startHour !==
 * prev.endHour`, and two bands sharing a start hour do too (whichever sorts
 * second cannot begin where the first ended). The ends are pinned to the span
 * separately, which is what rejects bands that start late, stop early, or
 * overshoot the opening hours.
 */
export function validateRateBands(bands: RateBand[], span: HourSpan): BandsFailure | null {
  if (bands.length === 0) return 'no_bands'

  const shapeFailure = validateBandShapes(bands)
  if (shapeFailure !== null) return shapeFailure

  const sorted = [...bands].sort((a, b) => a.startHour - b.startHour)
  if (sorted[0].startHour !== span.startHour) return 'bands_do_not_tile'
  if (sorted[sorted.length - 1].endHour !== span.endHour) return 'bands_do_not_tile'
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].startHour !== sorted[index - 1].endHour) return 'bands_do_not_tile'
  }
  return null
}

/**
 * Reads the repeating band rows.
 *
 * Three parallel `getAll()` lists rather than indexed field names
 * (`band-0-start`): rows are added and removed client-side, and index-based
 * names would need renumbering on every removal — a source of silent holes.
 * The equal-length check is what makes zipping them safe against a
 * hand-crafted POST.
 *
 * Does NOT check tiling: the span comes from the court's stored operating
 * hours, which only the write layer has. Callers run validateRateBands()
 * after loading it.
 */
export function parseRateBands(formData: FormData): ParsedBands {
  const starts = formData.getAll('bandStart')
  const ends = formData.getAll('bandEnd')
  const prices = formData.getAll('bandPrice')

  if (starts.length === 0) return { ok: false, reason: 'no_bands' }
  if (ends.length !== starts.length || prices.length !== starts.length) {
    return { ok: false, reason: 'invalid_band' }
  }

  const bands: RateBand[] = starts.map((start, index) => {
    const pesos = Number(String(prices[index]).trim())
    return {
      startHour: Number(String(start).trim()),
      endHour: Number(String(ends[index]).trim()),
      // A fractional or blank peso value becomes NaN rather than a rounded
      // number, so validateBandShapes rejects it instead of quietly storing
      // a price the owner did not type.
      priceCentavos: Number.isInteger(pesos) ? pesos * PESOS_TO_CENTAVOS : Number.NaN,
    }
  })

  const failure = validateBandShapes(bands)
  return failure === null ? { ok: true, bands } : { ok: false, reason: failure }
}

/**
 * "Do these bands price every open hour, exactly once?" — one rule, two
 * callers, deliberately.
 *
 * Lifted out of getListingCourt (src/lib/listings/queries.ts), which had this
 * expression inline, when the admin approval queue needed the identical
 * judgement. approveCourt REFUSES while this is non-null and the owner's court
 * page WARNS while this is non-null; two copies would eventually let the queue
 * approve a court the owner's own page is still telling them to fix — a court
 * that is live, bookable, and throws "No rate band covers hour N" out of
 * priceSlots() in the middle of a player's checkout.
 *
 * 'no_open_day' covers the brand-new court that has no hours yet as well as
 * one whose hours were deleted: either way the bands have nothing to tile, and
 * the next instruction is the same.
 */
export function courtScheduleWarning(
  days: OperatingHoursDay[],
  bands: RateBand[],
): HoursFailure | BandsFailure | null {
  const span = operatingSpan(days)
  if (span === null) return 'no_open_day'
  return validateRateBands(bands, span)
}
