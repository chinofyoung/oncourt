import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@/db'
import { manilaHour, seedBranchWithCourts, seedPlayer } from '../helpers/fixtures'

/** SQLSTATE of a raw pg error, which drizzle wraps in DrizzleQueryError. */
function sqlStateOf(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause
  return (cause as { code?: string })?.code ?? (error as { code?: string })?.code
}

async function seedCompletedBooking() {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const startsAt = manilaHour('2020-01-06', 12)
  const endsAt = manilaHour('2020-01-06', 13)
  const row = await db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
      fee_config_snapshot
    ) values (
      ${courtIds[0]}::uuid, ${branchId}::uuid, ${playerId}::uuid,
      ${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz,
      'completed', 26500, 0, 26500, 2650, 0, 23850, '{}'::jsonb
    )
    returning id
  `)
  return { bookingId: row.rows[0].id as string, branchId, playerId }
}

describe('reviews schema', () => {
  it('accepts a valid review', async () => {
    const { bookingId, branchId, playerId } = await seedCompletedBooking()
    const result = await db.execute(sql`
      insert into reviews (booking_id, branch_id, player_id, rating, body)
      values (${bookingId}::uuid, ${branchId}::uuid, ${playerId}::uuid, 5, 'Great courts')
      returning id, rating, created_at
    `)
    expect(result.rows).toHaveLength(1)
    expect(Number(result.rows[0].rating)).toBe(5)
    expect(result.rows[0].created_at).toBeTruthy()
  })

  it('rejects a rating outside 1-5', async () => {
    const { bookingId, branchId, playerId } = await seedCompletedBooking()
    for (const rating of [0, 6, -1]) {
      await expect(
        db.execute(sql`
          insert into reviews (booking_id, branch_id, player_id, rating)
          values (${bookingId}::uuid, ${branchId}::uuid, ${playerId}::uuid, ${rating})
        `),
      ).rejects.toSatisfy((e: unknown) => sqlStateOf(e) === '23514')
    }
  })

  it('allows only one review per booking', async () => {
    const { bookingId, branchId, playerId } = await seedCompletedBooking()
    await db.execute(sql`
      insert into reviews (booking_id, branch_id, player_id, rating)
      values (${bookingId}::uuid, ${branchId}::uuid, ${playerId}::uuid, 4)
    `)
    await expect(
      db.execute(sql`
        insert into reviews (booking_id, branch_id, player_id, rating)
        values (${bookingId}::uuid, ${branchId}::uuid, ${playerId}::uuid, 3)
      `),
    ).rejects.toSatisfy((e: unknown) => sqlStateOf(e) === '23505')
  })

  it('cascades when the branch is deleted', async () => {
    const { bookingId, playerId } = await seedCompletedBooking()
    // The review's branch_id points at a SECOND, booking-free branch rather
    // than the booking's own branch. That is not a dodge — it is the only
    // way to reach this cascade at all. bookings.branch_id is NO ACTION, so
    // a branch that has bookings cannot be deleted; and reviews.booking_id
    // is NO ACTION, so the booking cannot be deleted first either. The two
    // restrictions form a cycle. In production this cascade is therefore
    // near-unreachable and exists for a future hard-delete/purge path; this
    // test pins the constraint as declared without colliding with the
    // restriction the NEXT test pins.
    const { branchId: emptyBranchId } = await seedBranchWithCourts(0)
    await db.execute(sql`
      insert into reviews (booking_id, branch_id, player_id, rating)
      values (${bookingId}::uuid, ${emptyBranchId}::uuid, ${playerId}::uuid, 4)
    `)
    await db.execute(sql`delete from branches where id = ${emptyBranchId}::uuid`)
    const left = await db.execute(sql`select 1 from reviews where booking_id = ${bookingId}::uuid`)
    expect(left.rows).toHaveLength(0)
  })

  it('blocks deleting a booking that still has a review', async () => {
    const { bookingId, branchId, playerId } = await seedCompletedBooking()
    await db.execute(sql`
      insert into reviews (booking_id, branch_id, player_id, rating)
      values (${bookingId}::uuid, ${branchId}::uuid, ${playerId}::uuid, 4)
    `)
    await expect(
      db.execute(sql`delete from bookings where id = ${bookingId}::uuid`),
    ).rejects.toSatisfy((e: unknown) => sqlStateOf(e) === '23503')
    // Clean up so teardownFixtures() can delete the booking.
    await db.execute(sql`delete from reviews where booking_id = ${bookingId}::uuid`)
  })

  it('has row level security enabled and no policies', async () => {
    const rls = await db.execute(sql`
      select relrowsecurity from pg_class where oid = 'public.reviews'::regclass
    `)
    expect(rls.rows[0].relrowsecurity).toBe(true)

    const policies = await db.execute(sql`
      select policyname from pg_policies where schemaname = 'public' and tablename = 'reviews'
    `)
    expect(policies.rows).toHaveLength(0)
  })

  it('indexes both cascading foreign keys', async () => {
    const indexes = await db.execute(sql`
      select indexdef from pg_indexes where schemaname = 'public' and tablename = 'reviews'
    `)
    const defs = indexes.rows.map((r) => r.indexdef as string).join('\n')
    expect(defs).toContain('(branch_id)')
    expect(defs).toContain('(player_id)')
  })
})
