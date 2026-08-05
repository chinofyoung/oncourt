import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

export type OwnerGridCourt = { courtId: string; courtName: string; branchName: string }
export type OwnerGridBooking = {
  bookingId: string
  courtId: string
  startHour: number
  endHour: number
  playerName: string
}
export type OwnerStats = {
  bookingsThisWeek: number
  occupancyPct: number | null
  grossCentavos: number
  netCentavos: number
}
/**
 * `createdAt` is a Manila calendar date (`YYYY-MM-DD`), not a raw instant —
 * matching this module's existing `to_char(... at time zone 'Asia/Manila',
 * 'YYYY-MM-DD')` convention (see `getOwnerBookings`'s `date` field) — so
 * callers can feed it straight into `formatDateLabel()` without a second
 * timezone conversion at the call site.
 */
export type OwnerPendingCourt = { id: string; name: string; branchName: string; createdAt: string }
export type OwnerActivity = { kind: 'booking' | 'review'; at: string; text: string }
export type OwnerOverview = {
  branchCount: number
  stats: OwnerStats
  courts: OwnerGridCourt[]
  openHour: number
  closeHour: number
  todaysBookings: OwnerGridBooking[]
  pendingCourts: OwnerPendingCourt[]
  activity: OwnerActivity[]
}
export type OwnerBookingRow = {
  bookingId: string
  date: string
  startHour: number
  endHour: number
  branchName: string
  courtName: string
  playerName: string
  status: string
  totalChargedCentavos: number
  ownerNetCentavos: number
}
export type OwnerEarningsRow = {
  branchId: string
  branchName: string
  bookingCount: number
  grossCentavos: number
  platformFeeCentavos: number
  netCentavos: number
}
export type OwnerEarnings = {
  month: string
  rows: OwnerEarningsRow[]
  totals: { bookingCount: number; grossCentavos: number; platformFeeCentavos: number; netCentavos: number }
}

/**
 * `confirmed` and `completed` only — the same rule as
 * `src/lib/bookings/queries.ts`'s player-facing module. Defined locally
 * rather than imported: it is three words, and importing across query
 * modules for it would be a heavier coupling than the fragment itself.
 */
const REAL_BOOKING = sql`bk.status in ('confirmed', 'completed')`

/**
 * A booking's end hour in Manila's local clock, with the midnight edge case
 * handled: bookings are whole-hour, so the last bookable hour of a day
 * (23:00-24:00) has an `ends_at` that lands exactly on the *next* calendar
 * day's local midnight. A plain `extract(hour from ...)` reads that as 0,
 * corrupting the row to (startHour: 23, endHour: 0). Treating exact local
 * midnight as hour 24 of the day that just ended fixes this without
 * affecting any other hour — start hours never need this treatment, since a
 * booking never starts at hour 24. Mirrors `src/lib/bookings/queries.ts`'s
 * `MANILA_PARTS` fix for the same bug; kept as a separate local fragment
 * rather than a shared import, matching this module's existing precedent for
 * `REAL_BOOKING`.
 */
const MANILA_END_HOUR = sql`
  case
    when (bk.ends_at at time zone 'Asia/Manila') = date_trunc('day', bk.ends_at at time zone 'Asia/Manila')
      then 24
    else extract(hour from (bk.ends_at at time zone 'Asia/Manila'))::int
  end
`

/**
 * Default fallback used when an owner has no approved courts (or none with
 * operating-hours rows for the day in question): a generic 7am-11pm window
 * so the grid still renders something sane instead of an empty 0-0 range.
 */
const DEFAULT_OPEN_HOUR = 7
const DEFAULT_CLOSE_HOUR = 23

function toGridCourt(row: Record<string, unknown>): OwnerGridCourt {
  return {
    courtId: row.court_id as string,
    courtName: row.court_name as string,
    branchName: row.branch_name as string,
  }
}

function toPlayerName(row: Record<string, unknown>): string {
  return row.player_name as string
}

/** All branches the caller owns — feeds the branch filter dropdown. */
export async function getOwnerBranches(ownerId: string): Promise<{ id: string; name: string }[]> {
  const result = await db.execute(sql`
    select id, name from branches where owner_id = ${ownerId}::uuid order by name
  `)
  return result.rows.map((row) => ({ id: row.id as string, name: row.name as string }))
}

/**
 * Everything the /dashboard overview renders: branch count, the day's court
 * grid (courts x hours), this week's stats, pending-approval courts, and a
 * recent-activity feed. Kept as several round trips rather than one giant
 * join, matching the player dashboard module's precedent — each piece backs
 * an independently rendered panel and the row shapes do not line up.
 *
 * Every query below is scoped by `b.owner_id = ${ownerId}` in its WHERE
 * clause. Ownership is never filtered in TypeScript.
 */
export async function getOwnerOverview(ownerId: string, day: string): Promise<OwnerOverview> {
  const branchCountResult = await db.execute(sql`
    select count(*)::int as branch_count from branches where owner_id = ${ownerId}::uuid
  `)
  const branchCount = Number(branchCountResult.rows[0].branch_count)

  // The owner's approved courts, across all their branches. Reused (as a CTE)
  // by the operating-hours query below so both agree on exactly which courts
  // count.
  const ownedApprovedCourts = sql`
    select c.id as court_id, c.name as court_name, b.id as branch_id, b.name as branch_name
    from courts c
    join branches b on b.id = c.branch_id
    where b.owner_id = ${ownerId}::uuid and c.status = 'approved'
  `

  const courtsResult = await db.execute(sql`
    with owned_courts as (${ownedApprovedCourts})
    select court_id, court_name, branch_name from owned_courts
    order by branch_name, court_name
  `)
  const courts = courtsResult.rows.map(toGridCourt)

  // "That Manila weekday" is the weekday of `day` itself, computed the same
  // way as src/lib/date-manila.ts's manilaWeekday(): extract(dow ...) on the
  // plain date, 0=Sunday..6=Saturday, matching court_operating_hours.day_of_week
  // (see src/lib/branches/queries.ts's "open now" query for the same
  // convention). Casting `day` to `date` (not `timestamptz`) keeps this a pure
  // calendar-date computation with no timezone shift to get wrong.
  const hoursResult = await db.execute(sql`
    with owned_courts as (${ownedApprovedCourts})
    select
      min(oh.opens_hour)::int as open_hour,
      max(oh.closes_hour)::int as close_hour,
      coalesce(sum(oh.closes_hour - oh.opens_hour), 0)::int as operating_hours
    from owned_courts oc
    join court_operating_hours oh
      on oh.court_id = oc.court_id
     and oh.day_of_week = extract(dow from ${day}::date)::int
  `)
  const hoursRow = hoursResult.rows[0]
  const openHour = hoursRow.open_hour === null ? DEFAULT_OPEN_HOUR : Number(hoursRow.open_hour)
  const closeHour = hoursRow.close_hour === null ? DEFAULT_CLOSE_HOUR : Number(hoursRow.close_hour)
  const operatingHours = Number(hoursRow.operating_hours)

  // Scoped to the same owned_courts CTE as the grid and the operating-hours
  // denominator above, so numerator, denominator, and grid all agree on
  // exactly which courts count. A suspended (non-approved) court's bookings
  // are therefore invisible here by design: it has no column in the grid and
  // no capacity in the denominator, so including its booked hours in the
  // numerator would inflate occupancy past 100% for rows that render nowhere.
  const todaysBookingsResult = await db.execute(sql`
    with owned_courts as (${ownedApprovedCourts})
    select bk.id as booking_id, bk.court_id,
      extract(hour from (bk.starts_at at time zone 'Asia/Manila'))::int as start_hour,
      ${MANILA_END_HOUR} as end_hour,
      coalesce(pr.full_name, split_part(pr.email, '@', 1)) as player_name
    from bookings bk
    join owned_courts oc on oc.court_id = bk.court_id
    join profiles pr on pr.id = bk.player_id
    where ${REAL_BOOKING}
      and to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') = ${day}
    order by bk.starts_at
  `)
  const todaysBookings: OwnerGridBooking[] = todaysBookingsResult.rows.map((row) => ({
    bookingId: row.booking_id as string,
    courtId: row.court_id as string,
    startHour: Number(row.start_hour),
    endHour: Number(row.end_hour),
    playerName: toPlayerName(row),
  }))

  // Booked hours today, for the occupancy numerator, is just the sum of the
  // durations already fetched above — no second SQL round trip needed for it.
  const bookedHoursToday = todaysBookings.reduce((sum, b) => sum + (b.endHour - b.startHour), 0)
  // null (not 0) when there is no capacity to divide by (no approved courts,
  // or none open on this weekday) — a "0%" would misleadingly say "open all
  // day, nobody came" rather than "nothing to measure".
  const occupancyPct = operatingHours === 0 ? null : Math.round((bookedHoursToday / operatingHours) * 100)

  // bookingsThisWeek/grossCentavos/netCentavos cover the Manila week
  // containing `day`: [date_trunc('week', day), date_trunc('week', day) + 7d).
  const statsResult = await db.execute(sql`
    select
      count(*)::int as bookings_this_week,
      coalesce(sum(bk.total_charged_centavos), 0)::bigint as gross_centavos,
      coalesce(sum(bk.owner_net_centavos), 0)::bigint as net_centavos
    from bookings bk
    join branches b on b.id = bk.branch_id
    where b.owner_id = ${ownerId}::uuid
      and ${REAL_BOOKING}
      and (bk.starts_at at time zone 'Asia/Manila') >= date_trunc('week', ${day}::date)
      and (bk.starts_at at time zone 'Asia/Manila') <  date_trunc('week', ${day}::date) + interval '7 days'
  `)
  const statsRow = statsResult.rows[0]

  const pendingCourtsResult = await db.execute(sql`
    select c.id, c.name, b.name as branch_name,
      to_char(c.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as created_at
    from courts c
    join branches b on b.id = c.branch_id
    where b.owner_id = ${ownerId}::uuid and c.status = 'pending'
    order by c.created_at
  `)
  const pendingCourts: OwnerPendingCourt[] = pendingCourtsResult.rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    branchName: row.branch_name as string,
    createdAt: row.created_at as string,
  }))

  // Activity feed: the most recent real bookings and reviews across the
  // owner's branches, merged and re-sorted in TypeScript (the two shapes
  // don't line up for a SQL UNION, and composing the human-readable string
  // here is clearer than building it with `format()`).
  const recentBookingsResult = await db.execute(sql`
    select bk.created_at as at, c.name as court_name, b.name as branch_name,
      coalesce(pr.full_name, split_part(pr.email, '@', 1)) as player_name
    from bookings bk
    join branches b on b.id = bk.branch_id
    join courts c   on c.id = bk.court_id
    join profiles pr on pr.id = bk.player_id
    where b.owner_id = ${ownerId}::uuid and ${REAL_BOOKING}
    order by bk.created_at desc
    limit 8
  `)
  const recentReviewsResult = await db.execute(sql`
    select rv.created_at as at, rv.rating, c.name as court_name, b.name as branch_name,
      coalesce(pr.full_name, split_part(pr.email, '@', 1)) as player_name
    from reviews rv
    join branches b on b.id = rv.branch_id
    join bookings bk on bk.id = rv.booking_id
    join courts c    on c.id = bk.court_id
    join profiles pr on pr.id = rv.player_id
    where b.owner_id = ${ownerId}::uuid
    order by rv.created_at desc
    limit 8
  `)

  const activity: OwnerActivity[] = [
    ...recentBookingsResult.rows.map((row) => ({
      kind: 'booking' as const,
      at: new Date(row.at as string).toISOString(),
      text: `${toPlayerName(row)} booked ${row.court_name as string} at ${row.branch_name as string}`,
    })),
    ...recentReviewsResult.rows.map((row) => ({
      kind: 'review' as const,
      at: new Date(row.at as string).toISOString(),
      text: `${toPlayerName(row)} left a ${Number(row.rating)}-star review for ${row.court_name as string}`,
    })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, 8)

  return {
    branchCount,
    stats: {
      bookingsThisWeek: Number(statsRow.bookings_this_week),
      occupancyPct,
      grossCentavos: Number(statsRow.gross_centavos),
      netCentavos: Number(statsRow.net_centavos),
    },
    courts,
    openHour,
    closeHour,
    todaysBookings,
    pendingCourts,
    activity,
  }
}

/**
 * The owner's bookings list for one day, optionally narrowed to one branch.
 * `REAL_BOOKING`-filtered, same as the overview grid: this is a list of court
 * time actually taken, not a hold-management queue. A `pending_payment` hold
 * that never completed, or a refunded/expired row, is not a booking an owner
 * needs to act on here.
 */
export async function getOwnerBookings(
  ownerId: string,
  filters: { day: string; branchId?: string },
): Promise<OwnerBookingRow[]> {
  const branchFilter = filters.branchId ? sql`and b.id = ${filters.branchId}::uuid` : sql``

  const result = await db.execute(sql`
    select bk.id as booking_id,
      to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as date,
      extract(hour from (bk.starts_at at time zone 'Asia/Manila'))::int as start_hour,
      ${MANILA_END_HOUR} as end_hour,
      b.name as branch_name, c.name as court_name,
      coalesce(pr.full_name, split_part(pr.email, '@', 1)) as player_name,
      bk.status,
      bk.total_charged_centavos, bk.owner_net_centavos
    from bookings bk
    join branches b on b.id = bk.branch_id
    join courts c   on c.id = bk.court_id
    join profiles pr on pr.id = bk.player_id
    where b.owner_id = ${ownerId}::uuid
      and ${REAL_BOOKING}
      and to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') = ${filters.day}
      ${branchFilter}
    order by bk.starts_at
  `)

  return result.rows.map((row) => ({
    bookingId: row.booking_id as string,
    date: row.date as string,
    startHour: Number(row.start_hour),
    endHour: Number(row.end_hour),
    branchName: row.branch_name as string,
    courtName: row.court_name as string,
    playerName: toPlayerName(row),
    status: row.status as string,
    totalChargedCentavos: Number(row.total_charged_centavos),
    ownerNetCentavos: Number(row.owner_net_centavos),
  }))
}

/**
 * Per-branch earnings for one Manila calendar month, plus totals summed in
 * TypeScript (not a second SQL rollup) — that is what makes the "rollup
 * equals sum of parts" test meaningful rather than tautological. Only
 * REAL_BOOKING rows count: an expired hold or a manually refunded booking
 * never became real revenue.
 */
export async function getOwnerEarnings(ownerId: string, month: string): Promise<OwnerEarnings> {
  const result = await db.execute(sql`
    select b.id as branch_id, b.name as branch_name,
      count(*)::int as booking_count,
      coalesce(sum(bk.total_charged_centavos), 0)::bigint as gross_centavos,
      coalesce(sum(bk.platform_fee_centavos), 0)::bigint as platform_fee_centavos,
      coalesce(sum(bk.owner_net_centavos), 0)::bigint as net_centavos
    from bookings bk
    join branches b on b.id = bk.branch_id
    where b.owner_id = ${ownerId}::uuid
      and ${REAL_BOOKING}
      and date_trunc('month', bk.starts_at at time zone 'Asia/Manila') = ${month + '-01'}::date
    group by b.id, b.name
    order by b.name
  `)

  const rows: OwnerEarningsRow[] = result.rows.map((row) => ({
    branchId: row.branch_id as string,
    branchName: row.branch_name as string,
    bookingCount: Number(row.booking_count),
    grossCentavos: Number(row.gross_centavos),
    platformFeeCentavos: Number(row.platform_fee_centavos),
    netCentavos: Number(row.net_centavos),
  }))

  const totals = rows.reduce(
    (acc, row) => ({
      bookingCount: acc.bookingCount + row.bookingCount,
      grossCentavos: acc.grossCentavos + row.grossCentavos,
      platformFeeCentavos: acc.platformFeeCentavos + row.platformFeeCentavos,
      netCentavos: acc.netCentavos + row.netCentavos,
    }),
    { bookingCount: 0, grossCentavos: 0, platformFeeCentavos: 0, netCentavos: 0 },
  )

  return { month, rows, totals }
}
