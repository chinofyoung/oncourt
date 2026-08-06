import { afterAll, expect, test } from 'vitest'
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
import { allPermissions, noPermissions } from '@/lib/staff/permissions'
import {
  addBranchStaff,
  parseStaffEmail,
  parseStaffId,
  promoteToOwner,
  revokeBranchStaff,
  updateBranchStaff,
} from '@/lib/staff/write'
import { getBranchStaffForOwner } from '@/lib/staff/queries'

afterAll(teardownFixtures)

const UUID = '11111111-2222-3333-4444-555555555555'

function form(entries: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.set(key, value)
  return data
}

async function emailOf(userId: string): Promise<string> {
  const result = await db.execute(sql`select email from profiles where id = ${userId}::uuid`)
  return result.rows[0].email as string
}

test('parseStaffEmail trims, and rejects blanks and non-addresses', () => {
  expect(parseStaffEmail(form({ email: '  Juan@Example.com  ' }))).toBe('Juan@Example.com')
  expect(parseStaffEmail(form({ email: '' }))).toBeNull()
  expect(parseStaffEmail(form({ email: '   ' }))).toBeNull()
  expect(parseStaffEmail(form({ email: 'not-an-email' }))).toBeNull()
  expect(parseStaffEmail(new FormData())).toBeNull()
})

test('parseStaffId accepts a UUID and rejects anything else', () => {
  expect(parseStaffId(form({ staffId: UUID }))).toBe(UUID)
  expect(parseStaffId(form({ staffId: 'nope' }))).toBeNull()
})

test('addBranchStaff grants an existing player the requested permissions', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()

  const result = await addBranchStaff({
    branchId,
    email: await emailOf(staffId),
    permissions: { ...noPermissions(), view_bookings: true, block_slots: true },
  })
  expect(result).toMatchObject({ ok: true })

  const rows = await db.execute(sql`
    select user_id, view_bookings, block_slots, manage_courts, view_earnings
    from branch_staff where branch_id = ${branchId}::uuid
  `)
  expect(rows.rows[0]).toMatchObject({
    user_id: staffId,
    view_bookings: true,
    block_slots: true,
    manage_courts: false,
    view_earnings: false,
  })
})

test('addBranchStaff matches the email case-insensitively', async () => {
  // Google returns lowercase; a person typing a colleague's address types
  // whatever they type. Refusing a case mismatch would be a bug, not security —
  // and it is still an EXACT whole-address match, never a prefix or search.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const email = await emailOf(staffId)

  await expect(
    addBranchStaff({
      branchId,
      email: email.toUpperCase(),
      permissions: { ...noPermissions(), view_bookings: true },
    }),
  ).resolves.toMatchObject({ ok: true })
})

test('addBranchStaff refuses an email with no account', async () => {
  // No pending-invite state exists (spec's Out of scope): the person must sign
  // in once first, which is what creates their profile row.
  const { branchId } = await seedBranchWithCourts(1)

  await expect(
    addBranchStaff({
      branchId,
      email: `ghost-${crypto.randomUUID()}@example.test`,
      permissions: { ...noPermissions(), view_bookings: true },
    }),
  ).resolves.toEqual({ ok: false, reason: 'no_such_user' })
})

test('addBranchStaff refuses an owner and an admin as a target', async () => {
  // Roles are exclusive: an owner is a business account and can never be
  // someone else's staff. There is deliberately no DB constraint for this —
  // a role can change later, and promoteToOwner owns that edge — so this
  // TypeScript check is the enforcement.
  const { branchId } = await seedBranchWithCourts(1)
  const ownerTarget = await seedOwner()
  const adminTarget = await seedAdmin()

  for (const target of [ownerTarget, adminTarget]) {
    await expect(
      addBranchStaff({
        branchId,
        email: await emailOf(target),
        permissions: { ...noPermissions(), view_bookings: true },
      }),
    ).resolves.toEqual({ ok: false, reason: 'not_a_player' })
  }
})

test('addBranchStaff refuses a target promoted to owner between the lookup and the insert', async () => {
  // Pins the TOCTOU fix: the friendly-reason SELECT can only ever see a stale
  // "player" belief, so the real boundary has to be the INSERT ... SELECT's own
  // `role = 'player'` condition. Simulated sequentially here (promote fully
  // commits before addBranchStaff runs at all) rather than as a genuine race,
  // because the INSERT ... SELECT makes "zero rows selected -> zero rows
  // inserted" a structural property, not a timing-dependent one — there is no
  // window for a true concurrent test to prove that a sequential one cannot.
  const { branchId } = await seedBranchWithCourts(1)
  const userId = await seedPlayer()
  const email = await emailOf(userId)

  await expect(
    promoteToOwner({ userId, businessName: 'Raced Courts', slug: 'raced-' + crypto.randomUUID() }),
  ).resolves.toMatchObject({ ok: true })

  await expect(
    addBranchStaff({
      branchId,
      email,
      permissions: { ...noPermissions(), view_bookings: true },
    }),
  ).resolves.toEqual({ ok: false, reason: 'not_a_player' })

  const rows = await db.execute(sql`select 1 from branch_staff where user_id = ${userId}::uuid`)
  expect(rows.rows).toHaveLength(0)
})

test('addBranchStaff refuses an all-false permission set before touching SQL', async () => {
  // branch_staff_some_permission would raise 23514; catching it here turns a
  // crash into a form error, and keeps "revoke" a DELETE rather than an
  // all-false UPDATE.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()

  await expect(
    addBranchStaff({ branchId, email: await emailOf(staffId), permissions: noPermissions() }),
  ).resolves.toEqual({ ok: false, reason: 'no_permission_selected' })

  const rows = await db.execute(sql`select 1 from branch_staff where user_id = ${staffId}::uuid`)
  expect(rows.rows).toHaveLength(0)
})

test('addBranchStaff reports already_staff on a second grant for the same branch', async () => {
  // branch_staff_unique is the authority; the code translates 23505 rather
  // than racing a check-then-insert.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const email = await emailOf(staffId)

  await addBranchStaff({
    branchId,
    email,
    permissions: { ...noPermissions(), view_bookings: true },
  })
  await expect(
    addBranchStaff({ branchId, email, permissions: { ...noPermissions(), view_earnings: true } }),
  ).resolves.toEqual({ ok: false, reason: 'already_staff' })
})

test('addBranchStaff allows the same person on a second branch', async () => {
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const email = await emailOf(staffId)

  await addBranchStaff({
    branchId: first.branchId,
    email,
    permissions: { ...noPermissions(), view_bookings: true },
  })
  await expect(
    addBranchStaff({
      branchId: second.branchId,
      email,
      permissions: { ...noPermissions(), manage_courts: true },
    }),
  ).resolves.toMatchObject({ ok: true })
})

test('addBranchStaff works again after a revoke', async () => {
  // Explicitly in the spec's Testing list: revoking is a DELETE, so re-adding
  // must not trip the unique constraint on a soft-deleted leftover.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const email = await emailOf(staffId)

  const added = await addBranchStaff({
    branchId,
    email,
    permissions: { ...noPermissions(), view_bookings: true },
  })
  await revokeBranchStaff({
    staffId: (added as { ok: true; staffId: string }).staffId,
    branchId,
  })
  await expect(
    addBranchStaff({ branchId, email, permissions: { ...noPermissions(), block_slots: true } }),
  ).resolves.toMatchObject({ ok: true })
})

test('updateBranchStaff replaces the whole permission set', async () => {
  // Not a merge: the edit form always submits all four checkboxes, because an
  // unchecked box submits nothing and a partial update would silently keep
  // permissions the owner just cleared.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const grantId = await seedStaffGrant({ branchId, userId: staffId, viewBookings: true })

  await expect(
    updateBranchStaff({
      staffId: grantId,
      branchId,
      permissions: { ...noPermissions(), view_earnings: true, manage_courts: true },
    }),
  ).resolves.toEqual({ ok: true })

  const rows = await db.execute(sql`
    select view_bookings, block_slots, manage_courts, view_earnings
    from branch_staff where id = ${grantId}::uuid
  `)
  expect(rows.rows[0]).toEqual({
    view_bookings: false,
    block_slots: false,
    manage_courts: true,
    view_earnings: true,
  })
})

test('updateBranchStaff refuses an all-false set and leaves the row intact', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const grantId = await seedStaffGrant({ branchId, userId: staffId, viewBookings: true })

  await expect(
    updateBranchStaff({ staffId: grantId, branchId, permissions: noPermissions() }),
  ).resolves.toEqual({ ok: false, reason: 'no_permission_selected' })

  const rows = await db.execute(
    sql`select view_bookings from branch_staff where id = ${grantId}::uuid`,
  )
  expect(rows.rows[0].view_bookings).toBe(true)
})

test('updateBranchStaff cannot reach a grant on a different branch', async () => {
  // branchId is in the WHERE clause, not compared after a read. The action
  // guards requireOwnerOf(branchId) on a submitted branchId, so an owner
  // passing their OWN branch id with someone else's staffId must write nothing.
  const mine = await seedBranchWithCourts(1)
  const theirs = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const theirGrant = await seedStaffGrant({
    branchId: theirs.branchId,
    userId: staffId,
    viewBookings: true,
  })

  await expect(
    updateBranchStaff({
      staffId: theirGrant,
      branchId: mine.branchId,
      permissions: allPermissions(),
    }),
  ).resolves.toEqual({ ok: false, reason: 'not_found' })

  const rows = await db.execute(
    sql`select view_earnings from branch_staff where id = ${theirGrant}::uuid`,
  )
  expect(rows.rows[0].view_earnings).toBe(false)
})

test('revokeBranchStaff deletes the grant and is idempotent', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const grantId = await seedStaffGrant({ branchId, userId: staffId, blockSlots: true })

  await expect(revokeBranchStaff({ staffId: grantId, branchId })).resolves.toEqual({ ok: true })
  await expect(revokeBranchStaff({ staffId: grantId, branchId })).resolves.toEqual({
    ok: false,
    reason: 'not_found',
  })
})

test('revokeBranchStaff cannot reach a grant on a different branch', async () => {
  const mine = await seedBranchWithCourts(1)
  const theirs = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const theirGrant = await seedStaffGrant({
    branchId: theirs.branchId,
    userId: staffId,
    viewBookings: true,
  })

  await expect(
    revokeBranchStaff({ staffId: theirGrant, branchId: mine.branchId }),
  ).resolves.toEqual({ ok: false, reason: 'not_found' })

  const rows = await db.execute(sql`select 1 from branch_staff where id = ${theirGrant}::uuid`)
  expect(rows.rows).toHaveLength(1)
})

test('promoting a staffed player to owner deletes every grant they held', async () => {
  // THE rule this task exists to pin. A user is never simultaneously an owner
  // and someone's staff, and this side effect is what keeps that true. The
  // admin screen that will call this is out of scope for this slice.
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  const userId = await seedPlayer()
  await seedStaffGrant({ branchId: first.branchId, userId, viewBookings: true })
  await seedStaffGrant({ branchId: second.branchId, userId, blockSlots: true })

  const slug = 'promoted-' + crypto.randomUUID()
  await expect(
    promoteToOwner({ userId, businessName: 'Promoted Courts', slug }),
  ).resolves.toEqual({ ok: true, revokedGrants: 2 })

  const profile = await db.execute(sql`
    select role::text as role, business_name, slug from profiles where id = ${userId}::uuid
  `)
  expect(profile.rows[0]).toEqual({
    role: 'owner',
    business_name: 'Promoted Courts',
    slug,
  })

  const grants = await db.execute(sql`select 1 from branch_staff where user_id = ${userId}::uuid`)
  expect(grants.rows).toHaveLength(0)
})

test('promoting an unstaffed player reports zero revoked grants', async () => {
  const userId = await seedPlayer()

  await expect(
    promoteToOwner({
      userId,
      businessName: 'Clean Slate Courts',
      slug: 'clean-' + crypto.randomUUID(),
    }),
  ).resolves.toEqual({ ok: true, revokedGrants: 0 })
})

test('promoteToOwner refuses an existing owner, an admin, and an unknown user', async () => {
  // Never demotes and never re-flips: an admin passing through this path would
  // silently lose their admin role, and re-promoting an owner would overwrite
  // business_name/slug they may have edited.
  const ownerId = await seedOwner()
  await expect(
    promoteToOwner({ userId: ownerId, businessName: 'X', slug: 'x-' + crypto.randomUUID() }),
  ).resolves.toEqual({ ok: false, reason: 'already_owner' })

  const adminId = await seedPlayer()
  await db.execute(sql`update profiles set role = 'admin' where id = ${adminId}::uuid`)
  await expect(
    promoteToOwner({ userId: adminId, businessName: 'X', slug: 'x-' + crypto.randomUUID() }),
  ).resolves.toEqual({ ok: false, reason: 'already_owner' })

  await expect(
    promoteToOwner({
      userId: crypto.randomUUID(),
      businessName: 'X',
      slug: 'x-' + crypto.randomUUID(),
    }),
  ).resolves.toEqual({ ok: false, reason: 'no_such_user' })
})

test('promoteToOwner reports a taken slug instead of throwing, and changes nothing', async () => {
  // profiles.slug is UNIQUE and appears in /owners/<slug> URLs.
  const existing = await seedOwner()
  const slug = 'taken-' + crypto.randomUUID()
  await db.execute(sql`update profiles set slug = ${slug} where id = ${existing}::uuid`)

  const userId = await seedPlayer()
  await expect(
    promoteToOwner({ userId, businessName: 'Colliding Courts', slug }),
  ).resolves.toEqual({ ok: false, reason: 'slug_taken' })

  const profile = await db.execute(sql`select role::text as role from profiles where id = ${userId}::uuid`)
  expect(profile.rows[0].role).toBe('player')
})

test('promoteToOwner rejects a blank business name or a malformed slug', async () => {
  const userId = await seedPlayer()
  const bad = [
    { businessName: '   ', slug: 'fine-slug' },
    { businessName: 'Fine Name', slug: 'Has Spaces' },
    { businessName: 'Fine Name', slug: 'UPPERCASE' },
    { businessName: 'Fine Name', slug: '' },
  ]
  for (const input of bad) {
    await expect(promoteToOwner({ userId, ...input })).resolves.toEqual({
      ok: false,
      reason: 'invalid_input',
    })
  }
})

test('getBranchStaffForOwner groups grants by branch and lists every branch the owner has', async () => {
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  await db.execute(
    sql`update branches set owner_id = ${first.ownerId}::uuid where id = ${second.branchId}::uuid`,
  )
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: first.branchId, userId: staffId, viewBookings: true })

  const groups = await getBranchStaffForOwner(first.ownerId)
  const withStaff = groups.find((group) => group.branchId === first.branchId)!
  const without = groups.find((group) => group.branchId === second.branchId)!

  // A branch with no staff still gets a group: the page renders an "add staff"
  // form per branch, so a branch missing from this list would be unstaffable.
  expect(without.staff).toEqual([])
  expect(withStaff.staff).toHaveLength(1)
  expect(withStaff.staff[0]).toMatchObject({
    userId: staffId,
    permissions: {
      view_bookings: true,
      block_slots: false,
      manage_courts: false,
      view_earnings: false,
    },
  })
  expect(withStaff.staff[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

test('getBranchStaffForOwner never leaks another owner\'s branches or staff', async () => {
  const mine = await seedBranchWithCourts(1)
  const theirs = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: theirs.branchId, userId: staffId, viewBookings: true })

  const groups = await getBranchStaffForOwner(mine.ownerId)
  expect(groups.map((group) => group.branchId)).not.toContain(theirs.branchId)
  expect(groups.flatMap((group) => group.staff.map((row) => row.userId))).not.toContain(staffId)
})
