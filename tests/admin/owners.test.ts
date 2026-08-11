import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { getAdminOwners } from '@/lib/admin/owners'
import {
  seedAdmin,
  seedBranchWithCourts,
  seedOwner,
  seedPlayer,
  seedStaffGrant,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

/** A second branch for an owner seedBranchWithCourts() already created. */
async function addBranch(ownerId: string, name: string): Promise<string> {
  const slug = 'fixture-' + crypto.randomUUID()
  const result = await db.execute(sql`
    insert into branches (owner_id, name, slug, address, city, location)
    values (${ownerId}::uuid, ${name}, ${slug}, '2 Fixture Ave', 'Pasig',
            st_setsrid(st_makepoint(121.0851, 14.5764), 4326)::geography)
    returning id
  `)
  return result.rows[0].id as string
}

async function setCourtStatus(courtId: string, status: string): Promise<void> {
  await db.execute(sql`update courts set status = ${status}::court_status where id = ${courtId}::uuid`)
}

test('an owner appears with branches nested, and staff nested inside branches', async () => {
  const { ownerId, branchId } = await seedBranchWithCourts(2)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, viewBookings: true })

  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  expect(owner).toBeDefined()
  expect(owner!.role).toBe('owner')
  expect(owner!.branches).toHaveLength(1)

  const branch = owner!.branches[0]
  expect(branch.id).toBe(branchId)
  expect(branch.name).toBe('Fixture Branch')
  expect(branch.city).toBe('Marikina')
  expect(branch.staff).toHaveLength(1)
  expect(branch.staff[0].userId).toBe(staffId)
  expect(owner!.staffCount).toBe(1)
})

test('permissions are folded exactly, not merged or widened', async () => {
  const { ownerId, branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, viewBookings: true })

  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  expect(owner!.branches[0].staff[0].permissions).toEqual({
    view_bookings: true,
    block_slots: false,
    manage_courts: false,
    view_earnings: false,
  })
})

test('one person staffing two branches appears under each, with that branch permissions', async () => {
  const { ownerId, branchId } = await seedBranchWithCourts(1)
  const secondBranchId = await addBranch(ownerId, 'Fixture Branch Two')
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, viewBookings: true })
  await seedStaffGrant({ branchId: secondBranchId, userId: staffId, viewEarnings: true })

  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  expect(owner!.branches).toHaveLength(2)
  expect(owner!.staffCount).toBe(2)

  const first = owner!.branches.find((b) => b.id === branchId)!
  const second = owner!.branches.find((b) => b.id === secondBranchId)!
  expect(first.staff[0].permissions.view_bookings).toBe(true)
  expect(first.staff[0].permissions.view_earnings).toBe(false)
  expect(second.staff[0].permissions.view_earnings).toBe(true)
  expect(second.staff[0].permissions.view_bookings).toBe(false)
})

test('courtCount counts every status, pendingCourtCount only pending', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(2)
  await setCourtStatus(courtIds[0], 'pending')

  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  const branch = owner!.branches.find((b) => b.id === branchId)!
  expect(branch.courtCount).toBe(2)
  expect(branch.pendingCourtCount).toBe(1)
})

test('a branch with no courts reports zero, not one', async () => {
  // count(c.id) vs count(*): count(*) returns 1 for the left join's null row.
  const { ownerId } = await seedBranchWithCourts(1)
  const emptyBranchId = await addBranch(ownerId, 'Fixture Empty Branch')

  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  const branch = owner!.branches.find((b) => b.id === emptyBranchId)!
  expect(branch.courtCount).toBe(0)
  expect(branch.pendingCourtCount).toBe(0)
  expect(branch.staff).toEqual([])
})

test('an owner with no branches still appears', async () => {
  const ownerId = await seedPlayer()
  await db.execute(sql`update profiles set role = 'owner' where id = ${ownerId}::uuid`)

  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  expect(owner).toBeDefined()
  expect(owner!.branches).toEqual([])
  expect(owner!.staffCount).toBe(0)
})

test("one owner's branches and staff never appear under another", async () => {
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: second.branchId, userId: staffId, viewBookings: true })

  const owners = await getAdminOwners()
  const a = owners.find((row) => row.id === first.ownerId)!
  const b = owners.find((row) => row.id === second.ownerId)!

  expect(a.branches.map((branch) => branch.id)).toEqual([first.branchId])
  expect(b.branches.map((branch) => branch.id)).toEqual([second.branchId])
  expect(a.branches.flatMap((branch) => branch.staff)).toEqual([])
  expect(b.branches[0].staff.map((s) => s.userId)).toEqual([staffId])
})

test('a player is never an owner, even holding a staff grant', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, manageCourts: true })

  const owners = await getAdminOwners()
  expect(owners.find((row) => row.id === staffId)).toBeUndefined()
})

test('an owner fee override surfaces on the directory row', async () => {
  const ownerId = await seedOwner()
  await db.execute(sql`
    update profiles set platform_fee_mode = 'percentage', platform_fee_value = 1500,
                        processor_fee_bearer = 'owner'
    where id = ${ownerId}::uuid
  `)

  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  expect(owner!.feeMode).toBe('percentage')
  expect(owner!.feeValue).toBe(1500)
  expect(owner!.processorFeeBearer).toBe('owner')
})

test('an owner with no override reports null, not zero', async () => {
  const ownerId = await seedOwner()
  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  expect(owner!.feeMode).toBeNull()
  expect(owner!.feeValue).toBeNull()
  expect(owner!.processorFeeBearer).toBeNull()
})

test('an admin is listed only once they own a branch', async () => {
  const adminId = await seedAdmin()
  expect((await getAdminOwners()).find((row) => row.id === adminId)).toBeUndefined()

  const branchId = await addBranch(adminId, 'Fixture Admin Branch')
  const listed = (await getAdminOwners()).find((row) => row.id === adminId)
  expect(listed).toBeDefined()
  expect(listed!.role).toBe('admin')
  expect(listed!.branches.map((branch) => branch.id)).toEqual([branchId])
})
