import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { StorageClient } from '@/lib/listings/storage'
import {
  approveManualProof,
  cancelManualBooking,
  listPendingProofs,
  rejectManualProof,
  submitManualProof,
} from '@/lib/payments/manual'
import { addPaymentMethod } from '@/lib/owner/payment-methods'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

/** Records calls instead of really uploading -- storage has no rollback. */
function recorder() {
  const uploads: { bucket: string; path: string }[] = []
  const removed: string[] = []
  const client: StorageClient = {
    async upload(bucket, path) {
      uploads.push({ bucket, path })
      return { error: null }
    },
    async remove(_bucket, paths) {
      removed.push(...paths)
      return { error: null }
    },
    async createSignedUrl(_bucket, path) {
      return { url: `https://signed.test/${path}`, error: null }
    },
  }
  return { client, uploads, removed }
}

const PNG = { bytes: new Uint8Array([137, 80, 78, 71]), contentType: 'image/png' }

async function manualOwnerCourt() {
  const seeded = await seedBranchWithCourts(1)
  const added = await addPaymentMethod(seeded.ownerId, {
    kind: 'ewallet',
    institution: 'GCash',
    accountName: 'Smash Courts',
    accountNumber: '09171234567',
  })
  if (!added.ok) throw new Error('setup failed')
  await db.execute(
    sql`update profiles set payment_mode = 'manual' where id = ${seeded.ownerId}::uuid`,
  )
  return { ...seeded, methodId: added.id }
}

test('a submitted proof creates a pending_verification booking and a pending proof', async () => {
  const { branchId, courtIds, methodId } = await manualOwnerCourt()
  const playerId = await seedPlayer()
  const storage = recorder()

  const result = await submitManualProof(
    {
      courtId: courtIds[0],
      branchId,
      playerId,
      date: '2027-05-01',
      startHour: 12,
      endHour: 13,
      paymentMethodId: methodId,
      file: PNG,
      referenceNote: 'REF 12345',
    },
    storage.client,
  )

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(storage.uploads).toHaveLength(1)
  expect(storage.uploads[0].bucket).toBe('payment-proofs')

  const row = await db.execute(sql`
    select p.status::text as status, p.reference_note, p.paid_to_snapshot,
           b.status::text as booking_status
    from manual_payment_proofs p
    join bookings b on b.id = p.booking_id
    where p.booking_id = ${result.bookingId}::uuid
  `)
  expect(row.rows[0].status).toBe('pending')
  expect(row.rows[0].booking_status).toBe('pending_verification')
  expect(row.rows[0].reference_note).toBe('REF 12345')
  expect((row.rows[0].paid_to_snapshot as { institution: string }).institution).toBe('GCash')
})

test('an automated-rail court refuses a proof submission', async () => {
  const { branchId, courtIds, ownerId } = await manualOwnerCourt()
  await db.execute(
    sql`update profiles set payment_mode = 'automated' where id = ${ownerId}::uuid`,
  )
  const playerId = await seedPlayer()
  const storage = recorder()

  const result = await submitManualProof(
    {
      courtId: courtIds[0],
      branchId,
      playerId,
      date: '2027-05-02',
      startHour: 12,
      endHour: 13,
      paymentMethodId: 'ignored',
      file: PNG,
    },
    storage.client,
  )
  expect(result).toEqual({ ok: false, reason: 'not_manual' })
  expect(storage.uploads).toHaveLength(0)
})

test('a payment method belonging to a different owner is refused', async () => {
  const { branchId, courtIds } = await manualOwnerCourt()
  const other = await manualOwnerCourt()
  const playerId = await seedPlayer()
  const storage = recorder()

  const result = await submitManualProof(
    {
      courtId: courtIds[0],
      branchId,
      playerId,
      date: '2027-05-03',
      startHour: 12,
      endHour: 13,
      paymentMethodId: other.methodId,
      file: PNG,
    },
    storage.client,
  )
  expect(result).toEqual({ ok: false, reason: 'unknown_method' })
  expect(storage.uploads).toHaveLength(0)
})

test('an oversized or wrongly-typed file never reaches storage', async () => {
  const { branchId, courtIds, methodId } = await manualOwnerCourt()
  const playerId = await seedPlayer()
  const storage = recorder()
  const base = {
    courtId: courtIds[0],
    branchId,
    playerId,
    date: '2027-05-04',
    startHour: 12,
    endHour: 13,
    paymentMethodId: methodId,
  }

  expect(
    await submitManualProof(
      { ...base, file: { bytes: new Uint8Array(0), contentType: 'image/png' } },
      storage.client,
    ),
  ).toEqual({ ok: false, reason: 'no_file' })

  expect(
    await submitManualProof(
      { ...base, file: { bytes: new Uint8Array([1, 2]), contentType: 'application/pdf' } },
      storage.client,
    ),
  ).toEqual({ ok: false, reason: 'bad_type' })

  expect(
    await submitManualProof(
      {
        ...base,
        file: { bytes: new Uint8Array(5 * 1024 * 1024 + 1), contentType: 'image/png' },
      },
      storage.client,
    ),
  ).toEqual({ ok: false, reason: 'too_large' })

  expect(storage.uploads).toHaveLength(0)
})

test('losing the slot race removes the uploaded object', async () => {
  const { branchId, courtIds, methodId } = await manualOwnerCourt()
  const playerA = await seedPlayer()
  const playerB = await seedPlayer()
  const storage = recorder()
  const base = {
    courtId: courtIds[0],
    branchId,
    date: '2027-05-05',
    startHour: 12,
    endHour: 13,
    paymentMethodId: methodId,
    file: PNG,
  }

  const first = await submitManualProof({ ...base, playerId: playerA }, storage.client)
  expect(first.ok).toBe(true)

  const second = await submitManualProof({ ...base, playerId: playerB }, storage.client)
  expect(second).toEqual({ ok: false, reason: 'slot_taken' })
  expect(storage.removed).toHaveLength(1)
})

test('the owner is emailed that a proof is waiting', async () => {
  const { branchId, courtIds, methodId } = await manualOwnerCourt()
  const playerId = await seedPlayer()
  const storage = recorder()

  const result = await submitManualProof(
    {
      courtId: courtIds[0],
      branchId,
      playerId,
      date: '2027-05-06',
      startHour: 12,
      endHour: 13,
      paymentMethodId: methodId,
      file: PNG,
    },
    storage.client,
  )
  expect(result.ok).toBe(true)
  if (!result.ok) return

  const mail = await db.execute(sql`
    select count(*)::int as n from email_outbox
    where booking_id = ${result.bookingId}::uuid and kind = 'manual_proof_submitted'
  `)
  expect(Number(mail.rows[0].n)).toBe(1)
})

async function submitOne(date: string) {
  const seeded = await manualOwnerCourt()
  const playerId = await seedPlayer()
  const storage = recorder()
  const result = await submitManualProof(
    {
      courtId: seeded.courtIds[0],
      branchId: seeded.branchId,
      playerId,
      date,
      startHour: 12,
      endHour: 13,
      paymentMethodId: seeded.methodId,
      file: PNG,
    },
    storage.client,
  )
  if (!result.ok) throw new Error('setup failed: ' + result.reason)
  return { ...seeded, playerId, ...result }
}

test('approving confirms the booking and clears the deadline', async () => {
  const s = await submitOne('2027-06-01')
  expect(await approveManualProof(s.bookingId, s.ownerId)).toEqual({ ok: true })

  const row = await db.execute(sql`
    select b.status::text as status, b.expires_at, p.status::text as proof_status, p.reviewed_at
    from bookings b join manual_payment_proofs p on p.booking_id = b.id
    where b.id = ${s.bookingId}::uuid
  `)
  expect(row.rows[0].status).toBe('confirmed')
  expect(row.rows[0].expires_at).toBeNull()
  expect(row.rows[0].proof_status).toBe('approved')
  expect(row.rows[0].reviewed_at).not.toBeNull()
})

test('approving twice reports already_reviewed rather than throwing', async () => {
  const s = await submitOne('2027-06-02')
  expect(await approveManualProof(s.bookingId, s.ownerId)).toEqual({ ok: true })
  expect(await approveManualProof(s.bookingId, s.ownerId)).toEqual({
    ok: false,
    reason: 'already_reviewed',
  })
})

test('approving enqueues the confirmation to the player', async () => {
  const s = await submitOne('2027-06-03')
  await approveManualProof(s.bookingId, s.ownerId)
  const mail = await db.execute(sql`
    select count(*)::int as n from email_outbox
    where booking_id = ${s.bookingId}::uuid and kind = 'booking_confirmed'
  `)
  expect(Number(mail.rows[0].n)).toBe(1)
})

test('rejecting expires the booking, frees the slot and keeps the reason', async () => {
  const s = await submitOne('2027-06-04')
  expect(await rejectManualProof(s.bookingId, s.ownerId, 'No transfer received')).toEqual({
    ok: true,
  })

  const row = await db.execute(sql`
    select b.status::text as status, p.status::text as proof_status, p.rejection_reason
    from bookings b join manual_payment_proofs p on p.booking_id = b.id
    where b.id = ${s.bookingId}::uuid
  `)
  expect(row.rows[0].status).toBe('expired')
  expect(row.rows[0].proof_status).toBe('rejected')
  expect(row.rows[0].rejection_reason).toBe('No transfer received')

  // The slot is genuinely free again: the same slot books without 23P01.
  const other = await seedPlayer()
  const storage = recorder()
  const again = await submitManualProof(
    {
      courtId: s.courtIds[0],
      branchId: s.branchId,
      playerId: other,
      date: '2027-06-04',
      startHour: 12,
      endHour: 13,
      paymentMethodId: s.methodId,
      file: PNG,
    },
    storage.client,
  )
  expect(again.ok).toBe(true)
})

test('rejecting with a blank reason is refused', async () => {
  const s = await submitOne('2027-06-05')
  expect(await rejectManualProof(s.bookingId, s.ownerId, '   ')).toEqual({
    ok: false,
    reason: 'needs_reason',
  })
})

test('the queue lists a pending proof for the owner’s branch only', async () => {
  const s = await submitOne('2027-06-06')
  const mine = await listPendingProofs([s.branchId])
  expect(mine.map((p) => p.bookingId)).toContain(s.bookingId)

  const otherBranch = await manualOwnerCourt()
  const theirs = await listPendingProofs([otherBranch.branchId])
  expect(theirs.map((p) => p.bookingId)).not.toContain(s.bookingId)
})

test('cancelling a confirmed manual booking records it and frees the slot', async () => {
  const s = await submitOne('2027-06-10')
  await approveManualProof(s.bookingId, s.ownerId)

  expect(
    await cancelManualBooking(s.bookingId, s.ownerId, 'Court flooded, refunded via GCash'),
  ).toEqual({ ok: true })

  const row = await db.execute(sql`
    select status::text as status, note from bookings where id = ${s.bookingId}::uuid
  `)
  expect(row.rows[0].status).toBe('refunded_manual')
  expect(row.rows[0].note).toContain('GCash')

  // refunded_manual is excluded from bookings_no_overlap, so the slot is free.
  const other = await seedPlayer()
  const storage = recorder()
  const again = await submitManualProof(
    {
      courtId: s.courtIds[0],
      branchId: s.branchId,
      playerId: other,
      date: '2027-06-10',
      startHour: 12,
      endHour: 13,
      paymentMethodId: s.methodId,
      file: PNG,
    },
    storage.client,
  )
  expect(again.ok).toBe(true)
})

test('cancelling requires a note', async () => {
  const s = await submitOne('2027-06-11')
  await approveManualProof(s.bookingId, s.ownerId)
  expect(await cancelManualBooking(s.bookingId, s.ownerId, '  ')).toEqual({
    ok: false,
    reason: 'needs_reason',
  })
})

test('a booking still awaiting review is rejected, not cancelled', async () => {
  const s = await submitOne('2027-06-12')
  expect(await cancelManualBooking(s.bookingId, s.ownerId, 'changed my mind')).toEqual({
    ok: false,
    reason: 'not_cancellable',
  })
})

test('an automated booking cannot be cancelled through the manual path', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2027-06-13', 12),
    status: 'confirmed',
  })
  expect(await cancelManualBooking(bookingId, ownerId, 'nope')).toEqual({
    ok: false,
    reason: 'not_manual',
  })
})

test('the player is told their manual booking was cancelled', async () => {
  const s = await submitOne('2027-06-14')
  await approveManualProof(s.bookingId, s.ownerId)
  await cancelManualBooking(s.bookingId, s.ownerId, 'Court flooded')
  const mail = await db.execute(sql`
    select count(*)::int as n from email_outbox
    where booking_id = ${s.bookingId}::uuid and kind = 'refund_recorded'
  `)
  expect(Number(mail.rows[0].n)).toBe(1)
})
