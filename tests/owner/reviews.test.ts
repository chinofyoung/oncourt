import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'
import { getOwnerReviews, OWNER_REVIEWS_LIMIT } from '@/lib/owner/reviews'

afterAll(teardownFixtures)

/**
 * getOwnerReviews is SCOPED — it only ever sees the branch ids handed to it —
 * so unlike Slice C's admin queries these assertions can be exact rather than
 * filtered deltas. Every test seeds its own branch and asserts against that
 * branch's list.
 *
 * No test double anywhere in this file. The rows are real, the joins are real,
 * and the coalesce being asserted is the one that actually runs in production.
 */
async function seedReview(opts: {
  courtId: string
  branchId: string
  playerId: string
  hour: number
  rating?: number
  body?: string | null
}): Promise<string> {
  const bookingId = await seedBooking({
    courtId: opts.courtId,
    branchId: opts.branchId,
    playerId: opts.playerId,
    startsAt: manilaHour('2026-03-01', opts.hour),
    status: 'completed',
  })
  const result = await db.execute(sql`
    insert into reviews (booking_id, branch_id, player_id, rating, body)
    values (${bookingId}::uuid, ${opts.branchId}::uuid, ${opts.playerId}::uuid,
            ${opts.rating ?? 5}, ${opts.body ?? null})
    returning id
  `)
  return result.rows[0].id as string
}

test('getOwnerReviews returns every fact the dashboard list renders', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const reviewId = await seedReview({
    courtId: courtIds[0],
    branchId,
    playerId,
    hour: 12,
    rating: 4,
    body: 'Nets were in great shape.',
  })

  const page = await getOwnerReviews([branchId])
  expect(page.capped).toBe(false)
  expect(page.reviews).toHaveLength(1)
  expect(page.reviews[0]).toMatchObject({
    id: reviewId,
    rating: 4,
    body: 'Nets were in great shape.',
    // THE join the reviews table cannot do directly: reviews carries no
    // court_id, so this resolves booking_id -> bookings.court_id -> courts.name.
    courtName: 'Court 1',
    branchId,
    branchName: 'Fixture Branch',
  })
  // seedPlayer() leaves full_name null, so this is the split_part fallback --
  // the local part of the address, never the address itself.
  expect(page.reviews[0].playerName).toMatch(/^player-[0-9a-f-]+$/)
  expect(page.reviews[0].playerName).not.toContain('@')
  expect(page.reviews[0].createdOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  // rating comes out of a smallint column; a string here would render as
  // "4" today and break the moment anything does arithmetic on it.
  expect(typeof page.reviews[0].rating).toBe('number')
})

test('getOwnerReviews never returns another owner’s reviews', async () => {
  // THE cross-owner exclusion. Two owners, two branches, one review each: the
  // scope list is the only thing standing between them, and it is applied in
  // SQL rather than filtered afterwards.
  const mine = await seedBranchWithCourts(1)
  const theirs = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await seedReview({ courtId: mine.courtIds[0], branchId: mine.branchId, playerId, hour: 12 })
  await seedReview({ courtId: theirs.courtIds[0], branchId: theirs.branchId, playerId, hour: 14 })

  const page = await getOwnerReviews([mine.branchId])
  expect(page.reviews).toHaveLength(1)
  expect(page.reviews[0].branchId).toBe(mine.branchId)

  // And the other direction, so this cannot pass by the scope being ignored.
  const otherPage = await getOwnerReviews([theirs.branchId])
  expect(otherPage.reviews.map((row) => row.branchId)).toEqual([theirs.branchId])
})

test('getOwnerReviews returns nothing for an empty scope', async () => {
  // An owner with no branches yet. `= any('{}'::uuid[])` matches nothing,
  // which is the correct answer and not an error.
  await expect(getOwnerReviews([])).resolves.toEqual({ reviews: [], capped: false })
})

test('getOwnerReviews narrows to one branch when the filter is set', async () => {
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedReview({ courtId: first.courtIds[0], branchId: first.branchId, playerId, hour: 12 })
  await seedReview({ courtId: second.courtIds[0], branchId: second.branchId, playerId, hour: 14 })

  const scope = [first.branchId, second.branchId]
  expect((await getOwnerReviews(scope)).reviews).toHaveLength(2)

  const filtered = await getOwnerReviews(scope, { branchId: second.branchId })
  expect(filtered.reviews.map((row) => row.branchId)).toEqual([second.branchId])

  // A filter naming a branch OUTSIDE the scope narrows to nothing rather than
  // widening: the `any(branchIds)` clause is still there underneath it.
  const outside = await getOwnerReviews([first.branchId], { branchId: second.branchId })
  expect(outside.reviews).toEqual([])
})

test('getOwnerReviews reports an absent body as null, including a whitespace-only one', async () => {
  // The page renders nothing at all for a null body -- not an empty quote --
  // so a body of "   " has to arrive as null, not as three spaces that render
  // an empty paragraph with a margin.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedReview({ courtId: courtIds[0], branchId, playerId, hour: 12, body: null })
  await seedReview({ courtId: courtIds[0], branchId, playerId, hour: 13, body: '   \n\t ' })

  const page = await getOwnerReviews([branchId])
  expect(page.reviews).toHaveLength(2)
  expect(page.reviews.every((row) => row.body === null)).toBe(true)
})

test('getOwnerReviews uses the player’s full name when they have one', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await db.execute(sql`update profiles set full_name = 'Anna Reyes' where id = ${playerId}::uuid`)
  await seedReview({ courtId: courtIds[0], branchId, playerId, hour: 12 })

  const page = await getOwnerReviews([branchId])
  expect(page.reviews[0].playerName).toBe('Anna Reyes')
})

test('getOwnerReviews returns newest first, breaking ties by id', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const older = await seedReview({ courtId: courtIds[0], branchId, playerId, hour: 12 })
  const tieA = await seedReview({ courtId: courtIds[0], branchId, playerId, hour: 13 })
  const tieB = await seedReview({ courtId: courtIds[0], branchId, playerId, hour: 14 })

  // Backdated explicitly rather than trusting three inserts to land on three
  // different clock ticks. The two tied rows share a created_at to the
  // microsecond, so the ONLY thing that can order them is the id tiebreak --
  // without it this test would flake, which is the point of having it.
  await db.execute(sql`
    update reviews set created_at = timestamptz '2026-03-01 09:00:00+08'
    where id = ${older}::uuid
  `)
  await db.execute(sql`
    update reviews set created_at = timestamptz '2026-03-02 09:00:00+08'
    where id = any (array[${tieA}::uuid, ${tieB}::uuid])
  `)

  const page = await getOwnerReviews([branchId])
  const tied = [tieA, tieB].sort().reverse() // id desc
  expect(page.reviews.map((row) => row.id)).toEqual([...tied, older])
})

test('getOwnerReviews reports the Manila calendar date, not the UTC one', async () => {
  // 2026-03-02 01:30+08 is 2026-03-01 17:30 UTC -- the two zones disagree on
  // which day this is, unlike an instant near local noon where they'd agree
  // by coincidence. Same backdate technique as the tiebreak test above.
  // Dropping `at time zone 'Asia/Manila'` in src/lib/owner/reviews.ts would
  // report the UTC date ('2026-03-01') instead, so this pins the conversion.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const reviewId = await seedReview({ courtId: courtIds[0], branchId, playerId, hour: 12 })
  await db.execute(sql`
    update reviews set created_at = timestamptz '2026-03-02 01:30:00+08'
    where id = ${reviewId}::uuid
  `)

  const page = await getOwnerReviews([branchId])
  expect(page.reviews[0].createdOn).toBe('2026-03-02')
})

test('getOwnerReviews caps the list and says so', async () => {
  // OWNER_REVIEWS_LIMIT + 1 rows, inserted in two statements rather than 202
  // round trips: the pooler would not enjoy the latter and neither would the
  // 20s timeout. Consecutive whole hours on ONE court, so bookings_no_overlap
  // (a '[)' range) is satisfied by construction.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
      fee_config_snapshot
    )
    select ${courtIds[0]}::uuid, ${branchId}::uuid, ${playerId}::uuid,
      timestamptz '2026-04-01 00:00:00+08' + (n * interval '1 hour'),
      timestamptz '2026-04-01 01:00:00+08' + (n * interval '1 hour'),
      'completed', 30000, 0, 30000, 3000, 0, 27000, '{"test": true}'::jsonb
    from generate_series(0, ${OWNER_REVIEWS_LIMIT}) as n
  `)
  await db.execute(sql`
    insert into reviews (booking_id, branch_id, player_id, rating, body)
    select bk.id, bk.branch_id, bk.player_id, 5, null
    from bookings bk where bk.branch_id = ${branchId}::uuid
  `)

  const page = await getOwnerReviews([branchId])
  expect(page.reviews).toHaveLength(OWNER_REVIEWS_LIMIT)
  expect(page.capped).toBe(true)

  // Exactly at the limit is NOT capped -- an off-by-one here would show the
  // "showing the most recent 100" line to someone whose 100 reviews are all
  // on the page.
  await db.execute(sql`
    delete from reviews where id in (
      select id from reviews where branch_id = ${branchId}::uuid
      order by created_at, id limit 1
    )
  `)
  const exact = await getOwnerReviews([branchId])
  expect(exact.reviews).toHaveLength(OWNER_REVIEWS_LIMIT)
  expect(exact.capped).toBe(false)
})
