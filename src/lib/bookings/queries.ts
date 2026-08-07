import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

export type PlayerBookingStatus = 'confirmed' | 'completed'

export type PlayerBooking = {
  id: string
  courtName: string
  environment: 'indoor' | 'outdoor'
  branchName: string
  branchSlug: string
  branchAddress: string
  branchCity: string
  coverPhotoPath: string | null
  date: string
  startHour: number
  endHour: number
  status: PlayerBookingStatus
  totalChargedCentavos: number
  hasReview: boolean
}

export type PlayerReview = {
  id: string
  branchName: string
  branchSlug: string
  courtName: string
  rating: number
  body: string | null
  createdAt: string
}

export type PlayerStats = {
  upcomingCount: number
  hoursPlayedThisMonth: number
  courtsVisited: number
  totalSpentCentavos: number
}

export type PlayerDashboard = {
  stats: PlayerStats
  upcoming: PlayerBooking[]
  past: PlayerBooking[]
  reviews: PlayerReview[]
}

export type BookingReceipt = {
  id: string
  courtName: string
  environment: 'indoor' | 'outdoor'
  branchName: string
  branchSlug: string
  branchAddress: string
  branchCity: string
  date: string
  startHour: number
  endHour: number
  status: string
  courtFeeCentavos: number
  transactionFeeCentavos: number
  totalChargedCentavos: number
  createdAt: string
}

/**
 * `confirmed` and `completed` only. A `pending_payment` row is an unpaid hold,
 * not a booking — showing one as "your booking" would tell a player they have
 * court time they have not paid for. `expired` and `refunded_manual` are not
 * bookings either.
 */
const REAL_BOOKING = sql`bk.status in ('confirmed', 'completed')`

/**
 * Manila-local calendar date and clock hours, extracted in SQL rather than
 * from a JS Date. `starts_at` is a timestamptz; reading its hour in the
 * server's zone would be wrong anywhere but UTC+8, and this app is
 * Philippines-only by design (see src/lib/date-manila.ts).
 *
 * end_hour needs a midnight special case: bookings are whole-hour, so the
 * last bookable hour of a day (23:00-24:00) has an `ends_at` that lands
 * exactly on the *next* calendar day's local midnight. A plain
 * `extract(hour from ...)` reads that as 0, corrupting the pair to
 * (startHour: 23, endHour: 0) and sending `endHour - startHour` negative
 * downstream (e.g. the receipt page). Treating exact local midnight as hour
 * 24 of the day that just ended fixes this without affecting any other hour.
 *
 * Exported since the payments slice: the checkout page and the checkout write
 * need the identical Manila-local date/hour extraction, including the
 * midnight special case below. A second copy would eventually disagree with
 * this one, and the hour it disagreed on would be the last bookable hour of
 * the day — the one nobody tests by hand.
 */
export const MANILA_PARTS = sql`
  to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as date,
  extract(hour from (bk.starts_at at time zone 'Asia/Manila'))::int as start_hour,
  case
    when (bk.ends_at at time zone 'Asia/Manila') = date_trunc('day', bk.ends_at at time zone 'Asia/Manila')
      then 24
    else extract(hour from (bk.ends_at at time zone 'Asia/Manila'))::int
  end as end_hour
`

function toBooking(row: Record<string, unknown>): PlayerBooking {
  return {
    id: row.id as string,
    courtName: row.court_name as string,
    environment: row.environment as 'indoor' | 'outdoor',
    branchName: row.branch_name as string,
    branchSlug: row.branch_slug as string,
    branchAddress: row.branch_address as string,
    branchCity: row.branch_city as string,
    coverPhotoPath: (row.cover_photo_path as string | null) ?? null,
    date: row.date as string,
    startHour: Number(row.start_hour),
    endHour: Number(row.end_hour),
    status: row.status as PlayerBookingStatus,
    totalChargedCentavos: Number(row.total_charged_centavos),
    hasReview: row.has_review === true,
  }
}

/**
 * Everything /bookings renders, in four round trips: upcoming, past, reviews,
 * stats. Kept as separate statements rather than one CTE-heavy query because
 * each drives an independently rendered panel and the row shapes differ; a
 * single query would need to union incompatible shapes or return a wide
 * sparse row.
 *
 * "Upcoming" vs "past" splits on ends_at, not starts_at: a booking that
 * started an hour ago and runs for another hour is still court time you have
 * not used yet.
 */
export async function getPlayerDashboard(playerId: string): Promise<PlayerDashboard> {
  const columns = sql`
    bk.id, bk.status, bk.total_charged_centavos,
    c.name as court_name, c.environment,
    b.name as branch_name, b.slug as branch_slug,
    b.address as branch_address, b.city as branch_city,
    ph.storage_path as cover_photo_path,
    exists (select 1 from reviews rv where rv.booking_id = bk.id) as has_review,
    ${MANILA_PARTS}
  `

  const joins = sql`
    from bookings bk
    join courts c   on c.id = bk.court_id
    join branches b on b.id = bk.branch_id
    left join lateral (
      select bp.storage_path from branch_photos bp
      where bp.branch_id = b.id order by bp.sort_order, bp.id limit 1
    ) ph on true
    where bk.player_id = ${playerId}::uuid and ${REAL_BOOKING}
  `

  const upcoming = await db.execute(sql`
    select ${columns} ${joins} and bk.ends_at > now() order by bk.starts_at asc
  `)

  const past = await db.execute(sql`
    select ${columns} ${joins} and bk.ends_at <= now() order by bk.starts_at desc limit 50
  `)

  const reviews = await db.execute(sql`
    select rv.id, rv.rating, rv.body, rv.created_at,
           b.name as branch_name, b.slug as branch_slug, c.name as court_name
    from reviews rv
    join bookings bk on bk.id = rv.booking_id
    join courts c    on c.id = bk.court_id
    join branches b  on b.id = rv.branch_id
    where rv.player_id = ${playerId}::uuid
    order by rv.created_at desc, rv.id
  `)

  // hoursPlayedThisMonth counts only time already played (ends_at <= now())
  // inside the current Manila month, so a booking later this month does not
  // inflate it. courtsVisited counts distinct courts across all real
  // bookings. totalSpentCentavos sums every real booking, upcoming included —
  // that money is already charged.
  const stats = await db.execute(sql`
    select
      count(*) filter (where bk.ends_at > now())::int as upcoming_count,
      coalesce(sum(
        extract(epoch from (bk.ends_at - bk.starts_at)) / 3600
      ) filter (
        where bk.ends_at <= now()
          and date_trunc('month', bk.starts_at at time zone 'Asia/Manila')
            = date_trunc('month', now() at time zone 'Asia/Manila')
      ), 0)::float8 as hours_played_this_month,
      count(distinct bk.court_id)::int as courts_visited,
      coalesce(sum(bk.total_charged_centavos), 0)::bigint as total_spent_centavos
    from bookings bk
    where bk.player_id = ${playerId}::uuid and ${REAL_BOOKING}
  `)

  const row = stats.rows[0]

  return {
    stats: {
      upcomingCount: Number(row.upcoming_count),
      // Rounded for display: a 90-minute booking is 1.5 hours, and the stat
      // card shows a whole number.
      hoursPlayedThisMonth: Math.round(Number(row.hours_played_this_month)),
      courtsVisited: Number(row.courts_visited),
      totalSpentCentavos: Number(row.total_spent_centavos),
    },
    upcoming: upcoming.rows.map(toBooking),
    past: past.rows.map(toBooking),
    reviews: reviews.rows.map((rv) => ({
      id: rv.id as string,
      branchName: rv.branch_name as string,
      branchSlug: rv.branch_slug as string,
      courtName: rv.court_name as string,
      rating: Number(rv.rating),
      body: (rv.body as string | null) ?? null,
      createdAt: new Date(rv.created_at as string).toISOString(),
    })),
  }
}

/**
 * One booking's receipt, scoped to its player IN THE WHERE CLAUSE. Fetching by
 * id and comparing player_id afterward would leak existence: a stranger could
 * tell a real booking id (403) from a fake one (404). Here both are null.
 *
 * Not restricted to REAL_BOOKING: a receipt for an expired hold or a manually
 * refunded booking is a legitimate thing to look at.
 */
export async function getBookingReceipt(
  bookingId: string,
  playerId: string,
): Promise<BookingReceipt | null> {
  const result = await db.execute(sql`
    select bk.id, bk.status, bk.created_at,
           bk.court_fee_centavos, bk.transaction_fee_centavos, bk.total_charged_centavos,
           c.name as court_name, c.environment,
           b.name as branch_name, b.slug as branch_slug,
           b.address as branch_address, b.city as branch_city,
           ${MANILA_PARTS}
    from bookings bk
    join courts c   on c.id = bk.court_id
    join branches b on b.id = bk.branch_id
    where bk.id = ${bookingId}::uuid and bk.player_id = ${playerId}::uuid
  `)

  const row = result.rows[0]
  if (!row) return null

  return {
    id: row.id as string,
    courtName: row.court_name as string,
    environment: row.environment as 'indoor' | 'outdoor',
    branchName: row.branch_name as string,
    branchSlug: row.branch_slug as string,
    branchAddress: row.branch_address as string,
    branchCity: row.branch_city as string,
    date: row.date as string,
    startHour: Number(row.start_hour),
    endHour: Number(row.end_hour),
    status: row.status as string,
    courtFeeCentavos: Number(row.court_fee_centavos),
    transactionFeeCentavos: Number(row.transaction_fee_centavos),
    totalChargedCentavos: Number(row.total_charged_centavos),
    createdAt: new Date(row.created_at as string).toISOString(),
  }
}
