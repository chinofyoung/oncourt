import { expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { manilaHour, seedBranchWithCourts, seedPlayer } from '../helpers/fixtures'

/**
 * Raw inserts again, for the same reason as tests/schema/branch-staff.test.ts:
 * these tests must be able to attempt rows no fixture helper would build (a
 * paid booking with a null player_id, a block with no creator, a block with
 * money on it). Task 3's seedBlock() helper is for the query/action tests.
 *
 * Every insert here goes under a fixture-seeded branch/owner, so
 * teardownFixtures() reclaims them — including via its `created_by` clause,
 * added in Task 3, which matters because bookings.created_by is RESTRICT.
 */
const DATE = '2026-11-04'

async function insertPaid(opts: {
  courtId: string
  branchId: string
  playerId: string | null
  startHour: number
  endHour: number
  createdBy?: string | null
  snapshot?: string | null
}) {
  return db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status, created_by,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
      fee_config_snapshot
    ) values (
      ${opts.courtId}::uuid, ${opts.branchId}::uuid, ${opts.playerId}::uuid,
      ${manilaHour(DATE, opts.startHour).toISOString()}::timestamptz,
      ${manilaHour(DATE, opts.endHour).toISOString()}::timestamptz,
      'confirmed', ${opts.createdBy ?? null}::uuid,
      26500, 0, 26500, 2650, 0, 23850,
      ${opts.snapshot === undefined ? '{}' : opts.snapshot}::jsonb
    )
    returning id
  `)
}

async function insertBlock(opts: {
  courtId: string
  branchId: string
  startHour: number
  endHour: number
  createdBy: string | null
  note?: string | null
  money?: number
}) {
  const money = opts.money ?? 0
  return db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status, created_by, note,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
      fee_config_snapshot
    ) values (
      ${opts.courtId}::uuid, ${opts.branchId}::uuid, null,
      ${manilaHour(DATE, opts.startHour).toISOString()}::timestamptz,
      ${manilaHour(DATE, opts.endHour).toISOString()}::timestamptz,
      'blocked', ${opts.createdBy}::uuid, ${opts.note ?? null},
      ${money}, 0, ${money}, ${money}, 0, ${money},
      null::jsonb
    )
    returning id
  `)
}

test('a block with no player, a creator, zero money, and a null snapshot is accepted', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)

  const result = await insertBlock({
    courtId: courtIds[0],
    branchId,
    startHour: 9,
    endHour: 11,
    createdBy: ownerId,
    note: 'Resurfacing',
  })
  expect(result.rows).toHaveLength(1)
})

test('a non-blocked booking with a null player_id is rejected', async () => {
  // bookings_player_unless_blocked. player_id only became nullable to make
  // blocks representable; a paid booking with nobody attached is corruption.
  const { branchId, courtIds } = await seedBranchWithCourts(1)

  await expect(
    insertPaid({ courtId: courtIds[0], branchId, playerId: null, startHour: 12, endHour: 13 }),
  ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'bookings_player_unless_blocked' } })
})

test('a non-blocked booking with a null fee_config_snapshot is rejected', async () => {
  // bookings_snapshot_unless_blocked. Same reasoning: the snapshot is what
  // makes a charge auditable after the fee config changes. Blocks carry no
  // charge, and an empty-object snapshot on one would be a lie, hence null.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await expect(
    insertPaid({
      courtId: courtIds[0],
      branchId,
      playerId,
      startHour: 13,
      endHour: 14,
      snapshot: null,
    }),
  ).rejects.toMatchObject({
    cause: { code: '23514', constraint: 'bookings_snapshot_unless_blocked' },
  })
})

test('a block with a null created_by is rejected', async () => {
  // bookings_blocked_has_creator, forward direction. created_by is the audit
  // trail: a paid booking's creator is its player_id, a block's is whichever
  // owner or staff member took the slot off the market.
  const { branchId, courtIds } = await seedBranchWithCourts(1)

  await expect(
    insertBlock({ courtId: courtIds[0], branchId, startHour: 14, endHour: 15, createdBy: null }),
  ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'bookings_blocked_has_creator' } })
})

test('a non-blocked booking with a created_by set is rejected', async () => {
  // bookings_blocked_has_creator, reverse direction — the constraint is an
  // equivalence, not a one-way requirement. A paid booking's creator is
  // player_id; a second, disagreeing creator column would be two sources of
  // truth for the same fact.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await expect(
    insertPaid({
      courtId: courtIds[0],
      branchId,
      playerId,
      startHour: 15,
      endHour: 16,
      createdBy: ownerId,
    }),
  ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'bookings_blocked_has_creator' } })
})

test('a block carrying nonzero money is rejected', async () => {
  // bookings_blocked_is_free. "Excluded from earnings" is enforced by the
  // status filters in the query layer; this constraint is what makes that
  // enforcement unnecessary to trust — a blocked row cannot hold revenue to
  // leak in the first place, however a future query is written.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)

  await expect(
    insertBlock({
      courtId: courtIds[0],
      branchId,
      startHour: 16,
      endHour: 17,
      createdBy: ownerId,
      money: 30000,
    }),
  ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'bookings_blocked_is_free' } })
})

test('a block excludes an overlapping paid hold on the same court', async () => {
  // The whole reason a block is a bookings row: bookings_no_overlap now lists
  // 'blocked' in its predicate, so the exclusion constraint arbitrates
  // block-vs-booking with no extra code.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await insertBlock({
    courtId: courtIds[0],
    branchId,
    startHour: 18,
    endHour: 20,
    createdBy: ownerId,
  })

  await expect(
    insertPaid({ courtId: courtIds[0], branchId, playerId, startHour: 19, endHour: 21 }),
  ).rejects.toMatchObject({ cause: { code: '23P01', constraint: 'bookings_no_overlap' } })
})

test('a paid booking excludes an overlapping block on the same court', async () => {
  // The other direction, asserted separately: an exclusion constraint is
  // symmetric by definition, but the predicate is not — a bug that dropped
  // 'blocked' from the status list would still pass the test above if the
  // block were inserted second.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await insertPaid({ courtId: courtIds[0], branchId, playerId, startHour: 20, endHour: 22 })

  await expect(
    insertBlock({
      courtId: courtIds[0],
      branchId,
      startHour: 21,
      endHour: 23,
      createdBy: ownerId,
    }),
  ).rejects.toMatchObject({ cause: { code: '23P01', constraint: 'bookings_no_overlap' } })
})

test('a block adjacent to a booking is allowed — half-open bounds still hold', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await insertPaid({ courtId: courtIds[0], branchId, playerId, startHour: 7, endHour: 8 })
  await insertBlock({
    courtId: courtIds[0],
    branchId,
    startHour: 8,
    endHour: 9,
    createdBy: ownerId,
  })

  const result = await db.execute(
    sql`select count(*)::int as n from bookings where court_id = ${courtIds[0]}::uuid`,
  )
  expect(Number(result.rows[0].n)).toBe(2)
})

test('created_by carries its own index, per the index-every-FK rule', async () => {
  const result = await db.execute(sql`
    select indexname from pg_indexes
    where schemaname = 'public' and tablename = 'bookings'
    order by indexname
  `)
  expect(result.rows.map((r) => r.indexname)).toContain('bookings_created_by_idx')
})

test('bookings_no_overlap lists blocked in its predicate', async () => {
  // Reads the live constraint definition rather than inferring it from
  // behavior: this is the assertion that fails loudly if a later migration
  // rebuilds the constraint and forgets 'blocked'.
  const result = await db.execute(sql`
    select pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = 'public.bookings'::regclass and conname = 'bookings_no_overlap'
  `)
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0].def as string).toContain('blocked')
})
