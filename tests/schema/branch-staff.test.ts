import { expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBranchWithCourts, seedPlayer } from '../helpers/fixtures'

/**
 * Raw inserts, not a fixture helper: this file is about the constraints
 * themselves, so it must be able to write rows a helper would refuse to
 * build (all-false permissions, a duplicate pair). The staff *fixture*
 * helper lands in Task 3 and is used by the guard/action tests instead.
 *
 * branch_staff has no ON DELETE RESTRICT anywhere — branch_id and user_id both
 * CASCADE — so teardownFixtures()'s auth.users delete reclaims every row these
 * tests create, with no extra cleanup here.
 */
async function grant(opts: {
  branchId: string
  userId: string
  viewBookings?: boolean
  blockSlots?: boolean
  manageCourts?: boolean
  viewEarnings?: boolean
}) {
  return db.execute(sql`
    insert into branch_staff (
      branch_id, user_id, view_bookings, block_slots, manage_courts, view_earnings
    ) values (
      ${opts.branchId}::uuid, ${opts.userId}::uuid,
      ${opts.viewBookings ?? false}, ${opts.blockSlots ?? false},
      ${opts.manageCourts ?? false}, ${opts.viewEarnings ?? false}
    )
    returning id
  `)
}

test('a grant with at least one permission is accepted', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const userId = await seedPlayer()

  const result = await grant({ branchId, userId, viewBookings: true })
  expect(result.rows).toHaveLength(1)
})

test('a grant with every permission false is rejected', async () => {
  // branch_staff_some_permission. A row granting nothing is not a weaker
  // grant, it is a lie: requireBranchAccess would find a row and still deny
  // every permission, so the staff page would list a person who cannot do
  // anything. Revoking is a DELETE, not an all-false UPDATE.
  const { branchId } = await seedBranchWithCourts(1)
  const userId = await seedPlayer()

  await expect(grant({ branchId, userId })).rejects.toMatchObject({
    cause: { code: '23514', constraint: 'branch_staff_some_permission' },
  })
})

test('the same user cannot be granted twice on one branch', async () => {
  // branch_staff_unique (branch_id, user_id). One row per (branch, person):
  // permissions are edited in place, not stacked.
  const { branchId } = await seedBranchWithCourts(1)
  const userId = await seedPlayer()

  await grant({ branchId, userId, blockSlots: true })
  await expect(grant({ branchId, userId, viewEarnings: true })).rejects.toMatchObject({
    cause: { code: '23505' },
  })
})

test('the same user can be granted on two branches with different permissions', async () => {
  // Explicitly allowed by the spec: "Same person may be staffed at several
  // branches with different permissions (one row each)."
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  const userId = await seedPlayer()

  await grant({ branchId: first.branchId, userId, viewBookings: true })
  await grant({ branchId: second.branchId, userId, viewEarnings: true })

  const rows = await db.execute(sql`
    select view_bookings, view_earnings from branch_staff
    where user_id = ${userId}::uuid order by view_bookings
  `)
  expect(rows.rows).toHaveLength(2)
})

test('deleting the branch removes its grants', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const userId = await seedPlayer()
  await grant({ branchId, userId, viewBookings: true })

  await db.execute(sql`delete from branches where id = ${branchId}::uuid`)

  const rows = await db.execute(
    sql`select 1 from branch_staff where branch_id = ${branchId}::uuid`,
  )
  expect(rows.rows).toHaveLength(0)
})

test('deleting the staff user removes their grants', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const userId = await seedPlayer()
  await grant({ branchId, userId, viewBookings: true })

  await db.execute(sql`delete from auth.users where id = ${userId}::uuid`)

  const rows = await db.execute(sql`select 1 from branch_staff where user_id = ${userId}::uuid`)
  expect(rows.rows).toHaveLength(0)
})

test('user_id carries its own index, per the index-every-FK rule', async () => {
  // branch_id needs no separate index: branch_staff_unique's implicit index
  // is a btree on (branch_id, user_id), leading with branch_id.
  const result = await db.execute(sql`
    select indexname from pg_indexes
    where schemaname = 'public' and tablename = 'branch_staff'
    order by indexname
  `)
  expect(result.rows.map((r) => r.indexname)).toContain('branch_staff_user_id_idx')
})

test('branch_staff has RLS enabled and zero policies', async () => {
  const result = await db.execute(sql`
    select
      (select relrowsecurity from pg_class
        where relnamespace = 'public'::regnamespace and relname = 'branch_staff') as rls,
      (select count(*)::int from pg_policies
        where schemaname = 'public' and tablename = 'branch_staff') as policies
  `)
  expect(result.rows[0]).toEqual({ rls: true, policies: 0 })
})
