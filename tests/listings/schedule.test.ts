import { expect, test } from 'vitest'
import {
  BANDS_FAILURE_MESSAGES,
  HOURS_FAILURE_MESSAGES,
  courtScheduleWarning,
  operatingSpan,
  parseOperatingHours,
  parseRateBands,
  validateBandShapes,
  validateOperatingHours,
  validateRateBands,
  type OperatingHoursDay,
  type RateBand,
} from '@/lib/listings/schedule'

/**
 * Pure module: no database, no fixtures, no teardown. Every case here is a
 * rule the court forms must not be able to violate, because the layer below
 * (court_operating_hours' CHECKs, court_rate_bands_no_overlap, and
 * priceSlots' "No rate band covers hour N" throw) either raises an opaque
 * SQLSTATE or fails a player mid-checkout.
 */
function hoursForm(entries: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.set(key, value)
  return data
}

function bandsForm(bands: { start: string; end: string; pesos: string }[]): FormData {
  const data = new FormData()
  for (const band of bands) {
    data.append('bandStart', band.start)
    data.append('bandEnd', band.end)
    data.append('bandPrice', band.pesos)
  }
  return data
}

const OPEN_ALL_WEEK: OperatingHoursDay[] = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek,
  opensHour: 11,
  closesHour: 24,
}))

// ---------------------------------------------------------- operating hours

test('validateOperatingHours accepts one window per open weekday', () => {
  expect(validateOperatingHours(OPEN_ALL_WEEK)).toBeNull()
})

test('validateOperatingHours accepts a single open weekday', () => {
  // "At least one open weekday" is the floor, not "all seven": a venue that
  // only opens on Saturdays is a real venue.
  expect(validateOperatingHours([{ dayOfWeek: 6, opensHour: 8, closesHour: 20 }])).toBeNull()
})

test('validateOperatingHours accepts a window closing at 24', () => {
  // court_operating_hours.closes_hour permits 24 (local midnight) and the
  // seeded fixtures use it. formatHour(24) already renders "12 AM".
  expect(validateOperatingHours([{ dayOfWeek: 3, opensHour: 11, closesHour: 24 }])).toBeNull()
})

test('validateOperatingHours rejects an all-closed week', () => {
  // A court with no open day is unbookable and would make operatingSpan()
  // null, leaving the rate bands with nothing to tile.
  expect(validateOperatingHours([])).toBe('no_open_day')
})

test('validateOperatingHours rejects a window that closes before it opens', () => {
  expect(validateOperatingHours([{ dayOfWeek: 1, opensHour: 20, closesHour: 8 }])).toBe(
    'invalid_window',
  )
})

test('validateOperatingHours rejects a zero-length window', () => {
  // court_operating_hours_order is `closes_hour > opens_hour`, so this would
  // be a 23514 rather than a form error.
  expect(validateOperatingHours([{ dayOfWeek: 1, opensHour: 9, closesHour: 9 }])).toBe(
    'invalid_window',
  )
})

test('validateOperatingHours rejects hours outside 0..24', () => {
  expect(validateOperatingHours([{ dayOfWeek: 1, opensHour: -1, closesHour: 9 }])).toBe(
    'invalid_window',
  )
  expect(validateOperatingHours([{ dayOfWeek: 1, opensHour: 9, closesHour: 25 }])).toBe(
    'invalid_window',
  )
  // opens_hour's CHECK is `>= 0 and < 24`: a window opening AT midnight-end
  // has no room to close after it.
  expect(validateOperatingHours([{ dayOfWeek: 1, opensHour: 24, closesHour: 24 }])).toBe(
    'invalid_window',
  )
})

test('validateOperatingHours rejects non-integer hours', () => {
  // The columns are `integer`; 9.5 would be silently truncated by the driver.
  expect(validateOperatingHours([{ dayOfWeek: 1, opensHour: 9.5, closesHour: 17 }])).toBe(
    'invalid_window',
  )
})

test('validateOperatingHours rejects a weekday outside 0..6', () => {
  expect(validateOperatingHours([{ dayOfWeek: 7, opensHour: 9, closesHour: 17 }])).toBe(
    'invalid_window',
  )
})

test('validateOperatingHours rejects two windows on the same weekday', () => {
  // court_operating_hours_unique_day is UNIQUE (court_id, day_of_week), so a
  // split day (open 6-9, closed for a league, open 18-22) is not
  // representable. Caught here as a form error rather than as a 23505.
  expect(
    validateOperatingHours([
      { dayOfWeek: 2, opensHour: 6, closesHour: 9 },
      { dayOfWeek: 2, opensHour: 18, closesHour: 22 },
    ]),
  ).toBe('invalid_window')
})

test('parseOperatingHours reads only the weekdays whose checkbox was submitted', () => {
  // An unchecked HTML checkbox submits nothing at all, so absence IS closed.
  // The form always renders all seven rows for exactly this reason.
  const result = parseOperatingHours(
    hoursForm({
      'open-1': 'on',
      'opens-1': '6',
      'closes-1': '22',
      'open-6': 'on',
      'opens-6': '8',
      'closes-6': '24',
      // Sunday's hour inputs are submitted but its checkbox is not — the
      // browser still posts a disabled-looking-but-enabled number field, so
      // the checkbox has to be the only thing that decides.
      'opens-0': '9',
      'closes-0': '17',
    }),
  )
  expect(result).toEqual({
    ok: true,
    days: [
      { dayOfWeek: 1, opensHour: 6, closesHour: 22 },
      { dayOfWeek: 6, opensHour: 8, closesHour: 24 },
    ],
  })
})

test('parseOperatingHours reports no_open_day when nothing is checked', () => {
  expect(parseOperatingHours(hoursForm({}))).toEqual({ ok: false, reason: 'no_open_day' })
})

test('parseOperatingHours reports invalid_window for a blank or junk hour', () => {
  // Number('') and Number(null) are both 0, which would pass a naive
  // `Number.isInteger` check and silently store a midnight-to-midnight day.
  for (const closes of ['', 'noon']) {
    expect(
      parseOperatingHours(hoursForm({ 'open-4': 'on', 'opens-4': '9', 'closes-4': closes })),
    ).toEqual({ ok: false, reason: 'invalid_window' })
  }
})

// -------------------------------------------------------------- rate bands

test('operatingSpan takes the widest window across the week', () => {
  // The span is per-COURT and per-WEEK, not per-day: bands have no weekday
  // column (court_rate_bands is court_id + hours only), so they must cover
  // the union of every open day's window.
  expect(
    operatingSpan([
      { dayOfWeek: 1, opensHour: 11, closesHour: 22 },
      { dayOfWeek: 6, opensHour: 7, closesHour: 24 },
    ]),
  ).toEqual({ startHour: 7, endHour: 24 })
})

test('operatingSpan is null for a closed week', () => {
  expect(operatingSpan([])).toBeNull()
})

test('validateRateBands accepts bands that exactly tile the span', () => {
  const bands: RateBand[] = [
    { startHour: 11, endHour: 15, priceCentavos: 26500 },
    { startHour: 15, endHour: 17, priceCentavos: 31500 },
    { startHour: 17, endHour: 24, priceCentavos: 36500 },
  ]
  expect(validateRateBands(bands, { startHour: 11, endHour: 24 })).toBeNull()
})

test('validateRateBands accepts a single band covering the whole span', () => {
  expect(
    validateRateBands([{ startHour: 6, endHour: 22, priceCentavos: 20000 }], {
      startHour: 6,
      endHour: 22,
    }),
  ).toBeNull()
})

test('validateRateBands accepts bands submitted out of order', () => {
  // The form appends rows in DOM order; an owner inserting a band in the
  // middle should not have to re-sort by hand.
  expect(
    validateRateBands(
      [
        { startHour: 17, endHour: 24, priceCentavos: 36500 },
        { startHour: 11, endHour: 17, priceCentavos: 26500 },
      ],
      { startHour: 11, endHour: 24 },
    ),
  ).toBeNull()
})

test('validateRateBands rejects a gap between bands', () => {
  expect(
    validateRateBands(
      [
        { startHour: 11, endHour: 15, priceCentavos: 26500 },
        { startHour: 16, endHour: 24, priceCentavos: 36500 },
      ],
      { startHour: 11, endHour: 24 },
    ),
  ).toBe('bands_do_not_tile')
})

test('validateRateBands rejects overlapping bands', () => {
  // court_rate_bands_no_overlap would raise 23P01 on the INSERT; catching it
  // here makes it a sentence instead of an exclusion-constraint violation.
  expect(
    validateRateBands(
      [
        { startHour: 11, endHour: 16, priceCentavos: 26500 },
        { startHour: 15, endHour: 24, priceCentavos: 36500 },
      ],
      { startHour: 11, endHour: 24 },
    ),
  ).toBe('bands_do_not_tile')
})

test('validateRateBands rejects two bands starting at the same hour', () => {
  expect(
    validateRateBands(
      [
        { startHour: 11, endHour: 24, priceCentavos: 26500 },
        { startHour: 11, endHour: 15, priceCentavos: 31500 },
      ],
      { startHour: 11, endHour: 24 },
    ),
  ).toBe('bands_do_not_tile')
})

test('validateRateBands rejects bands that start after the court opens', () => {
  // The uncovered 11:00 and 12:00 hours are exactly what makes priceSlots
  // throw mid-checkout.
  expect(
    validateRateBands([{ startHour: 13, endHour: 24, priceCentavos: 26500 }], {
      startHour: 11,
      endHour: 24,
    }),
  ).toBe('bands_do_not_tile')
})

test('validateRateBands rejects bands that stop before the court closes', () => {
  expect(
    validateRateBands([{ startHour: 11, endHour: 20, priceCentavos: 26500 }], {
      startHour: 11,
      endHour: 24,
    }),
  ).toBe('bands_do_not_tile')
})

test('validateRateBands rejects bands wider than the span', () => {
  // Overshooting is not harmless: it prices hours the court is never open,
  // which reads on the court page as availability that does not exist.
  expect(
    validateRateBands([{ startHour: 6, endHour: 24, priceCentavos: 26500 }], {
      startHour: 11,
      endHour: 24,
    }),
  ).toBe('bands_do_not_tile')
})

test('validateRateBands rejects an empty band list', () => {
  expect(validateRateBands([], { startHour: 11, endHour: 24 })).toBe('no_bands')
})

test('validateBandShapes rejects a zero or negative price', () => {
  // court_rate_bands' CHECK is `price_centavos > 0`. A free court is not a
  // pricing tier, it is a data-entry mistake.
  for (const priceCentavos of [0, -100]) {
    expect(validateBandShapes([{ startHour: 11, endHour: 24, priceCentavos }])).toBe('invalid_band')
  }
})

test('validateBandShapes rejects a non-integer price', () => {
  expect(validateBandShapes([{ startHour: 11, endHour: 24, priceCentavos: 26500.5 }])).toBe(
    'invalid_band',
  )
})

test('validateBandShapes rejects non-integer or out-of-range hours', () => {
  expect(validateBandShapes([{ startHour: 11.5, endHour: 24, priceCentavos: 100 }])).toBe(
    'invalid_band',
  )
  expect(validateBandShapes([{ startHour: 11, endHour: 25, priceCentavos: 100 }])).toBe(
    'invalid_band',
  )
  expect(validateBandShapes([{ startHour: -1, endHour: 24, priceCentavos: 100 }])).toBe(
    'invalid_band',
  )
})

test('validateBandShapes rejects a band that ends before it starts', () => {
  expect(validateBandShapes([{ startHour: 17, endHour: 11, priceCentavos: 100 }])).toBe(
    'invalid_band',
  )
  expect(validateBandShapes([{ startHour: 17, endHour: 17, priceCentavos: 100 }])).toBe(
    'invalid_band',
  )
})

test('parseRateBands converts whole pesos to integer centavos', () => {
  // The form takes pesos because that is what an owner types; centavos are
  // what the database stores. Integer x 100 is exact — no float money.
  expect(
    parseRateBands(
      bandsForm([
        { start: '11', end: '15', pesos: '265' },
        { start: '15', end: '24', pesos: '365' },
      ]),
    ),
  ).toEqual({
    ok: true,
    bands: [
      { startHour: 11, endHour: 15, priceCentavos: 26500 },
      { startHour: 15, endHour: 24, priceCentavos: 36500 },
    ],
  })
})

test('parseRateBands rejects a fractional peso price', () => {
  expect(parseRateBands(bandsForm([{ start: '11', end: '24', pesos: '265.5' }]))).toEqual({
    ok: false,
    reason: 'invalid_band',
  })
})

test('parseRateBands rejects a blank price', () => {
  expect(parseRateBands(bandsForm([{ start: '11', end: '24', pesos: '' }]))).toEqual({
    ok: false,
    reason: 'invalid_band',
  })
})

test('parseRateBands reports no_bands for an empty submission', () => {
  expect(parseRateBands(new FormData())).toEqual({ ok: false, reason: 'no_bands' })
})

test('parseRateBands rejects a submission whose three lists disagree in length', () => {
  // A hand-crafted POST could send two starts and one price. Zipping them
  // blindly would produce a band with a NaN price.
  const data = new FormData()
  data.append('bandStart', '11')
  data.append('bandStart', '15')
  data.append('bandEnd', '15')
  data.append('bandEnd', '24')
  data.append('bandPrice', '265')
  expect(parseRateBands(data)).toEqual({ ok: false, reason: 'invalid_band' })
})

// -------------------------------------------------------- courtScheduleWarning

test('courtScheduleWarning is null when the bands tile the week exactly', () => {
  expect(
    courtScheduleWarning(OPEN_ALL_WEEK, [
      { startHour: 11, endHour: 15, priceCentavos: 26500 },
      { startHour: 15, endHour: 17, priceCentavos: 31500 },
      { startHour: 17, endHour: 24, priceCentavos: 36500 },
    ]),
  ).toBeNull()
})

test('courtScheduleWarning reports the gap, the missing hours, and the missing bands', () => {
  // A gap: 15-17 is unpriced, which is exactly what priceSlots() throws on.
  expect(
    courtScheduleWarning(OPEN_ALL_WEEK, [
      { startHour: 11, endHour: 15, priceCentavos: 26500 },
      { startHour: 17, endHour: 24, priceCentavos: 36500 },
    ]),
  ).toBe('bands_do_not_tile')

  // No hours at all -> the bands have nothing to tile, and this is the answer
  // even though the bands themselves are well formed.
  expect(courtScheduleWarning([], [{ startHour: 11, endHour: 24, priceCentavos: 26500 }])).toBe(
    'no_open_day',
  )

  // Hours but no bands.
  expect(courtScheduleWarning(OPEN_ALL_WEEK, [])).toBe('no_bands')
})

test('every failure reason has a message', () => {
  // The forms render these verbatim; a missing key would render "undefined".
  expect(Object.keys(HOURS_FAILURE_MESSAGES).sort()).toEqual(['invalid_window', 'no_open_day'])
  expect(Object.keys(BANDS_FAILURE_MESSAGES).sort()).toEqual([
    'bands_do_not_tile',
    'invalid_band',
    'no_bands',
  ])
  for (const message of [
    ...Object.values(HOURS_FAILURE_MESSAGES),
    ...Object.values(BANDS_FAILURE_MESSAGES),
  ]) {
    expect(message.length).toBeGreaterThan(0)
  }
})
