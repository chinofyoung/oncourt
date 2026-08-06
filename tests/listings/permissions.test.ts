import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  seedBranchWithCourts,
  seedPlayer,
  seedStaffGrant,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

/**
 * The spec's permission table, asserted against the real guards.
 *
 * Only the SESSION boundary is stubbed — the same `vi.mock` the guards' own
 * tests use (tests/auth/guards.test.ts). Everything below it (the profiles
 * lookup, the ownership join, the branch_staff grant read) hits the real
 * database, which is the whole point: this is the file that would fail if
 * `manage_courts` ever stopped meaning what the listings actions assume.
 *
 * The actions themselves are not called here. They invoke revalidatePath()
 * and redirect(), which throw outside a request context; the project's
 * convention (tests/bookings/review-action.test.ts) is to test the guards and
 * the server-only lib, with tests/auth/action-coverage.test.ts proving every
 * 'use server' file calls a guard at all.
 */
const claims = vi.hoisted(() => ({ value: null as null | { sub: string } }))

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getClaims: async () => ({ data: claims.value ? { claims: claims.value } : null }) },
  }),
}))

const { AuthError, requireBranchAccess, requireOwner, requireOwnerOf } = await import(
  '@/lib/auth/guards'
)
const { branchIdOfCourt } = await import('@/lib/courts/lookup')

function signInAs(userId: string) {
  claims.value = { sub: userId }
}

beforeEach(() => {
  claims.value = null
})

async function expectForbidden(promise: Promise<unknown>) {
  await expect(promise).rejects.toBeInstanceOf(AuthError)
  await promise.catch((error) => expect((error as InstanceType<typeof AuthError>).status).toBe(403))
}

test('the branch owner may manage courts on their own branch', async () => {
  const { ownerId, branchId } = await seedBranchWithCourts(1)
  signInAs(ownerId)
  await expect(requireBranchAccess(branchId, 'manage_courts')).resolves.toMatchObject({
    id: ownerId,
  })
})

test('staff holding manage_courts on that branch may manage its courts', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, manageCourts: true })

  signInAs(staffId)
  await expect(requireBranchAccess(branchId, 'manage_courts')).resolves.toMatchObject({
    id: staffId,
  })
})

test('staff with a grant on that branch but no manage_courts flag are refused', async () => {
  // The grant exists, so requireBranchAccess finds a row — this asserts it
  // reads the FLAG, not merely the row's existence.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, viewBookings: true, blockSlots: true })

  signInAs(staffId)
  await expectForbidden(requireBranchAccess(branchId, 'manage_courts'))
})

test('staff holding manage_courts on a different branch are refused', async () => {
  // Per-branch, not per-person: the permission model's whole point.
  const granted = await seedBranchWithCourts(1)
  const other = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: granted.branchId, userId: staffId, manageCourts: true })

  signInAs(staffId)
  await expect(requireBranchAccess(granted.branchId, 'manage_courts')).resolves.toBeTruthy()
  await expectForbidden(requireBranchAccess(other.branchId, 'manage_courts'))
})

test('a signed-in stranger is refused', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const strangerId = await seedPlayer()

  signInAs(strangerId)
  await expectForbidden(requireBranchAccess(branchId, 'manage_courts'))
})

test('a signed-out visitor is refused with 401', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  await expect(requireBranchAccess(branchId, 'manage_courts')).rejects.toMatchObject({ status: 401 })
})

test('staff with manage_courts still cannot create courts or edit branch fields', async () => {
  // createCourtAction and updateBranchAction guard requireOwnerOf, not
  // requireBranchAccess — the spec is explicit that staff never create
  // branches or courts and never edit branch-level fields.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, manageCourts: true })

  signInAs(staffId)
  await expectForbidden(requireOwnerOf(branchId))
})

test('staff with manage_courts still cannot create a branch', async () => {
  // createBranchAction guards requireOwner, which is a ROLE check: staff
  // remain role='player' by construction (see the roles slice).
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, manageCourts: true })

  signInAs(staffId)
  await expectForbidden(requireOwner())
})

test('the owner passes both the branch-scoped and the role-level owner guards', async () => {
  const { ownerId, branchId } = await seedBranchWithCourts(1)
  signInAs(ownerId)
  await expect(requireOwnerOf(branchId)).resolves.toMatchObject({ id: ownerId })
  await expect(requireOwner()).resolves.toMatchObject({ id: ownerId })
})

test('a court resolves to its own branch, so a granted branch cannot be borrowed', async () => {
  // The confused-deputy case the court-scoped actions are built to prevent:
  // a staff member with manage_courts on branch A submits branch B's court
  // id. Because the branch is read from the COURT row rather than the form,
  // the guard is asked about B and refuses.
  const granted = await seedBranchWithCourts(1)
  const other = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: granted.branchId, userId: staffId, manageCourts: true })

  const resolved = await branchIdOfCourt(other.courtIds[0])
  expect(resolved).toBe(other.branchId)
  expect(resolved).not.toBe(granted.branchId)

  signInAs(staffId)
  await expectForbidden(requireBranchAccess(resolved!, 'manage_courts'))
})

test('a court id that does not exist resolves to null and never reaches a guard', async () => {
  // The action returns its generic bad-input message on null, so a forged id
  // cannot be used to probe which court ids exist.
  expect(await branchIdOfCourt('11111111-2222-3333-4444-555555555555')).toBeNull()
})

test('an admin passes the branch-scoped guard on a branch they do not own', async () => {
  // requireBranchAccess short-circuits for admins by design (see its
  // docstring). Pinned here so a future narrowing of the listings guards
  // cannot lock moderators out silently.
  const { branchId } = await seedBranchWithCourts(1)
  const adminId = await seedPlayer()
  await db.execute(sql`update profiles set role = 'admin' where id = ${adminId}::uuid`)

  signInAs(adminId)
  await expect(requireBranchAccess(branchId, 'manage_courts')).resolves.toMatchObject({
    id: adminId,
  })
})
