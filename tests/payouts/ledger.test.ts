import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  getBranchesOwnerId,
  getOwnerLedger,
  getOwnerPayouts,
  getPayablePool,
} from '@/lib/payouts/ledger'
import { preparePayout } from '@/lib/payouts/write'
import {
  manilaHour,
  seedBlock,
  seedBooking,
  seedBranchWithCourts,
  seedPayout,
  seedPayoutLine,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

/**
 * seedBooking's default pricing: total 30000, platform fee 10% = 3000, so
 * owner_net = 27000 on the default 'platform' bearer. Named here because
 * every expectation below is a multiple of it.
 */
const NET = 27000

test('completed bookings with no payout line are what is owed', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-02', 12), status: 'completed',
  })
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-02', 14), status: 'completed',
  })

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(NET * 2)
  expect(ledger?.payableBookingCount).toBe(2)
  expect(ledger?.preparedCentavos).toBe(0)
  expect(ledger?.paidCentavos).toBe(0)
})

test('a stamped booking leaves the payable pool', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const stamped = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-03', 12), status: 'completed',
  })
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-03', 14), status: 'completed',
  })

  const payoutId = await seedPayout({ ownerId, netCentavos: NET })
  await seedPayoutLine({ payoutId, bookingId: stamped, kind: 'payment', netCentavos: NET })

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(NET)
  expect(ledger?.payableBookingCount).toBe(1)
  // Prepared, not paid: seedPayout defaults to status 'pending'.
  expect(ledger?.preparedCentavos).toBe(NET)
  expect(ledger?.paidCentavos).toBe(0)

  const pool = await getPayablePool(ownerId)
  expect(pool).toHaveLength(1)
  expect(pool[0].bookingId).not.toBe(stamped)
})

test('only completed bookings are payable — never confirmed, held, expired, or blocked', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  for (const [hour, status] of [
    [12, 'confirmed'], [14, 'pending_payment'], [16, 'expired'], [18, 'refunded_manual'],
  ] as const) {
    await seedBooking({
      courtId: courtIds[0], branchId, playerId,
      startsAt: manilaHour('2026-07-04', hour), status,
    })
  }
  // complete_past_bookings() only ever moves confirmed -> completed, so a
  // block can never reach the pool. Pinned here so a future change to that
  // cron cannot silently start paying owners for their own walk-ins.
  await seedBlock({
    courtId: courtIds[0], branchId, createdBy: ownerId,
    startsAt: manilaHour('2026-07-04', 20),
  })

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(0)
  expect(ledger?.payableBookingCount).toBe(0)
})

test('a booking refunded BEFORE payout is simply absent — no clawback', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-05', 12), status: 'refunded_manual',
  })

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(0)
  expect(ledger?.clawbackBookingCount).toBe(0)
})

test('a booking refunded AFTER payout becomes a negative adjustment', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const paid = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-06', 12), status: 'completed',
  })
  const payoutId = await seedPayout({ ownerId, netCentavos: NET, status: 'paid' })
  await seedPayoutLine({ payoutId, bookingId: paid, kind: 'payment', netCentavos: NET })

  await db.execute(sql`
    update bookings set status = 'refunded_manual' where id = ${paid}::uuid
  `)

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(-NET)
  expect(ledger?.clawbackBookingCount).toBe(1)
  expect(ledger?.paidCentavos).toBe(NET)
})

test('a booking already clawed back does not adjust twice', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const booking = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-07', 12), status: 'completed',
  })
  const first = await seedPayout({ ownerId, netCentavos: NET, status: 'paid' })
  await seedPayoutLine({ payoutId: first, bookingId: booking, kind: 'payment', netCentavos: NET })
  await db.execute(sql`
    update bookings set status = 'refunded_manual' where id = ${booking}::uuid
  `)
  const second = await seedPayout({ ownerId, netCentavos: 1 })
  await seedPayoutLine({ payoutId: second, bookingId: booking, kind: 'clawback', netCentavos: -NET })

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(0)
  expect(ledger?.clawbackBookingCount).toBe(0)
})

test('getOwnerPayouts returns lines, and flags a line whose booking was since refunded', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const good = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-08', 12), status: 'completed',
  })
  const gone = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-08', 14), status: 'completed',
  })
  const payoutId = await seedPayout({ ownerId, netCentavos: NET * 2 })
  await seedPayoutLine({ payoutId, bookingId: good, kind: 'payment', netCentavos: NET })
  await seedPayoutLine({ payoutId, bookingId: gone, kind: 'payment', netCentavos: NET })
  await db.execute(sql`update bookings set status = 'refunded_manual' where id = ${gone}::uuid`)

  const payouts = await getOwnerPayouts(ownerId)
  expect(payouts).toHaveLength(1)
  expect(payouts[0].lines).toHaveLength(2)
  expect(payouts[0].lines.find((l) => l.bookingId === gone)?.bookingRefunded).toBe(true)
  expect(payouts[0].lines.find((l) => l.bookingId === good)?.bookingRefunded).toBe(false)
  expect(payouts[0].lines[0].bookedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(payouts[0].lines[0].courtName).toBe('Court 1')
})

test('an owner with nothing has a zeroed ledger, not a missing one', async () => {
  const { ownerId } = await seedBranchWithCourts(1)
  const ledger = await getOwnerLedger(ownerId)
  expect(ledger).not.toBeNull()
  expect(ledger?.owedCentavos).toBe(0)
  expect(ledger?.preparedCentavos).toBe(0)
  expect(ledger?.paidCentavos).toBe(0)
  expect(await getPayablePool(ownerId)).toEqual([])
})

test('every money field is a number, not a bigint string', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-09', 12), status: 'completed',
  })
  const ledger = await getOwnerLedger(ownerId)
  expect(typeof ledger?.owedCentavos).toBe('number')
  expect(typeof ledger?.preparedCentavos).toBe('number')
  expect(typeof ledger?.paidCentavos).toBe('number')
})

test('getBranchesOwnerId resolves one owner, and refuses to guess across two', async () => {
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)

  expect(await getBranchesOwnerId([first.branchId])).toBe(first.ownerId)
  expect(await getBranchesOwnerId([])).toBeNull()
  expect(await getBranchesOwnerId([first.branchId, second.branchId])).toBeNull()
})

test('a completed manual booking is owed nothing, previewed nowhere, and paid never', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2027-07-01', 12),
    status: 'completed',
  })
  await db.execute(sql`
    update bookings set payment_mode = 'manual', platform_fee_centavos = 0,
      owner_net_centavos = court_fee_centavos
    where id = ${bookingId}::uuid
  `)

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(0)
  expect(ledger?.payableBookingCount).toBe(0)

  expect(await getPayablePool(ownerId)).toEqual([])

  expect(await preparePayout(ownerId)).toEqual({ ok: false, reason: 'nothing_to_pay' })
})

test('an automated booking beside a manual one is still paid', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  const manualId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2027-07-02', 12),
    status: 'completed',
  })
  await db.execute(
    sql`update bookings set payment_mode = 'manual' where id = ${manualId}::uuid`,
  )
  await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2027-07-02', 14),
    status: 'completed',
  })

  const pool = await getPayablePool(ownerId)
  expect(pool).toHaveLength(1)
  expect(pool[0].bookingId).not.toBe(manualId)
})

test('a refunded manual booking produces no clawback', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2027-07-03', 12),
    status: 'refunded_manual',
  })
  await db.execute(
    sql`update bookings set payment_mode = 'manual' where id = ${bookingId}::uuid`,
  )

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.clawbackBookingCount).toBe(0)
  expect(ledger?.owedCentavos).toBe(0)
})
