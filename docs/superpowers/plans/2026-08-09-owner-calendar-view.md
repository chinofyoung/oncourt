# Owner Month Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give owners a month calendar on `/dashboard/bookings` that shows how busy every day was across all their branches, and opens a day's bookings in a modal.

**Architecture:** The page gains a `?tab=` strip; the calendar tab renders a Server Component month grid fed by one new aggregate query. Clicking a day sets `?day=`, and the page renders a native `<dialog>` populated by the *existing* `getOwnerBookings` call — the modal is URL state, so it needs no new query and no new authorization surface.

**Tech Stack:** Next.js App Router (Server Components), TypeScript, Tailwind CSS v4, Postgres via `db.execute(sql\`...\`)`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-09-owner-calendar-view-design.md` — read it before Task 1.

## Global Constraints

- **Do NOT run any state-changing git command.** No `commit`, `add`, `branch`, `checkout`, `stash`, `reset`, `push`. Read-only `status`/`diff`/`log` is fine. The owner commits their own work. Where the template says "Commit", this plan says **Report**.
- **Data access is server-only**, via ``db.execute(sql`...`)`` — never the Drizzle query builder, never import `src/db/schema.ts`.
- **All money is integer centavos.** No floats anywhere near money; render through the existing `formatPeso`.
- **No schema change and no migration.** Every column this needs already exists.
- **Do not modify `getOwnerBookings`, the Schedule tab's table, or the block form.** The calendar is additive.
- **Authorization is unchanged:** `requireDashboardPage('/dashboard/bookings')` then `branchIdsWith(access, 'view_bookings')`. A client-supplied branch id is never trusted — scope is always re-derived from the session.
- **Tests run against a HOSTED, shared, persistent Supabase database** via `DATABASE_URL` in `.env.local` (Supavisor session pooler, port **5432**, never 6543). `DATABASE_URL` is **not** in the shell env — source it: `set -a; . ./.env.local; set +a`. Run vitest in the **FOREGROUND**. Use `tests/helpers/fixtures.ts` (`seedOwner`, `seedBranchWithCourts`, `seedBooking`, `seedBlock`, `teardownFixtures`) — never hand-roll an `auth.users` insert.
- **eslint baseline is 9 warnings / 0 errors** — clean means 0 errors and no NEW warnings.
- **Three tests fail for pre-existing, unrelated reasons** and must be left alone: `tests/schema/settings.test.ts` and `tests/booking/hold.test.ts` (both assume a 15-minute hold while the DB holds 5), and `tests/listings/write.test.ts` (a leaked `rally-point-bgc` row makes its slug assertion unsatisfiable).
- **Read `design/branding.md` before any styling**, and update it in the same turn if a design-system value changes — this feature introduces the project's first modal, which is a new pattern worth recording.
- `/dashboard/bookings` is **behind auth with no dev login**, so an agent cannot see any of this render. Never claim a visual check that did not happen.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/date-manila.ts` | Month helpers beside the existing day helpers | 1 |
| `src/lib/owner/queries.ts` | `getOwnerMonthCalendar` — the per-day aggregate | 2 |
| `src/components/dashboard/month-calendar.tsx` | The month grid (Server Component) | 3 |
| `src/app/dashboard/bookings/page.tsx` | Tab strip, month nav, wiring | 3, 4 |
| `src/components/dashboard/day-bookings-dialog.tsx` | The `<dialog>` and its row list | 4 |
| `design/branding.md` | Records the modal pattern | 4 |

---

### Task 1: Month helpers

**Files:**
- Modify: `src/lib/date-manila.ts`
- Test: `tests/lib/date-manila-month.test.ts` (create)

**Interfaces:**
- Produces: `manilaMonth(): string`, `isValidCalendarMonth(month: string): boolean`, `shiftMonth(month: string, months: number): string`, `monthDates(month: string): string[]` — all `'YYYY-MM'` in, `'YYYY-MM-DD'` out where dated.

- [ ] **Step 1: Read the existing module first**

Read `src/lib/date-manila.ts` in full. It carries a load-bearing warning on `shiftDay` about *not* reintroducing timezone arithmetic into calendar-date math (parsing `${date}T00:00:00+08:00` is off by one in both directions). Your month helpers must follow the same discipline: pure `Date.UTC` arithmetic, no offsets.

- [ ] **Step 2: Write the failing tests**

Create `tests/lib/date-manila-month.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  isValidCalendarMonth,
  manilaMonth,
  monthDates,
  shiftMonth,
} from '@/lib/date-manila'

test('isValidCalendarMonth accepts a real month and rejects everything else', () => {
  expect(isValidCalendarMonth('2026-08')).toBe(true)
  expect(isValidCalendarMonth('2026-01')).toBe(true)
  expect(isValidCalendarMonth('2026-12')).toBe(true)
  expect(isValidCalendarMonth('2026-00')).toBe(false)
  expect(isValidCalendarMonth('2026-13')).toBe(false)
  expect(isValidCalendarMonth('2026-8')).toBe(false)
  expect(isValidCalendarMonth('2026-08-01')).toBe(false)
  expect(isValidCalendarMonth('')).toBe(false)
  expect(isValidCalendarMonth('nope')).toBe(false)
})

test('shiftMonth crosses year boundaries in both directions', () => {
  expect(shiftMonth('2026-08', 1)).toBe('2026-09')
  expect(shiftMonth('2026-08', -1)).toBe('2026-07')
  expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  expect(shiftMonth('2026-08', 0)).toBe('2026-08')
  expect(shiftMonth('2026-08', 12)).toBe('2027-08')
})

test('monthDates returns every day of the month, in order', () => {
  const august = monthDates('2026-08')
  expect(august).toHaveLength(31)
  expect(august[0]).toBe('2026-08-01')
  expect(august[30]).toBe('2026-08-31')

  expect(monthDates('2026-09')).toHaveLength(30)
  // 2026 is not a leap year; 2028 is. Both are pinned so a naive
  // "always 28" or "always 29" implementation fails.
  expect(monthDates('2026-02')).toHaveLength(28)
  expect(monthDates('2028-02')).toHaveLength(29)
  expect(monthDates('2028-02').at(-1)).toBe('2028-02-29')
})

test('manilaMonth is the first seven characters of manilaToday', async () => {
  const { manilaToday } = await import('@/lib/date-manila')
  expect(manilaMonth()).toBe(manilaToday().slice(0, 7))
})
```

- [ ] **Step 3: Run and watch them fail**

```bash
npx vitest run tests/lib/date-manila-month.test.ts
```

Expected: FAIL — the four functions do not exist.

- [ ] **Step 4: Implement the helpers**

Append to `src/lib/date-manila.ts`:

```ts
const MONTH_RE = /^\d{4}-\d{2}$/

/** The current Manila calendar month, `YYYY-MM`. */
export function manilaMonth(): string {
  return manilaToday().slice(0, 7)
}

/**
 * True only for a `YYYY-MM` string naming a real month. The regex alone
 * accepts `2026-13`, so the month number is range-checked too.
 *
 * Matches the format `getOwnerEarnings` already takes, deliberately: two
 * month-based surfaces on the same dashboard must not disagree about what a
 * month string looks like.
 */
export function isValidCalendarMonth(month: string): boolean {
  if (!MONTH_RE.test(month)) return false
  const monthNumber = Number(month.slice(5, 7))
  return monthNumber >= 1 && monthNumber <= 12
}

/**
 * Shifts a `YYYY-MM` month by `months`. Pure `Date.UTC` arithmetic with no
 * timezone offsets, for the same reason `shiftDay` above avoids them — see
 * its comment. Day 1 is used only as an anchor and never read back.
 */
export function shiftMonth(month: string, months: number): string {
  const [year, monthNumber] = month.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + months, 1))
  return shifted.toISOString().slice(0, 7)
}

/**
 * Every calendar date in `month`, ascending. Length comes from day 0 of the
 * NEXT month, which JavaScript resolves to the last day of this one — so leap
 * years need no special case.
 */
export function monthDates(month: string): string[] {
  const [year, monthNumber] = month.split('-').map(Number)
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return Array.from({ length: dayCount }, (_, index) =>
    new Date(Date.UTC(year, monthNumber - 1, index + 1)).toISOString().slice(0, 10),
  )
}
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run tests/lib/date-manila-month.test.ts
```

Expected: all 4 PASS.

- [ ] **Step 6: Gate and report**

```bash
npx tsc --noEmit && npx eslint
```

Report the test output and the gate. Do not commit.

---

### Task 2: The month aggregate query

**Files:**
- Modify: `src/lib/owner/queries.ts`
- Test: `tests/owner/calendar.test.ts` (create)

**Interfaces:**
- Consumes: `monthDates` (Task 1) is *not* needed here — the query generates its own days in SQL.
- Produces:

```ts
export type OwnerCalendarDay = {
  date: string
  bookingCount: number
  blockCount: number
  grossCentavos: number
  netCentavos: number
  bookedHours: number
  capacityHours: number
  occupancyPct: number | null
}

export async function getOwnerMonthCalendar(
  branchIds: string[],
  month: string,
  branchId?: string,
): Promise<OwnerCalendarDay[]>
```

- [ ] **Step 1: Read the existing patterns you must match**

Read `src/lib/owner/queries.ts`, specifically: `approvedCourtsIn` (the scoped-courts CTE), `SCHEDULE_ROW`, and `getOwnerOverview`'s occupancy computation around lines 228–300. Your query generalises that single-day capacity calculation to a whole month, and **must agree with it** — a test in Step 3 asserts the two produce the same occupancy for the same day.

Three rules carried over from that code, all load-bearing:
- Only **approved** courts contribute capacity. A suspended court renders nowhere, so counting its hours would push occupancy past 100% for rows that appear on no surface.
- `occupancyPct` is `null`, never `0`, when capacity is 0 — "nothing to measure", not "open all day and nobody came".
- Blocks are excluded from money and from `bookedHours`. `getOwnerOverview`'s comment explains why: a resurfacing block reading as 100% occupancy would be "the metric lying about the business".

- [ ] **Step 2: Write the failing tests**

Create `tests/owner/calendar.test.ts`. Read `tests/helpers/fixtures.ts` first to confirm each helper's exact signature and return type.

```ts
import { afterAll, expect, test } from 'vitest'
import {
  seedBooking,
  seedBlock,
  seedBranchWithCourts,
  teardownFixtures,
} from '../helpers/fixtures'
import { getOwnerMonthCalendar, getOwnerOverview } from '@/lib/owner/queries'

afterAll(teardownFixtures)

test('returns one row for every day of the month, including empty days', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const days = await getOwnerMonthCalendar([branchId], '2026-09')
  expect(days).toHaveLength(30)
  expect(days[0].date).toBe('2026-09-01')
  expect(days.at(-1)!.date).toBe('2026-09-30')
  expect(days.every((d) => d.bookingCount === 0)).toBe(true)
})

test('February day counts are right in a leap and a non-leap year', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  expect(await getOwnerMonthCalendar([branchId], '2026-02')).toHaveLength(28)
  expect(await getOwnerMonthCalendar([branchId], '2028-02')).toHaveLength(29)
})

test('a paid booking raises count, money and booked hours on its own day only', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await seedBooking({ branchId, courtId: courtIds[0], date: '2026-09-10', startHour: 9, endHour: 11 })
  const days = await getOwnerMonthCalendar([branchId], '2026-09')
  const tenth = days.find((d) => d.date === '2026-09-10')!
  expect(tenth.bookingCount).toBe(1)
  expect(tenth.bookedHours).toBe(2)
  expect(tenth.grossCentavos).toBeGreaterThan(0)
  expect(days.filter((d) => d.bookingCount > 0)).toHaveLength(1)
})

test('a block raises blockCount but never money, hours or occupancy', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await seedBlock({ branchId, courtId: courtIds[0], date: '2026-09-12', startHour: 8, endHour: 12 })
  const day = (await getOwnerMonthCalendar([branchId], '2026-09')).find((d) => d.date === '2026-09-12')!
  expect(day.blockCount).toBe(1)
  expect(day.bookingCount).toBe(0)
  expect(day.grossCentavos).toBe(0)
  expect(day.netCentavos).toBe(0)
  expect(day.bookedHours).toBe(0)
  expect(day.occupancyPct === null || day.occupancyPct === 0).toBe(true)
})

test('occupancy agrees with getOwnerOverview for the same day', async () => {
  // The two sit on the same dashboard; if they disagree, one of them is lying.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await seedBooking({ branchId, courtId: courtIds[0], date: '2026-09-15', startHour: 10, endHour: 12 })
  const overview = await getOwnerOverview([branchId], '2026-09-15')
  const day = (await getOwnerMonthCalendar([branchId], '2026-09')).find((d) => d.date === '2026-09-15')!
  expect(day.occupancyPct).toBe(overview.stats.occupancyPct)
})

test('occupancy is null, never 0, when no court is open that day', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const days = await getOwnerMonthCalendar([branchId], '2026-09')
  for (const day of days) {
    if (day.capacityHours === 0) expect(day.occupancyPct).toBeNull()
  }
})

test('another owner\'s branch never appears', async () => {
  const mine = await seedBranchWithCourts(1)
  const theirs = await seedBranchWithCourts(1)
  await seedBooking({
    branchId: theirs.branchId,
    courtId: theirs.courtIds[0],
    date: '2026-09-20',
    startHour: 9,
    endHour: 10,
  })
  const day = (await getOwnerMonthCalendar([mine.branchId], '2026-09')).find(
    (d) => d.date === '2026-09-20',
  )!
  expect(day.bookingCount).toBe(0)
})
```

If a fixture helper's signature differs from what is written above, adapt the **call**, never the assertion — and say so in your report.

- [ ] **Step 3: Run and watch them fail**

```bash
set -a; . ./.env.local; set +a
npx vitest run tests/owner/calendar.test.ts
```

Foreground. Expected: FAIL — `getOwnerMonthCalendar` is not exported.

- [ ] **Step 4: Implement the query**

Add to `src/lib/owner/queries.ts`, beside `getOwnerBookings`:

```ts
export type OwnerCalendarDay = {
  date: string
  bookingCount: number
  blockCount: number
  grossCentavos: number
  netCentavos: number
  bookedHours: number
  capacityHours: number
  occupancyPct: number | null
}

/**
 * One row per calendar day of `month`, for the dashboard's month calendar.
 *
 * Generalises the single-day capacity computation in getOwnerOverview to a
 * whole month, and MUST agree with it — the two sit on the same dashboard, so
 * a day reading 80% here and 40% there would make both untrustworthy. Same
 * three rules, for the same reasons documented there:
 *   - only `approved` courts contribute capacity (a suspended court renders
 *     nowhere, so its hours would push occupancy past 100%);
 *   - blocks are excluded from money and from bookedHours (a resurfacing
 *     block reading as full occupancy would be the metric lying about the
 *     business);
 *   - occupancyPct is null, not 0, when there is no capacity to divide by.
 *
 * Days with nothing on them are still returned, so the grid never has to
 * invent missing dates.
 */
export async function getOwnerMonthCalendar(
  branchIds: string[],
  month: string,
  branchId?: string,
): Promise<OwnerCalendarDay[]> {
  if (branchIds.length === 0) return []
  const branchFilter = branchId ? sql`and sc.branch_id = ${branchId}::uuid` : sql``
  const firstDay = `${month}-01`

  const result = await db.execute(sql`
    with scoped_courts as (${approvedCourtsIn(branchIds)}),
    days as (
      select generate_series(
        ${firstDay}::date,
        (${firstDay}::date + interval '1 month' - interval '1 day')::date,
        interval '1 day'
      )::date as day
    ),
    capacity as (
      select d.day,
        coalesce(sum(oh.closes_hour - oh.opens_hour), 0)::int as capacity_hours
      from days d
      left join scoped_courts sc on true ${branchFilter}
      left join court_operating_hours oh
        on oh.court_id = sc.court_id
       and oh.day_of_week = extract(dow from d.day)::int
      group by d.day
    ),
    agg as (
      select to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as day,
        count(*) filter (where bk.status <> 'blocked')::int as booking_count,
        count(*) filter (where bk.status = 'blocked')::int as block_count,
        coalesce(sum(bk.total_charged_centavos) filter (where bk.status <> 'blocked'), 0)::bigint as gross,
        coalesce(sum(bk.owner_net_centavos)     filter (where bk.status <> 'blocked'), 0)::bigint as net,
        coalesce(sum(extract(epoch from (bk.ends_at - bk.starts_at)) / 3600)
                 filter (where bk.status <> 'blocked'), 0)::float8 as booked_hours
      from bookings bk
      join scoped_courts sc on sc.court_id = bk.court_id ${branchFilter}
      where ${SCHEDULE_ROW}
        -- Bound to the month. Without this the CTE aggregates every booking
        -- this owner has ever had and throws all but ~30 days away in the
        -- join below — correct, but it scans the whole table every render.
        and to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM') = ${month}
      group by 1
    )
    select to_char(c.day, 'YYYY-MM-DD') as date,
      c.capacity_hours,
      coalesce(a.booking_count, 0) as booking_count,
      coalesce(a.block_count, 0)   as block_count,
      coalesce(a.gross, 0)         as gross,
      coalesce(a.net, 0)           as net,
      coalesce(a.booked_hours, 0)  as booked_hours
    from capacity c
    left join agg a on a.day = to_char(c.day, 'YYYY-MM-DD')
    order by c.day
  `)

  return result.rows.map((row) => {
    const capacityHours = Number(row.capacity_hours)
    const bookedHours = Number(row.booked_hours)
    return {
      date: row.date as string,
      bookingCount: Number(row.booking_count),
      blockCount: Number(row.block_count),
      grossCentavos: Number(row.gross),
      netCentavos: Number(row.net),
      bookedHours,
      capacityHours,
      occupancyPct:
        capacityHours === 0 ? null : Math.round((bookedHours / capacityHours) * 100),
    }
  })
}
```

**Verify this SQL against the real schema before trusting it** — confirm `court_operating_hours` really has `opens_hour`/`closes_hour`/`day_of_week`, and that `bookings` has `ends_at`. If a column differs, fix the query and say so in your report.

- [ ] **Step 5: Run the tests**

```bash
set -a; . ./.env.local; set +a
npx vitest run tests/owner/calendar.test.ts
```

Foreground. Expected: all 7 PASS. Then run it a **second** time — the database is shared and persistent, so the suite must be re-runnable. A timeout rather than an assertion failure is a pool-contention flake; re-run the single file and say which it was.

- [ ] **Step 6: Confirm no existing owner test regressed**

```bash
set -a; . ./.env.local; set +a
npx vitest run tests/owner
```

Expected: all pass unchanged.

- [ ] **Step 7: Gate and report**

```bash
npx tsc --noEmit && npx eslint
```

Report both test runs, the existing-suite run, and the gate. Do not commit.

---

### Task 3: Tab strip and the month grid

**Files:**
- Create: `src/components/dashboard/month-calendar.tsx`
- Modify: `src/app/dashboard/bookings/page.tsx`

**Interfaces:**
- Consumes: `getOwnerMonthCalendar`, `OwnerCalendarDay` (Task 2); `manilaMonth`, `isValidCalendarMonth`, `shiftMonth` (Task 1); `manilaWeekday`, `manilaToday`, `formatPeso` (existing).
- Produces: `<MonthCalendar days month branchId today selectedDay />` — a Server Component.

- [ ] **Step 1: Read the tab-strip precedent and the branding rules**

Read `design/branding.md` (Layout, Controls, and the Tab strip entry) and `src/app/dashboard/listings/[branchId]/page.tsx` lines ~105–128, which is the tab strip to copy: a `<nav>` of plain `<Link>`s with `aria-current="page"` on the active one, `font-display` weight 700, a 2px bottom border, active `border-[var(--ink)]`, inactive `border-transparent text-[var(--ink-soft)]` hovering to `--ink`, the row sitting on a `--hairline` bottom border. **Not** `role="tab"`/`aria-selected` — these navigate to a URL.

- [ ] **Step 2: Add the tab strip to the page**

In `src/app/dashboard/bookings/page.tsx`:

- Widen `searchParams` to `Promise<{ day?: string; branch?: string; tab?: string; month?: string }>`.
- Resolve `const tab = rawTab === 'calendar' ? 'calendar' : 'schedule'` — an unknown value falls back, matching how the page already falls back on an invalid `?day=`.
- Render the tab strip above the existing content, with two links preserving `?branch=`: `?tab=schedule` and `?tab=calendar`.
- Wrap the existing table and block form so they render only when `tab === 'schedule'`. **Do not otherwise change them.**

- [ ] **Step 3: Resolve the month and fetch**

Still in the page, for the calendar tab only:

```tsx
const month = isValidCalendarMonth(rawMonth ?? '') ? rawMonth! : manilaMonth()
const calendarDays = await getOwnerMonthCalendar(scheduleBranchIds, month, branchId)
```

`scheduleBranchIds` is the existing `branchIdsWith(access, 'view_bookings')` — reuse it; do not re-derive scope, and never read a branch id from anywhere but the already-validated `branchId` the page computes today.

- [ ] **Step 4: Build the grid**

Create `src/components/dashboard/month-calendar.tsx`:

```tsx
import Link from 'next/link'
import type { OwnerCalendarDay } from '@/lib/owner/queries'
import { formatPeso } from '@/lib/format'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * Monday-first is a DISPLAY concern only. Postgres's extract(dow) and
 * court_operating_hours.day_of_week are both 0=Sunday..6=Saturday, and the
 * capacity join in getOwnerMonthCalendar depends on that — this conversion
 * exists solely to place a date in a column. Never push it into SQL: doing so
 * shifts every day's capacity by one weekday, which looks like plausible data
 * rather than an error.
 */
function mondayIndex(weekday: number): number {
  return (weekday + 6) % 7
}

export function MonthCalendar({
  days,
  month,
  branchId,
  today,
  selectedDay,
  weekdayOfFirst,
}: {
  days: OwnerCalendarDay[]
  month: string
  branchId?: string
  today: string
  selectedDay?: string
  weekdayOfFirst: number
}) {
  const lead = mondayIndex(weekdayOfFirst)
  const href = (day: string) =>
    `/dashboard/bookings?tab=calendar&month=${month}${branchId ? `&branch=${branchId}` : ''}&day=${day}`

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        <div className="mb-1 grid grid-cols-7 gap-1.5">
          {WEEKDAYS.map((label) => (
            <div
              key={label}
              className="font-mono px-1 text-[10px] tracking-[.14em] text-[var(--ink-soft)] uppercase"
            >
              {label}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1.5">
          {Array.from({ length: lead }, (_, i) => (
            <div key={`lead-${i}`} aria-hidden />
          ))}
          {days.map((day) => {
            const closed = day.occupancyPct === null
            const isToday = day.date === today
            const isSelected = day.date === selectedDay
            const dayNumber = Number(day.date.slice(8, 10))
            const cell = (
              <>
                <span className="font-display text-[13px] font-bold">{dayNumber}</span>
                {closed ? (
                  <span className="font-mono mt-1 block text-[10px] text-[var(--ink-soft)] uppercase">
                    Closed
                  </span>
                ) : (
                  <>
                    <span className="mt-1 block text-[11.5px] text-[var(--ink)]">
                      {day.bookingCount} {day.bookingCount === 1 ? 'booking' : 'bookings'}
                    </span>
                    <span className="font-mono block text-[11px] text-[var(--ink-soft)]">
                      {formatPeso(day.grossCentavos)}
                    </span>
                    {day.blockCount > 0 && (
                      <span className="font-mono block text-[10px] text-[var(--ink-soft)]">
                        {day.blockCount} blocked
                      </span>
                    )}
                  </>
                )}
              </>
            )
            const base = `relative block min-h-[86px] rounded-[10px] border p-2 text-left ${
              isSelected ? 'border-[var(--ink)] border-[1.5px]' : 'border-[var(--hairline)]'
            } ${isToday ? 'ring-1 ring-[var(--court)]' : ''}`
            if (closed) {
              return (
                <div key={day.date} className={`${base} bg-[var(--surface)] opacity-70`}>
                  {cell}
                </div>
              )
            }
            return (
              <Link
                key={day.date}
                href={href(day.date)}
                aria-label={`${day.date}, ${day.bookingCount} bookings, ${day.occupancyPct}% booked`}
                className={`${base} bg-[var(--panel)] transition-colors hover:border-[var(--court)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--court)] motion-reduce:transition-none`}
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-[10px] bg-[var(--court)]"
                  style={{ opacity: (day.occupancyPct ?? 0) / 100 * 0.18 }}
                />
                <span className="relative">{cell}</span>
              </Link>
            )
          })}
        </div>
      </div>
    </div>
  )
}
```

The page passes `weekdayOfFirst={manilaWeekday(`${month}-01`)}` and `today={manilaToday()}`.

**Do not add `outline-none` anywhere.** In Tailwind v4 it compiles to an ungated `--tw-outline-style: none` that the `focus-visible:` rule then reads through `var()`, silently killing the ring — documented in `branding.md`, and it has bitten this codebase three times.

- [ ] **Step 5: Add month navigation**

Prev/next links above the grid using `shiftMonth(month, -1)` and `shiftMonth(month, +1)`, preserving `?branch=`, mirroring how the schedule tab's day navigation already renders. Label the current month in display font.

- [ ] **Step 6: Gate**

```bash
npx tsc --noEmit && npx eslint
```

- [ ] **Step 7: Confirm the page still compiles and does not 500**

`/dashboard/bookings` redirects to login when signed out, and that redirect is itself proof the module graph loaded — a server-only import violation throws a 500 *before* the redirect.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -L http://localhost:3000/dashboard/bookings
```

Expected: `200` (the login page after redirect), never `500`. Also check the dev server log for `server-only`.

- [ ] **Step 8: Report**

State plainly that the grid's appearance is **unverified** — `/dashboard/bookings` needs a signed-in owner and this project has no dev login. Do not claim otherwise. Do not commit.

---

### Task 4: The day modal

**Files:**
- Create: `src/components/dashboard/day-bookings-dialog.tsx`
- Modify: `src/app/dashboard/bookings/page.tsx`, `design/branding.md`

**Interfaces:**
- Consumes: `getOwnerBookings`, `OwnerBookingRow` (existing, unchanged); `formatPeso`, `formatHourRange` (existing).

- [ ] **Step 1: Fetch the day's bookings when `?day=` is present**

In the page's calendar branch:

```tsx
const dialogDay = rawDay && isValidCalendarDate(rawDay) ? rawDay : undefined
const dialogRows = dialogDay
  ? await getOwnerBookings(scheduleBranchIds, { day: dialogDay, branchId })
  : []
```

This is the **same call the Schedule tab already makes** — no new query, no new authorization surface. Note the Schedule tab uses `?day=` for its own table; on the calendar tab the same parameter selects the modal's day. That overlap is intentional and keeps one meaning for `?day=`: "the day in focus".

- [ ] **Step 2: Build the dialog**

Create `src/components/dashboard/day-bookings-dialog.tsx` as a `'use client'` component. It receives plain data and a `closeHref`.

```tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { OwnerBookingRow } from '@/lib/owner/queries'
import { formatPeso, formatHourRange } from '@/lib/format'

/**
 * The project's first modal. A native <dialog> opened with showModal(),
 * deliberately: it gives focus trapping, Esc-to-close, and an inert
 * background for free. A hand-rolled <div> overlay silently provides none of
 * those, and they are exactly what a keyboard or screen-reader user needs.
 *
 * Open/closed state is the URL (?day=), not React state — the same rule this
 * page already follows for its filters. Closing navigates to closeHref, so
 * the back button works and the day is linkable.
 */
export function DayBookingsDialog({
  day,
  rows,
  closeHref,
}: {
  day: string
  rows: OwnerBookingRow[]
  closeHref: string
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const router = useRouter()
  const [openRow, setOpenRow] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="day-dialog-heading"
      onClose={() => router.push(closeHref)}
      className="w-[min(560px,92vw)] rounded-[20px] bg-[var(--panel)] p-0 backdrop:bg-[rgba(6,20,13,.45)]"
    >
      <div className="flex items-center justify-between border-b border-[var(--hairline)] px-5 py-3.5">
        <h2 id="day-dialog-heading" className="font-display text-[17px] font-bold">
          {day}
        </h2>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          className="rounded-[var(--btn-radius)] px-2 py-1 text-[13px] font-semibold text-[var(--court)] hover:text-[var(--court-deep)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--court)]"
        >
          Close
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-[var(--ink-soft)]">
          Nothing booked on this day.
        </p>
      ) : (
        <ul className="max-h-[60vh] divide-y divide-[var(--hairline)] overflow-y-auto">
          {rows.map((row) => (
            <li key={row.bookingId}>
              <button
                type="button"
                aria-expanded={openRow === row.bookingId}
                onClick={() => setOpenRow(openRow === row.bookingId ? null : row.bookingId)}
                className="flex w-full items-baseline gap-3 px-5 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--court)]"
              >
                <span className="font-mono text-[11.5px] text-[var(--ink-soft)]">
                  {formatHourRange(row.startHour, row.endHour)}
                </span>
                <span className="flex-1 text-[13.5px] font-semibold text-[var(--ink)]">
                  {row.label}
                </span>
                <span className="font-mono text-[11.5px] text-[var(--ink-soft)]">
                  {row.isBlock ? 'Blocked' : formatPeso(row.totalChargedCentavos)}
                </span>
              </button>
              {openRow === row.bookingId && (
                <dl className="grid grid-cols-2 gap-1 px-5 pb-3 text-[12.5px] text-[var(--ink-soft)]">
                  <dt>Branch</dt>
                  <dd className="text-[var(--ink)]">{row.branchName}</dd>
                  <dt>Court</dt>
                  <dd className="text-[var(--ink)]">{row.courtName}</dd>
                  <dt>Status</dt>
                  <dd className="text-[var(--ink)]">{row.status}</dd>
                  {!row.isBlock && (
                    <>
                      <dt>Charged</dt>
                      <dd className="font-mono text-[var(--ink)]">
                        {formatPeso(row.totalChargedCentavos)}
                      </dd>
                      <dt>Your net</dt>
                      <dd className="font-mono text-[var(--ink)]">
                        {formatPeso(row.ownerNetCentavos)}
                      </dd>
                    </>
                  )}
                  {row.note && (
                    <>
                      <dt>Note</dt>
                      <dd className="text-[var(--ink)]">{row.note}</dd>
                    </>
                  )}
                </dl>
              )}
            </li>
          ))}
        </ul>
      )}
    </dialog>
  )
}
```

`onClose` fires for `Esc` **and** for the close button (which calls `.close()`), so there is exactly one navigation path out. Do not add a second `router.push` in the button's handler or the close will fire twice.

- [ ] **Step 3: Render it from the page**

Only when `dialogDay` is set, passing `closeHref` as the same URL without `?day=`.

- [ ] **Step 4: Record the modal pattern in `design/branding.md`**

Add a **Modal** entry to the Components section: a native `<dialog>` opened with `showModal()`, never a hand-rolled overlay, because the native element supplies focus trapping, `Esc`, and an inert background; open state lives in the URL, not React state, so the back button closes it and the view is linkable; it needs `aria-labelledby` pointing at its heading and a real `<button>` to close; backdrop is `rgba(6,20,13,.45)` and the panel uses the card recipe (`--panel`, 20px radius, no border).

Re-read `branding.md` immediately before editing and use targeted string replacement — other sessions edit this file.

- [ ] **Step 5: Gate and check the page loads**

```bash
npx tsc --noEmit && npx eslint
curl -s -o /dev/null -w '%{http_code}\n' -L http://localhost:3000/dashboard/bookings
```

Expected: gate clean, `200`, no `server-only` in the dev server log.

- [ ] **Step 6: Report**

State explicitly that the dialog's **keyboard behaviour is unverified** — whether `Esc` closes it, whether focus is trapped, and whether focus returns to the triggering cell all need a signed-in session that no agent has. Do not assume `showModal()` handled it; say it is unconfirmed. Do not commit.

---

### Task 5: Verification sweep

**Files:** none. **If a check fails, report it — do not fix it.** A silent fix here ships unreviewed.

- [ ] **Step 1: Scope**

```bash
git status --short
```

Expected from this plan: `src/lib/date-manila.ts`, `src/lib/owner/queries.ts`, `src/app/dashboard/bookings/page.tsx`, `design/branding.md`, plus new `src/components/dashboard/month-calendar.tsx`, `src/components/dashboard/day-bookings-dialog.tsx`, `tests/lib/date-manila-month.test.ts`, `tests/owner/calendar.test.ts`.

Anything under `supabase/migrations/` is a scope violation — this feature changes no schema. So is any change to `getOwnerBookings`, the schedule table, or the block form.

Other modified files belong to two earlier, still-uncommitted features (star ratings and player profile completion) — not violations.

- [ ] **Step 2: Gates**

```bash
npx tsc --noEmit && npx eslint
```

- [ ] **Step 3: Full suite**

```bash
set -a; . ./.env.local; set +a
npx vitest run
```

Foreground; ~14 minutes. Expected: everything passes **except** the three known-unrelated failures named in the Global Constraints. Report exact counts. A timeout is a pool-contention flake — re-run that file alone and say which it was.

- [ ] **Step 4: Public pages unaffected**

```bash
curl -s -o /dev/null -w '/ %{http_code}\n' http://localhost:3000/
curl -s -o /dev/null -w '/search %{http_code}\n' 'http://localhost:3000/search?city=tacloban'
curl -s -o /dev/null -w '/dashboard/bookings %{http_code}\n' -L http://localhost:3000/dashboard/bookings
```

Expected: `200` for all three.

- [ ] **Step 5: Report**

Cover: the suite counts with the three known failures named; the scope list; and — plainly — that **the calendar, the tabs, and the dialog have never been seen rendered**, because `/dashboard/bookings` requires a signed-in owner and this project has no dev login. That gap is the honest outcome, not a failure. Nothing is committed.

---

## Notes for the executing agent

**You are the implementer.** Do not delegate any task to another subagent. Do not create a git worktree.

**Three things most likely to go wrong, all quiet:**
1. **Weekday convention.** SQL uses 0=Sunday; the grid displays Monday-first. Mixing them shifts every day's capacity by one weekday and looks like plausible data, not an error.
2. **Occupancy disagreeing with the dashboard's existing stat.** Task 2 Step 2 has a test pinning them equal; if it fails, the query is wrong, not the test.
3. **`outline-none` killing a focus ring** in Tailwind v4 — never pair it with `focus-visible:outline-*`.

**Do not fix things you notice in passing.** The spec's "Out of scope" list names a per-booking page, editing/cancelling, creating blocks from the calendar, week/day layouts, and export. Flag them; do not build them.
