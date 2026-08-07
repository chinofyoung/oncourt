import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

export type OwnerGridCourt = { courtId: string; courtName: string; branchName: string }
export type OwnerGridBooking = {
  bookingId: string
  courtId: string
  startHour: number
  endHour: number
  /**
   * Who or what holds this slot: the player's display name for a booking, the
   * block's note for a block, or 'Blocked' when a block carries no note.
   *
   * Named `label`, not `playerName`, since the roles-and-staff slice: a field
   * called playerName holding the string 'Blocked' is a field that lies.
   */
  label: string
  isBlock: boolean
  note: string | null
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
  branchId: string
  branchName: string
  courtName: string
  /** Same rule as OwnerGridBooking.label. */
  label: string
  isBlock: boolean
  note: string | null
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
  processorFeeCentavos: number
  netCentavos: number
}
export type OwnerEarnings = {
  month: string
  rows: OwnerEarningsRow[]
  totals: {
    bookingCount: number
    grossCentavos: number
    platformFeeCentavos: number
    processorFeeCentavos: number
    netCentavos: number
  }
}

/**
 * MONEY surfaces: gross, net, earnings, the weekly booking count. `confirmed`
 * and `completed` only — the same rule as `src/lib/bookings/queries.ts`'s
 * player-facing module. `blocked` is excluded because a block is not revenue
 * and not a booking; `pending_payment` because an unpaid hold is not either;
 * `expired`/`refunded_manual` because they never became real.
 *
 * Defined locally rather than imported from the player module: it is three
 * words, and importing across query modules for it would be a heavier coupling
 * than the fragment itself.
 */
const REAL_BOOKING = sql`bk.status in ('confirmed', 'completed')`

/**
 * SCHEDULE surfaces: the owner day grid and the /dashboard/bookings list.
 * Real bookings PLUS blocks, because a block occupies the slot and the people
 * running the venue have to see what is actually unavailable — that is the
 * whole point of blocks existing.
 *
 * Deliberately NOT the same as bookings_no_overlap's predicate, which also
 * includes `pending_payment`: an unpaid hold is a checkout in progress, not
 * something an owner acts on, and showing one as taken court time would tell
 * an owner they have a booking nobody has paid for. `expired` and
 * `refunded_manual` occupy nothing.
 */
const SCHEDULE_ROW = sql`bk.status in ('confirmed', 'completed', 'blocked')`

/**
 * The display value for a schedule row, from a LEFT-joined profiles row.
 *
 * The join MUST be left: a `blocked` row has a null `player_id`, and the inner
 * join this replaced silently dropped every block from the grid and the
 * bookings list — the slot rendered free while the exclusion constraint
 * refused every attempt to book it.
 *
 * `nullif(btrim(...), '')` so a whitespace-only note falls through to
 * 'Blocked' instead of rendering an empty cell. For a paid booking the
 * profiles row is always present, so the note/'Blocked' tail is unreachable.
 *
 * btrim's default trim set is a plain space only, so a note that is
 * whitespace but not solely spaces (e.g. a tab or newline) would survive
 * trimming and fail to collapse to null. Trim the full whitespace class
 * explicitly (these are literal control characters in this JS template
 * literal, not a Postgres E'' escape string).
 */
const SCHEDULE_LABEL = sql`
  coalesce(
    pr.full_name,
    split_part(pr.email, '@', 1),
    nullif(btrim(bk.note, ' \t\n\r\v\f'), ''),
    'Blocked'
  )
`

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

/**
 * Approved courts inside a scoped set of branches.
 *
 * `branchIds` replaces the previous `ownerId` scoping throughout this module.
 * That change is what admits staff: a branch_staff member is not the owner, so
 * `b.owner_id = $` structurally cannot include them, while an explicit id list
 * resolved once by `loadDashboardAccess` works for owners and staff alike. The
 * filter is still entirely in SQL — nothing is filtered in TypeScript after
 * the fetch — and the list itself comes from a guarded query, never from
 * client input.
 *
 * An empty array serializes to the Postgres empty array `{}`, so
 * `= any ('{}'::uuid[])` matches nothing and every query returns zero rows.
 * That is the correct answer for an owner who has not created a branch yet.
 */
function approvedCourtsIn(branchIds: string[]) {
  return sql`
    select c.id as court_id, c.name as court_name, b.id as branch_id, b.name as branch_name
    from courts c
    join branches b on b.id = c.branch_id
    where b.id = any (${sql.param(branchIds)}::uuid[]) and c.status = 'approved'
  `
}

/**
 * The scoped, approved courts as a flat list — the grid's columns, and the
 * option list for the block form (Task 9). Only 'approved' courts: a pending
 * or suspended court has no column in the grid, and the block writer refuses
 * it too, so offering it anywhere would create rows that render nowhere.
 */
export async function getScheduleCourts(branchIds: string[]): Promise<OwnerGridCourt[]> {
  const result = await db.execute(sql`
    with scoped_courts as (${approvedCourtsIn(branchIds)})
    select court_id, court_name, branch_name from scoped_courts
    order by branch_name, court_name
  `)
  return result.rows.map(toGridCourt)
}

/**
 * Everything the /dashboard overview renders: branch count, the day's court
 * grid (courts x hours), this week's stats, pending-approval courts, and a
 * recent-activity feed. Kept as several round trips rather than one giant
 * join, matching the player dashboard module's precedent — each piece backs
 * an independently rendered panel and the row shapes do not line up.
 *
 * Every query below is scoped by `b.id = any (branchIds)` in its WHERE
 * clause. Ownership is never filtered in TypeScript.
 */
export async function getOwnerOverview(branchIds: string[], day: string): Promise<OwnerOverview> {
  // The scope list IS the visible branch count — a round trip to recount it
  // would only introduce a way for the two to disagree.
  const branchCount = branchIds.length

  const scopedCourts = approvedCourtsIn(branchIds)

  const courts = await getScheduleCourts(branchIds)

  // "That Manila weekday" is the weekday of `day` itself, computed the same
  // way as src/lib/date-manila.ts's manilaWeekday(): extract(dow ...) on the
  // plain date, 0=Sunday..6=Saturday, matching court_operating_hours.day_of_week
  // (see src/lib/branches/queries.ts's "open now" query for the same
  // convention). Casting `day` to `date` (not `timestamptz`) keeps this a pure
  // calendar-date computation with no timezone shift to get wrong.
  const hoursResult = await db.execute(sql`
    with scoped_courts as (${scopedCourts})
    select
      min(oh.opens_hour)::int as open_hour,
      max(oh.closes_hour)::int as close_hour,
      coalesce(sum(oh.closes_hour - oh.opens_hour), 0)::int as operating_hours
    from scoped_courts sc
    join court_operating_hours oh
      on oh.court_id = sc.court_id
     and oh.day_of_week = extract(dow from ${day}::date)::int
  `)
  const hoursRow = hoursResult.rows[0]
  const openHour = hoursRow.open_hour === null ? DEFAULT_OPEN_HOUR : Number(hoursRow.open_hour)
  const closeHour = hoursRow.close_hour === null ? DEFAULT_CLOSE_HOUR : Number(hoursRow.close_hour)
  const operatingHours = Number(hoursRow.operating_hours)

  // Scoped to the same scoped_courts set as the operating-hours denominator,
  // so grid, numerator, and denominator all agree on which courts count. A
  // suspended court's rows are invisible here by design: no column, no
  // capacity, so counting its hours would push occupancy past 100% for rows
  // that render nowhere.
  //
  // SCHEDULE_ROW, and a LEFT join on profiles: blocks belong on this surface
  // and have no player_id. The inner join this replaced dropped them silently.
  const todaysBookingsResult = await db.execute(sql`
    with scoped_courts as (${scopedCourts})
    select bk.id as booking_id, bk.court_id,
      extract(hour from (bk.starts_at at time zone 'Asia/Manila'))::int as start_hour,
      ${MANILA_END_HOUR} as end_hour,
      (bk.status = 'blocked') as is_block,
      bk.note,
      ${SCHEDULE_LABEL} as label
    from bookings bk
    join scoped_courts sc on sc.court_id = bk.court_id
    left join profiles pr on pr.id = bk.player_id
    where ${SCHEDULE_ROW}
      and to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') = ${day}
    order by bk.starts_at
  `)
  const todaysBookings: OwnerGridBooking[] = todaysBookingsResult.rows.map((row) => ({
    bookingId: row.booking_id as string,
    courtId: row.court_id as string,
    startHour: Number(row.start_hour),
    endHour: Number(row.end_hour),
    label: row.label as string,
    isBlock: row.is_block === true,
    note: (row.note as string | null) ?? null,
  }))

  // Occupancy is PAID utilization: it sits in the stat row beside gross and
  // net and has to mean the same thing they do. A resurfacing block reading as
  // 100% occupancy would be the metric lying about the business. Filtered from
  // the rows already fetched — no extra round trip.
  const bookedHoursToday = todaysBookings
    .filter((booking) => !booking.isBlock)
    .reduce((sum, booking) => sum + (booking.endHour - booking.startHour), 0)
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
    where b.id = any (${sql.param(branchIds)}::uuid[])
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
    where b.id = any (${sql.param(branchIds)}::uuid[]) and c.status = 'pending'
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
  //
  // Activity is a feed of things PLAYERS did, so REAL_BOOKING — a block is the
  // owner's own action and is not news to them. The `join profiles` below can
  // therefore stay INNER: REAL_BOOKING guarantees a non-null player_id. If
  // that filter is ever widened to include 'blocked', this join must become a
  // LEFT join with SCHEDULE_LABEL, or blocks will be dropped silently.
  const recentBookingsResult = await db.execute(sql`
    select bk.created_at as at, c.name as court_name, b.name as branch_name,
      coalesce(pr.full_name, split_part(pr.email, '@', 1)) as player_name
    from bookings bk
    join branches b on b.id = bk.branch_id
    join courts c   on c.id = bk.court_id
    join profiles pr on pr.id = bk.player_id
    where b.id = any (${sql.param(branchIds)}::uuid[]) and ${REAL_BOOKING}
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
    where b.id = any (${sql.param(branchIds)}::uuid[])
    order by rv.created_at desc
    limit 8
  `)

  const activity: OwnerActivity[] = [
    ...recentBookingsResult.rows.map((row) => ({
      kind: 'booking' as const,
      at: new Date(row.at as string).toISOString(),
      text: `${row.player_name as string} booked ${row.court_name as string} at ${row.branch_name as string}`,
    })),
    ...recentReviewsResult.rows.map((row) => ({
      kind: 'review' as const,
      at: new Date(row.at as string).toISOString(),
      text: `${row.player_name as string} left a ${Number(row.rating)}-star review for ${row.court_name as string}`,
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
 * The day's schedule for the scoped branches, optionally narrowed to one.
 *
 * SCHEDULE_ROW, not REAL_BOOKING: blocks take slots, and this list is what an
 * owner or front-desk person reads to know who has the court. A
 * `pending_payment` hold still stays out — an unpaid checkout in progress is
 * not court time taken — as do `expired` and `refunded_manual`.
 *
 * `filters.branchId` is belt-and-braces on top of the scope list: the `any`
 * clause already makes an unscoped branch id return nothing, so a forged
 * filter cannot widen access, only narrow it.
 */
export async function getOwnerBookings(
  branchIds: string[],
  filters: { day: string; branchId?: string },
): Promise<OwnerBookingRow[]> {
  const branchFilter = filters.branchId ? sql`and b.id = ${filters.branchId}::uuid` : sql``

  const result = await db.execute(sql`
    select bk.id as booking_id,
      to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as date,
      extract(hour from (bk.starts_at at time zone 'Asia/Manila'))::int as start_hour,
      ${MANILA_END_HOUR} as end_hour,
      b.id as branch_id, b.name as branch_name, c.name as court_name,
      (bk.status = 'blocked') as is_block,
      bk.note,
      ${SCHEDULE_LABEL} as label,
      bk.status,
      bk.total_charged_centavos, bk.owner_net_centavos
    from bookings bk
    join branches b on b.id = bk.branch_id
    join courts c   on c.id = bk.court_id
    left join profiles pr on pr.id = bk.player_id
    where b.id = any (${sql.param(branchIds)}::uuid[])
      and ${SCHEDULE_ROW}
      and to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') = ${filters.day}
      ${branchFilter}
    order by bk.starts_at
  `)

  return result.rows.map((row) => ({
    bookingId: row.booking_id as string,
    date: row.date as string,
    startHour: Number(row.start_hour),
    endHour: Number(row.end_hour),
    branchId: row.branch_id as string,
    branchName: row.branch_name as string,
    courtName: row.court_name as string,
    label: row.label as string,
    isBlock: row.is_block === true,
    note: (row.note as string | null) ?? null,
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
 * never became real revenue. Blocks never appear: they are excluded by
 * REAL_BOOKING, and bookings_blocked_is_free guarantees they carry no money to
 * leak even if that filter were widened.
 *
 * processor_fee_centavos here is what the OWNER PAID, not what the processor
 * charged: it's 0 for the `platform` bearer, since that fee is carved out of
 * the platform's own margin (see platformRetainedCentavos in
 * src/lib/payments/fees.ts). That's what keeps
 * gross = platform_fee + processor_fee + net true per booking, and therefore
 * under SUM across branches/months even with mixed bearers. The CASE is
 * deny-by-default — mirroring bearerFromSnapshot's posture — so an
 * unrecognized bearer value is NOT treated as owner/player-borne and can't
 * silently double-count itself into the fee.
 */
export async function getOwnerEarnings(branchIds: string[], month: string): Promise<OwnerEarnings> {
  const result = await db.execute(sql`
    select b.id as branch_id, b.name as branch_name,
      count(*)::int as booking_count,
      coalesce(sum(bk.total_charged_centavos), 0)::bigint as gross_centavos,
      coalesce(sum(bk.platform_fee_centavos), 0)::bigint as platform_fee_centavos,
      coalesce(sum(case when coalesce(bk.fee_config_snapshot->>'bearer', 'platform') not in ('owner', 'player') then 0 else bk.processor_fee_centavos end), 0)::bigint as processor_fee_centavos,
      coalesce(sum(bk.owner_net_centavos), 0)::bigint as net_centavos
    from bookings bk
    join branches b on b.id = bk.branch_id
    where b.id = any (${sql.param(branchIds)}::uuid[])
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
    processorFeeCentavos: Number(row.processor_fee_centavos),
    netCentavos: Number(row.net_centavos),
  }))

  const totals = rows.reduce(
    (acc, row) => ({
      bookingCount: acc.bookingCount + row.bookingCount,
      grossCentavos: acc.grossCentavos + row.grossCentavos,
      platformFeeCentavos: acc.platformFeeCentavos + row.platformFeeCentavos,
      processorFeeCentavos: acc.processorFeeCentavos + row.processorFeeCentavos,
      netCentavos: acc.netCentavos + row.netCentavos,
    }),
    {
      bookingCount: 0,
      grossCentavos: 0,
      platformFeeCentavos: 0,
      processorFeeCentavos: 0,
      netCentavos: 0,
    },
  )

  return { month, rows, totals }
}
