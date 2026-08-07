import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@/db'
import { searchBranches } from '@/lib/branches/queries'
import { manilaHour, seedBooking, seedOwner, seedPlayer } from '../helpers/fixtures'

/**
 * A fresh, remote origin for one test's fixtures.
 *
 * These tests must NOT run against Metro Manila coordinates. The shared
 * hosted database holds ~976 leftover `fixture-*` branches from earlier
 * un-torn-down runs, and they all sit on the Marikina point — 980 branches
 * with approved courts fall within 5 km of it. Against `searchBranches`'s
 * default `limit: 50`, a test's own fixture would essentially never appear
 * in the result set, so `.toContain(...)` and every ordering assertion
 * would fail for reasons that have nothing to do with the code under test.
 *
 * The base point is in the Surigao area, ~800 km from Metro Manila, where
 * no seeded, demo, or leftover branch exists. The random per-call offset
 * keeps a run from colliding with rows a previously-FAILED run left behind
 * at the same point (teardown only runs on a clean exit).
 */
function remoteOrigin(): { lat: number; lng: number } {
  return {
    lat: 9.5 + Math.random() * 0.2,
    lng: 125.4 + Math.random() * 0.2,
  }
}

type CourtSpec = {
  name?: string
  environment?: 'indoor' | 'outdoor'
  priceCentavos?: number
  opensHour?: number
  closesHour?: number
  /**
   * Rate bands as `[startHour, endHour)` pairs, defaulting to a single band
   * covering the whole 7-23 window. Explicit pairs let a span test seed two
   * ADJACENT bands (a span may legitimately cross the seam) or two bands with
   * a GAP between them (the unpriced hour, which is not a bookable hour). The
   * database enforces non-overlap via `court_rate_bands_no_overlap` but
   * deliberately permits gaps — see the comment above that constraint in
   * supabase/migrations/20260801063910_listings.sql.
   */
  rateBands?: [number, number][]
}

/**
 * One approved court on an existing branch, with rate bands and all-week
 * operating hours. Extracted from `seedBranchAt` so the "same court for the
 * whole span" test can give a branch a SECOND court without hand-rolling the
 * three inserts (and drifting from the shape every other fixture here uses).
 */
async function seedCourtOn(branchId: string, options: CourtSpec = {}): Promise<string> {
  const court = await db.execute(sql`
    insert into courts (branch_id, name, environment, status)
    values (${branchId}::uuid, ${options.name ?? 'Court 1'},
            ${options.environment ?? 'indoor'}::court_environment, 'approved')
    returning id
  `)
  const courtId = court.rows[0].id as string

  for (const [startHour, endHour] of options.rateBands ?? [[7, 23]]) {
    await db.execute(sql`
      insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
      values (${courtId}::uuid, ${startHour}, ${endHour}, ${options.priceCentavos ?? 30000})
    `)
  }
  for (let day = 0; day <= 6; day++) {
    await db.execute(sql`
      insert into court_operating_hours (court_id, day_of_week, opens_hour, closes_hour)
      values (${courtId}::uuid, ${day}, ${options.opensHour ?? 7}, ${options.closesHour ?? 23})
    `)
  }
  return courtId
}

/**
 * A branch at an exact point with one approved court, given rate bands and
 * all-week operating hours. Returns ids so the test can assert on its own
 * rows only — this database is shared and full of other branches.
 */
async function seedBranchAt(options: CourtSpec & { lat: number; lng: number; amenities?: string[] }) {
  const ownerId = await seedOwner()
  const slug = 'search-fixture-' + crypto.randomUUID()
  const branch = await db.execute(sql`
    insert into branches (owner_id, name, slug, address, city, location, amenities)
    values (${ownerId}::uuid, 'Search Fixture', ${slug}, '1 Test St', 'Marikina',
            st_setsrid(st_makepoint(${options.lng}, ${options.lat}), 4326)::geography,
            ${sql.param(options.amenities ?? [])}::text[])
    returning id
  `)
  const branchId = branch.rows[0].id as string
  const courtId = await seedCourtOn(branchId, options)
  return { ownerId, branchId, courtId, slug }
}

/**
 * A completed booking on the given court/branch, hung off a fresh player, so
 * a review can reference it (reviews.booking_id is unique — one review per
 * booking). `hour` lets callers space bookings out within the same court's
 * 7-23 default operating window so the `bookings_no_overlap` exclusion
 * constraint never fires. Column list and 'completed' status mirror
 * tests/schema/reviews.test.ts's own seedCompletedBooking() (not imported
 * from there — see task brief).
 */
async function seedCompletedBooking(courtId: string, branchId: string, hour: number) {
  const playerId = await seedPlayer()
  const startsAt = manilaHour('2020-01-06', hour)
  const endsAt = manilaHour('2020-01-06', hour + 1)
  const row = await db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
      fee_config_snapshot
    ) values (
      ${courtId}::uuid, ${branchId}::uuid, ${playerId}::uuid,
      ${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz,
      'completed', 26500, 0, 26500, 2650, 0, 23850, '{}'::jsonb
    )
    returning id
  `)
  return { bookingId: row.rows[0].id as string, playerId }
}

describe('searchBranches', () => {
  it('includes a branch inside the radius and excludes one outside it', async () => {
    const origin = remoteOrigin()
    const near = await seedBranchAt({ lat: origin.lat, lng: origin.lng })
    // ~1 degree of latitude is ~111 km — comfortably outside any radius here.
    const far = await seedBranchAt({ lat: origin.lat + 1, lng: origin.lng })

    const results = await searchBranches({ ...origin, radiusMeters: 5000 })
    const slugs = results.map((r) => r.slug)
    expect(slugs).toContain(near.slug)
    expect(slugs).not.toContain(far.slug)
  })

  it('reports distance and sorts by it ascending', async () => {
    const origin = remoteOrigin()
    const close = await seedBranchAt({ lat: origin.lat, lng: origin.lng })
    const further = await seedBranchAt({ lat: origin.lat + 0.02, lng: origin.lng })

    const results = await searchBranches({ ...origin, radiusMeters: 10000, sort: 'distance' })
    const mine = results.filter((r) => r.slug === close.slug || r.slug === further.slug)
    expect(mine.map((r) => r.slug)).toEqual([close.slug, further.slug])
    expect(mine[0].distanceMeters).toBeLessThan(mine[1].distanceMeters!)
  })

  it('filters by environment', async () => {
    const origin = remoteOrigin()
    const indoor = await seedBranchAt({ ...origin, environment: 'indoor' })
    const outdoor = await seedBranchAt({ ...origin, environment: 'outdoor' })

    const results = await searchBranches({ ...origin, radiusMeters: 5000, environment: 'outdoor' })
    const slugs = results.map((r) => r.slug)
    expect(slugs).toContain(outdoor.slug)
    expect(slugs).not.toContain(indoor.slug)
  })

  /**
   * Regression test for a bug found while reading the generated SQL (Step 6):
   * the environment filter's EXISTS clause originally checked only
   * `status = 'approved'`, not that the matching-environment court also has
   * a rate band. A branch whose only *outdoor* court has no price would
   * still surface under `environment: 'outdoor'` as long as some other,
   * differently-environmented court on the same branch had a price (keeping
   * the branch in `branch_agg`). Every other fixture in this file seeds
   * exactly one court per branch, so this gap would never fail on those
   * alone — it only shows up on a multi-court branch, which is deliberately
   * constructed by hand here rather than through `seedBranchAt`.
   */
  it('excludes a branch whose only matching-environment court has no rate band', async () => {
    const origin = remoteOrigin()

    // A priced indoor court keeps the branch in branch_agg; an unpriced
    // outdoor court means there is no real bookable outdoor slot.
    const mixed = await seedBranchAt({ ...origin, environment: 'indoor' })
    await db.execute(sql`
      insert into courts (branch_id, name, environment, status)
      values (${mixed.branchId}::uuid, 'Unpriced Outdoor Court', 'outdoor'::court_environment, 'approved')
    `)

    // A control branch with a genuinely priced outdoor court, so the test
    // also confirms the fix does not over-exclude.
    const properOutdoor = await seedBranchAt({ ...origin, environment: 'outdoor' })

    const results = await searchBranches({ ...origin, radiusMeters: 5000, environment: 'outdoor' })
    const slugs = results.map((r) => r.slug)
    expect(slugs).not.toContain(mixed.slug)
    expect(slugs).toContain(properOutdoor.slug)
  })

  /**
   * Regression test for a second, related bug found in code review: even
   * after the fix above (the environment EXISTS clause requires a rate
   * band), `courtCount`/`minPriceCentavos` were still computed across ALL of
   * a branch's approved+priced courts, not scoped to the requested
   * environment. A branch with an indoor court at 5000 centavos and an
   * outdoor court at 50000 centavos would report `minPriceCentavos: 5000`
   * even under `environment: 'outdoor'` — the indoor court's price leaking
   * into an outdoor-scoped result — which also meant
   * `maxPriceCentavos: 10000` would wrongly let the branch through an
   * "outdoor under ₱100" search whose only outdoor court costs ₱500.
   */
  it('scopes courtCount and minPriceCentavos to the environment filter', async () => {
    const origin = remoteOrigin()
    const mixed = await seedBranchAt({ ...origin, environment: 'indoor', priceCentavos: 5000 })

    const outdoorCourt = await db.execute(sql`
      insert into courts (branch_id, name, environment, status)
      values (${mixed.branchId}::uuid, 'Outdoor Court', 'outdoor'::court_environment, 'approved')
      returning id
    `)
    const outdoorCourtId = outdoorCourt.rows[0].id as string
    await db.execute(sql`
      insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
      values (${outdoorCourtId}::uuid, 7, 23, 50000)
    `)

    // The branch's only outdoor court costs 50000 centavos — far above this
    // cap — so an outdoor-scoped search must not let the branch's much
    // cheaper indoor price satisfy the filter.
    const filtered = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      environment: 'outdoor',
      maxPriceCentavos: 10000,
    })
    expect(filtered.map((r) => r.slug)).not.toContain(mixed.slug)

    // With no price cap, the branch should still appear under
    // `environment: 'outdoor'` — but reporting the outdoor court's own
    // price (50000), not the branch-wide cheapest (the indoor court's 5000).
    const scoped = await searchBranches({ ...origin, radiusMeters: 5000, environment: 'outdoor' })
    const mine = scoped.find((r) => r.slug === mixed.slug)!
    expect(mine.minPriceCentavos).toBe(50000)
  })

  it('filters by max price against the cheapest court', async () => {
    const origin = remoteOrigin()
    const cheap = await seedBranchAt({ ...origin, priceCentavos: 20000 })
    const pricey = await seedBranchAt({ ...origin, priceCentavos: 60000 })

    const results = await searchBranches({ ...origin, radiusMeters: 5000, maxPriceCentavos: 30000 })
    const slugs = results.map((r) => r.slug)
    expect(slugs).toContain(cheap.slug)
    expect(slugs).not.toContain(pricey.slug)
  })

  it('filters by amenities, requiring all of them', async () => {
    const origin = remoteOrigin()
    const both = await seedBranchAt({ ...origin, amenities: ['parking', 'showers'] })
    const one = await seedBranchAt({ ...origin, amenities: ['parking'] })

    const results = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      amenities: ['parking', 'showers'],
    })
    const slugs = results.map((r) => r.slug)
    expect(slugs).toContain(both.slug)
    expect(slugs).not.toContain(one.slug)
  })

  it('excludes a branch closed at the requested hour', async () => {
    const origin = remoteOrigin()
    const open = await seedBranchAt({ ...origin, opensHour: 7, closesHour: 23 })
    const closed = await seedBranchAt({ ...origin, opensHour: 7, closesHour: 12 })

    const results = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: '2026-09-01',
      hour: 18,
    })
    const slugs = results.map((r) => r.slug)
    expect(slugs).toContain(open.slug)
    expect(slugs).not.toContain(closed.slug)
  })

  it('excludes a branch whose only court is already booked at that hour', async () => {
    const origin = remoteOrigin()
    const free = await seedBranchAt({ ...origin })
    const taken = await seedBranchAt({ ...origin })
    const playerId = await seedPlayer()
    await db.execute(sql`
      insert into bookings (
        court_id, branch_id, player_id, starts_at, ends_at, status,
        court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
        platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
        fee_config_snapshot
      ) values (
        ${taken.courtId}::uuid, ${taken.branchId}::uuid, ${playerId}::uuid,
        '2026-09-01T18:00:00+08:00'::timestamptz, '2026-09-01T19:00:00+08:00'::timestamptz,
        'confirmed', 30000, 0, 30000, 3000, 0, 27000, '{}'::jsonb
      )
    `)

    const results = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: '2026-09-01',
      hour: 18,
    })
    const slugs = results.map((r) => r.slug)
    expect(slugs).toContain(free.slug)
    expect(slugs).not.toContain(taken.slug)
  })

  it('excludes a branch whose only court is blocked at that hour', async () => {
    // The "open now"/"open at hour" filter enumerates statuses explicitly
    // rather than reusing the exclusion constraint's predicate, so 'blocked'
    // has to be added by hand here — otherwise search advertises a branch as
    // available at an hour its owner has taken off the market.
    const origin = remoteOrigin()
    const free = await seedBranchAt({ ...origin })
    const blocked = await seedBranchAt({ ...origin })
    await db.execute(sql`
      insert into bookings (
        court_id, branch_id, player_id, starts_at, ends_at, status, created_by,
        court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
        platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
        fee_config_snapshot
      ) values (
        ${blocked.courtId}::uuid, ${blocked.branchId}::uuid, null,
        '2026-09-01T18:00:00+08:00'::timestamptz, '2026-09-01T19:00:00+08:00'::timestamptz,
        'blocked', ${blocked.ownerId}::uuid, 0, 0, 0, 0, 0, 0, null::jsonb
      )
    `)

    const results = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: '2026-09-01',
      hour: 18,
    })
    const slugs = results.map((r) => r.slug)
    expect(slugs).toContain(free.slug)
    expect(slugs).not.toContain(blocked.slug)
  })

  /**
   * Regression test for a third, related bug found in code review: the
   * hour-availability EXISTS subquery (the `c3` block above) checks every
   * approved court on the branch for operating-hours/rate-band/booking
   * availability, but never applies `environmentFilter` the way the
   * `approved_courts` CTE does. A branch whose only *indoor* court is fully
   * booked at the requested hour still satisfies this EXISTS check — and
   * gets returned as an `environment: 'indoor'` result, reporting the
   * indoor court's count/price via `branch_agg` — as long as some other,
   * differently-environmented court (here, an unrelated outdoor court) is
   * free at that hour. The outdoor court's freedom says nothing about
   * whether the requested indoor court is actually bookable then.
   */
  it('excludes a branch whose only matching-environment court is booked at that hour, even if a differently-environmented court is free', async () => {
    const origin = remoteOrigin()

    const mixed = await seedBranchAt({ ...origin, environment: 'indoor' })

    const outdoorCourt = await db.execute(sql`
      insert into courts (branch_id, name, environment, status)
      values (${mixed.branchId}::uuid, 'Outdoor Court', 'outdoor'::court_environment, 'approved')
      returning id
    `)
    const outdoorCourtId = outdoorCourt.rows[0].id as string
    await db.execute(sql`
      insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
      values (${outdoorCourtId}::uuid, 7, 23, 30000)
    `)
    for (let day = 0; day <= 6; day++) {
      await db.execute(sql`
        insert into court_operating_hours (court_id, day_of_week, opens_hour, closes_hour)
        values (${outdoorCourtId}::uuid, ${day}, 7, 23)
      `)
    }

    // Book the INDOOR court (the requested environment) at the target hour,
    // leaving the outdoor court free at that same hour.
    const playerId = await seedPlayer()
    await db.execute(sql`
      insert into bookings (
        court_id, branch_id, player_id, starts_at, ends_at, status,
        court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
        platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
        fee_config_snapshot
      ) values (
        ${mixed.courtId}::uuid, ${mixed.branchId}::uuid, ${playerId}::uuid,
        '2026-09-01T18:00:00+08:00'::timestamptz, '2026-09-01T19:00:00+08:00'::timestamptz,
        'confirmed', 30000, 0, 30000, 3000, 0, 27000, '{}'::jsonb
      )
    `)

    const results = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      environment: 'indoor',
      date: '2026-09-01',
      hour: 18,
    })
    const slugs = results.map((r) => r.slug)
    expect(slugs).not.toContain(mixed.slug)
  })

  /**
   * The `until` span filter.
   *
   * `until` is the EXCLUSIVE end of the requested span, so `hour: 18,
   * until: 21` asks for hours 18, 19 and 20 on ONE court. Every test below
   * seeds its own branches at a fresh remote origin, so a shared, persistent
   * database can never make the assertions ambiguous.
   *
   * The single-hour tests above are the other half of this coverage: they pass
   * `hour` with no `until` and must keep behaving exactly as they did before
   * the span existed, since an absent `until` is just the degenerate span
   * `[hour, hour + 1)`.
   */
  const SPAN_DATE = '2026-09-01'

  it('qualifies for a sub-span the court is free for, but not for the full span', async () => {
    const origin = remoteOrigin()
    const fixture = await seedBranchAt({ ...origin })
    await seedBooking({
      courtId: fixture.courtId,
      branchId: fixture.branchId,
      playerId: await seedPlayer(),
      startsAt: manilaHour(SPAN_DATE, 20),
      status: 'confirmed',
    })

    // 18-20 is clear of the 20-21 booking.
    const sub = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: SPAN_DATE,
      hour: 18,
      until: 20,
    })
    expect(sub.map((r) => r.slug)).toContain(fixture.slug)

    // 18-21 runs into it, and a span is all-or-nothing.
    const full = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: SPAN_DATE,
      hour: 18,
      until: 21,
    })
    expect(full.map((r) => r.slug)).not.toContain(fixture.slug)
  })

  /**
   * THE assertion that pins "one single court for the whole span". Everything
   * else in this block passes under a naive implementation that hoists the
   * span conditions out to branch level ("some court is free for each hour");
   * only this one fails, because the branch here genuinely has a free court
   * for every hour of the span — just never the SAME one. Such a booking
   * cannot be made as one session, so the branch must not be offered.
   */
  it('does not qualify when two different courts each cover only half the span', async () => {
    const origin = remoteOrigin()
    const split = await seedBranchAt({ ...origin })
    const splitCourtB = await seedCourtOn(split.branchId, { name: 'Court 2' })
    // Control: one court free across the entire span, so a failure here means
    // the span filter over-excludes rather than that the fixtures are wrong.
    const whole = await seedBranchAt({ ...origin })

    const playerId = await seedPlayer()
    // Court A takes the second half of 18-21, court B the first half. Each is
    // free for the other half, and neither is free for all of it.
    await seedBooking({
      courtId: split.courtId,
      branchId: split.branchId,
      playerId,
      startsAt: manilaHour(SPAN_DATE, 20),
      hours: 1,
      status: 'confirmed',
    })
    await seedBooking({
      courtId: splitCourtB,
      branchId: split.branchId,
      playerId,
      startsAt: manilaHour(SPAN_DATE, 18),
      hours: 2,
      status: 'confirmed',
    })

    const results = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: SPAN_DATE,
      hour: 18,
      until: 21,
    })
    const slugs = results.map((r) => r.slug)
    expect(slugs).not.toContain(split.slug)
    expect(slugs).toContain(whole.slug)

    // …and each half of that same span IS satisfiable on its own, by a
    // different court each time. This is what makes the exclusion above mean
    // something: the branch is not simply busy, it has a free court for every
    // hour of 18-21 — just never one free court for all of it.
    const firstHalf = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: SPAN_DATE,
      hour: 18,
      until: 20,
    })
    expect(firstHalf.map((r) => r.slug)).toContain(split.slug)
    const secondHalf = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: SPAN_DATE,
      hour: 20,
      until: 21,
    })
    expect(secondHalf.map((r) => r.slug)).toContain(split.slug)
  })

  it('qualifies for a span that crosses a rate-band seam', async () => {
    // Two adjacent bands, no gap: every hour of 11-13 is priced, just not by
    // the same band. A per-span `start_hour <= hour and end_hour > hour` test
    // against a single band would wrongly reject this.
    const origin = remoteOrigin()
    const seam = await seedBranchAt({
      ...origin,
      rateBands: [
        [7, 12],
        [12, 23],
      ],
    })

    const results = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: SPAN_DATE,
      hour: 11,
      until: 13,
    })
    expect(results.map((r) => r.slug)).toContain(seam.slug)
  })

  it('does not qualify for a span containing an unpriced hour', async () => {
    // Bands 7-12 and 13-23 leave hour 12 unpriced. An unpriced hour is not a
    // bookable hour (the rule buildAvailabilityGrid applies per cell), so a
    // span straddling the gap must be rejected even though its first and last
    // hours are both priced — the trap a single-band check falls straight into.
    const origin = remoteOrigin()
    const gapped = await seedBranchAt({
      ...origin,
      rateBands: [
        [7, 12],
        [13, 23],
      ],
    })

    const across = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: SPAN_DATE,
      hour: 11,
      until: 14,
    })
    expect(across.map((r) => r.slug)).not.toContain(gapped.slug)

    // Control: a span wholly inside the second band still qualifies, so the
    // exclusion above is the gap and not the fixture.
    const inside = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: SPAN_DATE,
      hour: 13,
      until: 15,
    })
    expect(inside.map((r) => r.slug)).toContain(gapped.slug)
  })

  it('does not qualify for a span running past closes_hour', async () => {
    const origin = remoteOrigin()
    const early = await seedBranchAt({ ...origin, opensHour: 7, closesHour: 20 })
    const late = await seedBranchAt({ ...origin, opensHour: 7, closesHour: 23 })

    const past = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: SPAN_DATE,
      hour: 18,
      until: 21,
    })
    const pastSlugs = past.map((r) => r.slug)
    expect(pastSlugs).not.toContain(early.slug)
    expect(pastSlugs).toContain(late.slug)

    // closes_hour is exclusive, so a span ENDING exactly at it is still inside
    // the operating window — the boundary the `closes_hour >= end` predicate
    // has to get right.
    const upToClose = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: SPAN_DATE,
      hour: 18,
      until: 20,
    })
    expect(upToClose.map((r) => r.slug)).toContain(early.slug)
  })

  it('excludes a branch whose only court has a live booking in the middle of the span', async () => {
    const origin = remoteOrigin()
    const free = await seedBranchAt({ ...origin })
    const booked = await seedBranchAt({ ...origin })
    const held = await seedBranchAt({ ...origin })
    const stale = await seedBranchAt({ ...origin })

    // Hour 19 sits strictly inside 18-21 — neither endpoint — so only a real
    // overlap test over the whole span catches it.
    await seedBooking({
      courtId: booked.courtId,
      branchId: booked.branchId,
      playerId: await seedPlayer(),
      startsAt: manilaHour(SPAN_DATE, 19),
      status: 'confirmed',
    })
    await seedBooking({
      courtId: held.courtId,
      branchId: held.branchId,
      playerId: await seedPlayer(),
      startsAt: manilaHour(SPAN_DATE, 19),
      status: 'pending_payment',
      expiresAt: new Date(Date.now() + 900_000),
    })
    // An EXPIRED hold occupies nothing, expired-but-unswept included — the
    // half of the status predicate the span must not quietly drop.
    await seedBooking({
      courtId: stale.courtId,
      branchId: stale.branchId,
      playerId: await seedPlayer(),
      startsAt: manilaHour(SPAN_DATE, 19),
      status: 'pending_payment',
      expiresAt: new Date(Date.now() - 900_000),
    })

    const results = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: SPAN_DATE,
      hour: 18,
      until: 21,
    })
    const slugs = results.map((r) => r.slug)
    expect(slugs).toContain(free.slug)
    expect(slugs).not.toContain(booked.slug)
    expect(slugs).not.toContain(held.slug)
    expect(slugs).toContain(stale.slug)
  })

  it('treats an absent until as a one-hour span, ignoring the next hour', async () => {
    // The regression guard for the default `end = hour + 1`: a booking at 19
    // must not affect an 18-with-no-`until` search. If the span ever widened
    // by accident, this branch would vanish from a single-hour result.
    const origin = remoteOrigin()
    const fixture = await seedBranchAt({ ...origin })
    await seedBooking({
      courtId: fixture.courtId,
      branchId: fixture.branchId,
      playerId: await seedPlayer(),
      startsAt: manilaHour(SPAN_DATE, 19),
      status: 'confirmed',
    })

    const results = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: SPAN_DATE,
      hour: 18,
    })
    expect(results.map((r) => r.slug)).toContain(fixture.slug)
  })

  it('returns a null rating and zero count for a branch with no reviews', async () => {
    const origin = remoteOrigin()
    const fixture = await seedBranchAt({ ...origin })
    const results = await searchBranches({ ...origin, radiusMeters: 5000 })
    const mine = results.find((r) => r.slug === fixture.slug)!
    expect(mine.ratingAvg).toBeNull()
    expect(mine.ratingCount).toBe(0)
  })

  it('returns numbers, not strings, for every numeric field', async () => {
    const origin = remoteOrigin()
    const fixture = await seedBranchAt({ ...origin, priceCentavos: 24000 })
    const results = await searchBranches({ ...origin, radiusMeters: 5000 })
    const mine = results.find((r) => r.slug === fixture.slug)!
    // The pg driver returns `numeric` as a string. Every aggregate in this
    // query must be cast in SQL so it arrives as a JS number.
    expect(typeof mine.minPriceCentavos).toBe('number')
    expect(typeof mine.courtCount).toBe('number')
    expect(typeof mine.ratingCount).toBe('number')
    expect(typeof mine.distanceMeters).toBe('number')
    expect(mine.minPriceCentavos).toBe(24000)
  })

  /**
   * Task 5 shipped `sort: 'rating'` syntax-checked but never exercised
   * against real review rows (task-6-brief.md's "additional requirement").
   * Three branches at the same remote origin: one earns a high average
   * rating, one a low one, and one gets no reviews at all — proving both the
   * descending order and the `nulls last` placement.
   */
  it(
    'sorts by rating average descending, with unreviewed branches last',
    async () => {
      const origin = remoteOrigin()
      // Independent fixtures — run the three branch seeds concurrently so this
      // test's ~30 sequential round trips to the hosted DB don't trip the
      // default 5s vitest timeout under real network latency.
      const [higher, lower, none] = await Promise.all([
        seedBranchAt({ ...origin }),
        seedBranchAt({ ...origin }),
        seedBranchAt({ ...origin }),
      ])

      let hour = 8
      for (const rating of [5, 5]) {
        const { bookingId, playerId } = await seedCompletedBooking(higher.courtId, higher.branchId, hour++)
        await db.execute(sql`
          insert into reviews (booking_id, branch_id, player_id, rating)
          values (${bookingId}::uuid, ${higher.branchId}::uuid, ${playerId}::uuid, ${rating})
        `)
      }
      for (const rating of [1, 2]) {
        const { bookingId, playerId } = await seedCompletedBooking(lower.courtId, lower.branchId, hour++)
        await db.execute(sql`
          insert into reviews (booking_id, branch_id, player_id, rating)
          values (${bookingId}::uuid, ${lower.branchId}::uuid, ${playerId}::uuid, ${rating})
        `)
      }

      const results = await searchBranches({ ...origin, radiusMeters: 5000, sort: 'rating' })
      const slugs = results.map((r) => r.slug)
      const higherIdx = slugs.indexOf(higher.slug)
      const lowerIdx = slugs.indexOf(lower.slug)
      const noneIdx = slugs.indexOf(none.slug)
      expect(higherIdx).toBeGreaterThanOrEqual(0)
      expect(lowerIdx).toBeGreaterThan(higherIdx)
      expect(noneIdx).toBeGreaterThan(lowerIdx)
    },
    20000,
  )

  it('returns numeric coordinates', async () => {
    const origin = remoteOrigin()
    const fixture = await seedBranchAt({ ...origin })
    const results = await searchBranches({ ...origin, radiusMeters: 5000 })
    const mine = results.find((r) => r.slug === fixture.slug)!
    expect(typeof mine.lat).toBe('number')
    expect(typeof mine.lng).toBe('number')
    expect(mine.lat).toBeCloseTo(origin.lat, 3)
  })

  /**
   * Negative-fixture pin for the `c.status = 'approved'` predicate itself
   * (final review finding): every fixture in this file seeds only approved
   * courts, so nothing here would fail if that predicate were deleted
   * entirely from `approvedPricedCourtsCte`. This seeds a branch with one
   * approved court (via `seedBranchAt`, which already gives it a rate band
   * and week-round operating hours) plus a pending and a suspended sibling
   * court on the SAME branch, and asserts `courtCount` still reports 1 — not
   * 3 — proving pending/rejected/suspended courts never inflate a public
   * result even when they sit alongside a real approved court.
   *
   * Both siblings are given their own rate band (priced at the same
   * 30000 centavos as the approved court's default). Without a rate band, a
   * non-approved court would already be excluded from `branch_agg` by its
   * null `min_price` alone (see `approvedPricedCourtsCte`'s
   * `where ac.min_price is not null`), which would let this test pass even
   * if the `c.status = 'approved'` predicate were deleted outright —
   * confirmed by hand: with the predicate removed but no rate bands on the
   * siblings, this test still reported courtCount 1. Pricing them closes
   * that gap, so the assertion depends on the status filter itself.
   */
  it('counts only the approved court, not a pending or suspended sibling', async () => {
    const origin = remoteOrigin()
    const fixture = await seedBranchAt({ ...origin })
    const siblings = await db.execute(sql`
      insert into courts (branch_id, name, environment, status)
      values
        (${fixture.branchId}::uuid, 'Pending Court', 'indoor'::court_environment, 'pending'),
        (${fixture.branchId}::uuid, 'Suspended Court', 'indoor'::court_environment, 'suspended')
      returning id
    `)
    for (const row of siblings.rows) {
      await db.execute(sql`
        insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
        values (${row.id as string}::uuid, 7, 23, 30000)
      `)
    }

    const results = await searchBranches({ ...origin, radiusMeters: 5000 })
    const mine = results.find((r) => r.slug === fixture.slug)!
    expect(mine.courtCount).toBe(1)
  })

  it('excludes branches with no approved courts', async () => {
    const origin = remoteOrigin()
    const ownerId = await seedPlayer()
    await db.execute(sql`update profiles set role = 'owner' where id = ${ownerId}::uuid`)
    const slug = 'search-fixture-' + crypto.randomUUID()
    await db.execute(sql`
      insert into branches (owner_id, name, slug, address, city, location)
      values (${ownerId}::uuid, 'No Courts', ${slug}, '1 Test St', 'Marikina',
              st_setsrid(st_makepoint(${origin.lng}, ${origin.lat}), 4326)::geography)
    `)
    const results = await searchBranches({ ...origin, radiusMeters: 5000 })
    expect(results.map((r) => r.slug)).not.toContain(slug)
  })
})
