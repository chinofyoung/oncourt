import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
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

async function paymentRow(paymentId: string) {
  const result = await db.execute(sql`
    select needs_refund, refunded_at, refund_note from payments where id = ${paymentId}::uuid
  `)
  return result.rows[0]
}

async function bookingStatus(bookingId: string) {
  const result = await db.execute(sql`
    select status::text as status from bookings where id = ${bookingId}::uuid
  `)
  return result.rows[0].status as string
}

// Also the "single payment still flips" pin for recordPaymentRefund's
// `not exists` clause: exactly one paid payment covers this booking, so
// refunding it must still flip the booking, unchanged from before the clause
// was added. 'a completed booking flips too' pins the other status branch.
test('a confirmed booking flips to refunded_manual and its payment is stamped', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-05-02', 12), status: 'confirmed',
  })
  const paymentId = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  await db.execute(sql`update payments set needs_refund = true where id = ${paymentId}::uuid`)

  expect(await recordPaymentRefund(paymentId, 'PayMongo ref abc')).toEqual({
    ok: true, bookingRefunded: true,
  })
  expect(await bookingStatus(bookingId)).toBe('refunded_manual')

  const payment = await paymentRow(paymentId)
  expect(payment.needs_refund).toBe(false)
  expect(payment.refunded_at).not.toBeNull()
  expect(payment.refund_note).toBe('PayMongo ref abc')
})

test('refunding a duplicate charge leaves the booking alone', async () => {
  // THE case the `not exists` clause exists for. The webhook's `double_charge`
  // / `not_payable` / `amount_mismatch` shapes all put a paid, needs_refund
  // payment on a booking a DIFFERENT payment legitimately funded. Flipping the
  // booking here would pull the owner's owner_net out of the payable pool
  // while the platform keeps the original payment, show the player a refunded
  // booking whose money is still held, and free the slot — bookings_no_overlap
  // (20260801070328_bookings.sql:78) excludes refunded_manual from its
  // predicate, so another player could book over a paid, confirmed slot. There
  // is no un-refund path.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-05-08', 12), status: 'confirmed',
  })
  const original = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  const duplicate = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  await db.execute(sql`update payments set needs_refund = true where id = ${duplicate}::uuid`)

  expect(await recordPaymentRefund(duplicate, 'refunded the double charge')).toEqual({
    ok: true, bookingRefunded: false,
  })
  expect(await bookingStatus(bookingId)).toBe('confirmed')

  const stamped = await paymentRow(duplicate)
  expect(stamped.needs_refund).toBe(false)
  expect(stamped.refunded_at).not.toBeNull()
  expect(stamped.refund_note).toBe('refunded the double charge')
  // The original is untouched: still paid, still un-refunded, still funding
  // the booking.
  expect((await paymentRow(original)).refunded_at).toBeNull()
})

test('a duplicate on a completed booking leaves it completed too', async () => {
  // The `not_payable` shape: a late second payment lands after the booking has
  // already been played and completed. Same rule, different status branch.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-05-09', 12), status: 'completed',
  })
  await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  const duplicate = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })

  expect(await recordPaymentRefund(duplicate, 'dupe')).toEqual({
    ok: true, bookingRefunded: false,
  })
  expect(await bookingStatus(bookingId)).toBe('completed')
})

test('refunding the original while a duplicate is outstanding also leaves the booking alone', async () => {
  // Arguably the admin should be refunding the DUPLICATE, not this one — but
  // either way the booking is still covered by live paid money, so it must not
  // flip. Once BOTH are refunded the booking is genuinely unpaid; unwinding
  // that is out of scope (there is no un-refund path either).
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-05-10', 12), status: 'confirmed',
  })
  const original = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })

  expect(await recordPaymentRefund(original, 'refunded the wrong one')).toEqual({
    ok: true, bookingRefunded: false,
  })
  expect(await bookingStatus(bookingId)).toBe('confirmed')
})

test('a completed booking flips too', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-05-03', 12), status: 'completed',
  })
  const paymentId = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })

  expect(await recordPaymentRefund(paymentId, 'ref')).toEqual({ ok: true, bookingRefunded: true })
  expect(await bookingStatus(bookingId)).toBe('refunded_manual')
})

test('an orphan payment clears its flag and leaves the booking alone', async () => {
  // The shape src/lib/payments/webhook.ts produces most often: money landed
  // for a slot that was no longer available, so the booking never confirmed.
  // There is no owner credit to reverse.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-05-04', 12), status: 'expired',
  })
  const paymentId = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  await db.execute(sql`update payments set needs_refund = true where id = ${paymentId}::uuid`)

  expect(await recordPaymentRefund(paymentId, 'orphan')).toEqual({
    ok: true, bookingRefunded: false,
  })
  expect(await bookingStatus(bookingId)).toBe('expired')
  expect((await paymentRow(paymentId)).needs_refund).toBe(false)
})

test('recording twice is a no-op', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-05-05', 12), status: 'confirmed',
  })
  const paymentId = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })

  expect(await recordPaymentRefund(paymentId, 'first')).toEqual({ ok: true, bookingRefunded: true })
  expect(await recordPaymentRefund(paymentId, 'second')).toEqual({
    ok: false, reason: 'already_recorded',
  })
  expect((await paymentRow(paymentId)).refund_note).toBe('first')
})

test('an unknown payment id reports already_recorded rather than throwing', async () => {
  expect(await recordPaymentRefund(crypto.randomUUID(), 'x')).toEqual({
    ok: false, reason: 'already_recorded',
  })
})

test('a payment that was never paid cannot be refunded, and its booking is untouched', async () => {
  // The reachable state: an abandoned checkout's payment row stays `pending`
  // forever once a different session's payment confirms the booking
  // (src/lib/payments/checkout.ts:133, src/lib/payments/reconcile.ts:74-76).
  // Without a status guard, submitting its id would flip a fully-paid,
  // completed booking to refunded_manual and drop it from the payable pool.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-05-06', 12), status: 'completed',
  })
  const abandoned = await seedPayment({ bookingId, amountCentavos: 30000, status: 'pending' })

  expect(await recordPaymentRefund(abandoned, 'forged')).toEqual({
    ok: false, reason: 'already_recorded',
  })
  expect(await bookingStatus(bookingId)).toBe('completed')
  expect((await paymentRow(abandoned)).refunded_at).toBeNull()
})

test('a failed payment cannot be refunded either', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-05-07', 12), status: 'completed',
  })
  const failed = await seedPayment({ bookingId, amountCentavos: 30000, status: 'failed' })

  expect(await recordPaymentRefund(failed, 'forged')).toEqual({
    ok: false, reason: 'already_recorded',
  })
  expect(await bookingStatus(bookingId)).toBe('completed')
  expect((await paymentRow(failed)).refunded_at).toBeNull()
})
