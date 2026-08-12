import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { enqueueEmail, getFailedEmailCount, getFailedEmails, retryEmail } from '@/lib/email/outbox'
import {
  manilaHour, seedBooking, seedBranchWithCourts, seedOutboxRow, seedPlayer, teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

const ROLLBACK = new Error('rollback')

function facts(bookingId: string) {
  return {
    playerName: 'Ana Cruz', branchName: 'Fixture Branch', courtName: 'Court 1',
    bookedOn: '2026-09-20', startHour: 17, endHour: 19,
    totalChargedCentavos: 73000, bookingId,
  }
}

async function outboxCount(bookingId: string) {
  const r = await db.execute(sql`
    select count(*)::int as n from email_outbox where booking_id = ${bookingId}::uuid
  `)
  return Number(r.rows[0].n)
}

test('an enqueue joins the caller transaction and dies with it', async () => {
  // THE POINT OF THE OUTBOX: "booking confirmed" and "receipt owed" commit or
  // fail together. If the enqueue opened its own connection, a rolled-back
  // booking would still email the player.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-09-20', 17), status: 'confirmed',
  })

  await expect(
    db.transaction(async (tx) => {
      await enqueueEmail(tx, {
        payload: { kind: 'booking_confirmed', booking: facts(bookingId) },
        recipient: 'ana@example.test',
        bookingId,
      })
      expect(await outboxCount(bookingId)).toBe(0) // not visible outside yet
      throw ROLLBACK
    }),
  ).rejects.toThrow(ROLLBACK)

  expect(await outboxCount(bookingId)).toBe(0)
})

test('a replay is a no-op, not an error', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-09-21', 17), status: 'confirmed',
  })
  const input = {
    payload: { kind: 'booking_confirmed' as const, booking: facts(bookingId) },
    recipient: 'ana@example.test',
    bookingId,
  }

  await enqueueEmail(db, input)
  await enqueueEmail(db, input)   // must not throw 23505
  expect(await outboxCount(bookingId)).toBe(1)
})

test('different kinds for one booking coexist', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-09-22', 17), status: 'confirmed',
  })
  await enqueueEmail(db, {
    payload: { kind: 'booking_confirmed', booking: facts(bookingId) },
    recipient: 'ana@example.test', bookingId,
  })
  await enqueueEmail(db, {
    payload: { kind: 'booking_reminder', booking: facts(bookingId) },
    recipient: 'ana@example.test', bookingId,
  })
  expect(await outboxCount(bookingId)).toBe(2)
})

test('the payload round-trips through jsonb intact', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-09-23', 17), status: 'confirmed',
  })
  await enqueueEmail(db, {
    payload: { kind: 'booking_confirmed', booking: facts(bookingId) },
    recipient: 'ana@example.test', bookingId,
  })
  const row = await db.execute(sql`
    select payload from email_outbox where booking_id = ${bookingId}::uuid
  `)
  expect(row.rows[0].payload).toMatchObject({
    kind: 'booking_confirmed',
    booking: { totalChargedCentavos: 73000, courtName: 'Court 1' },
  })
})

test('the failed count tracks the queue', async () => {
  const before = await getFailedEmailCount()
  await seedOutboxRow({ kind: 'booking_new', status: 'failed' })
  expect(await getFailedEmailCount()).toBe(before + 1)
})

test('getFailedEmails returns a seeded failed row and not a pending one', async () => {
  const failedId = await seedOutboxRow({
    kind: 'booking_new',
    recipient: 'failed-recipient@example.test',
    status: 'failed',
    attempts: 3,
  })
  // seedOutboxRow has no lastError option; set it directly, same as the
  // enqueue tests above reach into the table with raw SQL for what the
  // fixture helper doesn't expose.
  await db.execute(sql`
    update email_outbox set last_error = 'SMTP timeout' where id = ${failedId}::uuid
  `)
  const pendingId = await seedOutboxRow({ kind: 'booking_new', status: 'pending' })

  const failed = await getFailedEmails()
  const ids = failed.map((row) => row.id)
  expect(ids).toContain(failedId)
  expect(ids).not.toContain(pendingId)

  const row = failed.find((r) => r.id === failedId)!
  expect(row.kind).toBe('booking_new')
  expect(row.recipient).toBe('failed-recipient@example.test')
  expect(row.attempts).toBe(3)
  expect(row.lastError).toBe('SMTP timeout')
  expect(row.createdOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

test('retryEmail flips a failed row back to pending with attempts reset and the error cleared', async () => {
  const id = await seedOutboxRow({ kind: 'booking_new', status: 'failed', attempts: 4 })
  await db.execute(sql`update email_outbox set last_error = 'boom' where id = ${id}::uuid`)

  const result = await retryEmail(id)
  expect(result).toEqual({ ok: true })

  const row = await db.execute(sql`
    select status, attempts, last_error, (next_attempt_at <= now()) as due
    from email_outbox where id = ${id}::uuid
  `)
  expect(row.rows[0].status).toBe('pending')
  expect(Number(row.rows[0].attempts)).toBe(0)
  expect(row.rows[0].last_error).toBeNull()
  expect(row.rows[0].due).toBe(true)
})

test('a second retryEmail on the same row returns already_moved', async () => {
  const id = await seedOutboxRow({ kind: 'booking_new', status: 'failed' })
  const first = await retryEmail(id)
  expect(first).toEqual({ ok: true })

  const second = await retryEmail(id)
  expect(second).toEqual({ ok: false, reason: 'already_moved' })
})

test('retryEmail on an unknown uuid returns the same rather than throwing', async () => {
  const result = await retryEmail(crypto.randomUUID())
  expect(result).toEqual({ ok: false, reason: 'already_moved' })
})
