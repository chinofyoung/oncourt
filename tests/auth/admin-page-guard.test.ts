import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { seedAdmin, seedOwner, seedPlayer, teardownFixtures } from '../helpers/fixtures'

afterAll(teardownFixtures)

/**
 * requireAdminPage's entire contract is "which path does this session end up
 * on", so both boundaries it answers through are replaced here and nothing
 * else is:
 *
 *   1. The SESSION — the same vi.mock tests/auth/guards.test.ts uses.
 *      Everything below it (the profiles lookup, the role read) hits the real
 *      database, which is the point: this file would fail if `role = 'admin'`
 *      ever stopped meaning admin.
 *   2. next/navigation's REDIRECT — the second and last permitted double in
 *      this slice. redirect() throws a framework control-flow signal that only
 *      carries meaning inside a request context; swapping it for an error that
 *      carries the destination is what makes the answer assertable at all.
 *
 * Declared through vi.hoisted() because vi.mock factories are hoisted above
 * every other statement in the file — a plain `class RedirectSignal` below
 * would be in its temporal dead zone when the factory closure is created.
 */
const { RedirectSignal } = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly to: string
    constructor(to: string) {
      super(`redirect:${to}`)
      this.name = 'RedirectSignal'
      this.to = to
    }
  }
  return { RedirectSignal }
})

const claims = vi.hoisted(() => ({ value: null as null | { sub: string } }))

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getClaims: async () => ({ data: claims.value ? { claims: claims.value } : null }) },
  }),
}))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to)
  },
}))

const { requireAdminPage } = await import('@/lib/auth/page-guards')

function signInAs(userId: string) {
  claims.value = { sub: userId }
}

beforeEach(() => {
  claims.value = null
})

async function expectRedirect(promise: Promise<unknown>, to: string) {
  await expect(promise).rejects.toBeInstanceOf(RedirectSignal)
  await promise.catch((error) => expect((error as InstanceType<typeof RedirectSignal>).to).toBe(to))
}

test('requireAdminPage sends a signed-out visitor to login carrying the path back', async () => {
  await expectRedirect(requireAdminPage('/admin'), '/login?next=%2Fadmin')
})

test('requireAdminPage normalizes the next path through safeNextPath', async () => {
  // Not user input today — every caller passes a literal — but there is one
  // definition of an acceptable `next` in this app and this guard uses it,
  // exactly like requireUserPage. "//evil.com/admin" is protocol-relative and
  // resolves cross-origin in a browser, so it collapses to "/".
  await expectRedirect(requireAdminPage('//evil.com/admin'), '/login?next=%2F')
})

test('requireAdminPage sends a signed-in player to the home page', async () => {
  const playerId = await seedPlayer()
  signInAs(playerId)
  await expectRedirect(requireAdminPage('/admin'), '/')
})

test('requireAdminPage sends a signed-in owner to the home page too', async () => {
  // Deliberately the SAME destination as the player above. A redirect that
  // differed by role would tell an owner that /admin is a real place with a
  // different answer for them; it is not, and they learn nothing.
  const ownerId = await seedOwner()
  signInAs(ownerId)
  await expectRedirect(requireAdminPage('/admin'), '/')
})

test('requireAdminPage resolves to the admin session user', async () => {
  const adminId = await seedAdmin()
  signInAs(adminId)
  await expect(requireAdminPage('/admin')).resolves.toMatchObject({
    id: adminId,
    role: 'admin',
  })
})
