import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBranchWithCourts, seedPlayer, teardownFixtures } from '../helpers/fixtures'
import { insertReviewIfEligible, parseReviewInput } from '@/lib/bookings/review-write'

afterAll(teardownFixtures)

async function seedBookingWithStatus(status: 'confirmed' | 'completed', hour: number) {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const startsAt = new Date(Date.UTC(2026, 3, 12, hour - 8, 0, 0))
  const endsAt = new Date(startsAt.getTime() + 3_600_000)
  const result = await db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos, fee_config_snapshot
    ) values (
      ${courtIds[0]}::uuid, ${branchId}::uuid, ${playerId}::uuid,
      ${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz,
      ${status}::booking_status, 30000, 0, 30000, 3000, 0, 27000, '{"test": true}'::jsonb
    ) returning id
  `)
  return { bookingId: result.rows[0].id as string, playerId, branchId }
}

test('parseReviewInput accepts a valid submission', () => {
  const form = new FormData()
  form.set('bookingId', '11111111-2222-3333-4444-555555555555')
  form.set('rating', '4')
  form.set('body', '  Good surface.  ')
  expect(parseReviewInput(form)).toEqual({
    bookingId: '11111111-2222-3333-4444-555555555555',
    rating: 4,
    body: 'Good surface.',
  })
})

test('parseReviewInput rejects a non-UUID booking id', () => {
  // Without this, the id reaches a ::uuid cast and Postgres raises 22P02,
  // which would escape as an unhandled exception rather than a form error.
  const form = new FormData()
  form.set('bookingId', 'not-a-uuid')
  form.set('rating', '4')
  expect(parseReviewInput(form)).toBeNull()
})

test('parseReviewInput rejects out-of-range and non-integer ratings', () => {
  // The DB CHECK is rating between 1 and 5; catching it here turns a 23514
  // crash into a form error.
  for (const rating of ['0', '6', '4.5', 'five', '']) {
    const form = new FormData()
    form.set('bookingId', '11111111-2222-3333-4444-555555555555')
    form.set('rating', rating)
    expect(parseReviewInput(form)).toBeNull()
  }
})

test('parseReviewInput normalizes an empty body to null', () => {
  const form = new FormData()
  form.set('bookingId', '11111111-2222-3333-4444-555555555555')
  form.set('rating', '5')
  form.set('body', '   ')
  expect(parseReviewInput(form)?.body).toBeNull()
})

test('insertReviewIfEligible writes a review for the player\'s own completed booking', async () => {
  const { bookingId, playerId } = await seedBookingWithStatus('completed', 10)
  await expect(
    insertReviewIfEligible({ bookingId, playerId, rating: 5, body: 'Clean courts.' }),
  ).resolves.toEqual({ ok: true })

  const rows = await db.execute(sql`select rating from reviews where booking_id = ${bookingId}::uuid`)
  expect(rows.rows).toHaveLength(1)
  expect(Number(rows.rows[0].rating)).toBe(5)
})

test('insertReviewIfEligible reports already_reviewed on a second attempt', async () => {
  // reviews.booking_id is UNIQUE — the database is the authority, and the
  // action must translate 23505 rather than crash.
  const { bookingId, playerId } = await seedBookingWithStatus('completed', 11)
  await insertReviewIfEligible({ bookingId, playerId, rating: 4, body: null })
  await expect(
    insertReviewIfEligible({ bookingId, playerId, rating: 3, body: 'Changed my mind.' }),
  ).resolves.toEqual({ ok: false, reason: 'already_reviewed' })
})

test('insertReviewIfEligible refuses a booking that is not completed', async () => {
  const { bookingId, playerId } = await seedBookingWithStatus('confirmed', 12)
  await expect(
    insertReviewIfEligible({ bookingId, playerId, rating: 5, body: null }),
  ).resolves.toEqual({ ok: false, reason: 'not_eligible' })

  const rows = await db.execute(sql`select 1 from reviews where booking_id = ${bookingId}::uuid`)
  expect(rows.rows).toHaveLength(0)
})

test('insertReviewIfEligible refuses another player\'s booking and writes nothing', async () => {
  const { bookingId } = await seedBookingWithStatus('completed', 13)
  const stranger = await seedPlayer()
  await expect(
    insertReviewIfEligible({ bookingId, playerId: stranger, rating: 1, body: 'Never went.' }),
  ).resolves.toEqual({ ok: false, reason: 'not_eligible' })

  const rows = await db.execute(sql`select 1 from reviews where booking_id = ${bookingId}::uuid`)
  expect(rows.rows).toHaveLength(0)
})
