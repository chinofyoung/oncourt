import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@/db'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY_LENGTH = 2000

export type ReviewInput = { bookingId: string; rating: number; body: string | null }

/**
 * Validates the form payload before any of it reaches SQL. Every rule here
 * corresponds to a database constraint that would otherwise raise and escape
 * as an unhandled exception: a non-UUID id hits a ::uuid cast (22P02), and a
 * rating outside 1..5 hits reviews' CHECK (23514).
 *
 * Exported for tests; src/app/bookings/actions.ts is the only production caller.
 */
export function parseReviewInput(formData: FormData): ReviewInput | null {
  const bookingId = String(formData.get('bookingId') ?? '')
  const rating = Number(formData.get('rating'))
  const rawBody = String(formData.get('body') ?? '').trim()

  if (!UUID_RE.test(bookingId)) return null
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null
  if (rawBody.length > MAX_BODY_LENGTH) return null

  return { bookingId, rating, body: rawBody.length > 0 ? rawBody : null }
}

export type InsertResult = { ok: true } | { ok: false; reason: 'already_reviewed' | 'not_eligible' }

/**
 * Inserts a review only if the booking is the caller's own and is completed.
 *
 * Eligibility lives in the INSERT's own SELECT, not in a prior read: a
 * check-then-insert would be a race, and a forged booking_id must insert
 * nothing rather than be rejected after the fact. `branch_id` is taken from
 * the booking row, never from the form — trusting client input there would let
 * a review be attached to any branch.
 *
 * Exported for tests; src/app/bookings/actions.ts is the only production caller.
 */
export async function insertReviewIfEligible(input: ReviewInput & { playerId: string }): Promise<InsertResult> {
  try {
    const result = await db.execute(sql`
      insert into reviews (booking_id, branch_id, player_id, rating, body)
      select bk.id, bk.branch_id, bk.player_id, ${input.rating}, ${input.body}
      from bookings bk
      where bk.id = ${input.bookingId}::uuid
        and bk.player_id = ${input.playerId}::uuid
        and bk.status = 'completed'
      returning id
    `)
    return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'not_eligible' }
  } catch (error) {
    // reviews.booking_id is UNIQUE; the constraint is the authority on
    // "one review per booking", so a duplicate is a normal outcome to report.
    // drizzle-orm wraps the PostgreSQL error in a cause property.
    const pgError = (error as { cause?: unknown }).cause || error
    if (
      typeof pgError === 'object' &&
      pgError !== null &&
      (pgError as { code?: string }).code === '23505'
    ) {
      return { ok: false, reason: 'already_reviewed' }
    }
    throw error
  }
}
