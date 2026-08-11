import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { getOwnerLedger, getOwnerPayouts } from '@/lib/payouts/ledger'
import { markPayoutPaid, preparePayout } from '@/lib/payouts/write'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

const NET = 27000
const GROSS = 30000

test('prepare stamps exactly the payable set and locks the amount', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-02', 12), status: 'completed',
  })
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-05', 14), status: 'completed',
  })

  const result = await preparePayout(ownerId)
  expect(result).toMatchObject({ ok: true, netCentavos: NET * 2, lineCount: 2 })

  // The pool is now empty — those bookings are spoken for.
  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(0)
  expect(ledger?.preparedCentavos).toBe(NET * 2)
  expect(ledger?.paidCentavos).toBe(0)

  const [payout] = await getOwnerPayouts(ownerId)
  expect(payout.status).toBe('pending')
  expect(payout.grossCentavos).toBe(GROSS * 2)
  expect(payout.feeCentavos).toBe(GROSS * 2 - NET * 2)
  expect(payout.lines.every((l) => l.kind === 'payment' && l.netCentavos > 0)).toBe(true)
  // Period comes from the payment lines' Manila dates.
  expect(payout.periodStart).toBe('2026-06-02')
  expect(payout.periodEnd).toBe('2026-06-05')
})

test('prepare writes nothing when there is nothing to pay', async () => {
  const { ownerId } = await seedBranchWithCourts(1)
  expect(await preparePayout(ownerId)).toEqual({ ok: false, reason: 'nothing_to_pay' })
  expect(await getOwnerPayouts(ownerId)).toEqual([])
})

test('an outstanding clawback becomes a negative line on the next payout', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const first = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-10', 12), status: 'completed',
  })
  const prepared = await preparePayout(ownerId)
  expect(prepared.ok).toBe(true)

  await db.execute(sql`update bookings set status = 'refunded_manual' where id = ${first}::uuid`)

  // Two more completed bookings, so the next payout can absorb the clawback.
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-11', 12), status: 'completed',
  })
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-11', 14), status: 'completed',
  })

  const second = await preparePayout(ownerId)
  expect(second).toMatchObject({ ok: true, netCentavos: NET * 2 - NET, lineCount: 3 })

  const payouts = await getOwnerPayouts(ownerId)
  const latest = payouts.find((p) => p.lines.length === 3)
  expect(latest?.lines.filter((l) => l.kind === 'clawback')).toHaveLength(1)
  expect(latest?.lines.find((l) => l.kind === 'clawback')?.netCentavos).toBe(-NET)
  // Clawbacks must not stretch the period label.
  expect(latest?.periodStart).toBe('2026-06-11')
  expect(latest?.grossCentavos).toBe(GROSS * 2 - GROSS)
  expect(latest?.feeCentavos).toBe(GROSS - NET)
})

test('a clawback larger than the pool writes nothing and stays outstanding', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const big = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-15', 12), status: 'completed', totalCentavos: 100000,
  })
  expect((await preparePayout(ownerId)).ok).toBe(true)
  await db.execute(sql`update bookings set status = 'refunded_manual' where id = ${big}::uuid`)

  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-16', 12), status: 'completed',
  })

  // Owed is negative, so nothing is written — and critically, the clawback is
  // NOT consumed. It must reappear next time.
  expect(await preparePayout(ownerId)).toEqual({ ok: false, reason: 'nothing_to_pay' })
  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.clawbackBookingCount).toBe(1)
  expect(ledger?.owedCentavos).toBe(NET - 90000)
})

test('N concurrent prepares for one owner produce exactly one payout', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  for (let hour = 12; hour < 18; hour++) {
    await seedBooking({
      courtId: courtIds[0], branchId, playerId,
      startsAt: manilaHour('2026-06-20', hour), status: 'completed',
    })
  }

  const results = await Promise.all([1, 2, 3, 4, 5].map(() => preparePayout(ownerId)))
  const winners = results.filter((r) => r.ok)
  expect(winners).toHaveLength(1)
  expect(results.filter((r) => !r.ok && r.reason === 'nothing_to_pay')).toHaveLength(4)

  const payouts = await getOwnerPayouts(ownerId)
  expect(payouts).toHaveLength(1)
  expect(payouts[0].lines).toHaveLength(6)
})

test('mark paid is status-scoped and idempotent', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-25', 12), status: 'completed',
  })
  const prepared = await preparePayout(ownerId)
  if (!prepared.ok) throw new Error('expected a prepared payout')

  expect(await markPayoutPaid(prepared.payoutId, 'GCash ref 123456')).toEqual({ ok: true })
  expect(await markPayoutPaid(prepared.payoutId, 'GCash ref 123456')).toEqual({
    ok: false, reason: 'already_recorded',
  })

  const [payout] = await getOwnerPayouts(ownerId)
  expect(payout.status).toBe('paid')
  expect(payout.paidOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(payout.note).toBe('GCash ref 123456')

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.preparedCentavos).toBe(0)
  expect(ledger?.paidCentavos).toBe(NET)
})

test('mark paid on an unknown id reports already_recorded rather than throwing', async () => {
  expect(await markPayoutPaid(crypto.randomUUID(), 'ref')).toEqual({
    ok: false, reason: 'already_recorded',
  })
})

test('an over-long note is truncated, not rejected', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-26', 12), status: 'completed',
  })
  const prepared = await preparePayout(ownerId)
  if (!prepared.ok) throw new Error('expected a prepared payout')

  await markPayoutPaid(prepared.payoutId, 'x'.repeat(900))
  const [payout] = await getOwnerPayouts(ownerId)
  expect(payout.note).toHaveLength(500)
})
