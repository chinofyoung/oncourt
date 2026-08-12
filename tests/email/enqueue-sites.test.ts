import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { approveCourt, rejectCourt } from '@/lib/admin/write'
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

async function profileEmail(id: string): Promise<string> {
  const result = await db.execute(sql`select email from profiles where id = ${id}::uuid`)
  return result.rows[0].email as string
}

async function setCourtStatus(courtId: string, status: string) {
  await db.execute(sql`
    update courts set status = ${status}::court_status where id = ${courtId}::uuid
  `)
}

async function outboxForCourt(courtId: string, kind: string) {
  const result = await db.execute(sql`
    select recipient, payload
    from email_outbox
    where court_id = ${courtId}::uuid and kind = ${kind}::email_kind
  `)
  return result.rows
}

async function outboxForBooking(bookingId: string, kind: string) {
  const result = await db.execute(sql`
    select recipient, payload
    from email_outbox
    where booking_id = ${bookingId}::uuid and kind = ${kind}::email_kind
    order by created_at, id
  `)
  return result.rows
}

// ------------------------------------------------------------------ approve

test('approveCourt on a pending court with a valid schedule enqueues one court_moderated row to the owner', async () => {
  const { ownerId, courtIds } = await seedBranchWithCourts(1)
  await setCourtStatus(courtIds[0], 'pending')
  const ownerEmail = await profileEmail(ownerId)

  await expect(approveCourt({ courtId: courtIds[0] })).resolves.toEqual({ ok: true })

  const rows = await outboxForCourt(courtIds[0], 'court_moderated')
  expect(rows).toHaveLength(1)
  expect(rows[0].recipient).toBe(ownerEmail)
  expect(rows[0].payload).toMatchObject({ approved: true })
})

test('approveCourt on an already-approved court (stale) enqueues nothing', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setCourtStatus(courtIds[0], 'approved')

  await expect(approveCourt({ courtId: courtIds[0] })).resolves.toEqual({
    ok: false,
    reason: 'stale',
  })

  expect(await outboxForCourt(courtIds[0], 'court_moderated')).toHaveLength(0)
})

// ------------------------------------------------------------------- reject

test('rejectCourt with a reason enqueues one court_moderated row carrying that reason', async () => {
  const { ownerId, courtIds } = await seedBranchWithCourts(1)
  await setCourtStatus(courtIds[0], 'pending')
  const ownerEmail = await profileEmail(ownerId)

  await expect(
    rejectCourt({ courtId: courtIds[0], reason: 'Add a photo showing the whole court.' }),
  ).resolves.toEqual({ ok: true })

  const rows = await outboxForCourt(courtIds[0], 'court_moderated')
  expect(rows).toHaveLength(1)
  expect(rows[0].recipient).toBe(ownerEmail)
  expect(rows[0].payload).toMatchObject({
    approved: false,
    rejectionReason: 'Add a photo showing the whole court.',
  })
})

// ------------------------------------------------------------------- refund

test('recordPaymentRefund on a confirmed booking with a paid payment enqueues one refund_recorded row, bookingCancelled true', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2026-10-01', 12),
    status: 'confirmed',
  })
  const paymentId = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  await db.execute(sql`update payments set needs_refund = true where id = ${paymentId}::uuid`)

  await expect(recordPaymentRefund(paymentId, 'PayMongo ref abc')).resolves.toEqual({
    ok: true,
    bookingRefunded: true,
  })

  const rows = await outboxForBooking(bookingId, 'refund_recorded')
  expect(rows).toHaveLength(1)
  expect(rows[0].payload).toMatchObject({ bookingCancelled: true })
})

test('recordPaymentRefund on an orphan (expired) booking enqueues one refund_recorded row, bookingCancelled false', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2026-10-02', 12),
    status: 'expired',
  })
  const paymentId = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  await db.execute(sql`update payments set needs_refund = true where id = ${paymentId}::uuid`)

  await expect(recordPaymentRefund(paymentId, 'orphan refund')).resolves.toEqual({
    ok: true,
    bookingRefunded: false,
  })

  const rows = await outboxForBooking(bookingId, 'refund_recorded')
  expect(rows).toHaveLength(1)
  expect(rows[0].payload).toMatchObject({ bookingCancelled: false })
})

test('recordPaymentRefund replayed still leaves exactly one refund_recorded row', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2026-10-03', 12),
    status: 'confirmed',
  })
  const paymentId = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })

  await expect(recordPaymentRefund(paymentId, 'first')).resolves.toEqual({
    ok: true,
    bookingRefunded: true,
  })
  await expect(recordPaymentRefund(paymentId, 'second')).resolves.toEqual({
    ok: false,
    reason: 'already_recorded',
  })

  expect(await outboxForBooking(bookingId, 'refund_recorded')).toHaveLength(1)
})

test('two different paid payments on one booking, refunded separately, enqueue two refund_recorded rows', async () => {
  // Review finding: email_outbox_booking_kind_idx used to dedupe every
  // booking-linked kind by (kind, booking_id) — correct for
  // booking_confirmed/booking_new/booking_reminder (at most one each per
  // booking), but wrong for refund_recorded, which is per-PAYMENT. This is
  // exactly the double_charge/not_payable/amount_mismatch shape
  // recordPaymentRefund's own doc comment names: a stray payment refunded
  // first (booking stands), then the payment that actually funded the
  // booking refunded second (booking genuinely cancels). Both must produce
  // their own email — idempotency for refunds lives in recordPaymentRefund's
  // `refunded_at is null` guard, not in this index.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2026-10-05', 12),
    status: 'confirmed',
  })
  const stray = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  const real = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })

  // The stray payment refunded first: `real` still covers the booking, so it
  // does not flip.
  await expect(recordPaymentRefund(stray, 'refunded the stray charge')).resolves.toEqual({
    ok: true,
    bookingRefunded: false,
  })
  // The real payment refunded second: nothing else covers the booking now, so
  // it genuinely flips.
  await expect(recordPaymentRefund(real, 'refunded the real charge')).resolves.toEqual({
    ok: true,
    bookingRefunded: true,
  })

  const rows = await outboxForBooking(bookingId, 'refund_recorded')
  expect(rows).toHaveLength(2)
  expect(rows[0].payload).toMatchObject({ bookingCancelled: false })
  expect(rows[1].payload).toMatchObject({ bookingCancelled: true })
})
