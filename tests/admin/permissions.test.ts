import { readFile } from 'node:fs/promises'
import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import {
  seedAdmin,
  seedBranchWithCourts,
  seedOwner,
  seedPlayer,
  seedStaffGrant,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

/**
 * The spec's admin rule — "admin actions behind requireAdmin" — asserted
 * against the real guard, with only the SESSION stubbed (the same vi.mock
 * tests/auth/guards.test.ts uses). Everything below it, including the role
 * read, hits the real database.
 *
 * The actions themselves are not called here: they invoke revalidatePath(),
 * which throws outside a request context. The project's convention is to test
 * the guards and the server-only libs — so this file also makes the structural
 * assertions that pin the actions to those libs, which is how "the promote
 * screen wraps the already-tested promoteToOwner" becomes something a test can
 * actually check rather than something a reviewer has to remember.
 */
const claims = vi.hoisted(() => ({ value: null as null | { sub: string } }))

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getClaims: async () => ({ data: claims.value ? { claims: claims.value } : null }) },
  }),
}))

const { AuthError, requireAdmin } = await import('@/lib/auth/guards')

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

test('an admin may run the moderation actions', async () => {
  const adminId = await seedAdmin()
  signInAs(adminId)
  await expect(requireAdmin()).resolves.toMatchObject({ id: adminId, role: 'admin' })
})

test('an owner may not — owning venues is not moderating them', async () => {
  // The distinction this whole slice rests on. requireOwnerOf and
  // requireBranchAccess both let an admin through; nothing lets an owner into
  // requireAdmin, so an owner cannot approve their own court.
  const ownerId = await seedOwner()
  signInAs(ownerId)
  await expectForbidden(requireAdmin())
})

test('a plain player and a fully-granted staff member may not', async () => {
  const playerId = await seedPlayer()
  signInAs(playerId)
  await expectForbidden(requireAdmin())

  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({
    branchId,
    userId: staffId,
    viewBookings: true,
    blockSlots: true,
    manageCourts: true,
    viewEarnings: true,
  })
  signInAs(staffId)
  // Every permission on that branch, and still not an admin: manage_courts is
  // "edit this branch's courts", never "approve anyone's".
  await expectForbidden(requireAdmin())
})

test('a signed-out caller gets 401, not 403', async () => {
  await expect(requireAdmin()).rejects.toMatchObject({ status: 401 })
})

test('every admin action is guarded, and delegates to the already-tested libraries', async () => {
  const source = await readFile('src/app/admin/actions.ts', 'utf8')

  expect(source).toMatch(/^\s*['"]use server['"]/m)
  // Seven exported functions and no eighth: every export of a 'use server'
  // file is a client-invokable endpoint, so an accidentally exported helper
  // is an accidentally published endpoint. The seventh is
  // updateOwnerFeeOverrideAction, the Owners-directory per-owner fee
  // override — it must call the guard exactly like the other six.
  // `refuseUnlessAdmin` now lives in src/lib/admin/guard.ts, a plain server
  // module imported here (not re-exported) — it moved there specifically so
  // a second 'use server' file (src/app/admin/settings/actions.ts) could
  // share it without either duplicating it or adding an eighth export to
  // this one.
  expect(source.match(/export async function/g) ?? []).toHaveLength(7)
  expect(source.match(/await refuseUnlessAdmin\(\)/g)).toHaveLength(7)
  expect(source).toContain('requireAdmin')

  // The promote screen WRAPS slice A's tested function rather than
  // re-implementing the role flip — which is what keeps the grant-revocation
  // side effect (a user is never simultaneously an owner and someone's staff)
  // attached to promotion.
  expect(source).toContain("from '@/lib/staff/write'")
  expect(source).toContain('promoteToOwner')
  expect(source).toContain("from '@/lib/admin/write'")
  expect(source).toContain("from '@/lib/admin/queries'")

  // No SQL in a 'use server' file: every read and write goes through a
  // server-only module that has its own tests.
  expect(source).not.toContain('db.execute')
  expect(source).not.toContain('update profiles')
  expect(source).not.toContain('update courts')
})

test('the admin guard adapter itself calls requireAdmin', async () => {
  // Final whole-branch review, item #2: tests/auth/action-coverage.test.ts's
  // repo-wide scan trusts 'refuseUnlessAdmin' as a guard purely by name — a
  // grep for that string proves a 'use server' file CALLS something named
  // refuseUnlessAdmin, never that the thing it calls actually guards
  // anything. That trust is only legitimate if this assertion holds: this
  // pins refuseUnlessAdmin's own module (src/lib/admin/guard.ts) to the real
  // primitive, requireAdmin, imported from '@/lib/auth/guards' and actually
  // invoked, not just mentioned in a comment. No other test in this file (or
  // in action-coverage.test.ts) checks guard.ts's own source — the
  // 'src/app/admin/actions.ts' test above pins THAT file's use of the
  // adapter, but the adapter moved out of actions.ts specifically so a
  // second 'use server' file could share it, and nothing was left behind
  // pinning what the relocated code actually does.
  const source = await readFile('src/lib/admin/guard.ts', 'utf8')
  expect(source).toContain("from '@/lib/auth/guards'")
  expect(source).toMatch(/\brequireAdmin\b/)
  expect(source).toMatch(/await\s+requireAdmin\(\)/)
})
