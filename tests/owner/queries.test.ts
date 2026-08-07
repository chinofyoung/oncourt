import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  seedBlock,
  seedBooking,
  seedBranchWithCourts,
  seedOwner,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'
import {
  getOwnerBookings,
  getOwnerEarnings,
  getOwnerOverview,
  getScheduleCourts,
} from '@/lib/owner/queries'
import type { OwnerEarningsRow } from '@/lib/owner/queries'

/**
 * The universal balance identity for the earnings table's four displayed
 * columns: gross = platform fee + processor fee + net. This holds
 * per-booking for all three bearers (platform/owner/player) now that the
 * processor fee column reports what the owner actually paid — 0 when the
 * platform bears the fee (it already came out of the platform's own
 * retained margin, never out of gross or net), and the raw
 * processor_fee_centavos otherwise. Since every term is a plain SQL sum with
 * no per-bearer subtraction baked in, the identity survives aggregation
 * across a row summing a MIXED set of bearers too — unlike the old
 * platformRetainedCentavos-based check this replaces, which required every
 * booking in `row` to share one bearer.
 */
function expectBalances(row: OwnerEarningsRow) {
  expect(row.grossCentavos).toBe(
    row.platformFeeCentavos + row.processorFeeCentavos + row.netCentavos,
  )
}

afterAll(teardownFixtures)

/** A Manila-local instant on a given YYYY-MM-DD at a given hour. */
function manilaAt(date: string, hour: number) {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+08:00`)
}

/** Today in Manila, matching src/lib/date-manila.ts's manilaToday(). */
function manilaToday() {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
}

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

  const overview = await getOwnerOverview([mine.branchId], today)
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

  const overview = await getOwnerOverview([mine.branchId], manilaToday())
  expect(overview.pendingCourts.map((c) => c.name)).toContain('Court Pending')
})

test('getOwnerOverview reports zero branches without throwing', async () => {
  // An owner who has not created a branch yet. The page renders an empty
  // state for this; the query must not divide by zero computing occupancy.
  // The row is now unused by the query (scoping is by branchIds, not
  // ownerId) but seedOwner() keeps the test's intent legible.
  await seedOwner()

  const overview = await getOwnerOverview([], manilaToday())
  expect(overview.branchCount).toBe(0)
  expect(overview.courts).toEqual([])
  expect(overview.stats.occupancyPct).toBeNull()
  expect(overview.stats.grossCentavos).toBe(0)
})

test('getOwnerBookings filters by day and by branch', async () => {
  const mine = await seedBranchWithCourts(1)
  const other = await seedBranchWithCourts(1)
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

  const all = await getOwnerBookings([mine.branchId, other.branchId], { day: today })
  expect(all).toHaveLength(2)

  const filtered = await getOwnerBookings([mine.branchId, other.branchId], {
    day: today,
    branchId: mine.branchId,
  })
  expect(filtered).toHaveLength(1)
  expect(filtered[0].startHour).toBe(9)
})

test('getOwnerBookings carries each row\'s branchId, for per-row page-level gating', async () => {
  // Final whole-branch review fix #2: the page used to gate money/Unblock
  // all-or-nothing across the whole scope because this row shape had no
  // branch id to gate on per-row. Pinning the field itself here.
  const mine = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const today = manilaToday()

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 8),
  })

  const rows = await getOwnerBookings([mine.branchId], { day: today })
  expect(rows).toHaveLength(1)
  expect(rows[0].branchId).toBe(mine.branchId)
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

  const rows = await getOwnerBookings([mine.branchId], { day: today })
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

  const earnings = await getOwnerEarnings([mine.branchId], month)
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
  expect(earnings.totals.processorFeeCentavos).toBe(
    earnings.rows.reduce((sum, r) => sum + r.processorFeeCentavos, 0),
  )
  // Both seeded bookings above use seedBooking()'s default 'platform' bearer
  // (and so its default processorFeeCentavos of 0), so this particular
  // assertion reduces to the old gross = net + platformFee as a special case
  // of the universal identity.
  expectBalances(row!)
})

test("getOwnerEarnings balances gross/net/platform fee/processor fee for a non-platform bearer", async () => {
  // The defect this follow-up fixes: gross === net + platformFee held only
  // because processor_fee_centavos was always 0 in every seeded booking. A
  // player-bears booking (the GCash example from the task: ₱1,000 court fee,
  // ₱22.81 processor fee grossed onto the player) makes that false — gross
  // includes the processor fee the player paid on top of the court fee, so
  // the true identity needs the processor fee column too.
  const mine = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const today = manilaToday()
  const month = today.slice(0, 7)

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 19),
    totalCentavos: 100000,
    bearer: 'player',
    processorFeeCentavos: 2281,
  })

  const earnings = await getOwnerEarnings([mine.branchId], month)
  const row = earnings.rows.find((r) => r.branchId === mine.branchId)!
  expect(row.processorFeeCentavos).toBe(2281)
  // Gross includes the grossed-up processor fee: ₱1,022.81, not ₱1,000.
  expect(row.grossCentavos).toBe(102281)
  // The player bearer leaves owner_net untouched by the processor fee — only
  // the platform fee comes out of it.
  expect(row.netCentavos).toBe(100000 - 10000)
  expectBalances(row)
})

test('getOwnerEarnings reports zero processor fee for the owner when the platform bears it, not the raw fee', async () => {
  // The bug this follow-up exists to fix: for the 'platform' bearer (the
  // schema default), the processor fee already came out of the platform's
  // own retained margin (platformFee - processorFee) — it was never carved
  // out of gross or out of the owner's net. Showing the raw
  // processor_fee_centavos next to the raw platform_fee_centavos
  // double-counts it, so gross stops equaling
  // platformFee + processorFee + net. The fix is for this column to report
  // what the OWNER actually paid: 0 for 'platform'. This assertion is
  // expected to FAIL against the current, unfixed getOwnerEarnings, which
  // still sums the raw column.
  const mine = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const today = manilaToday()
  const month = today.slice(0, 7)

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 8),
    totalCentavos: 100000,
    // bearer defaults to 'platform'.
    processorFeeCentavos: 2281,
  })

  const earnings = await getOwnerEarnings([mine.branchId], month)
  const row = earnings.rows.find((r) => r.branchId === mine.branchId)!
  expect(row.grossCentavos).toBe(100000)
  expect(row.platformFeeCentavos).toBe(10000)
  expect(row.netCentavos).toBe(90000)
  // The owner-actually-paid semantics: 0, not the raw 2281.
  expect(row.processorFeeCentavos).toBe(0)
  expectBalances(row)
})

test('getOwnerEarnings reports the raw processor fee when the owner bears it', async () => {
  // The 'owner' bearer is a real cost the owner incurred, so — unlike
  // 'platform' above — the raw column is exactly what should be displayed.
  const mine = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const today = manilaToday()
  const month = today.slice(0, 7)

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 9),
    totalCentavos: 100000,
    bearer: 'owner',
    processorFeeCentavos: 2281,
  })

  const earnings = await getOwnerEarnings([mine.branchId], month)
  const row = earnings.rows.find((r) => r.branchId === mine.branchId)!
  expect(row.grossCentavos).toBe(100000)
  expect(row.platformFeeCentavos).toBe(10000)
  // The processor fee comes out of owner_net for this bearer.
  expect(row.netCentavos).toBe(100000 - 10000 - 2281)
  expect(row.processorFeeCentavos).toBe(2281)
  expectBalances(row)
})

// The 'player' bearer's own exact-value + identity coverage already exists
// above ("balances gross/net/platform fee/processor fee for a non-platform
// bearer"), completing the one-test-per-bearer set without duplicating it.

test('getOwnerEarnings balances the aggregate row across a mixed set of bearers in one branch/month', async () => {
  // New coverage the old, single-bearer-only expectBalances() could not
  // express: two bookings in the same branch/month with DIFFERENT bearers,
  // summed into one row. Because the universal identity
  // (gross = platformFee + processorFee + net) is a plain sum with no
  // per-bearer subtraction, it must hold on the aggregate even though the
  // rows behind it disagree on who bears the processor fee.
  const mine = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const today = manilaToday()
  const month = today.slice(0, 7)

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 10),
    totalCentavos: 100000,
    // bearer defaults to 'platform'.
    processorFeeCentavos: 2281,
  })
  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 11),
    totalCentavos: 50000,
    bearer: 'owner',
    processorFeeCentavos: 1500,
  })

  const earnings = await getOwnerEarnings([mine.branchId], month)
  const row = earnings.rows.find((r) => r.branchId === mine.branchId)!
  expect(row.bookingCount).toBe(2)
  expectBalances(row)
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

  const earnings = await getOwnerEarnings([mine.branchId], month)
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

  const rows = await getOwnerBookings([mine.branchId], { day: today })
  expect(rows).toHaveLength(1)
  expect(rows[0].startHour).toBe(23)
  expect(rows[0].endHour).toBe(24)
})

test('a block appears on the day grid, labelled by its note', async () => {
  // The forward note from the dashboards slice: the profiles join was INNER,
  // so a blocked row (player_id null) was silently dropped and the grid showed
  // the slot as free while the exclusion constraint refused every booking on
  // it — the worst possible failure, because it is invisible.
  const mine = await seedBranchWithCourts(1)
  const today = manilaToday()

  await seedBlock({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    createdBy: mine.ownerId,
    startsAt: manilaAt(today, 11),
    hours: 2,
    note: 'Resurfacing',
  })

  const overview = await getOwnerOverview([mine.branchId], today)
  expect(overview.todaysBookings).toHaveLength(1)
  expect(overview.todaysBookings[0]).toMatchObject({
    startHour: 11,
    endHour: 13,
    label: 'Resurfacing',
    isBlock: true,
    note: 'Resurfacing',
  })
})

test('a block with no note falls back to the label "Blocked"', async () => {
  const mine = await seedBranchWithCourts(1)
  const today = manilaToday()

  await seedBlock({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    createdBy: mine.ownerId,
    startsAt: manilaAt(today, 13),
  })

  const overview = await getOwnerOverview([mine.branchId], today)
  expect(overview.todaysBookings[0].label).toBe('Blocked')
  expect(overview.todaysBookings[0].note).toBeNull()
})

test('a whitespace-only note still falls back to "Blocked"', async () => {
  // nullif(btrim(note), '') — a blank grid cell reads as a rendering bug.
  const mine = await seedBranchWithCourts(1)
  const today = manilaToday()

  await seedBlock({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    createdBy: mine.ownerId,
    startsAt: manilaAt(today, 14),
    note: '   ',
  })

  const overview = await getOwnerOverview([mine.branchId], today)
  expect(overview.todaysBookings[0].label).toBe('Blocked')
})

test('a tab/newline-only note still falls back to "Blocked"', async () => {
  // btrim(note) with no explicit character set trims only the space
  // character, not tabs or newlines — the existing whitespace-only test above
  // only seeds plain spaces and would pass even with that one-arg defect.
  // This seeds a note that is whitespace but NOT solely spaces, which the
  // one-arg btrim leaves as "\n\t" instead of collapsing to null.
  const mine = await seedBranchWithCourts(1)
  const today = manilaToday()

  await seedBlock({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    createdBy: mine.ownerId,
    startsAt: manilaAt(today, 15),
    note: '   \n\t ',
  })

  const overview = await getOwnerOverview([mine.branchId], today)
  expect(overview.todaysBookings[0].label).toBe('Blocked')
})

test('blocks are excluded from gross, net, the weekly booking count, and occupancy', async () => {
  // The status story: SCHEDULE_ROW for the grid, REAL_BOOKING for every number
  // beside it. A resurfacing block reading as revenue or as occupancy would be
  // the dashboard lying about the business.
  const mine = await seedBranchWithCourts(2)
  const player = await seedPlayer()
  const today = manilaToday()

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 15),
    status: 'confirmed',
    totalCentavos: 50000,
  })
  await seedBlock({
    courtId: mine.courtIds[1],
    branchId: mine.branchId,
    createdBy: mine.ownerId,
    startsAt: manilaAt(today, 15),
    hours: 4,
    note: 'Repainting lines',
  })

  const overview = await getOwnerOverview([mine.branchId], today)
  // Both rows are on the schedule…
  expect(overview.todaysBookings).toHaveLength(2)
  // …and only the paid one is in any number.
  expect(overview.stats.grossCentavos).toBe(50000)
  expect(overview.stats.netCentavos).toBe(50000 - 5000)
  expect(overview.stats.bookingsThisWeek).toBe(1)
  // 1 booked hour over the two courts' operating hours for the day. The
  // block's 4 hours are NOT in the numerator.
  const perCourtHours = 24 - 11
  expect(overview.stats.occupancyPct).toBe(Math.round((1 / (perCourtHours * 2)) * 100))
})

test('getOwnerBookings lists blocks alongside bookings, with zero money', async () => {
  const mine = await seedBranchWithCourts(2)
  const player = await seedPlayer()
  const today = manilaToday()

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 16),
    status: 'confirmed',
    totalCentavos: 40000,
  })
  await seedBlock({
    courtId: mine.courtIds[1],
    branchId: mine.branchId,
    createdBy: mine.ownerId,
    startsAt: manilaAt(today, 16),
    note: 'Walk-in — Juan',
  })

  const rows = await getOwnerBookings([mine.branchId], { day: today })
  expect(rows).toHaveLength(2)
  const block = rows.find((row) => row.isBlock)!
  expect(block.label).toBe('Walk-in — Juan')
  expect(block.status).toBe('blocked')
  expect(block.totalChargedCentavos).toBe(0)
  expect(block.ownerNetCentavos).toBe(0)
  const booking = rows.find((row) => !row.isBlock)!
  expect(booking.totalChargedCentavos).toBe(40000)
})

test('getOwnerEarnings ignores blocks entirely', async () => {
  const mine = await seedBranchWithCourts(2)
  const player = await seedPlayer()
  const today = manilaToday()
  const month = today.slice(0, 7)

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 17),
    status: 'confirmed',
    totalCentavos: 80000,
  })
  await seedBlock({
    courtId: mine.courtIds[1],
    branchId: mine.branchId,
    createdBy: mine.ownerId,
    startsAt: manilaAt(today, 17),
    hours: 3,
  })

  const earnings = await getOwnerEarnings([mine.branchId], month)
  const row = earnings.rows.find((r) => r.branchId === mine.branchId)!
  expect(row.grossCentavos).toBe(80000)
  // The block contributes no row and no count — not a ₱0 row inflating the
  // booking count.
  expect(row.bookingCount).toBe(1)
  expect(earnings.totals.bookingCount).toBe(1)
})

test('a branch id not in the scope list is invisible, even under the same owner', async () => {
  // This is the staff-scoping guarantee: a front-desk person granted one
  // branch must not read another, and the filter is in SQL, never in
  // TypeScript after the fetch.
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  await db.execute(
    sql`update branches set owner_id = ${first.ownerId}::uuid where id = ${second.branchId}::uuid`,
  )
  const player = await seedPlayer()
  const today = manilaToday()

  await seedBooking({
    courtId: second.courtIds[0],
    branchId: second.branchId,
    playerId: player,
    startsAt: manilaAt(today, 18),
    status: 'confirmed',
    totalCentavos: 90000,
  })

  const scoped = await getOwnerOverview([first.branchId], today)
  expect(scoped.branchCount).toBe(1)
  expect(scoped.todaysBookings).toEqual([])
  expect(scoped.stats.grossCentavos).toBe(0)

  const bookings = await getOwnerBookings([first.branchId], { day: today })
  expect(bookings).toEqual([])
})

test('an empty scope list returns empty results without a SQL error', async () => {
  // A player with no grants never reaches these queries (requireDashboardPage
  // redirects them), but an owner with zero branches does. `= any ('{}')` must
  // be a clean no-match, not a cast failure or a division by zero.
  const today = manilaToday()

  const overview = await getOwnerOverview([], today)
  expect(overview.branchCount).toBe(0)
  expect(overview.courts).toEqual([])
  expect(overview.todaysBookings).toEqual([])
  expect(overview.stats.occupancyPct).toBeNull()
  expect(overview.stats.grossCentavos).toBe(0)

  await expect(getOwnerBookings([], { day: today })).resolves.toEqual([])
  const earnings = await getOwnerEarnings([], today.slice(0, 7))
  expect(earnings.rows).toEqual([])
  expect(earnings.totals.grossCentavos).toBe(0)
})

test('getScheduleCourts lists approved courts across the scoped branches only', async () => {
  const mine = await seedBranchWithCourts(2)
  const theirs = await seedBranchWithCourts(1)
  await db.execute(sql`
    insert into courts (branch_id, name, environment, status)
    values (${mine.branchId}::uuid, 'Court Pending', 'outdoor', 'pending')
  `)

  const courts = await getScheduleCourts([mine.branchId])
  const names = courts.map((c) => c.courtName)
  expect(names).toEqual(['Court 1', 'Court 2'])
  // A pending court has no column in the grid and must not be offerable as a
  // block target either — the block writer rejects it too (Task 8).
  expect(names).not.toContain('Court Pending')
  expect(courts.map((c) => c.courtId)).not.toContain(theirs.courtIds[0])
})
