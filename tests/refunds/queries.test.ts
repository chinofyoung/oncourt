import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { findRefundCandidates, getFlaggedRefundCount, getFlaggedRefunds } from '@/lib/refunds/queries'
import { recordPaymentRefund } from '@/lib/refunds/write'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedPayment,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

async function playerEmail(playerId: string) {
  const result = await db.execute(sql`select email from profiles where id = ${playerId}::uuid`)
  return result.rows[0].email as string
}

test('the flagged queue returns only needs_refund payments, and drops them once recorded', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-04-02', 12), status: 'confirmed',
  })
  const flagged = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  await db.execute(sql`update payments set needs_refund = true where id = ${flagged}::uuid`)

  const before = await getFlaggedRefunds()
  const mine = before.find((c) => c.bookingId === bookingId)
  expect(mine).toBeDefined()
  expect(mine?.payments.some((p) => p.paymentId === flagged && p.needsRefund)).toBe(true)
  expect(mine?.branchName).toBe('Fixture Branch')
  expect(mine?.courtName).toBe('Court 1')
  expect(mine?.playerEmail).toBe(await playerEmail(playerId))

  await recordPaymentRefund(flagged, 'done')
  const after = await getFlaggedRefunds()
  expect(after.find((c) => c.bookingId === bookingId)).toBeUndefined()
})

test('lookup matches by player email, case-insensitively', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-04-03', 12), status: 'completed',
  })
  await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })

  const email = await playerEmail(playerId)
  const found = await findRefundCandidates(email.toUpperCase())
  expect(found.map((c) => c.bookingId)).toContain(bookingId)
  expect(found[0].payments).toHaveLength(1)
})

test('lookup matches by booking id', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-04-04', 12), status: 'completed',
  })
  await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })

  const found = await findRefundCandidates(bookingId)
  expect(found).toHaveLength(1)
  expect(found[0].bookingId).toBe(bookingId)
})

test('a non-uuid, non-matching query returns nothing rather than throwing 22P02', async () => {
  expect(await findRefundCandidates('not-a-uuid-or-an-email')).toEqual([])
  expect(await findRefundCandidates('   ')).toEqual([])
})

test('a booking with no payments still returns, with an empty payments list', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-04-05', 12), status: 'completed',
  })

  const found = await findRefundCandidates(bookingId)
  expect(found).toHaveLength(1)
  expect(found[0].payments).toEqual([])
})

test('the flagged count tracks the queue', async () => {
  const before = await getFlaggedRefundCount()

  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-04-06', 12), status: 'confirmed',
  })
  const paymentId = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  await db.execute(sql`update payments set needs_refund = true where id = ${paymentId}::uuid`)

  expect(await getFlaggedRefundCount()).toBe(before + 1)
  await recordPaymentRefund(paymentId, 'done')
  expect(await getFlaggedRefundCount()).toBe(before)
})

test('the flagged count counts bookings, not payments', async () => {
  // The badge sits above a queue that renders ONE CARD PER BOOKING. A double
  // charge flags two payments on one booking; counting payments would badge
  // "2" over a single card.
  const before = await getFlaggedRefundCount()

  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-04-07', 12), status: 'confirmed',
  })
  const first = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  const second = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  await db.execute(sql`
    update payments set needs_refund = true where id = any (array[${first}::uuid, ${second}::uuid])
  `)

  expect(await getFlaggedRefundCount()).toBe(before + 1)
  expect(await getFlaggedRefunds()).toContainEqual(
    expect.objectContaining({ bookingId }),
  )

  // Clearing one of the two leaves the booking still in the queue, and the
  // badge still at +1 — not back to `before`.
  await recordPaymentRefund(second, 'the duplicate')
  expect(await getFlaggedRefundCount()).toBe(before + 1)
  await recordPaymentRefund(first, 'and the original')
  expect(await getFlaggedRefundCount()).toBe(before)
})
