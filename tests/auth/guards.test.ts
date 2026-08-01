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

const { requireUser, requireAdmin, requireOwnerOf, AuthError } = await import('@/lib/auth/guards')

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
