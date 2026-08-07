import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBranchWithCourts, seedOwner, seedPlayer, teardownFixtures } from '../helpers/fixtures'
import { findProfileByEmail, getAdminCourts, getPendingCourtCount } from '@/lib/admin/queries'

afterAll(teardownFixtures)

/**
 * These queries span EVERY owner — that is their purpose — so on this shared,
 * persistent database they also return the seed's rows and whatever other test
 * files have in flight. Every assertion about contents therefore filters to
 * ids this test seeded, and the one assertion about a global count is a delta.
 * A `toHaveLength(2)` against getAdminCourts() would pass alone and fail in a
 * full run.
 */
async function setStatus(courtId: string, status: string, rejectionReason: string | null = null) {
  await db.execute(sql`
    update courts set status = ${status}::court_status, rejection_reason = ${rejectionReason}
    where id = ${courtId}::uuid
  `)
}

async function emailOf(userId: string): Promise<string> {
  const result = await db.execute(sql`select email from profiles where id = ${userId}::uuid`)
  return result.rows[0].email as string
}

async function forBranch(statuses: ('pending' | 'approved' | 'rejected' | 'suspended')[], branchId: string) {
  return (await getAdminCourts(statuses)).filter((row) => row.branchId === branchId)
}

test('getAdminCourts returns the facts an admin needs to moderate without leaving the page', async () => {
  const { ownerId, branchId, slug, courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')
  await db.execute(sql`
    insert into court_photos (court_id, storage_path, sort_order)
    values (${courtIds[0]}::uuid, ${`courts/${courtIds[0]}/a.jpg`}, 0)
  `)

  const rows = await forBranch(['pending'], branchId)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    id: courtIds[0],
    name: 'Court 1',
    environment: 'indoor',
    status: 'pending',
    rejectionReason: null,
    branchId,
    branchName: 'Fixture Branch',
    branchCity: 'Marikina',
    branchSlug: slug,
    // seedOwner() sets the role and nothing else, so an owner with no business
    // name is a real state the queue has to render — the page falls back to
    // the email rather than printing "null".
    ownerBusinessName: null,
    ownerEmail: await emailOf(ownerId),
    coverPhotoPath: `courts/${courtIds[0]}/a.jpg`,
    // seedBranchWithCourts' fixture bands are 26500/31500/36500 centavos.
    minPriceCentavos: 26500,
    maxPriceCentavos: 36500,
    // The fixture court is open 11-24 all week. formatHourRange(11, 24) is
    // "11 – 12 AM" (both ends land in AM, so the period prints once) — this
    // asserts the app's real formatter, not a prettier hypothetical one.
    hoursSummary: '11 – 12 AM daily',
    scheduleWarning: null,
  })
  expect(rows[0].addedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

test('getAdminCourts picks the lowest sort_order photo as the cover, tie-broken by id', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')
  // Inserted out of order, and with two rows sharing sort_order 0, so this
  // only passes if the query orders by (sort_order, id) rather than by
  // insertion order or sort_order alone.
  await db.execute(sql`
    insert into court_photos (court_id, storage_path, sort_order)
    values (${courtIds[0]}::uuid, ${`courts/${courtIds[0]}/later.jpg`}, 1)
  `)
  const tieA = await db.execute(sql`
    insert into court_photos (court_id, storage_path, sort_order)
    values (${courtIds[0]}::uuid, ${`courts/${courtIds[0]}/tie-a.jpg`}, 0)
    returning id
  `)
  const tieB = await db.execute(sql`
    insert into court_photos (court_id, storage_path, sort_order)
    values (${courtIds[0]}::uuid, ${`courts/${courtIds[0]}/tie-b.jpg`}, 0)
    returning id
  `)
  const tieWinner = [
    { id: tieA.rows[0].id as string, path: `courts/${courtIds[0]}/tie-a.jpg` },
    { id: tieB.rows[0].id as string, path: `courts/${courtIds[0]}/tie-b.jpg` },
  ].sort((a, b) => (a.id < b.id ? -1 : 1))[0]

  const rows = await forBranch(['pending'], branchId)
  expect(rows[0].coverPhotoPath).toBe(tieWinner.path)
})

test('getAdminCourts leaves the cover photo and price range null with no photos or bands', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')
  await db.execute(sql`delete from court_rate_bands where court_id = ${courtIds[0]}::uuid`)

  const rows = await forBranch(['pending'], branchId)
  expect(rows[0].coverPhotoPath).toBeNull()
  expect(rows[0].minPriceCentavos).toBeNull()
  expect(rows[0].maxPriceCentavos).toBeNull()
})

test('getAdminCourts reports a single price, not a range, for a court with one band', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')
  await db.execute(sql`
    delete from court_rate_bands where court_id = ${courtIds[0]}::uuid and start_hour != 11
  `)

  const rows = await forBranch(['pending'], branchId)
  expect(rows[0].minPriceCentavos).toBe(26500)
  expect(rows[0].maxPriceCentavos).toBe(26500)
})

test('getAdminCourts carries the same schedule warning that blocks approval', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')
  await db.execute(sql`
    delete from court_rate_bands where court_id = ${courtIds[0]}::uuid and start_hour = 15
  `)

  const rows = await forBranch(['pending'], branchId)
  expect(rows[0].scheduleWarning).toBe('bands_do_not_tile')
  // The remaining two bands (11-15 @ 26500, 17-24 @ 36500) still span the same
  // min/max as the full three-band fixture — this asserts the price range is
  // computed from whatever bands exist, not hardcoded to the fixture's count.
  expect(rows[0].minPriceCentavos).toBe(26500)
  expect(rows[0].maxPriceCentavos).toBe(36500)
})

test('getAdminCourts summarizes a partial week and an empty one', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  await setStatus(courtIds[0], 'pending')
  await setStatus(courtIds[1], 'pending')
  await db.execute(sql`
    delete from court_operating_hours where court_id = ${courtIds[0]}::uuid and day_of_week = 0
  `)
  await db.execute(sql`delete from court_operating_hours where court_id = ${courtIds[1]}::uuid`)

  const rows = await forBranch(['pending'], branchId)
  const byId = new Map(rows.map((row) => [row.id, row]))
  expect(byId.get(courtIds[0])!.hoursSummary).toBe('6 days · 11 – 12 AM')
  expect(byId.get(courtIds[1])!.hoursSummary).toBe('No hours set')
  expect(byId.get(courtIds[1])!.scheduleWarning).toBe('no_open_day')
})

test('getAdminCourts takes several statuses at once, for the suspend tab', async () => {
  // The live tab is this same function with ['approved', 'suspended'] — one
  // query shape, two pages, so a column added for the queue is a column the
  // suspend tab gets too.
  const { branchId, courtIds } = await seedBranchWithCourts(3)
  await setStatus(courtIds[0], 'approved')
  await setStatus(courtIds[1], 'suspended')
  await setStatus(courtIds[2], 'pending')

  const live = await forBranch(['approved', 'suspended'], branchId)
  expect(live.map((row) => row.id).sort()).toEqual([courtIds[0], courtIds[1]].sort())
  expect(new Set(live.map((row) => row.status))).toEqual(new Set(['approved', 'suspended']))
})

test('getAdminCourts returns oldest first, so the queue is a queue', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  await setStatus(courtIds[0], 'pending')
  await setStatus(courtIds[1], 'pending')
  // Backdated explicitly rather than relying on two inserts landing on
  // different clock ticks: a tie would fall through to the id tiebreak, which
  // is a random uuid, and the test would flake.
  await db.execute(sql`
    update courts set created_at = now() - interval '3 days' where id = ${courtIds[1]}::uuid
  `)

  const rows = await forBranch(['pending'], branchId)
  expect(rows.map((row) => row.id)).toEqual([courtIds[1], courtIds[0]])
})

test('getAdminCourts returns nothing for an empty status list', async () => {
  expect(await getAdminCourts([])).toEqual([])
})

test('getPendingCourtCount counts pending courts across every owner', async () => {
  // A delta, not an absolute: this count is global by design and other rows
  // exist in this shared database.
  const before = await getPendingCourtCount()
  const { courtIds } = await seedBranchWithCourts(2)
  await setStatus(courtIds[0], 'pending')
  await setStatus(courtIds[1], 'pending')

  expect(await getPendingCourtCount()).toBe(before + 2)

  await setStatus(courtIds[0], 'approved')
  expect(await getPendingCourtCount()).toBe(before + 1)
})

test('findProfileByEmail matches the whole address, case-insensitively', async () => {
  const playerId = await seedPlayer()
  const email = await emailOf(playerId)

  await expect(findProfileByEmail(email)).resolves.toMatchObject({ id: playerId, role: 'player' })
  await expect(findProfileByEmail(email.toUpperCase())).resolves.toMatchObject({ id: playerId })
  await expect(findProfileByEmail(`  ${email}  `)).resolves.toMatchObject({ id: playerId })
})

test('findProfileByEmail never matches a prefix or a substring', async () => {
  // Exact-whole-address, so nobody can enumerate the user table by typing
  // letters — slice A's deterministic rule, and the same one addBranchStaff
  // follows.
  const playerId = await seedPlayer()
  const email = await emailOf(playerId)

  await expect(findProfileByEmail(email.slice(0, 8))).resolves.toBeNull()
  await expect(findProfileByEmail(email.split('@')[0])).resolves.toBeNull()
  await expect(findProfileByEmail('@example.test')).resolves.toBeNull()
})

test('findProfileByEmail returns the role, so the screen can say why it refuses', async () => {
  const ownerId = await seedOwner()
  await expect(findProfileByEmail(await emailOf(ownerId))).resolves.toMatchObject({
    id: ownerId,
    role: 'owner',
  })
})

test('findProfileByEmail returns null for an address nobody uses', async () => {
  await expect(findProfileByEmail(`nobody-${crypto.randomUUID()}@example.test`)).resolves.toBeNull()
})
