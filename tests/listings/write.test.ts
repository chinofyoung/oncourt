import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBranchWithCourts, seedOwner, teardownFixtures } from '../helpers/fixtures'
import { branchIdOfCourt } from '@/lib/courts/lookup'
import {
  createBranch,
  createCourt,
  replaceOperatingHours,
  replaceRateBands,
  updateBranch,
  updateCourtFields,
} from '@/lib/listings/write'
import type { BranchFields } from '@/lib/listings/fields'

afterAll(teardownFixtures)

const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555'

/**
 * Court statuses are flipped with raw SQL rather than through an admin
 * action: Slice C's approval queue does not exist yet, and the spec
 * explicitly sequences B before C by having B's tests do exactly this.
 */
async function setStatus(courtId: string, status: string, rejectionReason: string | null = null) {
  await db.execute(sql`
    update courts set status = ${status}::court_status, rejection_reason = ${rejectionReason}
    where id = ${courtId}::uuid
  `)
}

async function statusOf(courtId: string) {
  const result = await db.execute(sql`
    select status::text as status, rejection_reason from courts where id = ${courtId}::uuid
  `)
  return result.rows[0] as { status: string; rejection_reason: string | null }
}

function branchFields(overrides: Partial<BranchFields> = {}): BranchFields {
  return {
    name: 'Rally Point',
    description: null,
    address: '9 Katipunan Ave',
    city: 'Quezon City',
    contactPhone: null,
    contactEmail: null,
    amenities: [],
    lat: null,
    lng: null,
    ...overrides,
  }
}

// ----------------------------------------------------------------- branches

test('createBranch inserts a branch whose slug is derived from its name', async () => {
  const ownerId = await seedOwner()
  const result = await createBranch({ ownerId, fields: branchFields({ name: 'Rally Point BGC' }) })

  expect(result).toMatchObject({ ok: true, slug: 'rally-point-bgc' })
  if (!result.ok) throw new Error('unreachable')

  const row = await db.execute(sql`
    select owner_id, name, city, address from branches where id = ${result.branchId}::uuid
  `)
  expect(row.rows[0]).toMatchObject({
    owner_id: ownerId,
    name: 'Rally Point BGC',
    city: 'Quezon City',
    address: '9 Katipunan Ave',
  })
})

test('createBranch gives a second branch of the same name a different slug', async () => {
  // branches.slug is UNIQUE and public. Two owners naming their venue
  // "Rally Point" is normal; a 23505 escaping to the form is not.
  const ownerId = await seedOwner()
  const first = await createBranch({ ownerId, fields: branchFields({ name: 'Rally Point' }) })
  const second = await createBranch({ ownerId, fields: branchFields({ name: 'Rally Point' }) })

  expect(first).toMatchObject({ ok: true })
  expect(second).toMatchObject({ ok: true })
  if (!first.ok || !second.ok) throw new Error('unreachable')
  expect(second.slug).not.toBe(first.slug)
  expect(second.slug.startsWith('rally-point-')).toBe(true)
})

test('createBranch stores amenities and the map pin', async () => {
  const ownerId = await seedOwner()
  const result = await createBranch({
    ownerId,
    fields: branchFields({
      amenities: ['parking', 'showers'],
      lat: 14.6507,
      lng: 121.1029,
      description: 'Two indoor courts.',
      contactPhone: '0917 000 0000',
      contactEmail: 'desk@rallypoint.ph',
    }),
  })
  if (!result.ok) throw new Error('createBranch failed')

  // st_y/st_x, not the raw geography value: the driver hands geography back
  // as a WKB hex string, exactly as getBranchDetail documents.
  const row = await db.execute(sql`
    select amenities, description, contact_phone, contact_email,
           st_y(location::geometry)::float8 as lat, st_x(location::geometry)::float8 as lng
    from branches where id = ${result.branchId}::uuid
  `)
  expect(row.rows[0]).toMatchObject({
    amenities: ['parking', 'showers'],
    description: 'Two indoor courts.',
    contact_phone: '0917 000 0000',
    contact_email: 'desk@rallypoint.ph',
  })
  expect(Number(row.rows[0].lat)).toBeCloseTo(14.6507, 5)
  expect(Number(row.rows[0].lng)).toBeCloseTo(121.1029, 5)
})

test('createBranch stores a null location when no pin was set', async () => {
  // Geocoding is non-blocking per the spec, so "no pin yet" is a real state.
  const ownerId = await seedOwner()
  const result = await createBranch({ ownerId, fields: branchFields() })
  if (!result.ok) throw new Error('createBranch failed')

  const row = await db.execute(
    sql`select location is null as no_pin from branches where id = ${result.branchId}::uuid`,
  )
  expect(row.rows[0].no_pin).toBe(true)
})

test('updateBranch replaces every editable field and leaves the slug alone', async () => {
  // The slug is public (/venues/<slug>) and printed on posters and QR codes.
  // A rename must not break every link that already exists.
  const { branchId } = await seedBranchWithCourts(1)
  const before = await db.execute(sql`select slug from branches where id = ${branchId}::uuid`)

  const result = await updateBranch({
    branchId,
    fields: branchFields({
      name: 'Renamed Courts',
      city: 'Pasig',
      amenities: ['cafe'],
      lat: 14.5764,
      lng: 121.0851,
    }),
  })
  expect(result).toEqual({ ok: true })

  const after = await db.execute(sql`
    select name, city, slug, amenities from branches where id = ${branchId}::uuid
  `)
  expect(after.rows[0]).toMatchObject({
    name: 'Renamed Courts',
    city: 'Pasig',
    slug: before.rows[0].slug,
    amenities: ['cafe'],
  })
})

test('updateBranch never re-queues the branch approved courts', async () => {
  // Spec: "Name, surface, photos, and all branch-level edits do NOT
  // re-queue." A branch rename is not a moderation event.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await updateBranch({ branchId, fields: branchFields({ name: 'Still Approved' }) })
  expect((await statusOf(courtIds[0])).status).toBe('approved')
})

test('updateBranch reports not_found for an unknown branch', async () => {
  expect(await updateBranch({ branchId: UNKNOWN_ID, fields: branchFields() })).toEqual({
    ok: false,
    reason: 'not_found',
  })
})

// ------------------------------------------------------------------- courts

test('createCourt inserts a pending court with no rejection reason', async () => {
  // "A new court inserts as pending" — from the column default, not from an
  // explicit value, so the default can never drift away from the rule.
  const { branchId } = await seedBranchWithCourts(0)
  const result = await createCourt({
    branchId,
    fields: { name: 'Court A', environment: 'outdoor', surface: 'Acrylic' },
  })
  expect(result).toMatchObject({ ok: true })
  if (!result.ok) throw new Error('unreachable')

  const row = await db.execute(sql`
    select name, environment::text as environment, surface, status::text as status, rejection_reason
    from courts where id = ${result.courtId}::uuid
  `)
  expect(row.rows[0]).toEqual({
    name: 'Court A',
    environment: 'outdoor',
    surface: 'Acrylic',
    status: 'pending',
    rejection_reason: null,
  })
  // The court is immediately resolvable back to its branch, which is what
  // every court-scoped guard depends on.
  expect(await branchIdOfCourt(result.courtId)).toBe(branchId)
})

test('createCourt reports branch_missing for an unknown branch', async () => {
  expect(
    await createCourt({
      branchId: UNKNOWN_ID,
      fields: { name: 'Ghost', environment: 'indoor', surface: null },
    }),
  ).toEqual({ ok: false, reason: 'branch_missing' })
})

test('updateCourtFields renames an approved court without re-queueing it', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  const result = await updateCourtFields({
    courtId: courtIds[0],
    fields: { name: 'Center Court', environment: 'indoor', surface: 'Cushioned' },
  })

  expect(result).toEqual({ ok: true, requeued: false })
  const after = await statusOf(courtIds[0])
  expect(after.status).toBe('approved')
  const row = await db.execute(
    sql`select name, surface from courts where id = ${courtIds[0]}::uuid`,
  )
  expect(row.rows[0]).toEqual({ name: 'Center Court', surface: 'Cushioned' })
})

test('updateCourtFields re-queues an approved court when the environment changes', async () => {
  // environment IS a key field: an indoor court that became outdoor is a
  // materially different listing and has to be looked at again.
  const { courtIds } = await seedBranchWithCourts(1)
  const result = await updateCourtFields({
    courtId: courtIds[0],
    fields: { name: 'Court 1', environment: 'outdoor', surface: null },
  })

  expect(result).toEqual({ ok: true, requeued: true })
  expect(await statusOf(courtIds[0])).toEqual({ status: 'pending', rejection_reason: null })
})

test('updateCourtFields re-queues a rejected court and clears its rejection reason', async () => {
  // The fix-and-resubmit path. There is no separate resubmit button by
  // design; the edit IS the resubmission, and a stale rejection reason on a
  // pending court would read as a fresh rejection.
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'rejected', 'Photos do not show the court.')

  const result = await updateCourtFields({
    courtId: courtIds[0],
    fields: { name: 'Court 1', environment: 'outdoor', surface: null },
  })

  expect(result).toEqual({ ok: true, requeued: true })
  expect(await statusOf(courtIds[0])).toEqual({ status: 'pending', rejection_reason: null })
})

test('updateCourtFields leaves a suspended court suspended', async () => {
  // Suspension is an admin action. An owner must not be able to edit their
  // way back onto the market — which is why the transition predicate is
  // `status in ('approved','rejected')`, not `status <> 'suspended'`.
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'suspended')

  const result = await updateCourtFields({
    courtId: courtIds[0],
    fields: { name: 'Court 1', environment: 'outdoor', surface: null },
  })

  expect(result).toEqual({ ok: true, requeued: false })
  expect((await statusOf(courtIds[0])).status).toBe('suspended')
  // The edit itself still landed — suspension freezes the STATUS, not the row.
  const row = await db.execute(
    sql`select environment::text as environment from courts where id = ${courtIds[0]}::uuid`,
  )
  expect(row.rows[0].environment).toBe('outdoor')
})

test('updateCourtFields reports requeued false for a court already pending', async () => {
  // Nothing visible changed, so the form must not claim "back in the queue".
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')

  const result = await updateCourtFields({
    courtId: courtIds[0],
    fields: { name: 'Court 1', environment: 'outdoor', surface: null },
  })

  expect(result).toEqual({ ok: true, requeued: false })
  expect((await statusOf(courtIds[0])).status).toBe('pending')
})

test('updateCourtFields reports not_found for an unknown court', async () => {
  expect(
    await updateCourtFields({
      courtId: UNKNOWN_ID,
      fields: { name: 'Ghost', environment: 'indoor', surface: null },
    }),
  ).toEqual({ ok: false, reason: 'not_found' })
})

// ---------------------------------------------------------- operating hours

test('replaceOperatingHours replaces the whole week and re-queues an approved court', async () => {
  // A REPLACE, not a merge: the form always submits all seven rows, so the
  // submitted set IS the new week. Merging would make a day impossible to
  // close.
  const { courtIds } = await seedBranchWithCourts(1)
  const result = await replaceOperatingHours({
    courtId: courtIds[0],
    days: [
      { dayOfWeek: 5, opensHour: 7, closesHour: 22 },
      { dayOfWeek: 6, opensHour: 6, closesHour: 24 },
    ],
  })

  expect(result).toEqual({ ok: true, requeued: true })
  expect(await statusOf(courtIds[0])).toEqual({ status: 'pending', rejection_reason: null })

  const rows = await db.execute(sql`
    select day_of_week, opens_hour, closes_hour from court_operating_hours
    where court_id = ${courtIds[0]}::uuid order by day_of_week
  `)
  expect(rows.rows.map((r) => Number(r.day_of_week))).toEqual([5, 6])
  expect(rows.rows.map((r) => Number(r.opens_hour))).toEqual([7, 6])
})

test('replaceOperatingHours rejects an invalid week without touching the stored rows', async () => {
  // Atomicity that matters: a half-applied week would leave the court open
  // on days the owner closed.
  const { courtIds } = await seedBranchWithCourts(1)
  const result = await replaceOperatingHours({
    courtId: courtIds[0],
    days: [{ dayOfWeek: 1, opensHour: 20, closesHour: 8 }],
  })

  expect(result).toEqual({ ok: false, reason: 'invalid_window' })
  const rows = await db.execute(
    sql`select count(*)::int as n from court_operating_hours where court_id = ${courtIds[0]}::uuid`,
  )
  expect(Number(rows.rows[0].n)).toBe(7)
  expect((await statusOf(courtIds[0])).status).toBe('approved')
})

test('replaceOperatingHours rejects an all-closed week', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  expect(await replaceOperatingHours({ courtId: courtIds[0], days: [] })).toEqual({
    ok: false,
    reason: 'no_open_day',
  })
})

test('replaceOperatingHours reports not_found for an unknown court', async () => {
  expect(
    await replaceOperatingHours({
      courtId: UNKNOWN_ID,
      days: [{ dayOfWeek: 1, opensHour: 9, closesHour: 17 }],
    }),
  ).toEqual({ ok: false, reason: 'not_found' })
})

// -------------------------------------------------------------- rate bands

test('replaceRateBands replaces the bands and re-queues an approved court', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  const result = await replaceRateBands({
    courtId: courtIds[0],
    bands: [
      { startHour: 11, endHour: 18, priceCentavos: 28000 },
      { startHour: 18, endHour: 24, priceCentavos: 39000 },
    ],
  })

  expect(result).toEqual({ ok: true, requeued: true })
  expect(await statusOf(courtIds[0])).toEqual({ status: 'pending', rejection_reason: null })

  const rows = await db.execute(sql`
    select start_hour, end_hour, price_centavos from court_rate_bands
    where court_id = ${courtIds[0]}::uuid order by start_hour
  `)
  expect(rows.rows.map((r) => Number(r.price_centavos))).toEqual([28000, 39000])
})

test('replaceRateBands rejects bands that do not tile the stored hours, keeping the old bands', async () => {
  // The fixture court is open 11-24 every day. Bands covering only 11-20
  // leave four unpriced hours, which is what makes priceSlots throw
  // "No rate band covers hour 20" in the middle of a player's checkout.
  const { courtIds } = await seedBranchWithCourts(1)
  const result = await replaceRateBands({
    courtId: courtIds[0],
    bands: [{ startHour: 11, endHour: 20, priceCentavos: 28000 }],
  })

  expect(result).toEqual({ ok: false, reason: 'bands_do_not_tile' })
  const rows = await db.execute(
    sql`select count(*)::int as n from court_rate_bands where court_id = ${courtIds[0]}::uuid`,
  )
  expect(Number(rows.rows[0].n)).toBe(3)
  expect((await statusOf(courtIds[0])).status).toBe('approved')
})

test('replaceRateBands reports no_operating_hours when the court has none', async () => {
  // A brand-new court has no hours yet, so there is no span to tile and the
  // bands form has nothing to validate against. Reported as its own reason
  // so the page can say "set your opening hours first".
  const { branchId } = await seedBranchWithCourts(0)
  const created = await createCourt({
    branchId,
    fields: { name: 'Court B', environment: 'indoor', surface: null },
  })
  if (!created.ok) throw new Error('createCourt failed')

  expect(
    await replaceRateBands({
      courtId: created.courtId,
      bands: [{ startHour: 8, endHour: 20, priceCentavos: 25000 }],
    }),
  ).toEqual({ ok: false, reason: 'no_operating_hours' })
})

test('replaceRateBands rejects an empty band list', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  expect(await replaceRateBands({ courtId: courtIds[0], bands: [] })).toEqual({
    ok: false,
    reason: 'no_bands',
  })
})

test('replaceRateBands reports not_found for an unknown court', async () => {
  expect(
    await replaceRateBands({
      courtId: UNKNOWN_ID,
      bands: [{ startHour: 11, endHour: 24, priceCentavos: 25000 }],
    }),
  ).toEqual({ ok: false, reason: 'not_found' })
})

test('a rejected court returns to pending through a rate-band edit', async () => {
  // The full spec'd path, end to end: rejected -> key-field edit -> pending
  // with the reason cleared, no resubmit button anywhere.
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'rejected', 'Peak pricing is missing.')

  const result = await replaceRateBands({
    courtId: courtIds[0],
    bands: [
      { startHour: 11, endHour: 17, priceCentavos: 26500 },
      { startHour: 17, endHour: 24, priceCentavos: 38000 },
    ],
  })

  expect(result).toEqual({ ok: true, requeued: true })
  expect(await statusOf(courtIds[0])).toEqual({ status: 'pending', rejection_reason: null })
})

test('an hours edit re-queues a rejected court too', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'rejected', 'Opening hours look wrong.')

  const result = await replaceOperatingHours({
    courtId: courtIds[0],
    days: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opensHour: 11, closesHour: 24 })),
  })

  expect(result).toEqual({ ok: true, requeued: true })
  expect(await statusOf(courtIds[0])).toEqual({ status: 'pending', rejection_reason: null })
})
