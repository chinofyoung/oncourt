import { expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { Client } from 'pg'
import { db } from '@/db'
import { manilaHour, seedBranchWithCourts, seedPlayer } from '../helpers/fixtures'

test('both cron jobs are registered', async () => {
  const result = await db.execute(
    sql`select jobname from cron.job where jobname in ('expire-stale-holds', 'complete-past-bookings') order by jobname`,
  )
  expect(result.rows.map((r) => r.jobname)).toEqual([
    'complete-past-bookings',
    'expire-stale-holds',
  ])
})

// Final whole-branch review, ALSO FIX #9: expire_stale_holds()/
// complete_past_bookings() are real, unscoped janitor functions (see
// supabase/migrations/20260801110350_storage_and_cron.sql) — calling them
// for real, as the two tests below must in order to actually exercise their
// behavior, updates every OTHER pending_payment/confirmed row in this
// shared, persistent database that happens to satisfy their predicate, not
// just the rows this test created: other tests' leftover rows, the seed's
// rows, the manual-verification branch's rows. Scoping only the *assertion*
// to `branch_id = <this test's branch>` (the original shape of these tests)
// does not fix that — the janitor call itself still runs its real UPDATE
// against the whole table first and that mutation was permanent. Safe
// against a genuinely concurrent test run only because vitest.config.ts sets
// `fileParallelism: false`; it was never safe against the rest of the
// database.
//
// Fixed by running each test's setup, the janitor call, and its assertion
// inside one transaction on a single dedicated connection (BEGIN ...
// ROLLBACK), using the same raw `pg.Client` pattern
// tests/schema/bookings.test.ts's concurrency test already uses — the
// pooled `db` export (src/db/index.ts) spans multiple backend connections on
// different `db.execute()` calls, so it cannot hold one transaction across
// statements. The janitor function still runs for real inside that
// transaction and its real, unscoped effect on the whole table (as visible
// within the transaction) is exactly what gets asserted — this is not
// weakened into checking anything mocked, stubbed, or pre-filtered. The
// ROLLBACK at the end means none of that effect — including whatever it did
// to rows this test did not create — is ever persisted.
async function withRollback(fn: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    await client.query('begin')
    await fn(client)
  } finally {
    await client.query('rollback')
    await client.end()
  }
}

test('the janitor function expires only stale holds', async () => {
  // Default 5s timeout raised: seedBranchWithCourts(2) alone issues ~22
  // sequential round trips against the hosted Supabase pooler, and this
  // test now also opens and connects a dedicated pg.Client (Fix #9, for the
  // BEGIN/ROLLBACK wrapper) on top of that — comparable to why
  // tests/booking/hold.test.ts's larger-fixture tests needed the same bump.
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  const playerId = await seedPlayer()

  await withRollback(async (client) => {
    // One stale hold, one fresh hold.
    await client.query(
      `insert into bookings (court_id, branch_id, player_id, starts_at, ends_at, status, expires_at,
        court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
        platform_fee_centavos, processor_fee_centavos, owner_net_centavos, fee_config_snapshot)
       values
        ($1, $2, $3, $4, $5, 'pending_payment', now() - interval '1 minute',
         26500, 0, 26500, 2650, 0, 23850, '{}'::jsonb),
        ($6, $2, $3, $4, $5, 'pending_payment', now() + interval '10 minutes',
         26500, 0, 26500, 2650, 0, 23850, '{}'::jsonb)`,
      [
        courtIds[0], branchId, playerId,
        manilaHour('2026-09-01', 18).toISOString(),
        manilaHour('2026-09-01', 19).toISOString(),
        courtIds[1],
      ],
    )

    await client.query('select expire_stale_holds()')

    const result = await client.query(
      `select status::text as status, count(*)::int as n from bookings
       where branch_id = $1 group by status order by status::text`,
      [branchId],
    )
    expect(result.rows).toEqual([
      { status: 'expired', n: 1 },
      { status: 'pending_payment', n: 1 },
    ])
  })
}, 15_000)

test('the completion sweep only touches confirmed bookings whose slot has ended', async () => {
  // Same timeout bump as above, same reason.
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  const playerId = await seedPlayer()

  await withRollback(async (client) => {
    await client.query(
      `insert into bookings (court_id, branch_id, player_id, starts_at, ends_at, status,
        court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
        platform_fee_centavos, processor_fee_centavos, owner_net_centavos, fee_config_snapshot)
       values
        ($1, $2, $3, now() - interval '3 hours', now() - interval '2 hours', 'confirmed',
         26500, 0, 26500, 2650, 0, 23850, '{}'::jsonb),
        ($4, $2, $3, now() + interval '2 hours', now() + interval '3 hours', 'confirmed',
         26500, 0, 26500, 2650, 0, 23850, '{}'::jsonb)`,
      [courtIds[0], branchId, playerId, courtIds[1]],
    )

    await client.query('select complete_past_bookings()')

    const result = await client.query(
      `select status::text as status, count(*)::int as n from bookings
       where branch_id = $1 group by status order by status::text`,
      [branchId],
    )
    expect(result.rows).toEqual([
      { status: 'completed', n: 1 },
      { status: 'confirmed', n: 1 },
    ])
  })
}, 15_000)

test('the completion sweep leaves a past-dated blocked row untouched', async () => {
  // Pinned by test, not by a code change: complete_past_bookings() already
  // filters `status = 'confirmed'`. Without this test, a future edit widening
  // that filter would silently flip blocks to 'completed', which would put
  // them in REAL_BOOKING and therefore into every earnings sum — as ₱0 rows,
  // inflating booking counts and occupancy.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(2)
  const playerId = await seedPlayer()

  await withRollback(async (client) => {
    await client.query(
      `insert into bookings (court_id, branch_id, player_id, starts_at, ends_at, status,
        created_by, note,
        court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
        platform_fee_centavos, processor_fee_centavos, owner_net_centavos, fee_config_snapshot)
       values
        ($1, $2, null, now() - interval '3 hours', now() - interval '2 hours', 'blocked',
         $3, 'Resurfacing', 0, 0, 0, 0, 0, 0, null),
        ($4, $2, $5, now() - interval '3 hours', now() - interval '2 hours', 'confirmed',
         null, null, 26500, 0, 26500, 2650, 0, 23850, '{}'::jsonb)`,
      [courtIds[0], branchId, ownerId, courtIds[1], playerId],
    )

    await client.query('select complete_past_bookings()')

    const result = await client.query(
      `select status::text as status, count(*)::int as n from bookings
       where branch_id = $1 group by status order by status::text`,
      [branchId],
    )
    // The confirmed row completed; the blocked row did not move.
    expect(result.rows).toEqual([
      { status: 'blocked', n: 1 },
      { status: 'completed', n: 1 },
    ])
  })
}, 15_000)

test('both storage buckets exist and are public-read', async () => {
  const result = await db.execute(
    sql`select id, public from storage.buckets where id in ('branch-photos', 'court-photos') order by id`,
  )
  expect(result.rows).toEqual([
    { id: 'branch-photos', public: true },
    { id: 'court-photos', public: true },
  ])
})
