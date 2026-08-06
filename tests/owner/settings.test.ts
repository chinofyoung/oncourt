import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  seedAdmin,
  seedBranchWithCourts,
  seedOwner,
  seedPlayer,
  seedStaffGrant,
  teardownFixtures,
} from '../helpers/fixtures'
import { MAX_PHOTO_BYTES } from '@/lib/photos'
import { MAX_BUSINESS_NAME_LENGTH } from '@/lib/staff/write'
import type { StorageClient } from '@/lib/listings/storage'
import {
  getOwnerSettings,
  LOGO_BUCKET,
  removeBusinessLogo,
  updateBusinessLogo,
  updateBusinessName,
} from '@/lib/owner/settings'

afterAll(teardownFixtures)

const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555'

/**
 * Two boundaries are replaced in this file and nothing else is.
 *
 *   1. The SESSION, for the guard matrix at the bottom — the same vi.mock
 *      tests/auth/guards.test.ts and tests/listings/permissions.test.ts use.
 *      Everything under it (the profiles lookup, the role read) is real.
 *   2. The STORAGE CLIENT, passed as a parameter exactly as
 *      tests/listings/photos.test.ts does. The bucket is shared with the
 *      seeded demo photos and an upload has no rollback, so a test that really
 *      uploaded would leave objects in a shared Supabase project forever.
 *
 * Every profiles row below is real.
 */
const claims = vi.hoisted(() => ({ value: null as null | { sub: string } }))

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getClaims: async () => ({ data: claims.value ? { claims: claims.value } : null }) },
  }),
}))

const { AuthError, requireOwner } = await import('@/lib/auth/guards')

function signInAs(userId: string) {
  claims.value = { sub: userId }
}

beforeEach(() => {
  claims.value = null
})

/**
 * `pathAtCall` is what makes the ordering assertions real rather than
 * decorative: the fake reads profiles.business_logo_path AT THE MOMENT storage
 * is called, so "object first, then row" and "old object removed AFTER the row
 * update" are observed instead of assumed.
 */
type StorageCall = { op: 'upload' | 'remove'; bucket: string; paths: string[]; pathAtCall: string | null }

function recorder(ownerId: string, options: { uploadError?: string; removeError?: string } = {}) {
  const calls: StorageCall[] = []

  async function currentPath(): Promise<string | null> {
    const result = await db.execute(sql`
      select business_logo_path from profiles where id = ${ownerId}::uuid
    `)
    return (result.rows[0]?.business_logo_path as string | null) ?? null
  }

  const client: StorageClient = {
    async upload(bucket, path) {
      calls.push({ op: 'upload', bucket, paths: [path], pathAtCall: await currentPath() })
      return { error: options.uploadError ?? null }
    },
    async remove(bucket, paths) {
      calls.push({ op: 'remove', bucket, paths, pathAtCall: await currentPath() })
      return { error: options.removeError ?? null }
    },
  }

  return { client, calls }
}

function imageFile(type = 'image/jpeg', bytes = 64): File {
  return new File([new Uint8Array(bytes)], 'logo', { type })
}

async function logoPathOf(ownerId: string): Promise<string | null> {
  const result = await db.execute(sql`
    select business_logo_path from profiles where id = ${ownerId}::uuid
  `)
  return (result.rows[0].business_logo_path as string | null) ?? null
}

// -------------------------------------------------------------- getOwnerSettings

test('getOwnerSettings returns the three fields the page renders', async () => {
  const ownerId = await seedOwner()
  const slug = `settings-${crypto.randomUUID()}`
  await db.execute(sql`
    update profiles set business_name = 'Smash Zone', slug = ${slug}
    where id = ${ownerId}::uuid
  `)

  await expect(getOwnerSettings(ownerId)).resolves.toEqual({
    businessName: 'Smash Zone',
    slug,
    logoPath: null,
  })
})

test('getOwnerSettings returns nulls, not an error, for an owner promoted without a name', async () => {
  // seedOwner() flips the role and nothing else, which is a real state: the
  // page renders the em-dash brand-link line for exactly this row.
  const ownerId = await seedOwner()
  await expect(getOwnerSettings(ownerId)).resolves.toEqual({
    businessName: null,
    slug: null,
    logoPath: null,
  })
})

test('getOwnerSettings returns null for anyone who is not an owner', async () => {
  // An ADMIN is the case that matters: requireOwner admits them, so they can
  // reach the page, and this null is what tells the page to say so.
  await expect(getOwnerSettings(await seedAdmin())).resolves.toBeNull()
  await expect(getOwnerSettings(await seedPlayer())).resolves.toBeNull()
  await expect(getOwnerSettings(UNKNOWN_ID)).resolves.toBeNull()
})

// ------------------------------------------------------------ updateBusinessName

test('updateBusinessName trims and stores the name', async () => {
  const ownerId = await seedOwner()

  await expect(
    updateBusinessName({ ownerId, businessName: '  Smash Zone Marikina  ' }),
  ).resolves.toEqual({ ok: true })
  await expect(getOwnerSettings(ownerId)).resolves.toMatchObject({
    businessName: 'Smash Zone Marikina',
  })
})

test('updateBusinessName refuses an empty or whitespace-only name and writes nothing', async () => {
  const ownerId = await seedOwner()
  await updateBusinessName({ ownerId, businessName: 'Smash Zone' })

  for (const businessName of ['', '   ', '\n\t ']) {
    await expect(updateBusinessName({ ownerId, businessName })).resolves.toEqual({
      ok: false,
      reason: 'empty_name',
    })
  }
  await expect(getOwnerSettings(ownerId)).resolves.toMatchObject({ businessName: 'Smash Zone' })
})

test('updateBusinessName refuses a name past the shared cap, and allows the cap itself', async () => {
  // The cap is imported from src/lib/staff/write.ts, the same authority
  // promoteToOwner uses — never a second copy of the number.
  const ownerId = await seedOwner()

  await expect(
    updateBusinessName({ ownerId, businessName: 'x'.repeat(MAX_BUSINESS_NAME_LENGTH + 1) }),
  ).resolves.toEqual({ ok: false, reason: 'name_too_long' })
  await expect(getOwnerSettings(ownerId)).resolves.toMatchObject({ businessName: null })

  await expect(
    updateBusinessName({ ownerId, businessName: 'x'.repeat(MAX_BUSINESS_NAME_LENGTH) }),
  ).resolves.toEqual({ ok: true })
})

test('updateBusinessName measures the cap AFTER trimming', async () => {
  // Otherwise a name that fits would be refused for its trailing spaces.
  const ownerId = await seedOwner()
  const name = 'x'.repeat(MAX_BUSINESS_NAME_LENGTH)
  await expect(updateBusinessName({ ownerId, businessName: `  ${name}  ` })).resolves.toEqual({
    ok: true,
  })
  await expect(getOwnerSettings(ownerId)).resolves.toMatchObject({ businessName: name })
})

test('updateBusinessName refuses anyone whose profile is not role = owner', async () => {
  // An admin passes requireOwner but is not an owner, so the write's own
  // `role = 'owner'` scoping is the second layer that stops it. The reason is
  // not_an_owner rather than stale: telling an admin to reload would be advice
  // that never comes true.
  for (const id of [await seedAdmin(), await seedPlayer(), UNKNOWN_ID]) {
    await expect(updateBusinessName({ ownerId: id, businessName: 'Smash Zone' })).resolves.toEqual({
      ok: false,
      reason: 'not_an_owner',
    })
  }
})

// ------------------------------------------------------------ updateBusinessLogo

test('updateBusinessLogo uploads to logos/<ownerId>/ in the branch-photos bucket, object first', async () => {
  const ownerId = await seedOwner()
  const { client, calls } = recorder(ownerId)

  await expect(updateBusinessLogo({ ownerId, file: imageFile(), storage: client })).resolves.toEqual(
    { ok: true },
  )

  expect(calls).toHaveLength(1)
  expect(calls[0].op).toBe('upload')
  expect(calls[0].bucket).toBe(LOGO_BUCKET)
  expect(LOGO_BUCKET).toBe('branch-photos')
  // A fresh UUID per object, never the uploaded filename: two logos called
  // logo.png would collide, and a user-supplied name in a public URL is a
  // path-traversal question nobody needs to answer.
  expect(calls[0].paths[0]).toMatch(
    new RegExp(`^logos/${ownerId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$`),
  )
  // OBJECT FIRST: the row still had no path when storage was called.
  expect(calls[0].pathAtCall).toBeNull()
  expect(await logoPathOf(ownerId)).toBe(calls[0].paths[0])
})

test('updateBusinessLogo picks the extension from the content type', async () => {
  for (const [type, extension] of [
    ['image/png', 'png'],
    ['image/webp', 'webp'],
  ] as const) {
    const ownerId = await seedOwner()
    const { client } = recorder(ownerId)
    await updateBusinessLogo({ ownerId, file: imageFile(type), storage: client })
    expect(await logoPathOf(ownerId)).toMatch(new RegExp(`\\.${extension}$`))
  }
})

test('updateBusinessLogo removes the replaced object AFTER the new path is stored', async () => {
  const ownerId = await seedOwner()
  await updateBusinessLogo({ ownerId, file: imageFile(), storage: recorder(ownerId).client })
  const firstPath = await logoPathOf(ownerId)

  const { client, calls } = recorder(ownerId)
  await expect(
    updateBusinessLogo({ ownerId, file: imageFile('image/png'), storage: client }),
  ).resolves.toEqual({ ok: true })

  const secondPath = await logoPathOf(ownerId)
  expect(secondPath).not.toBe(firstPath)

  expect(calls.map((call) => call.op)).toEqual(['upload', 'remove'])
  // Object first: the row still pointed at the OLD path during the upload.
  expect(calls[0].pathAtCall).toBe(firstPath)
  // Cleanup after: the row already pointed at the NEW path when the old object
  // was removed, so a crash between the two leaves a dangling object rather
  // than a row pointing at nothing.
  expect(calls[1].paths).toEqual([firstPath])
  expect(calls[1].pathAtCall).toBe(secondPath)
})

test('updateBusinessLogo still succeeds when removing the replaced object fails', async () => {
  // BEST EFFORT, deliberately. A dangling old object costs storage; a failed
  // save costs the owner their logo for no reason they can act on.
  const ownerId = await seedOwner()
  await updateBusinessLogo({ ownerId, file: imageFile(), storage: recorder(ownerId).client })
  const firstPath = await logoPathOf(ownerId)

  const { client } = recorder(ownerId, { removeError: 'storage exploded' })
  await expect(
    updateBusinessLogo({ ownerId, file: imageFile(), storage: client }),
  ).resolves.toEqual({ ok: true })

  const secondPath = await logoPathOf(ownerId)
  expect(secondPath).not.toBeNull()
  expect(secondPath).not.toBe(firstPath)
})

test('updateBusinessLogo writes no row when the upload fails', async () => {
  const ownerId = await seedOwner()
  const { client, calls } = recorder(ownerId, { uploadError: 'network down' })

  await expect(updateBusinessLogo({ ownerId, file: imageFile(), storage: client })).resolves.toEqual(
    { ok: false, reason: 'upload_failed' },
  )
  expect(calls.map((call) => call.op)).toEqual(['upload'])
  expect(await logoPathOf(ownerId)).toBeNull()
})

test('updateBusinessLogo refuses an empty, wrong-typed or oversized file before touching storage', async () => {
  const ownerId = await seedOwner()

  const cases: [File, string][] = [
    // An <input type="file"> with nothing chosen still submits a zero-byte
    // entry, so "empty" is the normal shape of "no logo attached".
    [imageFile('image/jpeg', 0), 'no_file'],
    [imageFile('image/gif'), 'bad_type'],
    [imageFile('application/pdf'), 'bad_type'],
    [imageFile('image/jpeg', MAX_PHOTO_BYTES + 1), 'too_large'],
  ]

  for (const [file, reason] of cases) {
    const { client, calls } = recorder(ownerId)
    await expect(updateBusinessLogo({ ownerId, file, storage: client })).resolves.toEqual({
      ok: false,
      reason,
    })
    expect(calls).toEqual([])
  }
  expect(await logoPathOf(ownerId)).toBeNull()
})

test('updateBusinessLogo takes the uploaded object back out when the profile is not an owner', async () => {
  // The object went up before the row was checked, so a refusal has to
  // reclaim it — the same cleanup addPhoto does for a vanished target.
  const adminId = await seedAdmin()
  const { client, calls } = recorder(adminId)

  await expect(updateBusinessLogo({ ownerId: adminId, file: imageFile(), storage: client })).resolves.toEqual(
    { ok: false, reason: 'not_an_owner' },
  )
  expect(calls.map((call) => call.op)).toEqual(['upload', 'remove'])
  expect(calls[1].paths).toEqual(calls[0].paths)
  expect(await logoPathOf(adminId)).toBeNull()
})

// ------------------------------------------------------------ removeBusinessLogo

test('removeBusinessLogo nulls the path, then removes the object', async () => {
  const ownerId = await seedOwner()
  await updateBusinessLogo({ ownerId, file: imageFile(), storage: recorder(ownerId).client })
  const path = await logoPathOf(ownerId)

  const { client, calls } = recorder(ownerId)
  await expect(removeBusinessLogo({ ownerId, storage: client })).resolves.toEqual({ ok: true })

  expect(await logoPathOf(ownerId)).toBeNull()
  expect(calls.map((call) => call.op)).toEqual(['remove'])
  expect(calls[0].bucket).toBe(LOGO_BUCKET)
  expect(calls[0].paths).toEqual([path])
  // ROW FIRST here, the opposite order from the upload and for the same
  // reason: the failure this ordering avoids is a row pointing at an object
  // that is already gone.
  expect(calls[0].pathAtCall).toBeNull()
})

test('removeBusinessLogo still succeeds when the object removal fails', async () => {
  const ownerId = await seedOwner()
  await updateBusinessLogo({ ownerId, file: imageFile(), storage: recorder(ownerId).client })

  const { client } = recorder(ownerId, { removeError: 'storage exploded' })
  await expect(removeBusinessLogo({ ownerId, storage: client })).resolves.toEqual({ ok: true })
  expect(await logoPathOf(ownerId)).toBeNull()
})

test('removeBusinessLogo is a no-op, not an error, when there is no logo', async () => {
  // A double-submit must not be a failure the owner has to interpret.
  const ownerId = await seedOwner()
  const { client, calls } = recorder(ownerId)

  await expect(removeBusinessLogo({ ownerId, storage: client })).resolves.toEqual({ ok: true })
  expect(calls).toEqual([])
})

test('removeBusinessLogo refuses anyone whose profile is not role = owner', async () => {
  for (const id of [await seedAdmin(), await seedPlayer(), UNKNOWN_ID]) {
    const { client, calls } = recorder(id)
    await expect(removeBusinessLogo({ ownerId: id, storage: client })).resolves.toEqual({
      ok: false,
      reason: 'not_an_owner',
    })
    expect(calls).toEqual([])
  }
})

// ------------------------------------------------------------------ the guard

test('requireOwner admits an owner and an admin, and refuses everyone else', async () => {
  // The FIRST of the two layers. The second is the `role = 'owner'` scoping in
  // every write above — which is exactly why an admin passing here is safe.
  const ownerId = await seedOwner()
  signInAs(ownerId)
  await expect(requireOwner()).resolves.toMatchObject({ id: ownerId, role: 'owner' })

  const adminId = await seedAdmin()
  signInAs(adminId)
  await expect(requireOwner()).resolves.toMatchObject({ id: adminId, role: 'admin' })
})

test('requireOwner refuses a plain player and a staff member with a grant', async () => {
  // Settings is brand identity: staff never see it, no matter what they were
  // granted. There is no branch-scoped flag that opens this page.
  const playerId = await seedPlayer()
  signInAs(playerId)
  await expect(requireOwner()).rejects.toBeInstanceOf(AuthError)

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
  await requireOwner().catch((error) => expect((error as InstanceType<typeof AuthError>).status).toBe(403))
  await expect(requireOwner()).rejects.toBeInstanceOf(AuthError)
})

test('requireOwner reports 401, not 403, for a signed-out visitor', async () => {
  // beforeEach leaves claims null.
  await expect(requireOwner()).rejects.toBeInstanceOf(AuthError)
  await requireOwner().catch((error) => expect((error as InstanceType<typeof AuthError>).status).toBe(401))
})
