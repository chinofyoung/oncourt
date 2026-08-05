import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import { manilaWeekday } from '@/lib/date-manila'
import { CITIES, CITY_SEARCH_RADIUS_METERS, DEFAULT_CITY_SLUG } from '@/lib/geo/cities'

export type BranchSummary = {
  id: string
  slug: string
  name: string
  city: string
  address: string
  amenities: string[]
  courtCount: number
  minPriceCentavos: number
  ratingAvg: number | null
  ratingCount: number
  distanceMeters: number | null
  coverPhotoPath: string | null
  lat: number | null
  lng: number | null
}

export type SearchFilters = {
  lat: number
  lng: number
  radiusMeters?: number
  date?: string
  hour?: number
  environment?: 'indoor' | 'outdoor'
  maxPriceCentavos?: number
  amenities?: string[]
  sort?: 'distance' | 'price' | 'rating'
  limit?: number
}

const DEFAULT_RADIUS_METERS = 25_000
const DEFAULT_LIMIT = 50

/**
 * The shared "approved AND has a priced rate band" business rule, as a `with`
 * prefix any query can splice in front of its own `select`.
 *
 * Produces two CTEs: `approved_courts` (one row per approved court, plus its
 * cheapest rate band price if it has one) and `branch_agg` (one row per
 * branch that has at least one such priced court, with `court_count`/
 * `min_price_centavos`). A branch with no priced approved court simply has no
 * row in `branch_agg` — callers that need every branch regardless (e.g. a
 * single-row detail lookup) must `left join` it; callers that only want
 * branches with a real bookable court (search results, owner listings,
 * featured) `join` it.
 *
 * `environmentFilter` lets a caller scope the aggregate to one environment —
 * `searchBranches` is the only current user of this, so an
 * `environment: 'outdoor'` search reports the cheapest *outdoor* court's
 * price, not the branch's cheapest court overall (see `searchBranches`'s own
 * comment on why this matters). Every other call site passes the default,
 * unfiltered `sql\`\``.
 */
function approvedPricedCourtsCte(environmentFilter: SQL = sql``): SQL {
  return sql`
    with approved_courts as (
      select c.id, c.branch_id,
             (select min(rb.price_centavos) from court_rate_bands rb where rb.court_id = c.id) as min_price
      from courts c
      where c.status = 'approved' ${environmentFilter}
    ),
    branch_agg as (
      select ac.branch_id,
             count(*)::int as court_count,
             min(ac.min_price)::int as min_price_centavos
      from approved_courts ac
      where ac.min_price is not null
      group by ac.branch_id
    )
  `
}

/**
 * Maps a raw row onto BranchSummary.
 *
 * Every numeric column is coerced with Number() as a second line of defense:
 * the SQL below already casts each aggregate to int/float8 (the pg driver
 * returns `numeric` as a *string*), and a test asserts the types, but a
 * future column added without a cast would otherwise leak a string into
 * arithmetic silently.
 */
function toSummary(row: Record<string, unknown>): BranchSummary {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    city: row.city as string,
    address: row.address as string,
    amenities: (row.amenities as string[]) ?? [],
    courtCount: Number(row.court_count),
    minPriceCentavos: Number(row.min_price_centavos),
    ratingAvg: row.rating_avg === null ? null : Number(row.rating_avg),
    ratingCount: Number(row.rating_count),
    distanceMeters: row.distance_meters === null ? null : Number(row.distance_meters),
    coverPhotoPath: (row.cover_photo_path as string | null) ?? null,
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
  }
}

/**
 * Branches near a point, with the aggregates every card needs.
 *
 * Structure: a CTE reduces approved courts to one row per branch (count,
 * cheapest rate band), and the main query joins ratings and the cover photo
 * through LEFT JOIN LATERAL so a branch with no reviews and no photos still
 * appears.
 *
 * A branch is only listed if it has at least one approved court that has a
 * rate band — an hour with no price to charge is not a real open slot, which
 * is the same rule `buildAvailabilityGrid` applies per cell.
 *
 * When `filters.environment` is set, `courtCount`/`minPriceCentavos` are
 * scoped to that environment (an outdoor-filtered search reports the
 * cheapest *outdoor* court, not the branch's cheapest court overall) — see
 * `approved_courts`'s conditional `environmentFilter` fragment below.
 * `filters.hour` is deliberately NOT scoped into these aggregates; that
 * would require picking one court's price to show when several are open at
 * that hour, which is a separate product question.
 */
export async function searchBranches(filters: SearchFilters): Promise<BranchSummary[]> {
  const radius = filters.radiusMeters ?? DEFAULT_RADIUS_METERS
  const limit = filters.limit ?? DEFAULT_LIMIT
  const point = sql`st_setsrid(st_makepoint(${filters.lng}, ${filters.lat}), 4326)::geography`

  const conditions: SQL[] = [
    sql`b.location is not null`,
    sql`st_dwithin(b.location, ${point}, ${radius})`,
  ]

  // Scopes `approved_courts` itself to the requested environment, rather
  // than filtering branches with a separate EXISTS check afterward. This
  // makes `branch_agg`'s court_count/min_price_centavos naturally
  // environment-scoped too: an `environment: 'outdoor'` search reports the
  // cheapest *outdoor* court's price, not the branch's cheapest court
  // overall. A prior version filtered on a bare `courts` EXISTS instead,
  // which let `min_price_centavos` leak in from a differently-environmented
  // court — a branch with an indoor court at ₱50 and an outdoor court at
  // ₱500 would report ₱50 (and pass a `maxPriceCentavos: 100` filter) even
  // though its only outdoor court costs ₱500. See
  // "scopes courtCount/minPriceCentavos to the environment filter" in
  // tests/branches/search.test.ts.
  function environmentFilter(alias: string): SQL {
    return filters.environment
      ? sql`and ${sql.raw(alias)}.environment = ${filters.environment}::court_environment`
      : sql``
  }

  if (filters.maxPriceCentavos !== undefined) {
    conditions.push(sql`ba.min_price_centavos <= ${filters.maxPriceCentavos}`)
  }

  if (filters.amenities && filters.amenities.length > 0) {
    // @> is "contains", so this requires ALL of the requested amenities.
    conditions.push(sql`b.amenities @> ${sql.param(filters.amenities)}::text[]`)
  }

  if (filters.hour !== undefined && filters.date) {
    const weekday = manilaWeekday(filters.date)
    const hour = filters.hour
    const slotStart = `${filters.date}T${String(hour).padStart(2, '0')}:00:00+08:00`
    const slotEnd = `${filters.date}T${String(hour + 1).padStart(2, '0')}:00:00+08:00`

    // Mirrors src/lib/booking/availability.ts's definition of a bookable
    // slot exactly: within the operating window, covered by a rate band, and
    // not occupied by a live booking (an expired hold occupies nothing).
    conditions.push(sql`exists (
      select 1
      from courts c3
      join court_operating_hours oh
        on oh.court_id = c3.id and oh.day_of_week = ${weekday}
      where c3.branch_id = b.id
        and c3.status = 'approved'
        ${environmentFilter('c3')}
        and oh.opens_hour <= ${hour} and oh.closes_hour > ${hour}
        and exists (
          select 1 from court_rate_bands rb
          where rb.court_id = c3.id and rb.start_hour <= ${hour} and rb.end_hour > ${hour}
        )
        and not exists (
          select 1 from bookings bk
          where bk.court_id = c3.id
            and bk.slot && tstzrange(${slotStart}::timestamptz, ${slotEnd}::timestamptz, '[)')
            and (
              -- Matches src/lib/booking/availability.ts and
              -- bookings_no_overlap's predicate: a block takes the slot, so a
              -- branch whose only court is blocked at this hour is not open.
              bk.status in ('confirmed', 'completed', 'blocked')
              or (bk.status = 'pending_payment' and bk.expires_at > now())
            )
        )
    )`)
  }

  const orderBy =
    filters.sort === 'price'
      ? sql`ba.min_price_centavos asc, b.name`
      : filters.sort === 'rating'
        ? sql`r.rating_avg desc nulls last, r.rating_count desc, b.name`
        : sql`distance_meters asc nulls last`

  const query = sql`
    ${approvedPricedCourtsCte(environmentFilter('c'))}
    select b.id, b.slug, b.name, b.city, b.address, b.amenities,
           ba.court_count, ba.min_price_centavos,
           st_distance(b.location, ${point})::float8 as distance_meters,
           r.rating_avg, r.rating_count,
           p.storage_path as cover_photo_path,
           st_y(b.location::geometry)::float8 as lat, st_x(b.location::geometry)::float8 as lng
    from branches b
    join branch_agg ba on ba.branch_id = b.id
    left join lateral (
      select round(avg(rv.rating)::numeric, 1)::float8 as rating_avg,
             count(*)::int as rating_count
      from reviews rv
      where rv.branch_id = b.id
    ) r on true
    left join lateral (
      select bp.storage_path from branch_photos bp
      where bp.branch_id = b.id
      order by bp.sort_order, bp.id
      limit 1
    ) p on true
    where ${sql.join(conditions, sql` and `)}
    order by ${orderBy}
    limit ${limit}
  `

  const result = await db.execute(query)

  return result.rows.map(toSummary)
}

export type BranchReview = {
  id: string
  rating: number
  body: string | null
  createdAt: string
  authorName: string | null
  authorAvatarUrl: string | null
}

export type BranchDetail = {
  id: string
  slug: string
  name: string
  description: string | null
  address: string
  city: string
  amenities: string[]
  lat: number | null
  lng: number | null
  contactPhone: string | null
  contactEmail: string | null
  photoPaths: string[]
  courtCount: number
  minPriceCentavos: number | null
  ratingAvg: number | null
  ratingCount: number
  owner: { slug: string | null; businessName: string | null; logoPath: string | null }
  reviews: BranchReview[]
}

export type OwnerProfile = {
  id: string
  slug: string
  businessName: string | null
  fullName: string | null
  logoPath: string | null
  branches: BranchSummary[]
}

export type HomeData = {
  featured: BranchSummary[]
  cities: { slug: string; name: string; branchCount: number }[]
  openNowCount: number
}

const REVIEW_LIMIT = 8
const FEATURED_LIMIT = 6

/**
 * Everything the branch page needs except the availability grid, which keeps
 * its own existing path (`loadBranchDay` in src/lib/booking/availability.ts).
 *
 * `location` is read back through st_y/st_x rather than as a geography value:
 * the driver would otherwise hand back the WKB hex string, which the map
 * component cannot use.
 *
 * courtCount/minPriceCentavos are scoped to approved courts that ALSO have at
 * least one rate band (via `approved_courts`/`branch_agg`, the same CTE shape
 * `searchBranches` uses) rather than a bare `count(*)` over every approved
 * court. The brief's original draft counted all approved courts regardless of
 * pricing, which would disagree with `BranchSummary.courtCount` for the same
 * branch (e.g. 3 approved courts but only 2 priced ones shows "3 courts" on
 * the detail page and "2 courts" everywhere else the branch appears as a
 * card) — an unpriced court isn't a real bookable court, matching the rule
 * `searchBranches` already documents.
 *
 * Deliberately does NOT share `approvedPricedCourtsCte()` the way
 * `searchBranches`/`getOwnerProfile`/`getHomeData` do. That CTE's
 * `branch_agg` groups by `branch_id` over the *entire* `courts` table before
 * a single-row lookup can join back down to one branch — confirmed via
 * `explain (analyze)` against the hosted DB: the shared-CTE form plans a
 * `Seq Scan on courts` (cost ~226) with a correlated rate-band subquery
 * running once per court in the whole system, then a `GroupAggregate` over
 * every branch, followed by a `Join Filter` that throws away every row but
 * the one requested; the lateral form here plans an `Index Scan using
 * courts_branch_approved_idx` (cost ~33) bounded to this branch's own courts.
 * At today's ~29-row `courts` table both plans run in a few ms, but
 * `getBranchDetail` is the branch-detail-page query — likely the
 * highest-traffic read in the app — and the shared-CTE form's cost scales
 * with total courts across every owner on the platform, not with the one
 * branch being viewed. The correlated lateral keeps this page's cost
 * independent of platform size, so it stays as its own query rather than
 * sharing `approvedPricedCourtsCte()`.
 */
export async function getBranchDetail(slug: string): Promise<BranchDetail | null> {
  const result = await db.execute(sql`
    select b.id, b.slug, b.name, b.description, b.address, b.city, b.amenities,
           b.contact_phone, b.contact_email,
           st_y(b.location::geometry)::float8 as lat,
           st_x(b.location::geometry)::float8 as lng,
           pr.slug as owner_slug, pr.business_name, pr.business_logo_path,
           agg.court_count, agg.min_price_centavos,
           r.rating_avg, r.rating_count
    from branches b
    join profiles pr on pr.id = b.owner_id
    left join lateral (
      select count(*)::int as court_count, min(ac.min_price)::int as min_price_centavos
      from (
        select c.id,
               (select min(rb.price_centavos) from court_rate_bands rb where rb.court_id = c.id)
                 as min_price
        from courts c
        where c.branch_id = b.id and c.status = 'approved'
      ) ac
      where ac.min_price is not null
    ) agg on true
    left join lateral (
      select round(avg(rv.rating)::numeric, 1)::float8 as rating_avg,
             count(*)::int as rating_count
      from reviews rv where rv.branch_id = b.id
    ) r on true
    where b.slug = ${slug}
  `)

  const row = result.rows[0]
  if (!row) return null
  const branchId = row.id as string

  const photos = await db.execute(sql`
    select storage_path from branch_photos
    where branch_id = ${branchId}::uuid
    order by sort_order, id
  `)

  const reviews = await db.execute(sql`
    select rv.id, rv.rating, rv.body, rv.created_at,
           pr.full_name, pr.avatar_url
    from reviews rv
    join profiles pr on pr.id = rv.player_id
    where rv.branch_id = ${branchId}::uuid
    order by rv.created_at desc, rv.id
    limit ${REVIEW_LIMIT}
  `)

  return {
    id: branchId,
    slug: row.slug as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    address: row.address as string,
    city: row.city as string,
    amenities: (row.amenities as string[]) ?? [],
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
    contactPhone: (row.contact_phone as string | null) ?? null,
    contactEmail: (row.contact_email as string | null) ?? null,
    photoPaths: photos.rows.map((p) => p.storage_path as string),
    courtCount: Number(row.court_count ?? 0),
    minPriceCentavos: row.min_price_centavos === null ? null : Number(row.min_price_centavos),
    ratingAvg: row.rating_avg === null ? null : Number(row.rating_avg),
    ratingCount: Number(row.rating_count ?? 0),
    owner: {
      slug: (row.owner_slug as string | null) ?? null,
      businessName: (row.business_name as string | null) ?? null,
      logoPath: (row.business_logo_path as string | null) ?? null,
    },
    reviews: reviews.rows.map((rv) => ({
      id: rv.id as string,
      rating: Number(rv.rating),
      body: (rv.body as string | null) ?? null,
      createdAt: new Date(rv.created_at as string).toISOString(),
      authorName: (rv.full_name as string | null) ?? null,
      authorAvatarUrl: (rv.avatar_url as string | null) ?? null,
    })),
  }
}

/**
 * An owner's brand page: the profile plus a card-shaped summary of every
 * branch they own.
 *
 * Reuses the same aggregate shape as searchBranches so BranchCard renders
 * identically here; distanceMeters is null because there is no reference
 * point on this page.
 */
export async function getOwnerProfile(slug: string): Promise<OwnerProfile | null> {
  const ownerResult = await db.execute(sql`
    select id, slug, business_name, full_name, business_logo_path
    from profiles where slug = ${slug} and role in ('owner', 'admin')
  `)
  const owner = ownerResult.rows[0]
  if (!owner) return null

  const branches = await db.execute(sql`
    ${approvedPricedCourtsCte()}
    select b.id, b.slug, b.name, b.city, b.address, b.amenities,
           ba.court_count, ba.min_price_centavos,
           null::float8 as distance_meters,
           r.rating_avg, r.rating_count,
           p.storage_path as cover_photo_path,
           st_y(b.location::geometry)::float8 as lat, st_x(b.location::geometry)::float8 as lng
    from branches b
    join branch_agg ba on ba.branch_id = b.id
    left join lateral (
      select round(avg(rv.rating)::numeric, 1)::float8 as rating_avg,
             count(*)::int as rating_count
      from reviews rv where rv.branch_id = b.id
    ) r on true
    left join lateral (
      select bp.storage_path from branch_photos bp
      where bp.branch_id = b.id order by bp.sort_order, bp.id limit 1
    ) p on true
    where b.owner_id = ${owner.id as string}::uuid
    order by b.name
  `)

  return {
    id: owner.id as string,
    slug: owner.slug as string,
    businessName: (owner.business_name as string | null) ?? null,
    fullName: (owner.full_name as string | null) ?? null,
    logoPath: (owner.business_logo_path as string | null) ?? null,
    branches: branches.rows.map(toSummary),
  }
}

/**
 * Home page data: featured branches, the city list with counts for the
 * "browse by city" strip, and the live indicator's open-court count.
 *
 * `openNowCount` counts approved courts that are inside their operating
 * window for the current Manila hour, have a rate band covering it, and have
 * no live booking on it — the same three conditions searchBranches applies.
 */
export async function getHomeData(): Promise<HomeData> {
  const featured = await db.execute(sql`
    ${approvedPricedCourtsCte()}
    select b.id, b.slug, b.name, b.city, b.address, b.amenities,
           ba.court_count, ba.min_price_centavos,
           null::float8 as distance_meters,
           r.rating_avg, r.rating_count,
           p.storage_path as cover_photo_path,
           st_y(b.location::geometry)::float8 as lat, st_x(b.location::geometry)::float8 as lng
    from branches b
    join branch_agg ba on ba.branch_id = b.id
    left join lateral (
      select round(avg(rv.rating)::numeric, 1)::float8 as rating_avg,
             count(*)::int as rating_count
      from reviews rv where rv.branch_id = b.id
    ) r on true
    left join lateral (
      select bp.storage_path from branch_photos bp
      where bp.branch_id = b.id order by bp.sort_order, bp.id limit 1
    ) p on true
    order by r.rating_avg desc nulls last, ba.court_count desc, b.name
    limit ${FEATURED_LIMIT}
  `)

  // Counts branches the SAME way `/search?city=<slug>` finds them — a radius
  // search around each city's centroid (see src/lib/geo/cities.ts) at the
  // same 12,000m radius parseSearchParams uses for a non-default city — NOT
  // a string `group by b.city`. A prior version grouped on the raw
  // `branches.city` column, which disagreed with the radius-based `/search`
  // results by 3-10x (e.g. chip said "Makati (1)" while `/search?city=makati`
  // actually returned 7 venues): `city` is a free-text column on `branches`,
  // while `/search` only ever uses `city` to pick a lat/lng centroid for an
  // `ST_DWithin` search, so a branch just outside the "Makati" string but
  // within 12km of Makati's centroid (or vice versa) made the two numbers
  // diverge. `DEFAULT_CITY_SLUG` ("All of Metro Manila") is excluded — it's
  // a synthetic region-wide entry that never matches a real `branches.city`
  // string, so it never appeared as its own chip anyway, and its 30,000m
  // radius is a different number than every other city's 12,000m.
  //
  // Built as one query (a `values` table of every named city, joined via
  // `ST_DWithin`) rather than one round-trip per city — `CITIES` is a fixed,
  // hardcoded ~9-entry array (not user input), so inlining slug/name/lat/lng
  // as query parameters via `sql.join` is safe and keeps this to a single
  // round-trip regardless of how many cities are ever added to that table.
  const namedCities = CITIES.filter((c) => c.slug !== DEFAULT_CITY_SLUG)
  const cityValues = sql.join(
    namedCities.map(
      (c) => sql`(${c.slug}::text, ${c.name}::text, ${c.lat}::float8, ${c.lng}::float8)`,
    ),
    sql`, `,
  )

  const cities = await db.execute(sql`
    ${approvedPricedCourtsCte()}
    select v.slug, v.name, count(distinct b.id)::int as branch_count
    from (values ${cityValues}) as v(slug, name, lat, lng)
    join branches b
      on st_dwithin(b.location, st_setsrid(st_makepoint(v.lng, v.lat), 4326)::geography, ${CITY_SEARCH_RADIUS_METERS})
    join branch_agg ba on ba.branch_id = b.id
    where b.location is not null
    group by v.slug, v.name
    order by branch_count desc, v.name
  `)

  const openNow = await db.execute(sql`
    select count(*)::int as open_now
    from courts c
    join court_operating_hours oh
      on oh.court_id = c.id
     and oh.day_of_week = extract(dow from (now() at time zone 'Asia/Manila'))::int
    where c.status = 'approved'
      and oh.opens_hour <= extract(hour from (now() at time zone 'Asia/Manila'))::int
      and oh.closes_hour > extract(hour from (now() at time zone 'Asia/Manila'))::int
      and exists (
        select 1 from court_rate_bands rb
        where rb.court_id = c.id
          and rb.start_hour <= extract(hour from (now() at time zone 'Asia/Manila'))::int
          and rb.end_hour   >  extract(hour from (now() at time zone 'Asia/Manila'))::int
      )
      and not exists (
        select 1 from bookings bk
        where bk.court_id = c.id
          and bk.slot @> now()
          and (
            -- Matches src/lib/booking/availability.ts and
            -- bookings_no_overlap's predicate: a block takes the slot, so a
            -- branch whose only court is blocked at this hour is not open.
            bk.status in ('confirmed', 'completed', 'blocked')
            or (bk.status = 'pending_payment' and bk.expires_at > now())
          )
      )
  `)

  return {
    featured: featured.rows.map(toSummary),
    cities: cities.rows.map((row) => ({
      slug: row.slug as string,
      name: row.name as string,
      branchCount: Number(row.branch_count),
    })),
    openNowCount: Number(openNow.rows[0].open_now),
  }
}
