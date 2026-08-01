import { expect, test } from 'vitest'
import { buildAvailabilityGrid, loadBranchDay } from '@/lib/booking/availability'
import { seedBranchWithCourts } from '../helpers/fixtures'

const INPUT = {
  date: '2026-08-15', // a Saturday
  courts: [
    { courtId: 'c1', courtName: 'Court 1', environment: 'indoor' as const },
    { courtId: 'c2', courtName: 'Court 2', environment: 'outdoor' as const },
  ],
  rateBands: {
    c1: [
      { startHour: 11, endHour: 15, priceCentavos: 26500 },
      { startHour: 15, endHour: 24, priceCentavos: 36500 },
    ],
    c2: [{ startHour: 11, endHour: 24, priceCentavos: 26500 }],
  },
  operatingHours: { c1: { opensHour: 11, closesHour: 24 }, c2: { opensHour: 14, closesHour: 20 } },
  occupiedHours: { c1: [18, 19] },
}

test('renders one column per court over the union of operating hours', () => {
  const grid = buildAvailabilityGrid(INPUT)
  expect(grid.map((c) => c.courtId)).toEqual(['c1', 'c2'])
  // Union is 11:00-24:00 -> 13 hourly rows.
  expect(grid[0].cells).toHaveLength(13)
  expect(grid[1].cells).toHaveLength(13)
})

test('marks hours outside a court operating window as closed', () => {
  const grid = buildAvailabilityGrid(INPUT)
  const courtTwo = grid[1]
  expect(courtTwo.cells.find((c) => c.hour === 11)!.state).toBe('closed')
  expect(courtTwo.cells.find((c) => c.hour === 14)!.state).toBe('open')
  expect(courtTwo.cells.find((c) => c.hour === 20)!.state).toBe('closed')
})

test('marks occupied hours as booked', () => {
  const grid = buildAvailabilityGrid(INPUT)
  const courtOne = grid[0]
  expect(courtOne.cells.find((c) => c.hour === 18)!.state).toBe('booked')
  expect(courtOne.cells.find((c) => c.hour === 19)!.state).toBe('booked')
  expect(courtOne.cells.find((c) => c.hour === 20)!.state).toBe('open')
})

test('each cell carries the price for that specific hour', () => {
  const grid = buildAvailabilityGrid(INPUT)
  const courtOne = grid[0]
  expect(courtOne.cells.find((c) => c.hour === 12)!.priceCentavos).toBe(26500)
  expect(courtOne.cells.find((c) => c.hour === 16)!.priceCentavos).toBe(36500)
})

test('a court with no operating hours for that weekday is entirely closed', () => {
  const grid = buildAvailabilityGrid({ ...INPUT, operatingHours: { c1: INPUT.operatingHours.c1 } })
  expect(grid[1].cells.every((c) => c.state === 'closed')).toBe(true)
})

// Review round 1, Important-4: a mutation harness found three surviving
// mutants against the tests above, meaning none of them actually bound the
// behavior they looked like they covered. Each test below is written to
// bind to exactly one of those three, verified by hand-tracing what the
// named mutant would produce (not just what the un-mutated code produces).

test('a court open by hours but covered by no rate band at all is entirely closed', () => {
  // Kills deleting `&& band` from `isOpen`: with no bands entry for c3 at
  // all, `band` is `undefined` for every hour in its 10-14 window. The
  // un-mutated code requires `band` truthy for `isOpen`, so every hour
  // reads 'closed'. Without that clause, `isOpen` would depend on `window`
  // alone (true for hours 10-13), producing 'open' cells priced at 0
  // centavos (`band?.priceCentavos ?? 0`) — a real bug that would show a
  // bookable, free-of-charge slot to a paying user.
  const grid = buildAvailabilityGrid({
    date: '2026-08-15',
    courts: [{ courtId: 'c3', courtName: 'Court 3', environment: 'indoor' }],
    rateBands: {}, // no entry for c3 at all
    operatingHours: { c3: { opensHour: 10, closesHour: 14 } },
    occupiedHours: {},
  })
  expect(grid[0].cells.every((c) => c.state === 'closed')).toBe(true)
})

test('an hour exactly on a band boundary belongs to the next band, not the previous one', () => {
  // Kills `hour < b.endHour` -> `hour <= b.endHour`: INPUT's c1 has bands
  // 11-15 (₱265) and 15-24 (₱365). Under the mutant, hour 15 satisfies
  // BOTH `15 >= 11 && 15 <= 15` (band one) and `15 >= 15 && 15 < 24` (band
  // two); `Array.prototype.find` returns the first match in array order,
  // which is band one — so the mutant prices hour 15 at ₱265 instead of the
  // correct ₱365, undercharging a paying user for a peak-rate hour.
  const grid = buildAvailabilityGrid(INPUT)
  const courtOne = grid[0]
  expect(courtOne.cells.find((c) => c.hour === 14)!.priceCentavos).toBe(26500)
  expect(courtOne.cells.find((c) => c.hour === 15)!.priceCentavos).toBe(36500)
})

test('the hour union spans every court window, not just the first court listed', () => {
  // Kills computing `opensAt`/`closesAt` from only `input.courts[0]`'s
  // window: here court x1's own window (11-15) is narrower than the true
  // union across x1+x2 (11-20). The original suite's union test used a
  // fixture where court one's window (11-24) happened to already equal the
  // true union, so a "first court only" mutant produced the same 13-hour
  // result and passed by coincidence. Swapping which court is listed first
  // (x2, whose own window 15-20 is also not the union) additionally kills
  // any mutant that hardcodes "first" vs. "last" rather than genuinely
  // reducing over every court.
  const grid = buildAvailabilityGrid({
    date: '2026-08-15',
    courts: [
      { courtId: 'x2', courtName: 'X2', environment: 'indoor' },
      { courtId: 'x1', courtName: 'X1', environment: 'indoor' },
    ],
    rateBands: {
      x1: [{ startHour: 11, endHour: 15, priceCentavos: 10000 }],
      x2: [{ startHour: 15, endHour: 20, priceCentavos: 10000 }],
    },
    operatingHours: {
      x1: { opensHour: 11, closesHour: 15 },
      x2: { opensHour: 15, closesHour: 20 },
    },
    occupiedHours: {},
  })
  // True union across both courts is 11:00-20:00 -> 9 hourly rows.
  expect(grid[0].cells).toHaveLength(9)
  expect(grid[1].cells).toHaveLength(9)
})

test('a fully booked day marks every open hour as booked, not just some', () => {
  const grid = buildAvailabilityGrid({
    ...INPUT,
    // Every hour in c1's own 11-24 window (13 hours: 11..23) occupied.
    occupiedHours: { c1: Array.from({ length: 13 }, (_, i) => 11 + i) },
  })
  const courtOne = grid[0]
  expect(courtOne.cells.every((c) => c.state === 'booked')).toBe(true)
})

test('loadBranchDay returns one column per approved court on a multi-court branch', async () => {
  // Regression test for the Critical finding in review round 1: the
  // previous `in (${courtIds})` form of every query in loadBranchDay
  // relied on drizzle-orm's array-expansion behavior, which for 2+ courts
  // produced a SQL row constructor (`in (($1, $2))`) rather than an
  // IN-list, failing with `42883 operator does not exist: uuid = record`
  // on every real multi-court branch. It only ever looked correct because
  // manual browser verification happened to use a one-court branch, where
  // `($1)` degenerates to a plain scalar instead of a row. This test uses
  // `seedBranchWithCourts(2)` specifically so a regression back to that
  // form fails here, not just in a browser session nobody happened to
  // re-run against a multi-court branch.
  const { slug, courtIds } = await seedBranchWithCourts(2)

  const result = await loadBranchDay(slug, '2026-08-15') // a Saturday; fixture hours are every day, 11-24
  expect(result).not.toBeNull()
  expect(result!.grid).toHaveLength(2)
  expect(result!.grid.map((c) => c.courtId).sort()).toEqual([...courtIds].sort())

  // Fixture rate bands (tests/helpers/fixtures.ts): 11-15 -> ₱265,
  // 15-17 -> ₱315, 17-24 -> ₱365, identical on every seeded court.
  for (const column of result!.grid) {
    expect(column.cells).toHaveLength(13)
    expect(column.cells.find((c) => c.hour === 12)!.priceCentavos).toBe(26500)
    expect(column.cells.find((c) => c.hour === 16)!.priceCentavos).toBe(31500)
    expect(column.cells.find((c) => c.hour === 20)!.priceCentavos).toBe(36500)
    expect(column.cells.every((c) => c.state === 'open')).toBe(true)
  }
})
