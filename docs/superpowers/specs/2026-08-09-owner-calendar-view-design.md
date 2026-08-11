# Owner dashboard: month calendar view

**Date:** 2026-08-09
**Status:** approved, ready for implementation

## Problem

`/dashboard/bookings` shows exactly one day at a time: a table of that day's
bookings, filtered by `?day=` and optionally `?branch=`, plus the block form.
There is no way for an owner to see a week, a month, or a pattern. Answering
"how did last month go?", "which weekends are dead?", or "is Tuesday worth
staying open?" means clicking through thirty days one at a time.

The data to answer those questions already exists — `bookings`,
`court_operating_hours`, and the money columns are all there. Nothing surfaces
it above a single day.

## Decisions

| Question | Decision |
|---|---|
| Time span | A **month** grid — the span the page does not already cover |
| Branch scope | All owned branches combined; the existing `?branch=` filter still narrows it |
| Week starts | **Monday**, so Saturday and Sunday read as a pair at the right edge |
| Day cell | Booking count + the day's takings + a tint scaled to occupancy |
| Tint basis | **Paid** occupancy — blocks excluded, matching the existing Occupancy stat |
| Modal trigger | A day-cell link setting `?day=`; the modal is **URL state**, not client state |
| Modal data | The **existing** `getOwnerBookings` query, unchanged |
| Modal contents | Player, court, hours, status, money; blocks included |
| Booking detail | Row **expands in place** — no `/dashboard/bookings/[id]` route is built |
| Modal element | Native `<dialog>` + `showModal()` |

### Why the modal is URL state

`src/app/dashboard/bookings/page.tsx` already states the rule this follows:
"Filters are URL state (`?day=&branch=`), not client state — a fresh server
render per navigation, linkable, and off the client bundle entirely."

Clicking a day therefore navigates to `?tab=calendar&month=…&day=…`, and the
page renders the calendar *and* the dialog for that day from a server query.
Three consequences, all good: the modal reuses `getOwnerBookings` verbatim
rather than needing a second query or a second authorization surface; the
back button closes it; and an owner can send a staff member a link that opens
on the right day.

The alternative — a client fetch on click via a Server Action — would need its
own guard, its own re-derivation of the branch scope (a client-supplied
`branchIds` must never be trusted), and a loading state. It buys nothing here.

### Why native `<dialog>`

This codebase has **no modal anywhere** — verified by grepping for `<dialog`,
`role="dialog"` and `aria-modal`. So this establishes the pattern.
`showModal()` provides focus trapping, `Esc` to close, and an inert background
for free. A hand-rolled `<div>` overlay silently lacks all three, and the
missing ones are exactly what a keyboard or screen-reader user needs.

### Why blocks are excluded from the tint

`getOwnerOverview` computes `occupancyPct` from **paid** bookings only, and its
comment explains why: "a resurfacing block reading as 100% occupancy would be
the metric lying about the business." The calendar tint sits on the same
dashboard as that stat, so it must mean the same thing — otherwise one day
could read 100% busy on the calendar and 0% on the stat card.

Blocks are still *visible*: the day cell shows a block count, and blocks appear
in the modal beside real bookings. They just do not colour the day as earnings.

### Why no `/dashboard/bookings/[id]` page

Expanding the row in place shows the same information without a new route, a
new branch-scoped guard, a new query, and new tests — and it keeps the owner
in the calendar rather than navigating away and back. If a linkable
per-booking page is wanted later, the modal row is the natural place to link
from, and nothing here forecloses it.

## Design

### 1. Tabs — `src/app/dashboard/bookings/page.tsx`

`?tab=schedule` (default) and `?tab=calendar`, rendered with `branding.md`'s
Tab strip: a `<nav>` of plain `<Link>`s with `aria-current="page"` on the
active one, **not** `role="tab"`/`aria-selected` — these navigate to a URL, so
link semantics are the honest choice. Precedent:
`src/app/bookings/page.tsx` and
`src/app/dashboard/listings/[branchId]/page.tsx`.

An unknown `?tab=` value falls back to `schedule`, the same way the existing
page already falls back on an invalid `?day=`.

The Schedule tab keeps today's table and the block form **unchanged**. Both
tabs keep the `?branch=` filter, and switching tabs preserves it.

Access is unchanged: `requireDashboardPage('/dashboard/bookings')` then
`branchIdsWith(access, 'view_bookings')`. A session with an empty
`view_bookings` scope sees the calendar's own empty state, not a redirect —
matching how the page treats the schedule table today.

### 2. The month query — `src/lib/owner/queries.ts`

```ts
export type OwnerCalendarDay = {
  date: string              // 'YYYY-MM-DD', Manila
  bookingCount: number      // paid bookings only
  blockCount: number
  grossCentavos: number
  netCentavos: number
  bookedHours: number       // paid only — the occupancy numerator
  capacityHours: number     // sum of open hours across scoped courts that weekday
  occupancyPct: number | null   // null when capacityHours === 0
}

export async function getOwnerMonthCalendar(
  branchIds: string[],
  month: string,            // 'YYYY-MM'
  branchId?: string,
): Promise<OwnerCalendarDay[]>
```

Returns **one row per day of the month**, including days with nothing on them,
so the grid never has to invent missing days.

**Capacity** generalises the single-day computation `getOwnerOverview` already
performs: `approvedCourtsIn(branchIds)` as a CTE, joined to
`court_operating_hours` on `day_of_week = extract(dow from d::date)`, summed
over `generate_series` across the month's days. Casting to `date` (not
`timestamptz`) keeps it a pure calendar computation with no timezone shift, and
`extract(dow …)` is 0=Sunday…6=Saturday, matching
`court_operating_hours.day_of_week` and `manilaWeekday()`.

Scoping to **approved** courts matters and is not incidental: a suspended
court renders nowhere and contributes no capacity, so counting its hours would
push occupancy above 100% for rows that appear on no surface.

**Money and counts** come from the same `bookings` rows the schedule uses,
bucketed by `to_char(starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD')`.
Blocks are counted separately and excluded from money and from `bookedHours`.

`occupancyPct` is `null`, never `0`, when `capacityHours` is 0 — a day when
every court is closed is "nothing to measure", not "open all day and nobody
came". The grid renders those two states differently.

### 3. The grid — `src/components/dashboard/month-calendar.tsx`

A Server Component. Seven columns, **Monday-first**, with leading and trailing
blanks so the 1st lands under its weekday.

**Monday-first is a display concern only, and must not leak into the query.**
Postgres's `extract(dow …)` is 0=Sunday…6=Saturday, and
`court_operating_hours.day_of_week` stores that same convention — the capacity
join in §2 depends on it and stays as it is. The grid converts for layout
alone: `(dow + 6) % 7` gives Monday=0…Sunday=6 for column placement. Getting
these two backwards would silently shift every day's capacity by one weekday,
which is the kind of bug that looks like plausible data rather than an error,
so keep the conversion in the component and never in SQL. Each day cell shows the date
number, `N bookings`, the day's takings in mono (`branding.md`'s money rule),
and a background tint scaled to `occupancyPct`.

- **No capacity** (`occupancyPct === null`): muted, labelled "Closed", not
  clickable — there is nothing to open.
- **Capacity, no bookings**: normal cell, no tint, still clickable (an owner
  may want to confirm a day really was empty).
- **Today**: marked distinctly from the selected day, since both can be true
  at once.
- Cells are `<Link>`s to `?tab=calendar&month=…&day=…`, preserving `?branch=`.

Month navigation is `?month=YYYY-MM` with prev/next links, mirroring how the
schedule tab's day navigation already works. An invalid or missing `?month=`
falls back to the current Manila month.

`src/lib/date-manila.ts` has `isValidCalendarDate` and `shiftDay` but **no
month equivalent**, so this adds `isValidCalendarMonth(month: string)` and
`shiftMonth(month: string, months: number)` beside them. They belong in that
module rather than in the page, for the same reason the day helpers do: an
invalid `?month=` must be rejected before it reaches a `::date` cast, or
Postgres raises 22008 on a hand-edited URL. Note `getOwnerEarnings` already
accepts a `'YYYY-MM'` month string — these helpers should match that format
exactly so the two month-based surfaces cannot drift.

Per `branding.md`'s Layout rule, the grid scrolls horizontally inside its own
container on narrow screens rather than making the page scroll sideways.

### 4. The modal — `src/components/dashboard/day-bookings-dialog.tsx`

Rendered by the page only when `?day=` is present and valid, populated by
`getOwnerBookings(branchIds, { day, branchId })` — the identical call the
Schedule tab makes.

A thin `'use client'` wrapper calls `showModal()` on mount and, on close (`Esc`
or the close button — a native `<dialog>` does not close on backdrop click,
and this feature adds nothing to make it do so), navigates back to the same
URL without `?day=`. The dialog needs an accessible name (`aria-labelledby`
pointing at its heading), and the close control must be a real `<button>`.

Rows show the player label, branch and court, the hour range, status, and the
amount. Blocks render in the same list, visually distinguished, carrying their
note. Clicking a row toggles it open in place to show the fee breakdown
(`totalChargedCentavos`, `ownerNetCentavos`) — this is local `useState` in the
list, the one piece of genuine client state in the feature.

An empty day renders an empty state inside the dialog rather than an empty
box.

### 5. Money and formatting

All amounts stay integer centavos end to end and render through the existing
`formatPeso`. Peso amounts are mono per `branding.md`. Nothing computes money
in floating point anywhere in this feature.

## Testing

The calendar's value is entirely in its arithmetic, so that is what gets
tested — against the hosted database, in the foreground.

- `getOwnerMonthCalendar` returns a row for **every** day of the month,
  including empty ones, and for a 28-, 30- and 31-day month.
- Blocks raise `blockCount` but change neither `grossCentavos` nor
  `bookedHours` nor `occupancyPct`.
- `occupancyPct` is `null` when no court is open that weekday, and `0` never
  appears in that case.
- Occupancy for a day matches what `getOwnerOverview` reports for that same
  day — the two must not disagree, since they sit on the same dashboard.
- A non-approved (pending/suspended) court contributes no CAPACITY — but its
  real, already-paid bookings still count toward `bookingCount` and
  `grossCentavos`, scoped by branch like every other money surface
  (getOwnerEarnings, getOwnerOverview, the Schedule tab). A court can be
  re-queued to `pending` mid-month by `replaceOperatingHours` on any hours
  edit, or suspended by an admin, without its bookings ever having been
  cancelled or refunded — excluding those rows from the calendar's counts and
  takings would make it disagree with the rest of the dashboard about real
  revenue, which is worse than the occupancy metric briefly having no
  capacity to divide by.
- The `?branch=` filter narrows the month exactly as it narrows the schedule.
- Branch scoping holds: a second owner's bookings never appear.

Existing suites must pass unchanged; a diff to one signals the change escaped
its scope.

## Verification

- `npx tsc --noEmit` and `npx eslint` clean (baseline: 9 warnings, 0 errors).
- `/dashboard/bookings` is **behind auth and cannot be browser-verified by an
  agent** — this project has no dev login. The tab strip, the grid, and the
  dialog's focus behaviour must be confirmed by the user, or by tests that
  exercise the components directly. Do not claim a visual check that did not
  happen.
- The dialog's keyboard behaviour (`Esc` closes, focus is trapped, focus
  returns to the triggering cell) is the part most likely to be wrong and the
  hardest to verify without a session — call it out explicitly as unverified
  rather than assuming `showModal()` handled it.

## Out of scope

- A `/dashboard/bookings/[id]` per-booking page.
- Editing, cancelling, or refunding a booking from the calendar.
- Creating a block from the calendar — blocking stays on the Schedule tab.
- Week or day calendar layouts.
- Exporting or printing.
- Any change to the Schedule tab's table, the block form, or `getOwnerBookings`.
