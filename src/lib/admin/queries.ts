import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { Role } from '@/lib/auth/guards'
import { formatHourRange } from '@/lib/format'
import type { CourtEnvironment } from '@/lib/listings/fields'
import type { CourtStatus } from '@/lib/listings/status'
import {
  courtScheduleWarning,
  type BandsFailure,
  type HoursFailure,
  type OperatingHoursDay,
  type RateBand,
} from '@/lib/listings/schedule'

/**
 * The reads behind /admin/*.
 *
 * These are the only GLOBAL queries in the application. Every other read is
 * scoped by owner_id or by a branch-id list resolved from the session, because
 * every other reader is entitled to exactly one owner's data. Moderation is
 * the exception by definition: a queue that showed one owner's courts would
 * not be a queue. requireAdmin above every caller is therefore not a formality
 * — it is the whole of the access control on this module.
 *
 * Nothing here filters to `approved`, for the mirror-image reason
 * src/lib/listings/queries.ts does not: these pages exist to show what the
 * public surfaces hide.
 */

export type AdminCourtRow = {
  id: string
  name: string
  environment: CourtEnvironment
  surface: string | null
  status: CourtStatus
  rejectionReason: string | null
  /**
   * `YYYY-MM-DD` in Manila, from courts.created_at — the only date this table
   * has. The UI labels it "Added", never "Submitted": a court re-queued by a
   * rate change still carries its original creation date, and calling that a
   * submission date would be a number the page is lying about. There is no
   * submitted_at column and this slice adds no migration.
   */
  addedOn: string
  branchId: string
  branchName: string
  branchCity: string
  branchSlug: string
  ownerBusinessName: string | null
  ownerEmail: string
  photoCount: number
  bandCount: number
  hoursSummary: string
  /**
   * Non-null means approveCourt() will refuse this court — the identical rule,
   * from the identical function. Carried on the row so the queue can say so
   * before the admin clicks, instead of only after.
   */
  scheduleWarning: HoursFailure | BandsFailure | null
}

export type AdminProfileLookup = {
  id: string
  email: string
  fullName: string | null
  role: Role
}

/**
 * One line an admin can read at a glance, not a full timetable.
 *
 * Two shapes only: the common case (open every day on the same window) and
 * everything else (how many days, and the outer envelope those days span).
 * Deliberately NOT a per-weekday breakdown — that is what the owner's court
 * page is for, and the queue links to the branch for anyone who needs more.
 * The envelope is `[min(opens), max(closes)]`, which is the same span
 * validateRateBands tiles against, so a summary and a warning always describe
 * the same hours.
 */
function summarizeHours(days: OperatingHoursDay[]): string {
  if (days.length === 0) return 'No hours set'

  const opens = Math.min(...days.map((day) => day.opensHour))
  const closes = Math.max(...days.map((day) => day.closesHour))
  const span = formatHourRange(opens, closes)
  const sameWindow = days.every((day) => day.opensHour === opens && day.closesHour === closes)

  if (days.length === 7 && sameWindow) return `${span} daily`
  return `${days.length} ${days.length === 1 ? 'day' : 'days'} · ${span}`
}

export async function getAdminCourts(statuses: CourtStatus[]): Promise<AdminCourtRow[]> {
  // `= any ('{}')` matches nothing, so this is only a short-circuit — but it
  // also skips the two follow-up queries below, which would otherwise run with
  // an empty id list for no reason.
  if (statuses.length === 0) return []

  // Counts as correlated scalar subqueries rather than joins with a GROUP BY:
  // each is an index lookup on court_photos_court_id_idx /
  // court_rate_bands_court_id_idx over one court's rows, and the shape stays
  // readable. The queue is tens of rows, not thousands — an approval backlog
  // that large is a staffing problem, not a query-planning one.
  const courtsResult = await db.execute(sql`
    select c.id, c.name, c.environment::text as environment, c.surface,
           c.status::text as status, c.rejection_reason,
           to_char(c.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as added_on,
           b.id as branch_id, b.name as branch_name, b.city as branch_city, b.slug as branch_slug,
           p.business_name as owner_business_name, p.email as owner_email,
           (select count(*)::int from court_photos ph where ph.court_id = c.id) as photo_count,
           (select count(*)::int from court_rate_bands rb where rb.court_id = c.id) as band_count
    from courts c
    join branches b on b.id = c.branch_id
    join profiles p on p.id = b.owner_id
    where c.status = any (${sql.param(statuses)}::court_status[])
    order by c.created_at, c.id
  `)
  if (courtsResult.rows.length === 0) return []

  // Two bulk follow-ups keyed by court id, NOT one query per row: the schedule
  // warning has to be computed in TypeScript (courtScheduleWarning is the
  // shared rule and it is pure), so the rows have to come back, but they come
  // back in two round trips regardless of how long the queue is.
  const courtIds = courtsResult.rows.map((row) => row.id as string)

  const hourRows = await db.execute(sql`
    select court_id, day_of_week, opens_hour, closes_hour from court_operating_hours
    where court_id = any (${sql.param(courtIds)}::uuid[])
    order by court_id, day_of_week
  `)
  const bandRows = await db.execute(sql`
    select court_id, start_hour, end_hour, price_centavos from court_rate_bands
    where court_id = any (${sql.param(courtIds)}::uuid[])
    order by court_id, start_hour
  `)

  const daysByCourt = new Map<string, OperatingHoursDay[]>()
  for (const row of hourRows.rows) {
    const courtId = row.court_id as string
    const days = daysByCourt.get(courtId) ?? []
    days.push({
      dayOfWeek: Number(row.day_of_week),
      opensHour: Number(row.opens_hour),
      closesHour: Number(row.closes_hour),
    })
    daysByCourt.set(courtId, days)
  }

  const bandsByCourt = new Map<string, RateBand[]>()
  for (const row of bandRows.rows) {
    const courtId = row.court_id as string
    const bands = bandsByCourt.get(courtId) ?? []
    bands.push({
      startHour: Number(row.start_hour),
      endHour: Number(row.end_hour),
      priceCentavos: Number(row.price_centavos),
    })
    bandsByCourt.set(courtId, bands)
  }

  return courtsResult.rows.map((row) => {
    const courtId = row.id as string
    const days = daysByCourt.get(courtId) ?? []
    const bands = bandsByCourt.get(courtId) ?? []
    return {
      id: courtId,
      name: row.name as string,
      environment: row.environment as CourtEnvironment,
      surface: (row.surface as string | null) ?? null,
      status: row.status as CourtStatus,
      rejectionReason: (row.rejection_reason as string | null) ?? null,
      addedOn: row.added_on as string,
      branchId: row.branch_id as string,
      branchName: row.branch_name as string,
      branchCity: row.branch_city as string,
      branchSlug: row.branch_slug as string,
      ownerBusinessName: (row.owner_business_name as string | null) ?? null,
      ownerEmail: row.owner_email as string,
      photoCount: Number(row.photo_count),
      bandCount: Number(row.band_count),
      hoursSummary: summarizeHours(days),
      scheduleWarning: courtScheduleWarning(days, bands),
    }
  })
}

/** The sidebar badge. Same predicate as the queue, without the rows. */
export async function getPendingCourtCount(): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as pending from courts where status = 'pending'
  `)
  return Number(result.rows[0].pending)
}

/**
 * The promote screen's lookup: one account, by its whole address.
 *
 * EXACT on the full address — never a prefix, substring, or search, so the
 * user table cannot be enumerated by typing letters — and case-insensitive,
 * because Google returns lowercase addresses while the admin types what the
 * owner wrote on a form. Trimmed for the same reason parseStaffEmail trims.
 * This is deliberately the identical rule addBranchStaff uses; the two screens
 * must not disagree about what "that email" means.
 *
 * `order by created_at, id limit 1` makes the pick deterministic if
 * profiles.email ever collides case-insensitively — nothing enforces
 * uniqueness across case folding — which is unreachable today because the only
 * auth path is Google, one normalized address per account.
 *
 * Returns the role because the screen has to say WHY it will not promote
 * someone: "that account is already an owner" and "no account uses that
 * address" are different problems with different next steps.
 */
export async function findProfileByEmail(email: string): Promise<AdminProfileLookup | null> {
  const result = await db.execute(sql`
    select id, email, full_name, role::text as role from profiles
    where lower(email) = lower(${email.trim()})
    order by created_at, id limit 1
  `)
  const row = result.rows[0]
  if (!row) return null

  return {
    id: row.id as string,
    email: row.email as string,
    fullName: (row.full_name as string | null) ?? null,
    role: row.role as Role,
  }
}
