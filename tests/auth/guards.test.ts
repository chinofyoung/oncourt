import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

// Final whole-branch review, MUST FIX #3: this file seeds its own
// auth.users rows directly (not via tests/helpers/fixtures.ts) and
// previously never cleaned them up, leaking a handful of rows into the
// shared hosted database on every run. Tracked here and swept in the
// `afterAll` below — no bookings are ever created against these users, so
// (unlike tests/schema/bookings.test.ts) a plain cascading delete on
// auth.users is sufficient; there is no bookings.*_id RESTRICT to work
// around.
const createdUserIds: string[] = []

afterAll(async () => {
  if (createdUserIds.length === 0) return
  await db.execute(sql`delete from auth.users where id = any (${sql.param(createdUserIds)}::uuid[])`)
})

// The guards read the session through the server Supabase client; stub only
// that boundary. Everything below it (profiles lookup, ownership join) hits
// the real database.
const claims = vi.hoisted(() => ({ value: null as null | { sub: string; email: string } }))

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getClaims: async () => ({ data: claims.value ? { claims: claims.value } : null }) },
  }),
}))

const {
  requireUser,
  requireAdmin,
  requireOwner,
  requireOwnerOf,
  requirePlayer,
  requireBranchAccess,
  getOptionalUser,
  AuthError,
} = await import('@/lib/auth/guards')

async function seedUser(role: 'player' | 'owner' | 'admin') {
  const email = `${role}-${crypto.randomUUID()}@example.test`
  const inserted = await db.execute(sql`
    insert into auth.users (id, instance_id, aud, role, email)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated', ${email})
    returning id
  `)
  const id = inserted.rows[0].id as string
  createdUserIds.push(id)
  await db.execute(sql`update profiles set role = ${role}::user_role where id = ${id}::uuid`)
  return { id, email }
}

async function seedBranchFor(ownerId: string) {
  const branch = await db.execute(sql`
    insert into branches (owner_id, name, slug, address, city)
    values (${ownerId}::uuid, 'Guard Branch', ${'guard-' + crypto.randomUUID()},
            '1 Test St', 'Marikina')
    returning id
  `)
  return branch.rows[0].id as string
}

async function grant(
  branchId: string,
  userId: string,
  flags: Partial<Record<'view_bookings' | 'block_slots' | 'manage_courts' | 'view_earnings', boolean>>,
) {
  await db.execute(sql`
    insert into branch_staff (
      branch_id, user_id, view_bookings, block_slots, manage_courts, view_earnings
    ) values (
      ${branchId}::uuid, ${userId}::uuid,
      ${flags.view_bookings ?? false}, ${flags.block_slots ?? false},
      ${flags.manage_courts ?? false}, ${flags.view_earnings ?? false}
    )
  `)
}

beforeEach(() => { claims.value = null })

test('requireUser throws 401 when there is no session', async () => {
  await expect(requireUser()).rejects.toMatchObject({ status: 401 })
})

test('requireUser returns the profile role from the database, not the JWT', async () => {
  const user = await seedUser('owner')
  claims.value = { sub: user.id, email: user.email }

  // Asserting `email` too matters here: the mocked getClaims() above never
  // supplies a role, so this also proves the mapping at guards.ts reads
  // `profile.email`/`profile.role` from the database row, not from claims.
  await expect(requireUser()).resolves.toMatchObject({
    id: user.id,
    email: user.email,
    role: 'owner',
  })
})

test('requireUser throws 401 when the session has a valid claim but no profile row', async () => {
  // A random UUID with no matching auth.users/profiles row at all —
  // distinct from the "no session" case, which never has a sub in the
  // first place.
  claims.value = { sub: crypto.randomUUID(), email: 'ghost@example.test' }

  await expect(requireUser()).rejects.toMatchObject({ status: 401 })
})

test('getOptionalUser resolves to the profile role from the database, not the JWT', async () => {
  const user = await seedUser('owner')
  claims.value = { sub: user.id, email: user.email }

  // Same assertion shape as "requireUser returns the profile role from the
  // database, not the JWT" above — proves getOptionalUser() resolves through
  // the same loadSessionUser() mapping, not a separate/divergent path.
  await expect(getOptionalUser()).resolves.toMatchObject({
    id: user.id,
    email: user.email,
    role: 'owner',
  })
})

test('getOptionalUser resolves to null, and does not throw, when there is no session', async () => {
  // Contrast with "requireUser throws 401 when there is no session": the two
  // functions share loadSessionUser() and only diverge in what they do with a
  // null result — this proves getOptionalUser()'s half of that divergence.
  await expect(getOptionalUser()).resolves.toBeNull()
})

test('requireAdmin throws 403 for a player and resolves for an admin', async () => {
  const player = await seedUser('player')
  claims.value = { sub: player.id, email: player.email }
  await expect(requireAdmin()).rejects.toMatchObject({ status: 403 })

  const admin = await seedUser('admin')
  claims.value = { sub: admin.id, email: admin.email }
  await expect(requireAdmin()).resolves.toMatchObject({ role: 'admin' })
})

test('AuthError is thrown, not a bare Error', async () => {
  await expect(requireUser()).rejects.toBeInstanceOf(AuthError)
})

test('requireOwnerOf allows the owner, rejects a stranger, and allows an admin', async () => {
  const owner = await seedUser('owner')
  const branch = await db.execute(sql`
    insert into branches (owner_id, name, slug, address, city)
    values (${owner.id}::uuid, 'Owned Branch', ${'owned-' + crypto.randomUUID()},
            '1 Test St', 'Marikina')
    returning id
  `)
  const branchId = branch.rows[0].id as string

  claims.value = { sub: owner.id, email: owner.email }
  await expect(requireOwnerOf(branchId)).resolves.toMatchObject({ id: owner.id })

  const stranger = await seedUser('owner')
  claims.value = { sub: stranger.id, email: stranger.email }
  await expect(requireOwnerOf(branchId)).rejects.toMatchObject({ status: 403 })

  const admin = await seedUser('admin')
  claims.value = { sub: admin.id, email: admin.email }
  await expect(requireOwnerOf(branchId)).resolves.toMatchObject({ role: 'admin' })
})

test('requireOwnerOf rejects a nonexistent branch id with 403, not a database error', async () => {
  // A non-admin caller: for an admin, requireOwnerOf short-circuits before
  // ever touching the branches table, so this must exercise the join path.
  const stranger = await seedUser('owner')
  claims.value = { sub: stranger.id, email: stranger.email }
  await expect(requireOwnerOf(crypto.randomUUID())).rejects.toMatchObject({ status: 403 })
})

test('requireOwner resolves for an owner, resolves for an admin, and rejects a player', async () => {
  const owner = await seedUser('owner')
  claims.value = { sub: owner.id, email: owner.email }
  await expect(requireOwner()).resolves.toMatchObject({ id: owner.id, role: 'owner' })

  // An admin passes the role gate without owning anything. Admin oversight of
  // OTHER owners' data lives at /admin/*, not here: the owner queries all
  // filter on owner_id, so an admin at /dashboard sees only branches they
  // themselves own.
  const admin = await seedUser('admin')
  claims.value = { sub: admin.id, email: admin.email }
  await expect(requireOwner()).resolves.toMatchObject({ role: 'admin' })

  const player = await seedUser('player')
  claims.value = { sub: player.id, email: player.email }
  await expect(requireOwner()).rejects.toMatchObject({ status: 403 })
})

test('requireOwner throws 401, not 403, when there is no session at all', async () => {
  // Distinguishes "not signed in" from "signed in but wrong role" — the page
  // guards branch on exactly this to choose redirect-to-login vs redirect-to-/bookings.
  await expect(requireOwner()).rejects.toMatchObject({ status: 401 })
})

test('requirePlayer resolves for a player and rejects both owner and admin', async () => {
  // Roles are exclusive now. An owner account is a business account: it can
  // never hold a paid booking anywhere, including on someone else's courts.
  const player = await seedUser('player')
  claims.value = { sub: player.id, email: player.email }
  await expect(requirePlayer()).resolves.toMatchObject({ id: player.id, role: 'player' })

  const owner = await seedUser('owner')
  claims.value = { sub: owner.id, email: owner.email }
  await expect(requirePlayer()).rejects.toMatchObject({ status: 403 })

  // Admins do not book either — moderation is not a shopping account.
  const admin = await seedUser('admin')
  claims.value = { sub: admin.id, email: admin.email }
  await expect(requirePlayer()).rejects.toMatchObject({ status: 403 })
})

test('requirePlayer throws 401, not 403, when there is no session at all', async () => {
  // requirePlayerPage branches on exactly this to choose redirect-to-login
  // over redirect-to-/dashboard.
  await expect(requirePlayer()).rejects.toMatchObject({ status: 401 })
})

test('requireBranchAccess lets the branch owner through for every permission', async () => {
  const owner = await seedUser('owner')
  const branchId = await seedBranchFor(owner.id)
  claims.value = { sub: owner.id, email: owner.email }

  for (const permission of ['view_bookings', 'block_slots', 'manage_courts', 'view_earnings'] as const) {
    await expect(requireBranchAccess(branchId, permission)).resolves.toMatchObject({
      id: owner.id,
    })
  }
})

test('requireBranchAccess lets an admin through without any grant or ownership', async () => {
  const owner = await seedUser('owner')
  const branchId = await seedBranchFor(owner.id)

  const admin = await seedUser('admin')
  claims.value = { sub: admin.id, email: admin.email }
  await expect(requireBranchAccess(branchId, 'block_slots')).resolves.toMatchObject({
    role: 'admin',
  })
})

test('requireBranchAccess admits staff only for the flags they actually hold', async () => {
  const owner = await seedUser('owner')
  const branchId = await seedBranchFor(owner.id)
  const staff = await seedUser('player')
  await grant(branchId, staff.id, { view_bookings: true, block_slots: true })

  claims.value = { sub: staff.id, email: staff.email }
  await expect(requireBranchAccess(branchId, 'view_bookings')).resolves.toMatchObject({
    id: staff.id,
    role: 'player',
  })
  await expect(requireBranchAccess(branchId, 'block_slots')).resolves.toMatchObject({
    id: staff.id,
  })
  // Granted on this branch, but not these two flags.
  await expect(requireBranchAccess(branchId, 'manage_courts')).rejects.toMatchObject({
    status: 403,
  })
  await expect(requireBranchAccess(branchId, 'view_earnings')).rejects.toMatchObject({
    status: 403,
  })
})

test('requireBranchAccess rejects staff on a branch they were not granted', async () => {
  // The scope is the grant's branch, not "any branch of an owner who granted
  // me something" — a front-desk person at one location must not see another.
  const owner = await seedUser('owner')
  const granted = await seedBranchFor(owner.id)
  const otherBranch = await seedBranchFor(owner.id)
  const staff = await seedUser('player')
  await grant(granted, staff.id, { view_bookings: true })

  claims.value = { sub: staff.id, email: staff.email }
  await expect(requireBranchAccess(granted, 'view_bookings')).resolves.toMatchObject({
    id: staff.id,
  })
  await expect(requireBranchAccess(otherBranch, 'view_bookings')).rejects.toMatchObject({
    status: 403,
  })
})

test('requireBranchAccess rejects a plain player and a different owner', async () => {
  const owner = await seedUser('owner')
  const branchId = await seedBranchFor(owner.id)

  const player = await seedUser('player')
  claims.value = { sub: player.id, email: player.email }
  await expect(requireBranchAccess(branchId, 'view_bookings')).rejects.toMatchObject({
    status: 403,
  })

  // Being an owner of SOMETHING is not access to someone else's branch.
  const otherOwner = await seedUser('owner')
  await seedBranchFor(otherOwner.id)
  claims.value = { sub: otherOwner.id, email: otherOwner.email }
  await expect(requireBranchAccess(branchId, 'view_bookings')).rejects.toMatchObject({
    status: 403,
  })
})

test('requireBranchAccess rejects a nonexistent branch id with 403, not a database error', async () => {
  const staff = await seedUser('player')
  claims.value = { sub: staff.id, email: staff.email }
  await expect(requireBranchAccess(crypto.randomUUID(), 'block_slots')).rejects.toMatchObject({
    status: 403,
  })
})

test('requireBranchAccess throws 401, not 403, when there is no session at all', async () => {
  await expect(requireBranchAccess(crypto.randomUUID(), 'view_bookings')).rejects.toMatchObject({
    status: 401,
  })
})
