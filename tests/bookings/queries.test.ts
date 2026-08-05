import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBlock, seedBooking, seedBranchWithCourts, seedPlayer, teardownFixtures } from '../helpers/fixtures'
import { getBookingReceipt, getPlayerDashboard } from '@/lib/bookings/queries'

afterAll(teardownFixtures)

// A fixed past date well clear of the seeded demo bookings (2026-06-01..03)
// and of "now", so upcoming/past classification is unambiguous.
function pastAt(dayOffset: number, hour: number) {
  const d = new Date(Date.UTC(2026, 4, 10 + dayOffset, hour - 8, 0, 0)) // Manila hour
  return d
}
function futureAt(dayOffset: number, hour: number) {
  const base = new Date(Date.now() + dayOffset * 86_400_000)
  const iso = base.toISOString().slice(0, 10)
  return new Date(`${iso}T${String(hour).padStart(2, '0')}:00:00+08:00`)
}

/**
 * A [start, end] window for a booking that has already ended (as of `now`)
 * and started within the *current* Manila calendar month, sized to
 * `wantedHours` — except that it shrinks, rather than drifting into the
 * previous month, when fewer than `wantedHours` (plus a safety buffer) have
 * actually elapsed since Manila midnight on the 1st of this month. That only
 * matters in the first few hours of a new month; every other time this runs,
 * `durationMs` equals `wantedHours` exactly.
 *
 * This is what makes the fixture correct at ANY real run instant, including
 * the first minutes of a new month: `end` is clamped to `now - buffer`, so it
 * is always already-ended, and `start` is clamped to never precede the
 * current Manila month's start, so it can never be mistaken for last month's
 * time. `hours` is derived from the same two clamped instants the fixture
 * actually uses, so the caller's expectation and the fixture's real duration
 * can never disagree.
 */
function thisMonthPlayedWindow(wantedHours: number) {
  const bufferMs = 2 * 60_000
  const nowMs = Date.now()
  const manilaNowWall = new Date(nowMs + 8 * 3_600_000) // Manila wall-clock, read via UTC getters
  const monthStartMs =
    Date.UTC(manilaNowWall.getUTCFullYear(), manilaNowWall.getUTCMonth(), 1) - 8 * 3_600_000
  const end = nowMs - bufferMs
  const start = Math.max(monthStartMs, end - wantedHours * 3_600_000)
  const hours = Math.round((end - start) / 3_600_000)
  return { start: new Date(start), end: new Date(end), hours }
}

test('returns only the calling player\'s bookings', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const mine = await seedPlayer()
  const theirs = await seedPlayer()

  await seedBooking({ courtId: courtIds[0], branchId, playerId: mine, startsAt: pastAt(0, 12) })
  await seedBooking({ courtId: courtIds[0], branchId, playerId: theirs, startsAt: pastAt(1, 12) })

  const dashboard = await getPlayerDashboard(mine)
  expect(dashboard.past).toHaveLength(1)
  expect(dashboard.stats.courtsVisited).toBe(1)
})

test('excludes pending_payment holds from every list and every stat', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const player = await seedPlayer()

  await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: futureAt(3, 13),
    status: 'pending_payment',
  })

  const dashboard = await getPlayerDashboard(player)
  expect(dashboard.upcoming).toEqual([])
  expect(dashboard.past).toEqual([])
  expect(dashboard.stats.upcomingCount).toBe(0)
  expect(dashboard.stats.totalSpentCentavos).toBe(0)
})

test('splits upcoming from past by end time, and counts hours and spend', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  const player = await seedPlayer()

  await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: futureAt(2, 19),
    hours: 2,
    status: 'confirmed',
    totalCentavos: 62290,
  })
  await seedBooking({
    courtId: courtIds[1],
    branchId,
    playerId: player,
    startsAt: pastAt(0, 15),
    hours: 1,
    status: 'completed',
    totalCentavos: 28000,
  })

  const dashboard = await getPlayerDashboard(player)
  expect(dashboard.upcoming).toHaveLength(1)
  expect(dashboard.upcoming[0].startHour).toBe(19)
  expect(dashboard.upcoming[0].endHour).toBe(21)
  expect(dashboard.past).toHaveLength(1)
  expect(dashboard.stats.upcomingCount).toBe(1)
  expect(dashboard.stats.courtsVisited).toBe(2)
  expect(dashboard.stats.totalSpentCentavos).toBe(62290 + 28000)
  // Every numeric field must be a number, not a string: the pg driver returns
  // numeric/bigint as strings, and a string here would break arithmetic and
  // formatPeso() silently.
  expect(typeof dashboard.stats.totalSpentCentavos).toBe('number')
  expect(typeof dashboard.stats.hoursPlayedThisMonth).toBe('number')
})

test('flags a past booking that already has a review, and lists the review', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: pastAt(2, 9),
  })

  await db.execute(sql`
    insert into reviews (booking_id, branch_id, player_id, rating, body)
    values (${bookingId}::uuid, ${branchId}::uuid, ${player}::uuid, 5, 'Great court.')
  `)

  const dashboard = await getPlayerDashboard(player)
  expect(dashboard.past[0].hasReview).toBe(true)
  expect(dashboard.reviews).toHaveLength(1)
  expect(dashboard.reviews[0].rating).toBe(5)
})

test('getBookingReceipt returns the fee breakdown for the owning player', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: pastAt(3, 16),
    totalCentavos: 45000,
  })

  const receipt = await getBookingReceipt(bookingId, player)
  expect(receipt).toMatchObject({ id: bookingId, totalChargedCentavos: 45000 })
})

test('getBookingReceipt returns null for another player\'s booking', async () => {
  // Scoped in the SQL where clause, not checked after the fetch: a stranger
  // must not be able to distinguish "not yours" from "does not exist".
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const owner = await seedPlayer()
  const stranger = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: owner,
    startsAt: pastAt(4, 16),
  })

  await expect(getBookingReceipt(bookingId, stranger)).resolves.toBeNull()
})

test('hoursPlayedThisMonth counts only already-played time within the current Manila month', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  const player = await seedPlayer()

  // Already ended, within the current Manila month. thisMonthPlayedWindow()
  // pins the exact expected hour count from the same clamped instants the
  // fixture uses, so it is correct on any real run date/time — including the
  // first minutes of a new month, when there is little or no "already played
  // this month" time to have — not just on days deep into the month.
  const window = thisMonthPlayedWindow(3)
  await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: window.start,
    hours: (window.end.getTime() - window.start.getTime()) / 3_600_000,
    status: 'completed',
  })

  // Already ended too, but in a different Manila month (a fixed May 2026
  // date, always well behind "now" per this file's `pastAt` convention) —
  // this must NOT contribute to hoursPlayedThisMonth. If it did (e.g. the
  // month filter were dropped, or compared in the wrong timezone), the
  // assertion below would see window.hours + 5, not window.hours.
  await seedBooking({
    courtId: courtIds[1],
    branchId,
    playerId: player,
    startsAt: pastAt(10, 10),
    hours: 5,
    status: 'completed',
  })

  const dashboard = await getPlayerDashboard(player)
  expect(dashboard.stats.hoursPlayedThisMonth).toBe(window.hours)
})

test('reports a booking ending at midnight as hour 24, not 0', async () => {
  // 23:00-24:00 is the last bookable hour of a Manila day. Its `ends_at`
  // lands exactly on the next calendar day's midnight, so a naive
  // extract(hour from ...) reads 0 instead of 24 — corrupting this row to
  // (startHour: 23, endHour: 0), which would make the receipt/dashboard's
  // `endHour - startHour` duration go negative.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const player = await seedPlayer()

  await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: pastAt(6, 23),
    status: 'completed',
  })

  const dashboard = await getPlayerDashboard(player)
  expect(dashboard.past).toHaveLength(1)
  expect(dashboard.past[0].startHour).toBe(23)
  expect(dashboard.past[0].endHour).toBe(24)
})

test('a block never appears on any player surface', async () => {
  // The player dashboard filters to confirmed/completed, so this passes today;
  // the test is what keeps it passing. A block has no player_id at all, so
  // "whose booking is this" has no answer — surfacing one on /bookings would
  // render a booking belonging to nobody.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  await seedBlock({
    courtId: courtIds[0],
    branchId,
    createdBy: ownerId,
    startsAt: futureAt(6, 14),
    note: 'Walk-in',
  })

  const dashboard = await getPlayerDashboard(player)
  expect(dashboard.upcoming).toEqual([])
  expect(dashboard.past).toEqual([])
  expect(dashboard.stats.upcomingCount).toBe(0)
  expect(dashboard.stats.totalSpentCentavos).toBe(0)
})
