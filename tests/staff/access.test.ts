import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  seedBranchWithCourts,
  seedOwner,
  seedPlayer,
  seedStaffGrant,
  teardownFixtures,
} from '../helpers/fixtures'
import { branchIdsWith, hasAnyStaffGrant, loadDashboardAccess } from '@/lib/staff/access'

afterAll(teardownFixtures)

/**
 * loadDashboardAccess takes an already-resolved SessionUser, so these tests
 * build one directly instead of stubbing the Supabase client the way
 * tests/auth/guards.test.ts has to. That is the point of the split: the
 * session lookup is the guards' job and is tested there; this module is pure
 * database resolution over a known user.
 */
async function sessionUserFor(id: string) {
  const result = await db.execute(sql`
    select id, email, role, avatar_url, full_name, business_name
    from profiles where id = ${id}::uuid
  `)
  const row = result.rows[0]
  return {
    id: row.id as string,
    email: row.email as string,
    role: row.role as 'player' | 'owner' | 'admin',
    fullName: (row.full_name as string | null) ?? null,
    avatarUrl: (row.avatar_url as string | null) ?? null,
    businessName: (row.business_name as string | null) ?? null,
  }
}

test('an owner sees every branch they own, with all four permissions', async () => {
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  // Put both branches under one owner so this exercises the listing, not the
  // ownership filter (which the next test covers).
  await db.execute(
    sql`update branches set owner_id = ${first.ownerId}::uuid where id = ${second.branchId}::uuid`,
  )

  const access = await loadDashboardAccess(await sessionUserFor(first.ownerId))
  expect(access.isOwner).toBe(true)
  expect(access.branches.map((b) => b.id).sort()).toEqual(
    [first.branchId, second.branchId].sort(),
  )
  expect(access.branches[0].permissions).toEqual({
    view_bookings: true,
    block_slots: true,
    manage_courts: true,
    view_earnings: true,
  })
  expect(access.can).toEqual({
    view_bookings: true,
    block_slots: true,
    manage_courts: true,
    view_earnings: true,
  })
})

test('an owner never sees another owner\'s branch', async () => {
  const mine = await seedBranchWithCourts(1)
  const theirs = await seedBranchWithCourts(1)

  const access = await loadDashboardAccess(await sessionUserFor(mine.ownerId))
  const ids = access.branches.map((b) => b.id)
  expect(ids).toContain(mine.branchId)
  expect(ids).not.toContain(theirs.branchId)
})

test('an owner with no branches is still an owner, with an empty branch list', async () => {
  // The dashboard renders its "no branches yet" empty state for this; the
  // guard must admit them rather than bounce them to /bookings.
  const ownerId = await seedOwner()

  const access = await loadDashboardAccess(await sessionUserFor(ownerId))
  expect(access.isOwner).toBe(true)
  expect(access.branches).toEqual([])
  // Still all-true: an owner's capability is not derived from owning a branch.
  expect(access.can.view_earnings).toBe(true)
})

test('an admin is treated as an owner and sees only branches they own', async () => {
  // Same rule as requireOwner: an admin passes the role gate, and the queries
  // scope by branch, so an admin at /dashboard sees only their own branches.
  // Cross-owner oversight is /admin/*'s job, not this one.
  const other = await seedBranchWithCourts(1)
  const adminId = await seedPlayer()
  await db.execute(sql`update profiles set role = 'admin' where id = ${adminId}::uuid`)

  const access = await loadDashboardAccess(await sessionUserFor(adminId))
  expect(access.isOwner).toBe(true)
  expect(access.branches.map((b) => b.id)).not.toContain(other.branchId)
  expect(access.can.manage_courts).toBe(true)
})

test('staff see only granted branches, each with only its own flags', async () => {
  const granted = await seedBranchWithCourts(1)
  const ungranted = await seedBranchWithCourts(1)
  await db.execute(
    sql`update branches set owner_id = ${granted.ownerId}::uuid where id = ${ungranted.branchId}::uuid`,
  )
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: granted.branchId, userId: staffId, viewBookings: true })

  const access = await loadDashboardAccess(await sessionUserFor(staffId))
  expect(access.isOwner).toBe(false)
  expect(access.branches).toHaveLength(1)
  expect(access.branches[0].id).toBe(granted.branchId)
  expect(access.branches[0].permissions).toEqual({
    view_bookings: true,
    block_slots: false,
    manage_courts: false,
    view_earnings: false,
  })
})

test('`can` is the union across a staff member\'s branches, not the intersection', async () => {
  // Drives which sidebar items render. A person who can see earnings at one
  // branch gets the Earnings nav item; the page then scopes to the branches
  // where that flag is actually true.
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: first.branchId, userId: staffId, viewBookings: true })
  await seedStaffGrant({ branchId: second.branchId, userId: staffId, viewEarnings: true })

  const access = await loadDashboardAccess(await sessionUserFor(staffId))
  expect(access.branches).toHaveLength(2)
  expect(access.can).toEqual({
    view_bookings: true,
    block_slots: false,
    manage_courts: false,
    view_earnings: true,
  })
})

test('a plain player has no access at all', async () => {
  const playerId = await seedPlayer()

  const access = await loadDashboardAccess(await sessionUserFor(playerId))
  expect(access.isOwner).toBe(false)
  expect(access.branches).toEqual([])
  expect(access.can).toEqual({
    view_bookings: false,
    block_slots: false,
    manage_courts: false,
    view_earnings: false,
  })
})

test('branchIdsWith returns every branch id for an owner, regardless of permission', async () => {
  // An owner's `permissions` are all-true by construction, but branchIdsWith
  // must not depend on reading that per-branch object to get the right
  // answer for an owner — the isOwner short-circuit is the actual guarantee.
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  await db.execute(
    sql`update branches set owner_id = ${first.ownerId}::uuid where id = ${second.branchId}::uuid`,
  )

  const access = await loadDashboardAccess(await sessionUserFor(first.ownerId))
  expect(branchIdsWith(access, 'view_earnings').sort()).toEqual(
    [first.branchId, second.branchId].sort(),
  )
})

test('branchIdsWith returns only the branches where staff hold that exact flag', async () => {
  const granted = await seedBranchWithCourts(1)
  const ungranted = await seedBranchWithCourts(1)
  await db.execute(
    sql`update branches set owner_id = ${granted.ownerId}::uuid where id = ${ungranted.branchId}::uuid`,
  )
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: granted.branchId, userId: staffId, viewBookings: true })
  await seedStaffGrant({ branchId: ungranted.branchId, userId: staffId, manageCourts: true })

  const access = await loadDashboardAccess(await sessionUserFor(staffId))
  expect(branchIdsWith(access, 'view_bookings')).toEqual([granted.branchId])
})

test('branchIdsWith on a mixed grant: view_earnings on A but not B must never include B', async () => {
  // This is the exact cross-branch leak the fix closes: `access.can` is a
  // union (true because A grants it), so a page gating on `can` alone would
  // wrongly treat B as visible too. branchIdsWith is what a query's scope
  // list must come from instead.
  const a = await seedBranchWithCourts(1)
  const b = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: a.branchId, userId: staffId, viewEarnings: true, viewBookings: true })
  await seedStaffGrant({ branchId: b.branchId, userId: staffId, viewBookings: true })

  const access = await loadDashboardAccess(await sessionUserFor(staffId))
  expect(access.can.view_earnings).toBe(true)
  expect(branchIdsWith(access, 'view_earnings')).toEqual([a.branchId])
  expect(branchIdsWith(access, 'view_bookings').sort()).toEqual([a.branchId, b.branchId].sort())
})

test('branchIdsWith returns an empty array when nobody holds that permission', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, viewBookings: true })

  const access = await loadDashboardAccess(await sessionUserFor(staffId))
  expect(branchIdsWith(access, 'view_earnings')).toEqual([])
})

test('hasAnyStaffGrant is true only while a grant exists', async () => {
  // Drives the nav account menu's "Venue dashboard" item. One indexed lookup
  // on branch_staff (user_id), which is why the nav can afford it per request.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await expect(hasAnyStaffGrant(staffId)).resolves.toBe(false)

  const grantId = await seedStaffGrant({ branchId, userId: staffId, blockSlots: true })
  await expect(hasAnyStaffGrant(staffId)).resolves.toBe(true)

  await db.execute(sql`delete from branch_staff where id = ${grantId}::uuid`)
  await expect(hasAnyStaffGrant(staffId)).resolves.toBe(false)
})
