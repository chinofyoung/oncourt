import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@/db'
import { getBranchDetail, getHomeData, getOwnerProfile, searchBranches } from '@/lib/branches/queries'
import { CITIES, CITY_SEARCH_RADIUS_METERS } from '@/lib/geo/cities'
import { seedPlayer } from '../helpers/fixtures'

async function seedOwnerWithBranches(branchCount: number) {
  const ownerId = await seedPlayer()
  const ownerSlug = 'owner-fixture-' + crypto.randomUUID()
  await db.execute(sql`
    update profiles
    set role = 'owner', business_name = 'Fixture Courts', slug = ${ownerSlug}
    where id = ${ownerId}::uuid
  `)

  const branchSlugs: string[] = []
  const branchIds: string[] = []
  for (let i = 0; i < branchCount; i++) {
    const slug = 'detail-fixture-' + crypto.randomUUID()
    const branch = await db.execute(sql`
      insert into branches (owner_id, name, slug, description, address, city, location, amenities)
      values (${ownerId}::uuid, ${'Fixture Branch ' + i}, ${slug}, 'A description',
              '1 Test St', 'Marikina',
              st_setsrid(st_makepoint(121.1029, 14.6507), 4326)::geography,
              array['parking', 'showers'])
      returning id
    `)
    const branchId = branch.rows[0].id as string
    branchIds.push(branchId)
    branchSlugs.push(slug)

    const court = await db.execute(sql`
      insert into courts (branch_id, name, environment, status)
      values (${branchId}::uuid, 'Court 1', 'indoor', 'approved')
      returning id
    `)
    const courtId = court.rows[0].id as string
    await db.execute(sql`
      insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
      values (${courtId}::uuid, 7, 23, 30000)
    `)
    for (let day = 0; day <= 6; day++) {
      await db.execute(sql`
        insert into court_operating_hours (court_id, day_of_week, opens_hour, closes_hour)
        values (${courtId}::uuid, ${day}, 7, 23)
      `)
    }
    await db.execute(sql`
      insert into branch_photos (branch_id, storage_path, sort_order) values
        (${branchId}::uuid, ${'branches/' + branchId + '/2.jpg'}, 1),
        (${branchId}::uuid, ${'branches/' + branchId + '/1.jpg'}, 0)
    `)
  }
  return { ownerId, ownerSlug, branchIds, branchSlugs }
}

describe('getBranchDetail', () => {
  it('returns null for an unknown slug', async () => {
    expect(await getBranchDetail('no-such-branch-' + crypto.randomUUID())).toBeNull()
  })

  it('returns the branch with photos ordered by sort_order', async () => {
    const { branchSlugs, branchIds } = await seedOwnerWithBranches(1)
    const detail = (await getBranchDetail(branchSlugs[0]))!
    expect(detail.name).toBe('Fixture Branch 0')
    expect(detail.description).toBe('A description')
    expect(detail.amenities).toEqual(['parking', 'showers'])
    expect(detail.photoPaths).toEqual([
      `branches/${branchIds[0]}/1.jpg`,
      `branches/${branchIds[0]}/2.jpg`,
    ])
  })

  it('exposes the owner and numeric coordinates', async () => {
    const { branchSlugs, ownerSlug } = await seedOwnerWithBranches(1)
    const detail = (await getBranchDetail(branchSlugs[0]))!
    expect(detail.owner.slug).toBe(ownerSlug)
    expect(detail.owner.businessName).toBe('Fixture Courts')
    expect(typeof detail.lat).toBe('number')
    expect(typeof detail.lng).toBe('number')
    expect(detail.lat).toBeCloseTo(14.6507, 3)
    expect(detail.lng).toBeCloseTo(121.1029, 3)
  })

  it('returns an empty review list and null rating when there are no reviews', async () => {
    const { branchSlugs } = await seedOwnerWithBranches(1)
    const detail = (await getBranchDetail(branchSlugs[0]))!
    expect(detail.reviews).toEqual([])
    expect(detail.ratingAvg).toBeNull()
    expect(detail.ratingCount).toBe(0)
  })

  /**
   * Regression test for the courtCount/minPriceCentavos consistency fix
   * (code review Finding 1): a prior version of getBranchDetail counted every
   * approved court regardless of pricing, which disagreed with
   * searchBranches/getOwnerProfile/getHomeData's shared rule that an
   * unpriced court isn't a real bookable court. seedOwnerWithBranches(1)
   * already gives the branch one approved, priced court ("Court 1", 30000
   * centavos) — this adds a second approved court with NO rate band at all,
   * so a courtCount of 2 (or a minPriceCentavos pulled from a null) would
   * mean the bug is back.
   */
  it('excludes an approved court with no rate band from courtCount and minPriceCentavos', async () => {
    const { branchSlugs, branchIds } = await seedOwnerWithBranches(1)
    await db.execute(sql`
      insert into courts (branch_id, name, environment, status)
      values (${branchIds[0]}::uuid, 'Unpriced Court', 'indoor', 'approved')
    `)

    const detail = (await getBranchDetail(branchSlugs[0]))!
    expect(detail.courtCount).toBe(1)
    expect(detail.minPriceCentavos).toBe(30000)
  })

  /**
   * Negative-fixture pin for `getBranchDetail`'s own `c.status = 'approved'`
   * predicate (final review finding): no existing fixture in this file ever
   * creates a non-approved court, so that predicate could be deleted
   * outright and this suite would stay green. Adds a pending and a suspended
   * sibling alongside the one approved, priced court `seedOwnerWithBranches`
   * already seeds, and asserts `courtCount` still reports 1 — not 3.
   *
   * Both siblings get their own rate band. Without one, a non-approved
   * court would already be excluded by the surrounding
   * `where ac.min_price is not null` filter alone (its `min_price` would be
   * null), which would let this test pass even with the status predicate
   * deleted outright — verified by hand against this exact fixture shape in
   * the sibling `searchBranches` test in tests/branches/search.test.ts.
   * Pricing them closes that gap.
   */
  it('exposes only the approved court, not a pending or suspended sibling', async () => {
    const { branchSlugs, branchIds } = await seedOwnerWithBranches(1)
    const siblings = await db.execute(sql`
      insert into courts (branch_id, name, environment, status)
      values
        (${branchIds[0]}::uuid, 'Pending Court', 'indoor', 'pending'),
        (${branchIds[0]}::uuid, 'Suspended Court', 'indoor', 'suspended')
      returning id
    `)
    for (const row of siblings.rows) {
      await db.execute(sql`
        insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
        values (${row.id as string}::uuid, 7, 23, 30000)
      `)
    }

    const detail = (await getBranchDetail(branchSlugs[0]))!
    expect(detail.courtCount).toBe(1)
  })
})

describe('getOwnerProfile', () => {
  it('returns null for an unknown slug', async () => {
    expect(await getOwnerProfile('no-such-owner-' + crypto.randomUUID())).toBeNull()
  })

  it('lists every branch the owner has', async () => {
    const { ownerSlug, branchSlugs } = await seedOwnerWithBranches(3)
    const profile = (await getOwnerProfile(ownerSlug))!
    expect(profile.businessName).toBe('Fixture Courts')
    expect(profile.branches).toHaveLength(3)
    expect(profile.branches.map((b) => b.slug).sort()).toEqual([...branchSlugs].sort())
    expect(typeof profile.branches[0].minPriceCentavos).toBe('number')
  })
})

describe('getHomeData', () => {
  it('returns featured branches, city counts and a numeric open-now count', async () => {
    await seedOwnerWithBranches(1)
    const home = await getHomeData()
    expect(home.featured.length).toBeGreaterThan(0)
    expect(home.featured.length).toBeLessThanOrEqual(6)
    expect(home.cities.length).toBeGreaterThan(0)
    expect(typeof home.cities[0].branchCount).toBe('number')
    expect(typeof home.openNowCount).toBe('number')
    expect(Number.isInteger(home.openNowCount)).toBe(true)
  })

  /**
   * Regression test for code review Finding 3: `cities` previously counted a
   * branch toward its city if it had ANY approved court, with no rate-band
   * requirement — unlike every other query in this file (including this same
   * function's own `featured`). That meant a city's "N branches" count on
   * the home page could disagree with what a user actually gets back after
   * clicking through to search that city.
   *
   * `cities` no longer groups by the free-text `branches.city` column at
   * all (see queries.ts's `getHomeData` for why: it disagreed with
   * `/search?city=<slug>`'s radius-based count by 3-10x) — it's a radius
   * search against each named city's centroid instead, using the exact same
   * `approvedPricedCourtsCte()` join `searchBranches` uses. So rather than
   * diffing the live, shared `cities` count (which the hosted, persistent
   * test DB can mutate between two calls via concurrent test runs — a
   * flakiness class the sibling `search.test.ts` avoids entirely by
   * searching 800km from Metro Manila), this seeds the unpriced-only branch
   * at Marikina's exact centroid and calls `searchBranches` directly against
   * that same centroid/radius, then asserts the fixture's own slug is absent
   * from the results. That's an exact, per-fixture check immune to
   * concurrent churn elsewhere in the city, and it still fails if the
   * "approved AND priced" rule regresses in the query path both `cities` and
   * `searchBranches` share.
   */
  it('does not count a branch whose only approved court has no rate band', async () => {
    const marikina = CITIES.find((c) => c.slug === 'marikina')!

    const ownerId = await seedPlayer()
    await db.execute(sql`update profiles set role = 'owner' where id = ${ownerId}::uuid`)
    const slug = 'home-fixture-' + crypto.randomUUID()
    const branch = await db.execute(sql`
      insert into branches (owner_id, name, slug, address, city, location)
      values (${ownerId}::uuid, 'Unpriced City Branch', ${slug}, '1 Test St', 'Marikina',
              st_setsrid(st_makepoint(${marikina.lng}, ${marikina.lat}), 4326)::geography)
      returning id
    `)
    const branchId = branch.rows[0].id as string
    await db.execute(sql`
      insert into courts (branch_id, name, environment, status)
      values (${branchId}::uuid, 'Unpriced Court', 'indoor', 'approved')
    `)

    const results = await searchBranches({
      lat: marikina.lat,
      lng: marikina.lng,
      radiusMeters: CITY_SEARCH_RADIUS_METERS,
    })
    expect(results.map((r) => r.slug)).not.toContain(slug)
  })
})
