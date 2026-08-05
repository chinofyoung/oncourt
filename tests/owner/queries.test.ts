import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBooking, seedBranchWithCourts, seedPlayer, teardownFixtures } from '../helpers/fixtures'
import { getOwnerBookings, getOwnerBranches, getOwnerEarnings, getOwnerOverview } from '@/lib/owner/queries'

afterAll(teardownFixtures)

/** A Manila-local instant on a given YYYY-MM-DD at a given hour. */
function manilaAt(date: string, hour: number) {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+08:00`)
}

/** Today in Manila, matching src/lib/date-manila.ts's manilaToday(). */
function manilaToday() {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
}

test('getOwnerBranches returns only branches the caller owns', async () => {
  const mine = await seedBranchWithCourts(1)
  const theirs = await seedBranchWithCourts(1)

  const branches = await getOwnerBranches(mine.ownerId)
  const ids = branches.map((b) => b.id)
  expect(ids).toContain(mine.branchId)
  expect(ids).not.toContain(theirs.branchId)
})

test('getOwnerOverview counts only the caller\'s bookings and excludes holds', async () => {
  const mine = await seedBranchWithCourts(2)
  const theirs = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const today = manilaToday()

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 12),
    totalCentavos: 50000,
  })
  // A hold on the caller's own court: must not appear in the grid or stats.
  await seedBooking({
    courtId: mine.courtIds[1],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 14),
    status: 'pending_payment',
  })
  // Another owner's booking: must not leak in.
  await seedBooking({
    courtId: theirs.courtIds[0],
    branchId: theirs.branchId,
    playerId: player,
    startsAt: manilaAt(today, 16),
    totalCentavos: 99000,
  })

  const overview = await getOwnerOverview(mine.ownerId, today)
  expect(overview.branchCount).toBe(1)
  expect(overview.todaysBookings).toHaveLength(1)
  expect(overview.todaysBookings[0].startHour).toBe(12)
  expect(overview.stats.grossCentavos).toBe(50000)
  expect(overview.stats.netCentavos).toBe(50000 - 5000)
  expect(typeof overview.stats.grossCentavos).toBe('number')
})

test('getOwnerOverview lists pending courts awaiting approval', async () => {
  const mine = await seedBranchWithCourts(1)
  await db.execute(sql`
    insert into courts (branch_id, name, environment, status)
    values (${mine.branchId}::uuid, 'Court Pending', 'outdoor', 'pending')
  `)

  const overview = await getOwnerOverview(mine.ownerId, manilaToday())
  expect(overview.pendingCourts.map((c) => c.name)).toContain('Court Pending')
})

test('getOwnerOverview reports zero branches without throwing', async () => {
  // An owner who has not created a branch yet. The page renders an empty
  // state for this; the query must not divide by zero computing occupancy.
  const ownerId = await seedPlayer()
  await db.execute(sql`update profiles set role = 'owner' where id = ${ownerId}::uuid`)

  const overview = await getOwnerOverview(ownerId, manilaToday())
  expect(overview.branchCount).toBe(0)
  expect(overview.courts).toEqual([])
  expect(overview.stats.occupancyPct).toBeNull()
  expect(overview.stats.grossCentavos).toBe(0)
})

test('getOwnerBookings filters by day and by branch', async () => {
  const mine = await seedBranchWithCourts(1)
  const other = await seedBranchWithCourts(1)
  // Put the second branch under the same owner so the branch filter is
  // actually exercised rather than the ownership filter.
  await db.execute(
    sql`update branches set owner_id = ${mine.ownerId}::uuid where id = ${other.branchId}::uuid`,
  )
  const player = await seedPlayer()
  const today = manilaToday()

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 9),
  })
  await seedBooking({
    courtId: other.courtIds[0],
    branchId: other.branchId,
    playerId: player,
    startsAt: manilaAt(today, 10),
  })

  const all = await getOwnerBookings(mine.ownerId, { day: today })
  expect(all).toHaveLength(2)

  const filtered = await getOwnerBookings(mine.ownerId, { day: today, branchId: mine.branchId })
  expect(filtered).toHaveLength(1)
  expect(filtered[0].startHour).toBe(9)
})

test('getOwnerBookings excludes a pending_payment hold on the same owner/day', async () => {
  const mine = await seedBranchWithCourts(2)
  const player = await seedPlayer()
  const today = manilaToday()

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 10),
  })
  // A hold, not a real booking: the management list must not surface it.
  await seedBooking({
    courtId: mine.courtIds[1],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 13),
    status: 'pending_payment',
  })

  const rows = await getOwnerBookings(mine.ownerId, { day: today })
  expect(rows).toHaveLength(1)
  expect(rows.some((r) => r.status === 'pending_payment')).toBe(false)
})

test('getOwnerEarnings per-branch rows sum to the reported totals', async () => {
  const mine = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const today = manilaToday()
  const month = today.slice(0, 7)

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 20),
    totalCentavos: 40000,
  })
  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 21),
    totalCentavos: 60000,
  })

  const earnings = await getOwnerEarnings(mine.ownerId, month)
  const row = earnings.rows.find((r) => r.branchId === mine.branchId)
  expect(row).toBeDefined()
  expect(row!.grossCentavos).toBe(100000)
  expect(row!.bookingCount).toBe(2)
  // The invariant that matters: the rollup is the sum of its parts.
  expect(earnings.totals.grossCentavos).toBe(
    earnings.rows.reduce((sum, r) => sum + r.grossCentavos, 0),
  )
  expect(earnings.totals.netCentavos).toBe(
    earnings.rows.reduce((sum, r) => sum + r.netCentavos, 0),
  )
  // gross = net + platform fee, per row, with no float drift.
  expect(row!.grossCentavos).toBe(row!.netCentavos + row!.platformFeeCentavos)
})

test('getOwnerEarnings excludes expired and refunded bookings', async () => {
  const mine = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const today = manilaToday()
  const month = today.slice(0, 7)

  const bookingId = await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 22),
    totalCentavos: 70000,
  })
  await db.execute(
    sql`update bookings set status = 'refunded_manual' where id = ${bookingId}::uuid`,
  )

  const earnings = await getOwnerEarnings(mine.ownerId, month)
  const row = earnings.rows.find((r) => r.branchId === mine.branchId)
  expect(row?.grossCentavos ?? 0).toBe(0)
})

test('getOwnerBookings reports a booking ending at midnight as hour 24, not 0', async () => {
  // 23:00-24:00 is the last bookable hour of a Manila day. Its `ends_at`
  // lands exactly on the next calendar day's midnight, so a naive
  // extract(hour from ...) reads 0 instead of 24 — corrupting this row to
  // (startHour: 23, endHour: 0).
  const mine = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const today = manilaToday()

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 23),
  })

  const rows = await getOwnerBookings(mine.ownerId, { day: today })
  expect(rows).toHaveLength(1)
  expect(rows[0].startHour).toBe(23)
  expect(rows[0].endHour).toBe(24)
})
