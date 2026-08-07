import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { CourtEnvironment } from '@/lib/listings/fields'
import type { CourtStatus } from '@/lib/listings/status'
import {
  courtScheduleWarning,
  summarizeHours,
  type BandsFailure,
  type HoursFailure,
  type OperatingHoursDay,
  type RateBand,
} from '@/lib/listings/schedule'

/**
 * The reads behind /dashboard/listings/*.
 *
 * Scoped by an explicit branch-id list, never by ownerId — the same rule as
 * src/lib/owner/queries.ts, and for the same reason: a branch_staff member
 * holding `manage_courts` is not the owner, so `owner_id = $` structurally
 * cannot include them. The list itself comes from
 * `branchIdsWith(access, 'manage_courts')` in a guarded Server Component and
 * never from client input.
 *
 * Unlike src/lib/branches/queries.ts, nothing here filters to `approved`:
 * these pages exist precisely to show the pending, rejected and suspended
 * courts the public surfaces hide.
 */

// Re-exported so page modules need only one import for the row shape and the
// status union together; the union itself is declared in ./status.ts, which
// is pure and therefore importable from client components too.
export type { CourtStatus }

export type ListingPhoto = { id: string; storagePath: string; sortOrder: number }

export type ListingBranchSummary = {
  id: string
  name: string
  city: string
  slug: string
  photoCount: number
  coverPhotoPath: string | null
  courtCounts: Record<CourtStatus, number>
}

export type ListingCourtSummary = {
  id: string
  name: string
  environment: CourtEnvironment
  surface: string | null
  status: CourtStatus
  rejectionReason: string | null
  /**
   * `court_photos.storage_path` for the lowest `sort_order` row, tie-broken
   * by id so the cover never shuffles between renders if two photos share a
   * sort_order — same rule and same reason as branches' coverPhotoPath below
   * and src/lib/admin/queries.ts's identical subquery for courts. Null means
   * the court has no photos yet; the card falls back to an initial-letter
   * placeholder rather than treating this as an error.
   */
  coverPhotoPath: string | null
  /**
   * Min/max of `court_rate_bands.price_centavos`, both null together when the
   * court has no bands yet — same rule and same reason as
   * src/lib/admin/queries.ts's `AdminCourtRow.minPriceCentavos`. Derived from
   * `bandsByCourt` below rather than a third query — the bands are already in
   * hand.
   */
  minPriceCentavos: number | null
  maxPriceCentavos: number | null
  hoursSummary: string
  /**
   * Non-null when this court's rate bands do not exactly tile its opening
   * hours — the identical rule approveCourt() refuses on, so a court showing
   * this on its own card is one the admin queue will reject. Same field name
   * and meaning as `AdminCourtRow.scheduleWarning`.
   */
  scheduleWarning: HoursFailure | BandsFailure | null
}

export type ListingBranch = {
  id: string
  name: string
  slug: string
  description: string | null
  address: string
  city: string
  contactPhone: string | null
  contactEmail: string | null
  amenities: string[]
  lat: number | null
  lng: number | null
  photos: ListingPhoto[]
  courts: ListingCourtSummary[]
}

export type ListingCourt = {
  id: string
  branchId: string
  branchName: string
  branchCity: string
  name: string
  environment: CourtEnvironment
  surface: string | null
  status: CourtStatus
  rejectionReason: string | null
  days: OperatingHoursDay[]
  bands: RateBand[]
  photos: ListingPhoto[]
  /**
   * Non-null when this court's rate bands do not exactly tile its opening
   * hours — the state an hours-only edit deliberately allows (see
   * replaceOperatingHours). Rendered as a warning on the court page, because
   * nothing else catches it until a player's checkout throws.
   */
  scheduleWarning: HoursFailure | BandsFailure | null
}

function toPhoto(row: Record<string, unknown>): ListingPhoto {
  return {
    id: row.id as string,
    storagePath: row.storage_path as string,
    sortOrder: Number(row.sort_order),
  }
}

export async function getListingBranches(branchIds: string[]): Promise<ListingBranchSummary[]> {
  // Correlated scalar subqueries rather than four LEFT JOINs and a GROUP BY:
  // each is an index lookup on courts_branch_id_idx / branch_photos_branch_id_idx
  // over one branch's rows, and the shape stays readable as statuses are
  // added. An owner has a handful of branches, not thousands.
  const result = await db.execute(sql`
    select b.id, b.name, b.city, b.slug,
      (select count(*)::int from branch_photos p where p.branch_id = b.id) as photo_count,
      (select p.storage_path from branch_photos p where p.branch_id = b.id
        order by p.sort_order, p.id limit 1) as cover_photo_path,
      (select count(*)::int from courts c where c.branch_id = b.id and c.status = 'pending') as pending_count,
      (select count(*)::int from courts c where c.branch_id = b.id and c.status = 'approved') as approved_count,
      (select count(*)::int from courts c where c.branch_id = b.id and c.status = 'rejected') as rejected_count,
      (select count(*)::int from courts c where c.branch_id = b.id and c.status = 'suspended') as suspended_count
    from branches b
    where b.id = any (${sql.param(branchIds)}::uuid[])
    order by b.name
  `)

  return result.rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    city: row.city as string,
    slug: row.slug as string,
    photoCount: Number(row.photo_count),
    coverPhotoPath: (row.cover_photo_path as string | null) ?? null,
    courtCounts: {
      pending: Number(row.pending_count),
      approved: Number(row.approved_count),
      rejected: Number(row.rejected_count),
      suspended: Number(row.suspended_count),
    },
  }))
}

export async function getListingBranch(branchId: string): Promise<ListingBranch | null> {
  // st_y/st_x, not the geography value itself: the driver returns geography
  // as a WKB hex string, which no form field can use. Same treatment as
  // getBranchDetail.
  const branchResult = await db.execute(sql`
    select id, name, slug, description, address, city, amenities,
           contact_phone, contact_email,
           st_y(location::geometry)::float8 as lat,
           st_x(location::geometry)::float8 as lng
    from branches where id = ${branchId}::uuid
  `)
  const row = branchResult.rows[0]
  if (!row) return null

  const photos = await db.execute(sql`
    select id, storage_path, sort_order from branch_photos
    where branch_id = ${branchId}::uuid
    order by sort_order, id
  `)

  // Cover photo as a correlated scalar subquery, same pattern as branches'
  // cover_photo_path above and src/lib/admin/queries.ts's identical subquery
  // for courts: an index lookup on court_photos_court_id_idx over one
  // court's (usually handful of) photos, ordered and limited to the winner.
  const courts = await db.execute(sql`
    select c.id, c.name, c.environment::text as environment, c.surface,
           c.status::text as status, c.rejection_reason,
           (select p.storage_path from court_photos p where p.court_id = c.id
             order by p.sort_order, p.id limit 1) as cover_photo_path
    from courts c where c.branch_id = ${branchId}::uuid
    order by c.name, c.id
  `)

  // Two bulk follow-ups keyed by court id, NOT one query per row — same
  // reasoning as src/lib/admin/queries.ts's getAdminCourts: the schedule
  // warning and hours summary have to be computed in TypeScript
  // (courtScheduleWarning/summarizeHours are the shared, pure rules), so the
  // rows have to come back, but they come back in two round trips regardless
  // of how many courts this branch has. Skipped entirely when the branch has
  // no courts yet.
  const courtIds = courts.rows.map((court) => court.id as string)
  const daysByCourt = new Map<string, OperatingHoursDay[]>()
  const bandsByCourt = new Map<string, RateBand[]>()

  if (courtIds.length > 0) {
    const hourRows = await db.execute(sql`
      select court_id, day_of_week, opens_hour, closes_hour from court_operating_hours
      where court_id = any (${sql.param(courtIds)}::uuid[])
      order by court_id, day_of_week
    `)
    for (const hourRow of hourRows.rows) {
      const courtId = hourRow.court_id as string
      const days = daysByCourt.get(courtId) ?? []
      days.push({
        dayOfWeek: Number(hourRow.day_of_week),
        opensHour: Number(hourRow.opens_hour),
        closesHour: Number(hourRow.closes_hour),
      })
      daysByCourt.set(courtId, days)
    }

    const bandRows = await db.execute(sql`
      select court_id, start_hour, end_hour, price_centavos from court_rate_bands
      where court_id = any (${sql.param(courtIds)}::uuid[])
      order by court_id, start_hour
    `)
    for (const bandRow of bandRows.rows) {
      const courtId = bandRow.court_id as string
      const bands = bandsByCourt.get(courtId) ?? []
      bands.push({
        startHour: Number(bandRow.start_hour),
        endHour: Number(bandRow.end_hour),
        priceCentavos: Number(bandRow.price_centavos),
      })
      bandsByCourt.set(courtId, bands)
    }
  }

  return {
    id: row.id as string,
    name: row.name as string,
    slug: row.slug as string,
    description: (row.description as string | null) ?? null,
    address: row.address as string,
    city: row.city as string,
    contactPhone: (row.contact_phone as string | null) ?? null,
    contactEmail: (row.contact_email as string | null) ?? null,
    amenities: (row.amenities as string[]) ?? [],
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
    photos: photos.rows.map(toPhoto),
    courts: courts.rows.map((court) => {
      const courtId = court.id as string
      const days = daysByCourt.get(courtId) ?? []
      const bands = bandsByCourt.get(courtId) ?? []
      // Both null together: a court with no rate bands yet has no price to
      // show, not a zero one — Math.min/max of an empty array is
      // Infinity/-Infinity, which is why this branches on bands.length
      // rather than feeding the empty array through. Same guard as
      // getAdminCourts.
      const prices = bands.map((band) => band.priceCentavos)
      const minPriceCentavos = prices.length > 0 ? Math.min(...prices) : null
      const maxPriceCentavos = prices.length > 0 ? Math.max(...prices) : null
      return {
        id: courtId,
        name: court.name as string,
        environment: court.environment as CourtEnvironment,
        surface: (court.surface as string | null) ?? null,
        status: court.status as CourtStatus,
        rejectionReason: (court.rejection_reason as string | null) ?? null,
        coverPhotoPath: (court.cover_photo_path as string | null) ?? null,
        minPriceCentavos,
        maxPriceCentavos,
        hoursSummary: summarizeHours(days),
        scheduleWarning: courtScheduleWarning(days, bands),
      }
    }),
  }
}

export async function getListingCourt(courtId: string): Promise<ListingCourt | null> {
  const courtResult = await db.execute(sql`
    select c.id, c.branch_id, c.name, c.environment::text as environment, c.surface,
           c.status::text as status, c.rejection_reason,
           b.name as branch_name, b.city as branch_city
    from courts c
    join branches b on b.id = c.branch_id
    where c.id = ${courtId}::uuid
  `)
  const row = courtResult.rows[0]
  if (!row) return null

  const hours = await db.execute(sql`
    select day_of_week, opens_hour, closes_hour from court_operating_hours
    where court_id = ${courtId}::uuid
    order by day_of_week
  `)
  const bandRows = await db.execute(sql`
    select start_hour, end_hour, price_centavos from court_rate_bands
    where court_id = ${courtId}::uuid
    order by start_hour
  `)
  const photos = await db.execute(sql`
    select id, storage_path, sort_order from court_photos
    where court_id = ${courtId}::uuid
    order by sort_order, id
  `)

  const days: OperatingHoursDay[] = hours.rows.map((day) => ({
    dayOfWeek: Number(day.day_of_week),
    opensHour: Number(day.opens_hour),
    closesHour: Number(day.closes_hour),
  }))
  const bands: RateBand[] = bandRows.rows.map((band) => ({
    startHour: Number(band.start_hour),
    endHour: Number(band.end_hour),
    priceCentavos: Number(band.price_centavos),
  }))

  // The exact rule the approval queue refuses on — see courtScheduleWarning.
  const scheduleWarning = courtScheduleWarning(days, bands)

  return {
    id: row.id as string,
    branchId: row.branch_id as string,
    branchName: row.branch_name as string,
    branchCity: row.branch_city as string,
    name: row.name as string,
    environment: row.environment as CourtEnvironment,
    surface: (row.surface as string | null) ?? null,
    status: row.status as CourtStatus,
    rejectionReason: (row.rejection_reason as string | null) ?? null,
    days,
    bands,
    photos: photos.rows.map(toPhoto),
    scheduleWarning,
  }
}
