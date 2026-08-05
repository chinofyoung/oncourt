import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { manilaWeekday } from '@/lib/date-manila'
import type { RateBand } from '@/lib/booking/pricing'

export type CellState = 'open' | 'booked' | 'closed'
export type GridCell = { hour: number; priceCentavos: number; state: CellState }
export type GridColumn = {
  courtId: string
  courtName: string
  environment: 'indoor' | 'outdoor'
  cells: GridCell[]
}

export type GridInput = {
  date: string
  courts: { courtId: string; courtName: string; environment: 'indoor' | 'outdoor' }[]
  rateBands: Record<string, RateBand[]>
  operatingHours: Record<string, { opensHour: number; closesHour: number }>
  occupiedHours: Record<string, number[]>
}

/** Pure: no DB, no clock. Everything it needs is passed in, so it is trivially testable. */
export function buildAvailabilityGrid(input: GridInput): GridColumn[] {
  const windows = Object.values(input.operatingHours)
  const opensAt = windows.length ? Math.min(...windows.map((w) => w.opensHour)) : 0
  const closesAt = windows.length ? Math.max(...windows.map((w) => w.closesHour)) : 0
  const hours = Array.from({ length: Math.max(0, closesAt - opensAt) }, (_, i) => opensAt + i)

  return input.courts.map((court) => {
    const window = input.operatingHours[court.courtId]
    const bands = input.rateBands[court.courtId] ?? []
    const occupied = new Set(input.occupiedHours[court.courtId] ?? [])

    const cells = hours.map((hour): GridCell => {
      const band = bands.find((b) => hour >= b.startHour && hour < b.endHour)
      // A court is only actually bookable at an hour if it is both within
      // its operating window AND has a rate band covering that hour — an
      // hour with no price to charge is not a real open slot.
      const isOpen = Boolean(window && hour >= window.opensHour && hour < window.closesHour && band)

      return {
        hour,
        priceCentavos: band?.priceCentavos ?? 0,
        state: !isOpen ? 'closed' : occupied.has(hour) ? 'booked' : 'open',
      }
    })

    return { ...court, cells }
  })
}

/**
 * Loads one branch's courts, rate bands, operating hours (for `date`'s
 * Manila weekday), and live occupancy for `date`, and reduces them into a
 * `GridColumn[]` via the pure builder above. Returns `null` when no branch
 * matches `slug` (the caller should 404).
 */
export async function loadBranchDay(
  slug: string,
  date: string,
): Promise<{ branch: Record<string, unknown>; grid: GridColumn[] } | null> {
  const branchRows = await db.execute(sql`
    select id, name, slug, address, city from branches where slug = ${slug}
  `)
  const branch = branchRows.rows[0]
  if (!branch) return null

  const branchId = branch.id as string
  const weekday = manilaWeekday(date)
  const dayStart = new Date(`${date}T00:00:00+08:00`).toISOString()
  const dayEnd = new Date(`${date}T24:00:00+08:00`).toISOString()

  const courtRows = await db.execute(sql`
    select id, name, environment from courts
    where branch_id = ${branchId}::uuid and status = 'approved'
    order by name
  `)
  const courtIds = courtRows.rows.map((r) => r.id as string)
  if (courtIds.length === 0) {
    return { branch, grid: [] as GridColumn[] }
  }

  // Note: `${courtIds}` (a plain JS array) is NOT a Postgres array parameter
  // by itself — drizzle-orm's `sql` tag special-cases a *raw* array chunk by
  // expanding it into a parenthesized, comma-separated list of its own bind
  // parameters (confirmed by reading `buildQueryFromSourceParams`'s
  // `Array.isArray(chunk)` branch in `node_modules/drizzle-orm/sql/sql.js`).
  // Two versions of this file got this wrong before landing on the one
  // below, both confirmed live against the hosted database:
  //   1. `= any (${courtIds}::uuid[])` — the array expands to `($1)` (one
  //      element) or `($1, $2)` (two+), and the literal `::uuid[]` outside
  //      that group casts the *group itself*, not each element. For one
  //      court this produced `any (($1)::uuid[])`, casting a single UUID
  //      string to `uuid[]` — Postgres rejects that as a malformed array
  //      literal (22P02) on every call.
  //   2. `in (${courtIds})` — same expansion, so for two+ courts it produced
  //      `in (($1, $2))`: the *inner* parens come from the array expansion,
  //      the *outer* parens are the ones this file wrote around it, and
  //      together `($1, $2)` is a SQL row constructor, not an IN-list.
  //      Comparing a `uuid` column against a row value throws
  //      `42883 operator does not exist: uuid = record`. This only worked
  //      by accident for a single-court branch, where `($1)` degenerates to
  //      a plain scalar rather than a row — which is exactly why this
  //      shipped once already: the only branch used for manual verification
  //      had one court. Reproduced directly: `select ... where court_id in
  //      (${courtIds})` against a real 2-court fixture failed with that
  //      exact 42883 before this fix, and the same is now asserted as a
  //      test (`tests/booking/availability.test.ts`, "loadBranchDay returns
  //      one column per approved court").
  // `sql.param(courtIds)` is the actual fix: it wraps the array in drizzle's
  // `Param` class, which is handled by a *different* branch
  // (`is(chunk, Param)`) that binds the value as-is — one parameter whose
  // value is the whole array — instead of the array-expansion branch above.
  // node-postgres serializes that one array parameter into a real Postgres
  // array literal for the `::uuid[]` cast, and `= any (...)` then does the
  // membership test correctly. Verified live: generated SQL is
  // `where court_id = any ($1::uuid[])` with `params: [[id1, id2]]` — one
  // parameter, whose value is the array — and it returns the correct rows
  // for both a one-court and a two-court branch.
  const bandRows = await db.execute(sql`
    select court_id, start_hour, end_hour, price_centavos from court_rate_bands
    where court_id = any (${sql.param(courtIds)}::uuid[])
  `)
  const hourRows = await db.execute(sql`
    select court_id, opens_hour, closes_hour from court_operating_hours
    where court_id = any (${sql.param(courtIds)}::uuid[]) and day_of_week = ${weekday}
  `)
  // Live occupancy only: expired holds are not occupying anything.
  const bookingRows = await db.execute(sql`
    select court_id, starts_at, ends_at from bookings
    where court_id = any (${sql.param(courtIds)}::uuid[])
      and starts_at >= ${dayStart}::timestamptz
      and starts_at <  ${dayEnd}::timestamptz
      and (
        -- 'blocked' is here for the same reason it is in bookings_no_overlap's
        -- predicate: a block takes the slot. Leaving it out would render an
        -- open, priced cell that the exclusion constraint then refuses on
        -- submit — the app appearing to lose a booking at the last moment.
        status in ('confirmed', 'completed', 'blocked')
        or (status = 'pending_payment' and expires_at > now())
      )
  `)

  const rateBands: GridInput['rateBands'] = {}
  for (const r of bandRows.rows) {
    const id = r.court_id as string
    ;(rateBands[id] ??= []).push({
      startHour: Number(r.start_hour),
      endHour: Number(r.end_hour),
      priceCentavos: Number(r.price_centavos),
    })
  }

  const operatingHours: GridInput['operatingHours'] = {}
  for (const r of hourRows.rows) {
    operatingHours[r.court_id as string] = {
      opensHour: Number(r.opens_hour),
      closesHour: Number(r.closes_hour),
    }
  }

  const occupiedHours: GridInput['occupiedHours'] = {}
  for (const r of bookingRows.rows) {
    const id = r.court_id as string
    const from = new Date(r.starts_at as string)
    const to = new Date(r.ends_at as string)
    const list = (occupiedHours[id] ??= [])
    for (let t = from.getTime(); t < to.getTime(); t += 3_600_000) {
      // Manila hour-of-day for this instant: add the +8h offset to the
      // absolute UTC instant, then read UTC fields off the shifted instant.
      // This is the inverse (and correct) direction of the weekday bug
      // documented in `manilaWeekday` (`src/lib/date-manila.ts`) — here we
      // start from a real, unambiguous timestamptz and want the Manila
      // wall-clock hour, so shifting forward before reading UTC fields is
      // right; it is only wrong when a date string that already encodes a
      // Manila offset is parsed and then re-read via getUTCDay().
      list.push(new Date(t + 8 * 3_600_000).getUTCHours())
    }
  }

  const grid = buildAvailabilityGrid({
    date,
    courts: courtRows.rows.map((r) => ({
      courtId: r.id as string,
      courtName: r.name as string,
      environment: r.environment as 'indoor' | 'outdoor',
    })),
    rateBands,
    operatingHours,
    occupiedHours,
  })

  return { branch, grid }
}
