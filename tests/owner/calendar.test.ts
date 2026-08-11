import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  manilaHour,
  seedBlock,
  seedBooking,
  seedBranchWithCourts,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'
import { getOwnerMonthCalendar, getOwnerOverview } from '@/lib/owner/queries'
import { manilaWeekday } from '@/lib/date-manila'

/**
 * A court seeded directly with a non-'approved' status. `seedBranchWithCourts`
 * always inserts 'approved' courts (that's the shape most of this file needs),
 * so the one test below that needs a 'pending'/'suspended' court builds it by
 * hand rather than widening that shared helper for a single caller.
 */
async function seedCourtWithStatus(branchId: string, status: 'pending' | 'suspended'): Promise<string> {
  const result = await db.execute(sql`
    insert into courts (branch_id, name, environment, status)
    values (${branchId}::uuid, 'Unapproved Court', 'indoor', ${status}::court_status)
    returning id
  `)
  return result.rows[0].id as string
}

afterAll(teardownFixtures)

test('returns one row for every day of the month, including empty days', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const days = await getOwnerMonthCalendar([branchId], [branchId], '2026-09')
  expect(days).toHaveLength(30)
  expect(days[0].date).toBe('2026-09-01')
  expect(days.at(-1)!.date).toBe('2026-09-30')
  expect(days.every((d) => d.bookingCount === 0)).toBe(true)
})

test('February day counts are right in a leap and a non-leap year', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  expect(await getOwnerMonthCalendar([branchId], [branchId], '2026-02')).toHaveLength(28)
  expect(await getOwnerMonthCalendar([branchId], [branchId], '2028-02')).toHaveLength(29)
})

test('capacity differs by weekday when a court has non-uniform operating hours', async () => {
  // tests/helpers/fixtures.ts seeds identical 11-24 (13h) hours for every
  // day_of_week, so every day of every OTHER test in this file has the same
  // capacity — a wrong day_of_week join (off-by-one, ISO-vs-Sunday `dow`
  // mixup, or the predicate dropped entirely) would still produce uniform,
  // plausible-looking numbers and pass everything else here. Closing the
  // court on one specific weekday is what makes such a bug visible: it forces
  // capacityHours to actually depend on which weekday each day is, not just
  // on which month.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await db.execute(sql`
    delete from court_operating_hours
    where court_id = ${courtIds[0]}::uuid and day_of_week = 0
  `)

  const days = await getOwnerMonthCalendar([branchId], [branchId], '2026-09')

  for (const day of days) {
    const expected = manilaWeekday(day.date) === 0 ? 0 : 13
    expect(day.capacityHours).toBe(expected)
  }
  // Guard against a vacuous pass: the month must actually contain both a
  // Sunday and a non-Sunday, or the loop above never exercises the branch.
  expect(days.some((d) => manilaWeekday(d.date) === 0)).toBe(true)
  expect(days.some((d) => manilaWeekday(d.date) !== 0)).toBe(true)
})

test('a paid booking raises count, money and booked hours on its own day only', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  await seedBooking({
    branchId,
    courtId: courtIds[0],
    playerId: player,
    startsAt: manilaHour('2026-09-10', 9),
    hours: 2,
  })
  const days = await getOwnerMonthCalendar([branchId], [branchId], '2026-09')
  const tenth = days.find((d) => d.date === '2026-09-10')!
  expect(tenth.bookingCount).toBe(1)
  expect(tenth.bookedHours).toBe(2)
  expect(tenth.grossCentavos).toBeGreaterThan(0)
  expect(days.filter((d) => d.bookingCount > 0)).toHaveLength(1)
})

test('a block raises blockCount but never money, hours or occupancy', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  await seedBlock({
    branchId,
    courtId: courtIds[0],
    createdBy: ownerId,
    startsAt: manilaHour('2026-09-12', 8),
    hours: 4,
  })
  const day = (await getOwnerMonthCalendar([branchId], [branchId], '2026-09')).find(
    (d) => d.date === '2026-09-12',
  )!
  expect(day.blockCount).toBe(1)
  expect(day.bookingCount).toBe(0)
  expect(day.grossCentavos).toBe(0)
  expect(day.netCentavos).toBe(0)
  expect(day.bookedHours).toBe(0)
  expect(day.occupancyPct === null || day.occupancyPct === 0).toBe(true)
})

test('occupancy agrees with getOwnerOverview for the same day', async () => {
  // The two sit on the same dashboard; if they disagree, one of them is lying.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  await seedBooking({
    branchId,
    courtId: courtIds[0],
    playerId: player,
    startsAt: manilaHour('2026-09-15', 10),
    hours: 2,
  })
  const overview = await getOwnerOverview([branchId], '2026-09-15')
  const day = (await getOwnerMonthCalendar([branchId], [branchId], '2026-09')).find(
    (d) => d.date === '2026-09-15',
  )!
  expect(day.occupancyPct).toBe(overview.stats.occupancyPct)
})

test('occupancy is null, never 0, when no court is open that day', async () => {
  // A branch with zero courts has zero scoped capacity every day of the
  // month — genuinely zero, not "zero on the days this fixture happens to
  // land on" — so this exercises the null-not-zero rule unconditionally,
  // unlike a fixture where every day has nonzero capacity (which would make
  // this assertion pass vacuously without checking anything).
  const { branchId } = await seedBranchWithCourts(0)
  const days = await getOwnerMonthCalendar([branchId], [branchId], '2026-09')
  expect(days.length).toBeGreaterThan(0)
  for (const day of days) {
    expect(day.capacityHours).toBe(0)
    expect(day.occupancyPct).toBeNull()
    expect(day.occupancyPct).not.toBe(0)
  }
})

test('a booking before 8am Manila still lands on its Manila calendar day', async () => {
  // Manila is UTC+8, so every OTHER booking in this file (Manila hour >= 8)
  // lands on the same calendar date in UTC as in Manila — a dropped
  // `at time zone 'Asia/Manila'` in the day-bucketing to_char() calls would
  // go completely unnoticed by them. 07:00 Manila is 23:00 the PREVIOUS day
  // in UTC, so this booking only lands on 2026-09-05 if the conversion is
  // actually applied; if it were dropped, it would bucket onto 2026-09-04
  // instead, failing loudly.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  await seedBooking({
    branchId,
    courtId: courtIds[0],
    playerId: player,
    startsAt: manilaHour('2026-09-05', 7),
    hours: 1,
  })
  const days = await getOwnerMonthCalendar([branchId], [branchId], '2026-09')
  const fifth = days.find((d) => d.date === '2026-09-05')!
  const fourth = days.find((d) => d.date === '2026-09-04')!
  expect(fifth.bookingCount).toBe(1)
  expect(fifth.bookedHours).toBe(1)
  expect(fourth.bookingCount).toBe(0)
})

test("another owner's branch never appears", async () => {
  const mine = await seedBranchWithCourts(1)
  const theirs = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  await seedBooking({
    branchId: theirs.branchId,
    courtId: theirs.courtIds[0],
    playerId: player,
    startsAt: manilaHour('2026-09-20', 9),
  })
  const day = (await getOwnerMonthCalendar([mine.branchId], [mine.branchId], '2026-09')).find(
    (d) => d.date === '2026-09-20',
  )!
  expect(day.bookingCount).toBe(0)
})

test('a branch in the bookings scope but not the earnings scope reports bookings and occupancy while money stays zero', async () => {
  // Pins the fix for the earnings leak a review caught: a staff grant with
  // view_bookings but WITHOUT view_earnings on a branch (the exact shape
  // src/app/dashboard/bookings/page.tsx's `earningsBranchIds` distinguishes
  // from `scheduleBranchIds`) must still see how busy the branch was — that
  // is bookings information — while gross/net stay at 0, never the real
  // figures. `branchIds` carries the branch so bookingCount/occupancy are
  // real; `earningsBranchIds` is `[]`, deliberately excluding it, so
  // grossCentavos/netCentavos must come back 0 despite a real paid booking
  // existing on this day. Without this test the query regresses silently the
  // next time someone touches the `agg` CTE.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  await seedBooking({
    branchId,
    courtId: courtIds[0],
    playerId: player,
    startsAt: manilaHour('2026-09-22', 9),
    hours: 2,
  })
  const days = await getOwnerMonthCalendar([branchId], [], '2026-09')
  const day = days.find((d) => d.date === '2026-09-22')!
  expect(day.bookingCount).toBe(1)
  expect(day.bookedHours).toBe(2)
  expect(day.occupancyPct).not.toBeNull()
  expect(day.occupancyPct).toBeGreaterThan(0)
  expect(day.grossCentavos).toBe(0)
  expect(day.netCentavos).toBe(0)
})

test('a non-approved court still reports its real booking and money, but contributes no capacity', async () => {
  // Pins the fix for the money-erasure bug a review caught: replaceOperatingHours
  // re-queues an approved court to 'pending' on every hours edit (and admin
  // suspension does the same), but the booking underneath it is still real and
  // already paid. Scoping bookingCount/grossCentavos to `scoped_courts`
  // (approved-only, same as capacity) made that booking and its money vanish
  // from the calendar for as long as the court stayed non-approved, while the
  // Schedule tab, the day dialog, getOwnerEarnings and getOwnerOverview's
  // gross/net all kept showing both — the calendar disagreed with the rest of
  // the dashboard about real revenue. `capacityHours` is the one thing that
  // must stay approved-only (it's the occupancy denominator), so this test
  // pins both halves at once: the booking counts and its money show up, and
  // the day still reports zero capacity.
  const { branchId } = await seedBranchWithCourts(0)
  const pendingCourtId = await seedCourtWithStatus(branchId, 'pending')
  const player = await seedPlayer()
  await seedBooking({
    branchId,
    courtId: pendingCourtId,
    playerId: player,
    startsAt: manilaHour('2026-09-24', 9),
    hours: 2,
  })
  const days = await getOwnerMonthCalendar([branchId], [branchId], '2026-09')
  const day = days.find((d) => d.date === '2026-09-24')!
  expect(day.bookingCount).toBe(1)
  expect(day.grossCentavos).toBeGreaterThan(0)
  expect(day.netCentavos).toBeGreaterThan(0)
  expect(day.capacityHours).toBe(0)
  expect(day.bookedHours).toBe(0)
  expect(day.occupancyPct).toBeNull()
})
