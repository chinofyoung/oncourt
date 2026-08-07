import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBranchWithCourts, teardownFixtures } from '../helpers/fixtures'
import { getListingBranch, getListingBranches, getListingCourt } from '@/lib/listings/queries'

afterAll(teardownFixtures)

const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555'

async function setStatus(courtId: string, status: string, rejectionReason: string | null = null) {
  await db.execute(sql`
    update courts set status = ${status}::court_status, rejection_reason = ${rejectionReason}
    where id = ${courtId}::uuid
  `)
}

async function addBranchPhoto(branchId: string, storagePath: string, sortOrder: number) {
  await db.execute(sql`
    insert into branch_photos (branch_id, storage_path, sort_order)
    values (${branchId}::uuid, ${storagePath}, ${sortOrder})
  `)
}

async function addCourtPhoto(
  courtId: string,
  storagePath: string,
  sortOrder: number,
): Promise<string> {
  const result = await db.execute(sql`
    insert into court_photos (court_id, storage_path, sort_order)
    values (${courtId}::uuid, ${storagePath}, ${sortOrder})
    returning id
  `)
  return result.rows[0].id as string
}

test('getListingBranches counts courts by status and photos per branch', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(3)
  await setStatus(courtIds[0], 'pending')
  await setStatus(courtIds[1], 'rejected', 'Blurry photos.')
  await setStatus(courtIds[2], 'suspended')
  await addBranchPhoto(branchId, `branches/${branchId}/a.jpg`, 0)

  const rows = await getListingBranches([branchId])
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    id: branchId,
    name: 'Fixture Branch',
    city: 'Marikina',
    photoCount: 1,
    courtCounts: { pending: 1, approved: 0, rejected: 1, suspended: 1 },
  })
})

test('getListingBranches returns the lowest-sort_order photo path as coverPhotoPath, or null with no photos', async () => {
  const { branchId: withPhotos } = await seedBranchWithCourts(1)
  const { branchId: withoutPhotos } = await seedBranchWithCourts(1)
  // Deliberately inserted out of order so the ORDER BY is doing real work.
  await addBranchPhoto(withPhotos, `branches/${withPhotos}/second.jpg`, 1)
  await addBranchPhoto(withPhotos, `branches/${withPhotos}/first.jpg`, 0)

  const rows = await getListingBranches([withPhotos, withoutPhotos])
  const withCover = rows.find((row) => row.id === withPhotos)
  const withoutCover = rows.find((row) => row.id === withoutPhotos)
  expect(withCover!.coverPhotoPath).toBe(`branches/${withPhotos}/first.jpg`)
  expect(withoutCover!.coverPhotoPath).toBeNull()
})

test('getListingBranches returns nothing for an empty scope', async () => {
  // An empty array serializes to the Postgres empty array, so
  // `= any ('{}'::uuid[])` matches nothing — the correct answer for a staff
  // member with no manage_courts grant anywhere.
  expect(await getListingBranches([])).toEqual([])
})

test('getListingBranch returns the editable fields, photos in order, and courts', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  await setStatus(courtIds[0], 'rejected', 'Add a photo of the net.')
  // Deliberately inserted out of order so the ORDER BY is doing real work.
  await addBranchPhoto(branchId, `branches/${branchId}/second.jpg`, 1)
  await addBranchPhoto(branchId, `branches/${branchId}/first.jpg`, 0)

  const branch = await getListingBranch(branchId)
  expect(branch).not.toBeNull()
  expect(branch!.name).toBe('Fixture Branch')
  expect(branch!.city).toBe('Marikina')
  expect(branch!.address).toBe('1 Fixture St')
  expect(branch!.lat).toBeCloseTo(14.6507, 4)
  expect(branch!.lng).toBeCloseTo(121.1029, 4)
  expect(branch!.photos.map((photo) => photo.storagePath)).toEqual([
    `branches/${branchId}/first.jpg`,
    `branches/${branchId}/second.jpg`,
  ])
  expect(branch!.courts).toHaveLength(2)
  const rejected = branch!.courts.find((court) => court.id === courtIds[0])
  expect(rejected).toMatchObject({ status: 'rejected', rejectionReason: 'Add a photo of the net.' })
})

test('getListingBranch returns null for an unknown branch', async () => {
  expect(await getListingBranch(UNKNOWN_ID)).toBeNull()
})

test('getListingBranch reports a price range and a null one for a court with no bands yet', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  // Math.min/max of an empty array is Infinity, not null — the guard this
  // pins, mirroring getAdminCourts' identical test.
  await db.execute(sql`delete from court_rate_bands where court_id = ${courtIds[1]}::uuid`)

  const branch = await getListingBranch(branchId)
  const priced = branch!.courts.find((court) => court.id === courtIds[0])!
  const unpriced = branch!.courts.find((court) => court.id === courtIds[1])!

  expect(priced.minPriceCentavos).toBe(26500)
  expect(priced.maxPriceCentavos).toBe(36500)
  expect(unpriced.minPriceCentavos).toBeNull()
  expect(unpriced.maxPriceCentavos).toBeNull()
})

test("getListingBranch's hours summary and schedule warning agree with the court's own seeded schedule", async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  // Court 1: still open every day on the fixture's 11-24 window, and its
  // bands still tile it exactly, so this is the "no warning" baseline.
  // Court 2: hours deleted entirely, so it has nothing to tile — the same
  // 'no_open_day' state a brand-new court starts in.
  await db.execute(sql`delete from court_operating_hours where court_id = ${courtIds[1]}::uuid`)

  const branch = await getListingBranch(branchId)
  const tiling = branch!.courts.find((court) => court.id === courtIds[0])!
  const noHours = branch!.courts.find((court) => court.id === courtIds[1])!

  expect(tiling.hoursSummary).toBe('11 – 12 AM daily')
  expect(tiling.scheduleWarning).toBeNull()
  expect(noHours.hoursSummary).toBe('No hours set')
  expect(noHours.scheduleWarning).toBe('no_open_day')
})

test("getListingBranch returns each court's lowest-sort_order photo as coverPhotoPath, tie-broken by id, or null with no photos", async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  const [withPhotos, withoutPhotos] = courtIds
  // Deliberately inserted out of order so the ORDER BY is doing real work.
  await addCourtPhoto(withPhotos, `courts/${withPhotos}/second.jpg`, 1)
  const firstId = await addCourtPhoto(withPhotos, `courts/${withPhotos}/first.jpg`, 0)
  // Same sort_order as "first.jpg": the `, p.id` tie-break must pick
  // whichever of the two has the lower id, and stay stable across repeated
  // calls, rather than shuffling between renders.
  const tiedId = await addCourtPhoto(withPhotos, `courts/${withPhotos}/tied-a.jpg`, 0)
  const expectedTiedWinner =
    tiedId < firstId ? `courts/${withPhotos}/tied-a.jpg` : `courts/${withPhotos}/first.jpg`

  const branch = await getListingBranch(branchId)
  const withCover = branch!.courts.find((court) => court.id === withPhotos)!
  const withoutCover = branch!.courts.find((court) => court.id === withoutPhotos)!

  expect(withCover.coverPhotoPath).toBe(expectedTiedWinner)
  expect(withoutCover.coverPhotoPath).toBeNull()

  // Repeat the read: the tie-break must be deterministic, not luck of one
  // query plan.
  const branchAgain = await getListingBranch(branchId)
  expect(branchAgain!.courts.find((court) => court.id === withPhotos)!.coverPhotoPath).toBe(
    expectedTiedWinner,
  )
})

test('getListingCourt returns hours, bands, photos and no warning when the bands tile', async () => {
  // The fixture court is open 11-24 all week with bands 11-15/15-17/17-24 —
  // an exact tiling, which is what "no warning" has to mean.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await db.execute(sql`
    insert into court_photos (court_id, storage_path, sort_order)
    values (${courtIds[0]}::uuid, ${`courts/${courtIds[0]}/a.jpg`}, 0)
  `)

  const court = await getListingCourt(courtIds[0])
  expect(court).not.toBeNull()
  expect(court!.branchId).toBe(branchId)
  expect(court!.branchName).toBe('Fixture Branch')
  expect(court!.status).toBe('approved')
  expect(court!.days).toHaveLength(7)
  expect(court!.days.map((day) => day.dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6])
  expect(court!.bands.map((band) => band.startHour)).toEqual([11, 15, 17])
  expect(court!.bands[0].priceCentavos).toBe(26500)
  expect(court!.photos).toHaveLength(1)
  expect(court!.scheduleWarning).toBeNull()
})

test('getListingCourt warns when the bands no longer cover the opening hours', async () => {
  // Exactly the state an hours-only edit can leave behind: the court page
  // has to say so, because nothing else will until a player hits checkout.
  const { courtIds } = await seedBranchWithCourts(1)
  await db.execute(sql`
    update court_operating_hours set opens_hour = 7 where court_id = ${courtIds[0]}::uuid
  `)

  const court = await getListingCourt(courtIds[0])
  expect(court!.scheduleWarning).toBe('bands_do_not_tile')
})

test('getListingCourt warns when a court has no opening hours at all', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await db.execute(sql`delete from court_operating_hours where court_id = ${courtIds[0]}::uuid`)

  const court = await getListingCourt(courtIds[0])
  expect(court!.scheduleWarning).toBe('no_open_day')
})

test('getListingCourt returns null for an unknown court', async () => {
  expect(await getListingCourt(UNKNOWN_ID)).toBeNull()
})
