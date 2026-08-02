# Public Browse Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the four public browse pages — home, search results, full branch page, and owner profile — from `design/mockups/`, rendered from real data in the live Supabase database.

**Architecture:** Next.js App Router Server Components do every read through one server-only query module (`src/lib/branches/queries.ts`) using `db.execute(sql\`...\`)`. Search state lives entirely in the URL. Only two client components exist: the Leaflet map and a thin wrapper holding list↔map hover state. A new `reviews` table and an expanded seed give the pages real content.

**Tech Stack:** Next.js 16 (App Router, TypeScript), React 19, Tailwind CSS v4, Drizzle 0.45.2 over `pg`, Supabase (Postgres + PostGIS + Storage), Leaflet, Vitest.

**Source spec:** `docs/superpowers/specs/2026-08-01-public-browse-pages-design.md`

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from `CLAUDE.md`, `design/branding.md`, and the spec.

- **Read `design/branding.md` before ANY design/UI work.** It is the design source of truth and outranks the mockup HTML wherever they disagree. If a branding change becomes necessary, update `design/branding.md` in the same turn.
- **Data access is server-only.** The browser never queries Postgres. All reads go through Server Components. Client components receive data as props.
- **Use `db.execute(sql\`...\`)`, never the Drizzle query builder.** Do not import `src/db/schema.ts` — it will resurface a `TS2304`.
- **Array parameters must use `= any (${sql.param(ids)}::uuid[])`.** The forms `in (${ids})` and `= any (${ids}::uuid[])` both generate wrong SQL (`42883` / `22P02`). See the long comment in `src/lib/booking/availability.ts:102-138`.
- **All money is `integer` centavos; percentages are integer basis points.** Never floats, never `numeric` — `numeric` returns as a *string* from the pg driver. Cast aggregates to `float8` or `int` in SQL.
- **Identifiers are lowercase `snake_case`.** Index every foreign key explicitly.
- **RLS enabled on every new table with zero policies.** No policies, and never `force row level security`.
- **Migrations must be idempotent.** `create table if not exists`, `create index if not exists`, and `DO $$ ... $$` blocks checking `pg_constraint` for any `add constraint`. Prove it by applying twice — `supabase db reset` is unavailable.
- **The database is hosted, shared, and persistent.** Tests must pass on repeated runs and must never mutate seeded singleton rows (`smash-zone-marikina`, the `task9-*` fixtures, or anything this plan seeds).
- **Connect via the Supavisor session pooler, port 5432**, username `postgres.<project-ref>`, from `DATABASE_URL` in `.env.local`. **Never port 6543.**
- Apply migrations with: `npx supabase db push --db-url "$DATABASE_URL"`
- **Currency is PHP (₱); market is the Philippines.** Copy may use light Taglish. Brand name "oncourt" is a placeholder — keep it swappable.
- **Colors: solid only. No gradients of any kind, no glows.**
- **Control tokens:** `--control-h: 56px`, `--btn-h: 48px`, `--btn-h-sm: 38px`, `--btn-radius: 12px` — one radius for all buttons and inputs. Non-interactive chips/badges stay pill-shaped (`border-radius: 999px`).
- **Content column: 1120px max, centered, 24px side padding.** Full-bleed bands pad with `max(24px, calc((100vw - 1120px) / 2))`. Breakpoints `980px` and `560px`.
- **Do NOT use Tailwind's `md:`/`lg:` shorthands for these breakpoints.** This project has no `tailwind.config.*` and no `--breakpoint-*` override in `globals.css`, so `md:` resolves to Tailwind's stock **768px** — not the 980px `branding.md` specifies. Between 768px and 980px the layout would then be wrong in a way that looks plausible. Use arbitrary variants that state the real value: `max-[980px]:` / `min-[980px]:` and `max-[560px]:`.
- **The brand name "oncourt" must appear in exactly ONE place in the codebase** — `src/components/site/wordmark.tsx` — so it stays swappable. Never hardcode it a second time (a footer copyright line, a page title, an alt text). Route any other appearance through the component or a shared constant.
- **Never save PNGs or screenshots in the project root** — use `docs/screenshots/`.
- **Do not run state-changing git commands automatically.** Commit steps in this plan are written out for the user to run; an agent must not execute them unless explicitly told to.
- **Never create git worktrees.** All work happens in the main working directory.
- Verify what generated code actually produces — print the SQL, read the computed CSS, query the catalog. `docs/foundation-review-notes.md` documents five separate cases where a confident comment outran the code.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/lib/date-manila.ts` | The four Manila calendar helpers, consolidated from four call sites |
| `src/lib/format.ts` | Peso / hour / hour-range / date-label display formatting |
| `src/lib/geo/cities.ts` | Metro Manila city → centroid lookup; no external geocoder |
| `src/lib/photos.ts` | Supabase Storage public URL construction |
| `src/lib/branches/queries.ts` | Every read for these four pages |
| `src/components/site/wordmark.tsx` | "oncourt" + lime square |
| `src/components/site/nav.tsx` | Nav, `overlay` and `solid` variants |
| `src/components/site/footer.tsx` | Shared footer |
| `src/components/ui/rating.tsx` | Lime dot + number + count |
| `src/components/ui/amenity-chip.tsx` | Pill badge |
| `src/components/ui/branch-card.tsx` | The card shared by home, search, owner profile |
| `src/components/search/filter-bar.tsx` | Search filters (client — writes to the URL) |
| `src/components/search/search-results.tsx` | Client wrapper holding `activeId` for list↔map hover |
| `src/components/search/search-map.tsx` | Leaflet map, client-only |
| `src/components/branch/photo-gallery.tsx` | Branch page gallery |
| `src/components/branch/review-list.tsx` | Branch page reviews |
| `src/app/search/page.tsx` | Search results page |
| `src/app/owners/[slug]/page.tsx` | Owner profile page |
| `supabase/migrations/<ts>_reviews.sql` | The `reviews` table |
| `scripts/seed-photos.ts` | Downloads Unsplash photos, uploads to Storage, upserts photo rows |

**Modified:**

| File | Change |
|---|---|
| `src/lib/booking/hold.ts` | Import `manilaWeekday` from `@/lib/date-manila`; delete the local copy |
| `src/lib/booking/availability.ts` | Same |
| `src/app/venues/[slug]/page.tsx` | Import the helpers; build out the full page |
| `src/app/venues/[slug]/actions.ts` | Import `isValidCalendarDate`; delete `isRealCalendarDate` |
| `src/app/page.tsx` | Replaced with the home page |
| `src/app/globals.css` | Add brand tokens the new pages reference |
| `supabase/seed.sql` | Grow to 3 owners / ~10 branches / ~30 courts / bookings / reviews |
| `package.json` | Add `leaflet`, `@types/leaflet`, a `seed:photos` script |

---

## Task 1: Manila date helpers and display formatting

Pure functions with no DB and no clock dependency beyond `Date.now()`. This is the debt repayment `docs/foundation-review-notes.md` lists as unowned, done now because all four new pages need these helpers.

**Files:**
- Create: `src/lib/date-manila.ts`
- Create: `src/lib/format.ts`
- Create: `tests/lib/date-manila.test.ts`
- Create: `tests/lib/format.test.ts`
- Modify: `src/lib/booking/hold.ts` (delete local `manilaWeekday`, import instead)
- Modify: `src/lib/booking/availability.ts` (delete local `manilaWeekday`, import instead)
- Modify: `src/app/venues/[slug]/actions.ts` (delete `isRealCalendarDate`, import `isValidCalendarDate`)
- Modify: `src/app/venues/[slug]/page.tsx` (delete local `manilaToday`, `isValidCalendarDate`, `shiftDay`, `formatDateLabel`; import instead)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // src/lib/date-manila.ts
  export function manilaToday(): string                          // 'YYYY-MM-DD'
  export function manilaWeekday(date: string): number             // 0=Sun..6=Sat
  export function isValidCalendarDate(date: string): boolean
  export function shiftDay(date: string, days: number): string

  // src/lib/format.ts
  export function formatPeso(centavos: number): string            // '₱300' | '₱1,022.90'
  export function formatPriceFrom(centavos: number): string       // 'from ₱200/hr'
  export function formatHour(hour: number): string                // '6 AM', formatHour(24) === '12 AM'
  export function formatHourRange(start: number, end: number): string  // '7 – 9 AM'
  export function formatDateLabel(date: string): string           // 'Fri, Aug 1'
  ```

`manilaInstant` in `hold.ts` is **not** moved — it exists in only one place, so there is no duplication to resolve, and moving it widens this task's blast radius for no gain.

- [ ] **Step 1: Write the failing tests for `src/lib/date-manila.ts`**

Create `tests/lib/date-manila.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  isValidCalendarDate,
  manilaToday,
  manilaWeekday,
  shiftDay,
} from '@/lib/date-manila'

describe('manilaWeekday', () => {
  // 2026-08-01 is a Saturday. The bug this guards against is reading
  // getUTCDay() off a '+08:00'-parsed instant: Manila midnight of Aug 1 is
  // 16:00 UTC on Jul 31, so that returns Friday (5) instead of Saturday (6).
  it('returns the weekday of the calendar date itself', () => {
    expect(manilaWeekday('2026-08-01')).toBe(6)
    expect(manilaWeekday('2026-08-02')).toBe(0)
    expect(manilaWeekday('2026-08-03')).toBe(1)
  })

  it('is correct across a year boundary', () => {
    expect(manilaWeekday('2027-01-01')).toBe(5)
  })
})

describe('shiftDay', () => {
  it('shifts forward', () => {
    expect(shiftDay('2026-08-01', 1)).toBe('2026-08-02')
  })

  // The prior implementation was a no-op forward and a two-day jump backward.
  it('shifts backward by exactly one day', () => {
    expect(shiftDay('2026-08-01', -1)).toBe('2026-07-31')
  })

  it('crosses a month boundary', () => {
    expect(shiftDay('2026-07-31', 1)).toBe('2026-08-01')
  })

  it('crosses a year boundary', () => {
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDay('2027-01-01', -1)).toBe('2026-12-31')
  })

  it('handles a leap day', () => {
    expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29')
  })
})

describe('isValidCalendarDate', () => {
  it('accepts a real date', () => {
    expect(isValidCalendarDate('2026-08-01')).toBe(true)
  })

  it('rejects shape-invalid input', () => {
    expect(isValidCalendarDate('lol')).toBe(false)
    expect(isValidCalendarDate('2026-8-1')).toBe(false)
    expect(isValidCalendarDate('')).toBe(false)
  })

  it('rejects a shape-valid but nonexistent date', () => {
    expect(isValidCalendarDate('2026-02-30')).toBe(false)
    expect(isValidCalendarDate('2026-13-01')).toBe(false)
  })
})

describe('manilaToday', () => {
  it('returns a valid YYYY-MM-DD date', () => {
    expect(isValidCalendarDate(manilaToday())).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/date-manila.test.ts`
Expected: FAIL — "Failed to resolve import '@/lib/date-manila'".

- [ ] **Step 3: Implement `src/lib/date-manila.ts`**

```ts
/**
 * Manila calendar-date helpers. Manila is UTC+8 with no DST, so a fixed
 * offset is correct and stable.
 *
 * Consolidated from four call sites that each carried their own copy
 * (`src/lib/booking/hold.ts`, `src/lib/booking/availability.ts`,
 * `src/app/venues/[slug]/page.tsx`, `src/app/venues/[slug]/actions.ts`) —
 * `isRealCalendarDate` and `isValidCalendarDate` were the same function
 * under two names. See docs/foundation-review-notes.md, "Smaller deferred
 * items".
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Today's Manila calendar date as `YYYY-MM-DD`. */
export function manilaToday(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
}

/**
 * Day-of-week (0=Sunday..6=Saturday) of the Manila calendar date itself.
 *
 * Parses the date's own y/m/d components into `Date.UTC`, treating them as a
 * plain calendar date with no timezone shift — which is what
 * `court_operating_hours.day_of_week` actually means.
 *
 * Do NOT rewrite this as `new Date(`${date}T00:00:00+08:00`).getUTCDay()`.
 * That is off by one on every day of the year: Manila midnight of `date` is
 * 16:00 UTC on the *previous* calendar day, so `getUTCDay()` returns the
 * earlier weekday. It would validate every booking against the wrong day's
 * operating hours.
 */
export function manilaWeekday(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * True only for a `YYYY-MM-DD` string naming a date that exists. The
 * round-trip through `Date.UTC` is what rejects `2026-02-30`, which the
 * regex alone accepts (`Date.UTC` rolls it over to March 2).
 */
export function isValidCalendarDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false
  const [year, month, day] = date.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  )
}

/**
 * Shifts a `YYYY-MM-DD` calendar date by `days`, with no timezone arithmetic
 * at all — a calendar date shift needs no notion of an offset.
 *
 * Do NOT rewrite this to parse `${date}T00:00:00+08:00` and shift with
 * `setUTCDate`. That is off by one in both directions: parsing with an
 * explicit +08:00 offset first converts to a UTC instant on the *previous*
 * calendar day, and reading the result back with `toISOString().slice(0, 10)`
 * never corrects for it.
 */
export function shiftDay(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/date-manila.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Write the failing tests for `src/lib/format.ts`**

Create `tests/lib/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  formatDateLabel,
  formatHour,
  formatHourRange,
  formatPeso,
  formatPriceFrom,
} from '@/lib/format'

describe('formatPeso', () => {
  it('omits centavos when the amount is whole pesos', () => {
    expect(formatPeso(30000)).toBe('₱300')
    expect(formatPeso(0)).toBe('₱0')
  })

  it('shows centavos when they are non-zero', () => {
    expect(formatPeso(102290)).toBe('₱1,022.90')
    expect(formatPeso(2230)).toBe('₱22.30')
  })

  it('separates thousands', () => {
    expect(formatPeso(100000)).toBe('₱1,000')
  })
})

describe('formatPriceFrom', () => {
  it('renders the price-from pattern', () => {
    expect(formatPriceFrom(20000)).toBe('from ₱200/hr')
  })
})

describe('formatHour', () => {
  it('formats morning and afternoon hours', () => {
    expect(formatHour(6)).toBe('6 AM')
    expect(formatHour(11)).toBe('11 AM')
    expect(formatHour(13)).toBe('1 PM')
    expect(formatHour(23)).toBe('11 PM')
  })

  it('formats both noon and midnight as 12', () => {
    expect(formatHour(0)).toBe('12 AM')
    expect(formatHour(12)).toBe('12 PM')
  })

  // court_operating_hours.closes_hour is allowed to be 24 and the fixtures
  // use it, so this path runs constantly. Rendering it as '24 AM' was a real
  // bug (docs/foundation-review-notes.md).
  it('formats hour 24 as midnight', () => {
    expect(formatHour(24)).toBe('12 AM')
  })
})

describe('formatHourRange', () => {
  it('collapses a shared period onto the end of the range', () => {
    expect(formatHourRange(7, 9)).toBe('7 – 9 AM')
  })

  it('keeps both periods when they differ', () => {
    expect(formatHourRange(11, 13)).toBe('11 AM – 1 PM')
    expect(formatHourRange(17, 24)).toBe('5 PM – 12 AM')
  })
})

describe('formatDateLabel', () => {
  it('renders weekday, month and day', () => {
    expect(formatDateLabel('2026-08-01')).toBe('Sat, Aug 1')
  })

  it('does not shift the date across a timezone boundary', () => {
    expect(formatDateLabel('2026-01-01')).toBe('Thu, Jan 1')
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run tests/lib/format.test.ts`
Expected: FAIL — "Failed to resolve import '@/lib/format'".

- [ ] **Step 7: Implement `src/lib/format.ts`**

```ts
/**
 * Display formatting for money, times and dates.
 *
 * Per design/branding.md, "Currency & data formatting": peso amounts render
 * in mono at the call site (`₱300`, `₱1,022.90`), times as `6 AM` / `7 – 9 AM`
 * (spaced EN DASH, U+2013), dates as `Fri, Aug 1`.
 *
 * Everything here takes integer centavos or integer hours. No float money
 * ever enters or leaves this module — the division by 100 happens at this
 * edge and nowhere else.
 */

const EN_DASH = '–'

/**
 * `₱300` for whole pesos, `₱1,022.90` when there are centavos. Never renders
 * a trailing `.00`, because branding.md's examples don't.
 */
export function formatPeso(centavos: number): string {
  const hasFraction = centavos % 100 !== 0
  return (
    '₱' +
    (centavos / 100).toLocaleString('en-US', {
      minimumFractionDigits: hasFraction ? 2 : 0,
      maximumFractionDigits: 2,
    })
  )
}

/** branding.md's price-from pattern: `from ₱200/hr`. */
export function formatPriceFrom(centavos: number): string {
  return `from ${formatPeso(centavos)}/hr`
}

/**
 * 24h integer hour to a 12h label. Accepts 24, which
 * `court_operating_hours.closes_hour` permits and the fixtures use — it is
 * midnight, and rendering it as `24 AM` was a real bug.
 */
export function formatHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24
  const period = h < 12 ? 'AM' : 'PM'
  const display = h % 12 === 0 ? 12 : h % 12
  return `${display} ${period}`
}

/**
 * `7 – 9 AM` when both ends share a period, `11 AM – 1 PM` when they don't.
 */
export function formatHourRange(start: number, end: number): string {
  const startText = formatHour(start)
  const endText = formatHour(end)
  const [startNumber, startPeriod] = startText.split(' ')
  const endPeriod = endText.split(' ')[1]
  return startPeriod === endPeriod
    ? `${startNumber} ${EN_DASH} ${endText}`
    : `${startText} ${EN_DASH} ${endText}`
}

/**
 * `Fri, Aug 1` from a `YYYY-MM-DD` calendar date.
 *
 * Parses through `Date.UTC` and formats with `timeZone: 'UTC'` so the label
 * is the date's own components — formatting in the runtime's local zone
 * would render the previous day for anyone west of UTC.
 */
export function formatDateLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run tests/lib/format.test.ts`
Expected: PASS, all tests.

- [ ] **Step 9: Update the four existing call sites to import the shared helpers**

In `src/lib/booking/hold.ts`: delete the local `function manilaWeekday(...)` and its doc comment, and add `manilaWeekday` to the imports:
```ts
import { manilaWeekday } from '@/lib/date-manila'
```
Leave `manilaInstant` and `sqlStateOf` exactly as they are.

In `src/lib/booking/availability.ts`: delete the local `function manilaWeekday(...)` and its doc comment (lines 52-69), and add:
```ts
import { manilaWeekday } from '@/lib/date-manila'
```

In `src/app/venues/[slug]/actions.ts`: delete `function isRealCalendarDate(...)`, add `import { isValidCalendarDate } from '@/lib/date-manila'`, and rename every call site from `isRealCalendarDate(` to `isValidCalendarDate(`.

In `src/app/venues/[slug]/page.tsx`: delete the local `manilaToday`, `isValidCalendarDate`, `shiftDay` and `formatDateLabel` functions and their doc comments (lines 15-75), and add:
```ts
import { isValidCalendarDate, manilaToday, shiftDay } from '@/lib/date-manila'
import { formatDateLabel } from '@/lib/format'
```

- [ ] **Step 10: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS. The pre-existing suite was 79 tests / 13 files; it should now be larger and still fully green. If a `hold` or `availability` test fails, the helper was transcribed wrong — do not adjust the test.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add src/lib/date-manila.ts src/lib/format.ts tests/lib src/lib/booking/hold.ts src/lib/booking/availability.ts "src/app/venues/[slug]" && git commit -m "refactor: consolidate Manila date helpers, add display formatting"
```

---

## Task 2: `reviews` table

**Files:**
- Create: `supabase/migrations/<timestamp>_reviews.sql` — generate the timestamp with `date -u +%Y%m%d%H%M%S`, so it sorts after `20260801110350_storage_and_cron.sql`
- Create: `tests/schema/reviews.test.ts`

**Interfaces:**
- Consumes: the existing `bookings`, `branches`, `profiles` tables.
- Produces: table `reviews (id, booking_id, branch_id, player_id, rating, body, created_at)`, consumed by Task 5's and Task 6's aggregates.

- [ ] **Step 1: Read an existing schema test for the house pattern**

Read `tests/schema/listings.test.ts` and `tests/schema/bookings.test.ts` in full before writing anything. Match their structure: `db.execute(sql\`...\`)`, fixtures from `tests/helpers/fixtures.ts`, assertions on real Postgres errors by SQLSTATE.

- [ ] **Step 2: Write the failing test**

Create `tests/schema/reviews.test.ts`:

```ts
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@/db'
import { manilaHour, seedBranchWithCourts, seedPlayer } from '../helpers/fixtures'

/** SQLSTATE of a raw pg error, which drizzle wraps in DrizzleQueryError. */
function sqlStateOf(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause
  return (cause as { code?: string })?.code ?? (error as { code?: string })?.code
}

async function seedCompletedBooking() {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const startsAt = manilaHour('2020-01-06', 12)
  const endsAt = manilaHour('2020-01-06', 13)
  const row = await db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
      fee_config_snapshot
    ) values (
      ${courtIds[0]}::uuid, ${branchId}::uuid, ${playerId}::uuid,
      ${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz,
      'completed', 26500, 0, 26500, 2650, 0, 23850, '{}'::jsonb
    )
    returning id
  `)
  return { bookingId: row.rows[0].id as string, branchId, playerId }
}

describe('reviews schema', () => {
  it('accepts a valid review', async () => {
    const { bookingId, branchId, playerId } = await seedCompletedBooking()
    const result = await db.execute(sql`
      insert into reviews (booking_id, branch_id, player_id, rating, body)
      values (${bookingId}::uuid, ${branchId}::uuid, ${playerId}::uuid, 5, 'Great courts')
      returning id, rating, created_at
    `)
    expect(result.rows).toHaveLength(1)
    expect(Number(result.rows[0].rating)).toBe(5)
    expect(result.rows[0].created_at).toBeTruthy()
  })

  it('rejects a rating outside 1-5', async () => {
    const { bookingId, branchId, playerId } = await seedCompletedBooking()
    for (const rating of [0, 6, -1]) {
      await expect(
        db.execute(sql`
          insert into reviews (booking_id, branch_id, player_id, rating)
          values (${bookingId}::uuid, ${branchId}::uuid, ${playerId}::uuid, ${rating})
        `),
      ).rejects.toSatisfy((e: unknown) => sqlStateOf(e) === '23514')
    }
  })

  it('allows only one review per booking', async () => {
    const { bookingId, branchId, playerId } = await seedCompletedBooking()
    await db.execute(sql`
      insert into reviews (booking_id, branch_id, player_id, rating)
      values (${bookingId}::uuid, ${branchId}::uuid, ${playerId}::uuid, 4)
    `)
    await expect(
      db.execute(sql`
        insert into reviews (booking_id, branch_id, player_id, rating)
        values (${bookingId}::uuid, ${branchId}::uuid, ${playerId}::uuid, 3)
      `),
    ).rejects.toSatisfy((e: unknown) => sqlStateOf(e) === '23505')
  })

  it('cascades when the branch is deleted', async () => {
    const { bookingId, playerId } = await seedCompletedBooking()
    // The review's branch_id points at a SECOND, booking-free branch rather
    // than the booking's own branch. That is not a dodge — it is the only
    // way to reach this cascade at all. bookings.branch_id is NO ACTION, so
    // a branch that has bookings cannot be deleted; and reviews.booking_id
    // is NO ACTION, so the booking cannot be deleted first either. The two
    // restrictions form a cycle. In production this cascade is therefore
    // near-unreachable and exists for a future hard-delete/purge path; this
    // test pins the constraint as declared without colliding with the
    // restriction the NEXT test pins.
    const { branchId: emptyBranchId } = await seedBranchWithCourts(0)
    await db.execute(sql`
      insert into reviews (booking_id, branch_id, player_id, rating)
      values (${bookingId}::uuid, ${emptyBranchId}::uuid, ${playerId}::uuid, 4)
    `)
    await db.execute(sql`delete from branches where id = ${emptyBranchId}::uuid`)
    const left = await db.execute(sql`select 1 from reviews where booking_id = ${bookingId}::uuid`)
    expect(left.rows).toHaveLength(0)
  })

  it('blocks deleting a booking that still has a review', async () => {
    const { bookingId, branchId, playerId } = await seedCompletedBooking()
    await db.execute(sql`
      insert into reviews (booking_id, branch_id, player_id, rating)
      values (${bookingId}::uuid, ${branchId}::uuid, ${playerId}::uuid, 4)
    `)
    await expect(
      db.execute(sql`delete from bookings where id = ${bookingId}::uuid`),
    ).rejects.toSatisfy((e: unknown) => sqlStateOf(e) === '23503')
    // Clean up so teardownFixtures() can delete the booking.
    await db.execute(sql`delete from reviews where booking_id = ${bookingId}::uuid`)
  })

  it('has row level security enabled and no policies', async () => {
    const rls = await db.execute(sql`
      select relrowsecurity from pg_class where oid = 'public.reviews'::regclass
    `)
    expect(rls.rows[0].relrowsecurity).toBe(true)

    const policies = await db.execute(sql`
      select policyname from pg_policies where schemaname = 'public' and tablename = 'reviews'
    `)
    expect(policies.rows).toHaveLength(0)
  })

  it('indexes both cascading foreign keys', async () => {
    const indexes = await db.execute(sql`
      select indexdef from pg_indexes where schemaname = 'public' and tablename = 'reviews'
    `)
    const defs = indexes.rows.map((r) => r.indexdef as string).join('\n')
    expect(defs).toContain('(branch_id)')
    expect(defs).toContain('(player_id)')
  })
})
```

Note: the branch-cascade test deletes a fixture branch that `teardownFixtures()` also tracks. That is safe — teardown deletes by `auth.users` id and cascades; a branch already gone is simply not there.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/schema/reviews.test.ts`
Expected: FAIL — `42P01 relation "reviews" does not exist`.

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/<timestamp>_reviews.sql`:

```sql
-- Read-only in this slice: the public browse pages aggregate ratings and
-- render review text. The write path (leaving a review after a completed
-- booking) belongs to the player dashboard slice.
--
-- booking_id is UNIQUE, which both enforces one review per booking and gives
-- that FK its required index for free.
--
-- FK delete behavior deliberately mirrors bookings: booking_id is NO ACTION
-- because a booking is a financial record that must not vanish, while
-- branch_id and player_id CASCADE like every table above them. Consequence:
-- deleting a booking that has a review raises 23503. Pinned by a test.
--
-- branch_id is denormalized off booking -> court -> branch because every read
-- in this slice aggregates by branch.
--
-- No denormalized rating column on branches: the aggregate is cheap at this
-- scale, and a cached column needs trigger machinery this slice would not test.
create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings (id),
  branch_id uuid not null references branches (id) on delete cascade,
  player_id uuid not null references profiles (id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  body text,
  created_at timestamptz not null default now()
);

create index if not exists reviews_branch_id_idx on reviews (branch_id);
create index if not exists reviews_player_id_idx on reviews (player_id);

-- Deny-by-default, like every other table: the publishable key ships in the
-- browser and must never reach this table. Do NOT add policies, and do NOT
-- use `force row level security` (it would subject the owner role to those
-- non-existent policies and break the app).
alter table reviews enable row level security;
```

No explicit `revoke` is needed — Task 3 of the foundation branch set default privileges for role `postgres` in schema `public`, so this table inherits the revoke. The lockdown suite verifies it.

- [ ] **Step 5: Apply the migration**

```bash
npx supabase db push --db-url "$DATABASE_URL"
```
Expected: the new migration applies cleanly.

- [ ] **Step 6: Prove idempotency by applying twice**

```bash
npx supabase db push --db-url "$DATABASE_URL"
```
Expected: no error. (`supabase db reset` is unavailable on a hosted project, so double-apply is how idempotency is proven here.)

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/schema/reviews.test.ts`
Expected: PASS, all tests.

- [ ] **Step 8: Confirm the lockdown suite picked up the new table automatically**

Run: `npx vitest run tests/security/data-api-lockdown.test.ts`
Expected: PASS. Read the test output and confirm `reviews` appears in the enumerated table list. If the suite hardcodes a table list rather than enumerating `pg_tables`, add `reviews` to it — but prefer fixing it to enumerate.

- [ ] **Step 9: Fix `teardownFixtures` for the new FK**

**This step is mandatory and blocks Tasks 5 and 6.** `tests/helpers/fixtures.ts`'s `teardownFixtures()` deletes bookings, then `auth.users`. It never deletes reviews. Because `reviews.booking_id` is `NO ACTION`, `delete from bookings` now raises `23503` for any test that created a review — teardown throws, `auth.users` is never deleted, and every row that run created leaks into the shared database permanently.

Add a reviews delete before the bookings delete, selecting by exactly the same tracked-id criteria so it can still never touch a row this run did not create:

```ts
  // Must precede the bookings delete: reviews.booking_id is NO ACTION
  // (a booking is a financial record), so a surviving review blocks its
  // booking's deletion with 23503 — which would abort teardown and leak
  // every row this run created into the shared, persistent database.
  await db.execute(sql`
    delete from reviews
    where player_id = any (${sql.param(ids)}::uuid[])
       or branch_id in (
         select id from branches where owner_id = any (${sql.param(ids)}::uuid[])
       )
       or booking_id in (
         select id from bookings
         where player_id = any (${sql.param(ids)}::uuid[])
            or branch_id in (
              select id from branches where owner_id = any (${sql.param(ids)}::uuid[])
            )
       )
  `)
```

The third disjunct (`booking_id in (...)`) is defensive, not currently load-bearing — be honest about this rather than inventing a justification. Every review that actually survives to teardown today is already caught by the `player_id` disjunct, and the cascade test's review is removed by the branch cascade inside the test itself, before teardown ever runs. Keep the disjunct anyway: it costs nothing and covers a future test whose review has a tracked *booking* but an untracked `player_id`/`branch_id`.

- [ ] **Step 10: Prove teardown actually cleans up**

Run the reviews test file twice in a row:

Run: `npx vitest run tests/schema/reviews.test.ts && npx vitest run tests/schema/reviews.test.ts`
Expected: PASS both times, with no `afterAll` error on either run.

Then confirm nothing leaked:
```bash
/opt/homebrew/opt/libpq/bin/psql "$DATABASE_URL" -c "select count(*) from reviews;"
```
Expected: the same count before and after a run. A growing count means teardown is still broken.

- [ ] **Step 11: Commit**

```bash
git add supabase/migrations tests/schema/reviews.test.ts tests/helpers/fixtures.ts && git commit -m "feat: add reviews table"
```

---

## Task 3: Expand the seed to 3 owners, ~10 branches, ~30 courts

**Files:**
- Modify: `supabase/seed.sql`

**Interfaces:**
- Consumes: the `reviews` table from Task 2.
- Produces: branch slugs and city values that Task 5's `cities.ts` must match, and that Tasks 8-12 render.

**Hard constraints on this task:**

1. **Every statement idempotent.** `on conflict ... do nothing` on inserts; guarded `update`s. The file may run more than once against a shared, persistent database.
2. **Deterministic UUIDs that collide with nothing.** Taken: `aaaa…`/`bbbb…`/`cccc…` (the existing `smash-zone-marikina` seed) and `1111…`/`2222…`/`3333…` (the `task9-*` fixtures). This task uses the prefixes `d`, `e`, and `f` — e.g. owners `dddddddd-dddd-dddd-dddd-ddddddddddd1`, branches `eeeeeeee-…`, courts `ffffffff-…`. Read the existing `supabase/seed.sql` header before writing: it documents exactly why a collision here silently no-ops instead of erroring.
3. **Do not modify the existing `smash-zone-marikina` rows.** It stays as the tenth branch, owned by its existing owner.
4. **Real Metro Manila coordinates**, one per city, so `ST_DWithin` and distance ordering produce believable results instead of a cluster on one point.

- [ ] **Step 1: Read the existing seed in full**

Read `supabase/seed.sql`. Note the `on conflict (id) do nothing` pattern, the `DO $$` block for courts, and — critically — that the loop variable is named `v_court_id`, not `court_id`. A plpgsql loop variable named `court_id` collides with the column in `on conflict (court_id, day_of_week)` and fails with `42702 column reference "court_id" is ambiguous`.

- [ ] **Step 2: Append the owner rows**

Owners need `auth.users` rows first — the `on_auth_user_created` trigger creates the matching `profiles` row, which the `update` below then promotes.

```sql
-- ---------------------------------------------------------------------------
-- Public browse demo content: 3 owners -> 9 branches -> ~27 courts, joining
-- the pre-existing Smash Zone owner/branch for 10 branches total.
--
-- Id prefixes 'd'/'e'/'f' are chosen to avoid two existing occupants of this
-- shared, persistent database: 'a'/'b'/'c' (the Smash Zone seed above) and
-- '1'/'2'/'3' (Task 9's hand-seeded verification fixtures). A collision here
-- would silently no-op against `on conflict (id) do nothing` rather than
-- error, so the wrong id produces missing data, not a failed seed.
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data) values
  ('dddddddd-dddd-dddd-dddd-ddddddddddd1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'rally@oncourt.test',
   '{"full_name": "Rally Republic"}'::jsonb),
  ('dddddddd-dddd-dddd-dddd-ddddddddddd2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dinkhaus@oncourt.test',
   '{"full_name": "Dink Haus"}'::jsonb),
  ('dddddddd-dddd-dddd-dddd-ddddddddddd3', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'kitchen@oncourt.test',
   '{"full_name": "The Kitchen MNL"}'::jsonb)
on conflict (id) do nothing;

update profiles set role = 'owner', business_name = 'Rally Republic',
       slug = 'rally-republic', phone = '+639170000001'
where id = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';

update profiles set role = 'owner', business_name = 'Dink Haus',
       slug = 'dink-haus', phone = '+639170000002'
where id = 'dddddddd-dddd-dddd-dddd-ddddddddddd2';

update profiles set role = 'owner', business_name = 'The Kitchen MNL',
       slug = 'the-kitchen-mnl', phone = '+639170000003'
where id = 'dddddddd-dddd-dddd-dddd-ddddddddddd3';
```

- [ ] **Step 3: Append the branch rows**

Nine branches: Rally Republic gets 4, Dink Haus 3, The Kitchen MNL 2. Amenities are drawn from a fixed vocabulary — `parking`, `showers`, `rentals`, `aircon`, `pro-shop`, `cafe`, `lockers`, `night-lights` — so filters have both matching and non-matching rows.

```sql
insert into branches (id, owner_id, name, slug, description, address, city, location, amenities) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', 'dddddddd-dddd-dddd-dddd-ddddddddddd1',
   'Rally Republic – Quezon City', 'rally-republic-quezon-city',
   'Four indoor courts with aircon and a pro shop, right off Tomas Morato.',
   '88 Tomas Morato Ave', 'Quezon City',
   st_setsrid(st_makepoint(121.0437, 14.6760), 4326)::geography,
   array['parking', 'aircon', 'pro-shop', 'lockers']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2', 'dddddddd-dddd-dddd-dddd-ddddddddddd1',
   'Rally Republic – Makati', 'rally-republic-makati',
   'Two indoor courts in Poblacion. Walk-ins welcome after 9 PM.',
   '5 Kalayaan Ave', 'Makati',
   st_setsrid(st_makepoint(121.0244, 14.5547), 4326)::geography,
   array['aircon', 'showers', 'cafe']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3', 'dddddddd-dddd-dddd-dddd-ddddddddddd1',
   'Rally Republic – Pasig', 'rally-republic-pasig',
   'Three courts beside Kapitolyo. Free parking on weekends.',
   '21 East Capitol Dr', 'Pasig',
   st_setsrid(st_makepoint(121.0851, 14.5764), 4326)::geography,
   array['parking', 'rentals', 'cafe']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee4', 'dddddddd-dddd-dddd-dddd-ddddddddddd1',
   'Rally Republic – Taguig', 'rally-republic-taguig',
   'Rooftop courts in BGC with night lights.',
   '32 8th Ave, BGC', 'Taguig',
   st_setsrid(st_makepoint(121.0509, 14.5176), 4326)::geography,
   array['night-lights', 'showers', 'lockers']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee5', 'dddddddd-dddd-dddd-dddd-ddddddddddd2',
   'Dink Haus – Mandaluyong', 'dink-haus-mandaluyong',
   'Warehouse conversion with three cushioned indoor courts.',
   '14 Shaw Blvd', 'Mandaluyong',
   st_setsrid(st_makepoint(121.0359, 14.5794), 4326)::geography,
   array['parking', 'aircon', 'rentals', 'showers']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee6', 'dddddddd-dddd-dddd-dddd-ddddddddddd2',
   'Dink Haus – San Juan', 'dink-haus-san-juan',
   'Two courts near Greenhills. Paddle rentals included.',
   '9 Ortigas Ave', 'San Juan',
   st_setsrid(st_makepoint(121.0355, 14.6019), 4326)::geography,
   array['rentals', 'cafe']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee7', 'dddddddd-dddd-dddd-dddd-ddddddddddd2',
   'Dink Haus – Parañaque', 'dink-haus-paranaque',
   'Covered outdoor courts near BF Homes.',
   '77 Aguirre Ave', 'Parañaque',
   st_setsrid(st_makepoint(121.0198, 14.4793), 4326)::geography,
   array['parking', 'night-lights']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee8', 'dddddddd-dddd-dddd-dddd-ddddddddddd3',
   'The Kitchen MNL – Caloocan', 'the-kitchen-mnl-caloocan',
   'Three outdoor courts with night lights and a canteen.',
   '4 Samson Rd', 'Caloocan',
   st_setsrid(st_makepoint(120.9676, 14.6507), 4326)::geography,
   array['parking', 'night-lights', 'cafe']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee9', 'dddddddd-dddd-dddd-dddd-ddddddddddd3',
   'The Kitchen MNL – Marikina', 'the-kitchen-mnl-marikina',
   'Two indoor courts along the riverbanks.',
   '3 J.P. Rizal St', 'Marikina',
   st_setsrid(st_makepoint(121.0980, 14.6350), 4326)::geography,
   array['parking', 'showers', 'lockers'])
on conflict (id) do nothing;
```

- [ ] **Step 4: Append the court / rate band / operating hour block**

One `DO $$` block, driven by an array of `(branch_id, court_count, environment, base_price)` tuples. Court ids are derived deterministically from the branch prefix so re-running is a no-op.

```sql
do $$
declare
  specs jsonb := '[
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1", "prefix": "ffffffff-ffff-ffff-ffff-f0000000000", "courts": 4, "env": "indoor",  "base": 32000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2", "prefix": "ffffffff-ffff-ffff-ffff-f1000000000", "courts": 2, "env": "indoor",  "base": 38000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3", "prefix": "ffffffff-ffff-ffff-ffff-f2000000000", "courts": 3, "env": "indoor",  "base": 28000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee4", "prefix": "ffffffff-ffff-ffff-ffff-f3000000000", "courts": 2, "env": "outdoor", "base": 30000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee5", "prefix": "ffffffff-ffff-ffff-ffff-f4000000000", "courts": 3, "env": "indoor",  "base": 34000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee6", "prefix": "ffffffff-ffff-ffff-ffff-f5000000000", "courts": 2, "env": "indoor",  "base": 30000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee7", "prefix": "ffffffff-ffff-ffff-ffff-f6000000000", "courts": 3, "env": "outdoor", "base": 22000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee8", "prefix": "ffffffff-ffff-ffff-ffff-f7000000000", "courts": 3, "env": "outdoor", "base": 20000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee9", "prefix": "ffffffff-ffff-ffff-ffff-f8000000000", "courts": 2, "env": "indoor",  "base": 26000}
  ]'::jsonb;
  spec jsonb;
  -- NOT named court_id: a plpgsql variable of that name collides with the
  -- column in `on conflict (court_id, day_of_week)` and raises 42702
  -- "column reference is ambiguous". Same trap the block above documents.
  v_court_id uuid;
  idx integer;
  day integer;
  base integer;
begin
  for spec in select * from jsonb_array_elements(specs) loop
    base := (spec->>'base')::integer;
    for idx in 1..(spec->>'courts')::integer loop
      v_court_id := ((spec->>'prefix') || idx::text)::uuid;

      insert into courts (id, branch_id, name, environment, status)
      values (v_court_id, (spec->>'branch')::uuid, 'Court ' || idx,
              (spec->>'env')::court_environment, 'approved')
      on conflict (id) do nothing;

      -- Off-peak / mid / peak. Bands must not overlap
      -- (court_rate_bands_no_overlap is a GiST exclusion constraint) and
      -- end_hour <= 24.
      insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos) values
        (v_court_id,  7, 15, base),
        (v_court_id, 15, 18, base + 5000),
        (v_court_id, 18, 23, base + 9000)
      on conflict do nothing;

      for day in 0..6 loop
        insert into court_operating_hours (court_id, day_of_week, opens_hour, closes_hour)
        values (v_court_id, day, 7, 23)
        on conflict (court_id, day_of_week) do nothing;
      end loop;
    end loop;
  end loop;
end $$;
```

- [ ] **Step 5: Append seeded players, completed bookings, and reviews**

Ratings must vary across branches so the `rating` sort is exercised. Bookings are in the past with `status = 'completed'`, so they need no `expires_at` and never block a live booking.

```sql
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data) values
  ('dddddddd-dddd-dddd-dddd-dddddddddde1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'mika@oncourt.test', '{"full_name": "Mika Reyes"}'::jsonb),
  ('dddddddd-dddd-dddd-dddd-dddddddddde2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'jomar@oncourt.test', '{"full_name": "Jomar Cruz"}'::jsonb),
  ('dddddddd-dddd-dddd-dddd-dddddddddde3', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ash@oncourt.test', '{"full_name": "Ash Villanueva"}'::jsonb)
on conflict (id) do nothing;

-- One completed booking + review per (branch, player), placed on distinct
-- past hours so bookings_no_overlap can never fire. Booking ids are derived
-- deterministically from the branch and player index, so re-running no-ops.
do $$
declare
  players uuid[] := array[
    'dddddddd-dddd-dddd-dddd-dddddddddde1',
    'dddddddd-dddd-dddd-dddd-dddddddddde2',
    'dddddddd-dddd-dddd-dddd-dddddddddde3'
  ];
  ratings jsonb := '{
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1": [5, 5, 4],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2": [4, 5],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3": [4, 4, 3],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee4": [5],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee5": [5, 4, 5],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee6": [3, 4],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee7": [4],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee8": [3, 3],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee9": [5, 4]
  }'::jsonb;
  bodies text[] := array[
    'Malinis ang courts and the lights are great at night.',
    'Booked last minute, walang hassle. Balik kami next week.',
    'Solid surface, friendly staff. Parking fills up fast though.'
  ];
  v_branch text;
  v_ratings jsonb;
  v_court_id uuid;
  v_player uuid;
  v_booking_id uuid;
  v_starts timestamptz;
  i integer;
begin
  for v_branch, v_ratings in select key, value from jsonb_each(ratings) loop
    select id into v_court_id from courts
      where branch_id = v_branch::uuid and status = 'approved'
      order by name limit 1;

    for i in 0..jsonb_array_length(v_ratings) - 1 loop
      v_player := players[i + 1];
      v_booking_id := md5(v_branch || v_player::text)::uuid;
      v_starts := timestamptz '2026-06-01 12:00:00+08' + (i || ' days')::interval;

      insert into bookings (
        id, court_id, branch_id, player_id, starts_at, ends_at, status,
        court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
        platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
        fee_config_snapshot
      ) values (
        v_booking_id, v_court_id, v_branch::uuid, v_player,
        v_starts, v_starts + interval '1 hour', 'completed',
        30000, 0, 30000, 3000, 0, 27000, '{"seed": true}'::jsonb
      ) on conflict (id) do nothing;

      insert into reviews (booking_id, branch_id, player_id, rating, body)
      values (v_booking_id, v_branch::uuid, v_player,
              (v_ratings->>i)::smallint, bodies[i + 1])
      on conflict (booking_id) do nothing;
    end loop;
  end loop;
end $$;
```

- [ ] **Step 6: Apply the seed**

```bash
psql "$DATABASE_URL" -f supabase/seed.sql
```
Expected: no errors. If `psql` is unavailable, run it through `npx supabase db push` is **not** correct — seeds are not migrations. Use `psql`, or a short `tsx` script that reads the file and calls `db.execute(sql.raw(...))`.

- [ ] **Step 7: Apply the seed a second time to prove idempotency**

```bash
psql "$DATABASE_URL" -f supabase/seed.sql
```
Expected: no errors, and no duplicate rows.

- [ ] **Step 8: Verify the shape of what landed**

```bash
psql "$DATABASE_URL" -c "select count(*) as branches from branches; select count(*) as approved_courts from courts where status = 'approved'; select count(*) as reviews from reviews; select b.city, count(*) from branches b group by 1 order by 1;"
```
Expected: at least 10 branches, ~30 approved courts, ~20 reviews, and cities spread across Quezon City / Makati / Pasig / Taguig / Mandaluyong / San Juan / Parañaque / Caloocan / Marikina. Record the actual numbers — Task 5's tests must not hardcode them, but a wildly different count means the seed misfired.

- [ ] **Step 9: Confirm the pre-existing fixtures are untouched**

```bash
psql "$DATABASE_URL" -c "select slug from branches where slug in ('smash-zone-marikina', 'task9-verify-smash-zone');"
```
Expected: both rows still present.

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS. The new rows must not break any existing test — if one now fails because it assumed a branch count, that test was over-specified and should assert a property rather than a count.

- [ ] **Step 11: Commit**

```bash
git add supabase/seed.sql && git commit -m "feat: seed 3 owners, 9 branches, courts, bookings and reviews"
```

---

## Task 4: Storage photo URLs and the photo seeding script

**Files:**
- Create: `src/lib/photos.ts`
- Create: `tests/lib/photos.test.ts`
- Create: `scripts/seed-photos.ts`
- Modify: `package.json` (add a `seed:photos` script)

**Interfaces:**
- Consumes: `branches` / `courts` rows from Task 3.
- Produces:
  ```ts
  export type PhotoBucket = 'branch-photos' | 'court-photos'
  export function photoUrl(bucket: PhotoBucket, storagePath: string | null | undefined): string | null
  ```
  Returns `null` when there is no path, so callers render a placeholder rather than a broken image.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/photos.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { photoUrl } from '@/lib/photos'

describe('photoUrl', () => {
  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  })

  it('builds a public object URL', () => {
    expect(photoUrl('branch-photos', 'branches/abc/1.jpg')).toBe(
      'https://example.supabase.co/storage/v1/object/public/branch-photos/branches/abc/1.jpg',
    )
  })

  it('tolerates a trailing slash on the base URL', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co/'
    expect(photoUrl('court-photos', 'courts/x/1.jpg')).toBe(
      'https://example.supabase.co/storage/v1/object/public/court-photos/courts/x/1.jpg',
    )
  })

  it('returns null when there is no path', () => {
    expect(photoUrl('branch-photos', null)).toBeNull()
    expect(photoUrl('branch-photos', undefined)).toBeNull()
    expect(photoUrl('branch-photos', '')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/photos.test.ts`
Expected: FAIL — "Failed to resolve import '@/lib/photos'".

- [ ] **Step 3: Implement `src/lib/photos.ts`**

```ts
/**
 * Public URLs for objects in the `branch-photos` and `court-photos` buckets.
 *
 * Both buckets are created `public` (supabase/migrations/*_storage_and_cron.sql),
 * so the URL is deterministic and needs no client, no signing, and no round
 * trip. Built by hand rather than through supabase-js's
 * `storage.from(b).getPublicUrl(p)` so this module stays importable from a
 * Server Component without instantiating a client.
 *
 * NEXT_PUBLIC_SUPABASE_URL is deliberately the public env var: these URLs end
 * up in <img src> and are meant to be fetched by the browser.
 */

export type PhotoBucket = 'branch-photos' | 'court-photos'

export function photoUrl(
  bucket: PhotoBucket,
  storagePath: string | null | undefined,
): string | null {
  if (!storagePath) return null
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  return `${base.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/${storagePath}`
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/photos.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the photo seeding script**

Create `scripts/seed-photos.ts`. This is a development utility, not application code — it uses the **secret** key and must never be imported by anything under `src/app`.

```ts
/**
 * Downloads a fixed set of pickleball/court photos and uploads them into the
 * public `branch-photos` bucket, then upserts the matching `branch_photos`
 * rows.
 *
 * Photo rows are created HERE rather than in supabase/seed.sql on purpose: a
 * branch_photos row whose storage object does not exist renders as a broken
 * image, so the row is only written after the upload succeeds.
 *
 * Idempotent: `upsert: true` on the storage write, and `on conflict do
 * nothing` keyed on (branch_id, storage_path) for the row. Re-running is a
 * no-op.
 *
 * Run with: npm run seed:photos
 */
import { loadEnvFile } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { sql } from 'drizzle-orm'

loadEnvFile('.env.local')

// Do NOT import `@/db` / `src/db/index.ts` here. That module imports
// `server-only`, which resolves to a module that throws outside Next's
// `react-server` condition — and "fixing" that with
// `tsx --conditions=react-server` is a trap: it is a PROCESS-WIDE Node
// resolution condition, not a scoped alias like the one in
// `vitest.config.ts`. It silently changes resolution for every package
// shipping a `react-server` export (React's react-server build has no
// `useState` at all), so it works only by accident of the current import
// graph. This script is a dev utility, not application code — give it its
// own standalone `pg` Pool from DATABASE_URL and the problem disappears at
// the root. `loadEnvFile('.env.local')` must stay the first top-level
// statement, and call `pool.end()` on both success and failure paths.

// design/branding.md, Photography: real court/gameplay photos, Unsplash free
// tier, hotlinked with ?q=70&w=<size>&auto=format&fit=crop. Prefer shots
// where the court is visible.
const SOURCES = [
  'https://images.unsplash.com/photo-1626224583764-f87db24ac4ea',
  'https://images.unsplash.com/photo-1554068865-24cecd4e34b8',
  'https://images.unsplash.com/photo-1693142518820-78d7a05f1546',
  'https://images.unsplash.com/photo-1595435934249-5df7ed86e1c0',
  'https://images.unsplash.com/photo-1756477558468-b3e485757470',
  'https://images.unsplash.com/photo-1747027694225-cbf12dd20826',
]
// NOTE: three of the originally-planned photo ids were off-brand on
// inspection (a badminton racket close-up with no court, a basketball on a
// basketball court, and a road-cycling peloton). branding.md requires real
// court/gameplay photos where the court is visible, so they were replaced
// with verified pickleball shots. Inspect any future substitution visually
// — a 200 response only proves the URL resolves, not that the image is
// on-brand.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } },
)

async function main() {
  const branches = await db.execute(sql`select id, slug from branches order by slug`)
  console.log(`seeding photos for ${branches.rows.length} branches`)

  for (const [branchIndex, branch] of branches.rows.entries()) {
    const branchId = branch.id as string

    // Three photos per branch, rotating through the source list so no two
    // adjacent branches share a cover.
    for (let n = 0; n < 3; n++) {
      const source = SOURCES[(branchIndex * 3 + n) % SOURCES.length]
      const url = `${source}?q=70&w=1200&auto=format&fit=crop`
      const storagePath = `branches/${branchId}/${n + 1}.jpg`

      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`failed to download ${url}: ${response.status}`)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())

      const { error } = await supabase.storage
        .from('branch-photos')
        .upload(storagePath, bytes, { contentType: 'image/jpeg', upsert: true })
      if (error) throw error

      await db.execute(sql`
        insert into branch_photos (branch_id, storage_path, sort_order)
        select ${branchId}::uuid, ${storagePath}, ${n}
        where not exists (
          select 1 from branch_photos
          where branch_id = ${branchId}::uuid and storage_path = ${storagePath}
        )
      `)
      console.log(`  ${branch.slug} <- ${storagePath}`)
    }
  }

  console.log('done')
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
```

`branch_photos` has no unique constraint on `(branch_id, storage_path)`, which is why the insert uses a `where not exists` guard rather than `on conflict` — do not add a constraint just for this script.

- [ ] **Step 6: Add the npm script**

In `package.json`, under `"scripts"`:

```json
"seed:photos": "tsx scripts/seed-photos.ts"
```

- [ ] **Step 7: Confirm the secret key env var name**

Read `.env.local.example`. If the secret key is named something other than `SUPABASE_SECRET_KEY`, use the real name in the script. Do not print the key's value at any point.

- [ ] **Step 8: Run the script**

Run: `npm run seed:photos`
Expected: three lines per branch, then `done`.

- [ ] **Step 9: Run it a second time to prove idempotency**

Run: `npm run seed:photos`
Expected: same output, and no duplicate rows:
```bash
psql "$DATABASE_URL" -c "select branch_id, count(*) from branch_photos group by 1 having count(*) <> 3;"
```
Expected: zero rows.

- [ ] **Step 10: Verify one URL actually resolves**

Take one `storage_path` from the query above, build its URL by hand, and fetch it:
```bash
curl -sS -o /dev/null -w "%{http_code} %{content_type}\n" "<NEXT_PUBLIC_SUPABASE_URL>/storage/v1/object/public/branch-photos/<storage_path>"
```
Expected: `200 image/jpeg`. Anything else means the bucket is not actually public or the path is wrong — fix it now, not when a page renders a broken image.

- [ ] **Step 11: Commit**

```bash
git add src/lib/photos.ts tests/lib/photos.test.ts scripts/seed-photos.ts package.json && git commit -m "feat: add storage photo URLs and photo seeding script"
```

---

## Task 5: Cities lookup and `searchBranches`

The heaviest query in the slice. It gets its own task because a reviewer could reasonably approve the cities module and reject the SQL, or vice versa.

**Files:**
- Create: `src/lib/geo/cities.ts`
- Create: `src/lib/branches/queries.ts`
- Create: `tests/branches/search.test.ts`

**Interfaces:**
- Consumes: `reviews` (Task 2), the seeded branches (Task 3), `photoUrl` (Task 4).
- Produces:
  ```ts
  // src/lib/geo/cities.ts
  export type City = { slug: string; name: string; lat: number; lng: number }
  export const CITIES: readonly City[]
  export const DEFAULT_CITY_SLUG = 'metro-manila'
  export function cityBySlug(slug: string | null | undefined): City

  // src/lib/branches/queries.ts
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
  }

  export type SearchFilters = {
    lat: number
    lng: number
    radiusMeters?: number          // default 25000
    date?: string                  // YYYY-MM-DD, required when hour is set
    hour?: number                  // 0-23
    environment?: 'indoor' | 'outdoor'
    maxPriceCentavos?: number
    amenities?: string[]
    sort?: 'distance' | 'price' | 'rating'
    limit?: number                 // default 50
  }

  export async function searchBranches(filters: SearchFilters): Promise<BranchSummary[]>
  ```

- [ ] **Step 1: Write `src/lib/geo/cities.ts`**

```ts
/**
 * The cities the seed actually places branches in, each with a centroid.
 *
 * A hardcoded table rather than a geocoder on purpose: no API key, no rate
 * limit, no usage policy to honor, no network failure mode, and — because
 * every entry corresponds to real seeded branches — no option in the picker
 * that returns nothing. If a branch is ever created in a city not listed
 * here, the city picker simply will not offer it; the branch is still
 * reachable through the region-wide default and through its own URL.
 */

export type City = { slug: string; name: string; lat: number; lng: number }

/** Region-wide default. Roughly the geographic middle of Metro Manila. */
export const DEFAULT_CITY_SLUG = 'metro-manila'

export const CITIES: readonly City[] = [
  { slug: 'metro-manila', name: 'All of Metro Manila', lat: 14.5995, lng: 121.0359 },
  { slug: 'quezon-city', name: 'Quezon City', lat: 14.676, lng: 121.0437 },
  { slug: 'makati', name: 'Makati', lat: 14.5547, lng: 121.0244 },
  { slug: 'pasig', name: 'Pasig', lat: 14.5764, lng: 121.0851 },
  { slug: 'taguig', name: 'Taguig', lat: 14.5176, lng: 121.0509 },
  { slug: 'mandaluyong', name: 'Mandaluyong', lat: 14.5794, lng: 121.0359 },
  { slug: 'san-juan', name: 'San Juan', lat: 14.6019, lng: 121.0355 },
  { slug: 'marikina', name: 'Marikina', lat: 14.6507, lng: 121.1029 },
  { slug: 'paranaque', name: 'Parañaque', lat: 14.4793, lng: 121.0198 },
  { slug: 'caloocan', name: 'Caloocan', lat: 14.6507, lng: 120.9676 },
] as const

/** Falls back to the region-wide default for an unknown or missing slug. */
export function cityBySlug(slug: string | null | undefined): City {
  return (
    CITIES.find((city) => city.slug === slug) ??
    CITIES.find((city) => city.slug === DEFAULT_CITY_SLUG)!
  )
}
```

The region-wide default pairs with a larger radius at the call site (Task 9 uses 30 km for `metro-manila`, 12 km for a specific city) — `cities.ts` itself holds no radius.

- [ ] **Step 2: Write the failing test**

Create `tests/branches/search.test.ts`. It seeds its own fixtures rather than asserting on the demo seed, so it stays correct if the seed changes.

```ts
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@/db'
import { searchBranches } from '@/lib/branches/queries'
import { seedPlayer } from '../helpers/fixtures'

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

/**
 * A branch at an exact point with one approved court, given rate bands and
 * all-week operating hours. Returns ids so the test can assert on its own
 * rows only — this database is shared and full of other branches.
 */
async function seedBranchAt(options: {
  lat: number
  lng: number
  environment?: 'indoor' | 'outdoor'
  priceCentavos?: number
  amenities?: string[]
  opensHour?: number
  closesHour?: number
}) {
  const ownerId = await seedPlayer()
  await db.execute(sql`update profiles set role = 'owner' where id = ${ownerId}::uuid`)
  const slug = 'search-fixture-' + crypto.randomUUID()
  const branch = await db.execute(sql`
    insert into branches (owner_id, name, slug, address, city, location, amenities)
    values (${ownerId}::uuid, 'Search Fixture', ${slug}, '1 Test St', 'Marikina',
            st_setsrid(st_makepoint(${options.lng}, ${options.lat}), 4326)::geography,
            ${sql.param(options.amenities ?? [])}::text[])
    returning id
  `)
  const branchId = branch.rows[0].id as string

  const court = await db.execute(sql`
    insert into courts (branch_id, name, environment, status)
    values (${branchId}::uuid, 'Court 1', ${options.environment ?? 'indoor'}::court_environment, 'approved')
    returning id
  `)
  const courtId = court.rows[0].id as string

  await db.execute(sql`
    insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
    values (${courtId}::uuid, 7, 23, ${options.priceCentavos ?? 30000})
  `)
  for (let day = 0; day <= 6; day++) {
    await db.execute(sql`
      insert into court_operating_hours (court_id, day_of_week, opens_hour, closes_hour)
      values (${courtId}::uuid, ${day}, ${options.opensHour ?? 7}, ${options.closesHour ?? 23})
    `)
  }
  return { branchId, courtId, slug }
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/branches/search.test.ts`
Expected: FAIL — "Failed to resolve import '@/lib/branches/queries'".

- [ ] **Step 4: Implement `searchBranches`**

Create `src/lib/branches/queries.ts`:

```ts
import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import { manilaWeekday } from '@/lib/date-manila'

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
 */
export async function searchBranches(filters: SearchFilters): Promise<BranchSummary[]> {
  const radius = filters.radiusMeters ?? DEFAULT_RADIUS_METERS
  const limit = filters.limit ?? DEFAULT_LIMIT
  const point = sql`st_setsrid(st_makepoint(${filters.lng}, ${filters.lat}), 4326)::geography`

  const conditions: SQL[] = [
    sql`b.location is not null`,
    sql`st_dwithin(b.location, ${point}, ${radius})`,
  ]

  // Scopes `approved_courts` ITSELF to the requested environment, rather
  // than filtering branches with a separate EXISTS check afterward. This
  // makes `branch_agg`'s court_count/min_price_centavos naturally
  // environment-scoped: an `environment: 'outdoor'` search reports the
  // cheapest *outdoor* court's price, not the branch's cheapest overall.
  //
  // Do NOT revert this to a bare `courts` EXISTS. That form lets
  // `min_price_centavos` leak in from a differently-environmented court:
  // a branch with an indoor court at ₱50 and an outdoor court at ₱500
  // reports ₱50 AND passes a `maxPriceCentavos: 100` filter, so an
  // "outdoor under ₱100" search returns a branch whose only outdoor court
  // costs ₱500 — the result set does not satisfy the caller's filter.
  // Pinned by "scopes courtCount/minPriceCentavos to the environment
  // filter" in tests/branches/search.test.ts.
  //
  // With this in place no separate environment condition is needed: the
  // inner `join branch_agg` already excludes any branch with no priced
  // court of that environment.
  const environmentFilter = filters.environment
    ? sql`and c.environment = ${filters.environment}::court_environment`
    : sql``

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
              bk.status in ('confirmed', 'completed')
              or (bk.status = 'pending_payment' and bk.expires_at > now())
            )
        )
    )`)
  }

  const orderBy =
    filters.sort === 'price'
      ? sql`ba.min_price_centavos asc`
      : filters.sort === 'rating'
        ? sql`r.rating_avg desc nulls last, r.rating_count desc`
        : sql`distance_meters asc nulls last`

  const result = await db.execute(sql`
    with approved_courts as (
      select c.id, c.branch_id, c.environment,
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
    select b.id, b.slug, b.name, b.city, b.address, b.amenities,
           ba.court_count, ba.min_price_centavos,
           st_distance(b.location, ${point})::float8 as distance_meters,
           r.rating_avg, r.rating_count,
           p.storage_path as cover_photo_path
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
  `)

  return result.rows.map(toSummary)
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/branches/search.test.ts`
Expected: PASS, all tests.

If the amenities test fails with `42883`, the `sql.param` wrapper was dropped — a bare array is expanded by drizzle into a parenthesized parameter list, not bound as a Postgres array.

- [ ] **Step 6: Print the generated SQL once and read it**

Temporarily add, just before the `await db.execute(...)`:
```ts
const query = sql`...`  // the same template
console.log(db.dialect?.sqlToQuery?.(query))
```
or run a one-off `tsx` script that builds the query and logs it. Confirm with your own eyes that:
- the amenities parameter appears as **one** parameter whose value is an array, not `($1, $2)`
- `st_dwithin` receives the point expression inline, not a stringified object

Then remove the logging. `docs/foundation-review-notes.md` documents five cases where a confident comment outran the code; this step is the antidote.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/geo src/lib/branches tests/branches && git commit -m "feat: add city lookup and branch search query"
```

---

## Task 6: Branch detail, owner profile, and home queries

**Files:**
- Modify: `src/lib/branches/queries.ts`
- Create: `tests/branches/detail.test.ts`

**Interfaces:**
- Consumes: `BranchSummary`, `toSummary` from Task 5.
- Produces:
  ```ts
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
    cities: { city: string; branchCount: number }[]
    openNowCount: number
  }

  export async function getBranchDetail(slug: string): Promise<BranchDetail | null>
  export async function getOwnerProfile(slug: string): Promise<OwnerProfile | null>
  export async function getHomeData(): Promise<HomeData>
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/branches/detail.test.ts`:

```ts
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '@/db'
import { getBranchDetail, getHomeData, getOwnerProfile } from '@/lib/branches/queries'
import { seedPlayer } from '../helpers/fixtures'

async function seedOwnerWithBranches(branchCount: number) {
  const ownerId = await seedPlayer()
  const ownerSlug = 'owner-fixture-' + crypto.randomUUID()
  await db.execute(sql`
    update profiles
    set role = 'owner', business_name = 'Fixture Courts', slug = ${ownerSlug}
    where id = ${ownerId}::uuid
  `)

  const branchSlugs: string[] = []
  const branchIds: string[] = []
  for (let i = 0; i < branchCount; i++) {
    const slug = 'detail-fixture-' + crypto.randomUUID()
    const branch = await db.execute(sql`
      insert into branches (owner_id, name, slug, description, address, city, location, amenities)
      values (${ownerId}::uuid, ${'Fixture Branch ' + i}, ${slug}, 'A description',
              '1 Test St', 'Marikina',
              st_setsrid(st_makepoint(121.1029, 14.6507), 4326)::geography,
              array['parking', 'showers'])
      returning id
    `)
    const branchId = branch.rows[0].id as string
    branchIds.push(branchId)
    branchSlugs.push(slug)

    const court = await db.execute(sql`
      insert into courts (branch_id, name, environment, status)
      values (${branchId}::uuid, 'Court 1', 'indoor', 'approved')
      returning id
    `)
    const courtId = court.rows[0].id as string
    await db.execute(sql`
      insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
      values (${courtId}::uuid, 7, 23, 30000)
    `)
    for (let day = 0; day <= 6; day++) {
      await db.execute(sql`
        insert into court_operating_hours (court_id, day_of_week, opens_hour, closes_hour)
        values (${courtId}::uuid, ${day}, 7, 23)
      `)
    }
    await db.execute(sql`
      insert into branch_photos (branch_id, storage_path, sort_order) values
        (${branchId}::uuid, ${'branches/' + branchId + '/2.jpg'}, 1),
        (${branchId}::uuid, ${'branches/' + branchId + '/1.jpg'}, 0)
    `)
  }
  return { ownerId, ownerSlug, branchIds, branchSlugs }
}

describe('getBranchDetail', () => {
  it('returns null for an unknown slug', async () => {
    expect(await getBranchDetail('no-such-branch-' + crypto.randomUUID())).toBeNull()
  })

  it('returns the branch with photos ordered by sort_order', async () => {
    const { branchSlugs, branchIds } = await seedOwnerWithBranches(1)
    const detail = (await getBranchDetail(branchSlugs[0]))!
    expect(detail.name).toBe('Fixture Branch 0')
    expect(detail.description).toBe('A description')
    expect(detail.amenities).toEqual(['parking', 'showers'])
    expect(detail.photoPaths).toEqual([
      `branches/${branchIds[0]}/1.jpg`,
      `branches/${branchIds[0]}/2.jpg`,
    ])
  })

  it('exposes the owner and numeric coordinates', async () => {
    const { branchSlugs, ownerSlug } = await seedOwnerWithBranches(1)
    const detail = (await getBranchDetail(branchSlugs[0]))!
    expect(detail.owner.slug).toBe(ownerSlug)
    expect(detail.owner.businessName).toBe('Fixture Courts')
    expect(typeof detail.lat).toBe('number')
    expect(typeof detail.lng).toBe('number')
    expect(detail.lat).toBeCloseTo(14.6507, 3)
    expect(detail.lng).toBeCloseTo(121.1029, 3)
  })

  it('returns an empty review list and null rating when there are no reviews', async () => {
    const { branchSlugs } = await seedOwnerWithBranches(1)
    const detail = (await getBranchDetail(branchSlugs[0]))!
    expect(detail.reviews).toEqual([])
    expect(detail.ratingAvg).toBeNull()
    expect(detail.ratingCount).toBe(0)
  })
})

describe('getOwnerProfile', () => {
  it('returns null for an unknown slug', async () => {
    expect(await getOwnerProfile('no-such-owner-' + crypto.randomUUID())).toBeNull()
  })

  it('lists every branch the owner has', async () => {
    const { ownerSlug, branchSlugs } = await seedOwnerWithBranches(3)
    const profile = (await getOwnerProfile(ownerSlug))!
    expect(profile.businessName).toBe('Fixture Courts')
    expect(profile.branches).toHaveLength(3)
    expect(profile.branches.map((b) => b.slug).sort()).toEqual([...branchSlugs].sort())
    expect(typeof profile.branches[0].minPriceCentavos).toBe('number')
  })
})

describe('getHomeData', () => {
  it('returns featured branches, city counts and a numeric open-now count', async () => {
    await seedOwnerWithBranches(1)
    const home = await getHomeData()
    expect(home.featured.length).toBeGreaterThan(0)
    expect(home.featured.length).toBeLessThanOrEqual(6)
    expect(home.cities.length).toBeGreaterThan(0)
    expect(typeof home.cities[0].branchCount).toBe('number')
    expect(typeof home.openNowCount).toBe('number')
    expect(Number.isInteger(home.openNowCount)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/branches/detail.test.ts`
Expected: FAIL — `getBranchDetail is not a function`.

- [ ] **Step 3: Implement the three queries**

Append to `src/lib/branches/queries.ts`:

```ts
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
  cities: { city: string; branchCount: number }[]
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
    -- Counts only approved courts that ALSO have a rate band, matching the
    -- `branch_agg` rule in searchBranches/getOwnerProfile/getHomeData. An
    -- earlier version counted every approved court regardless of pricing,
    -- so the SAME branch reported a different court count on the search
    -- page than on its own branch page. An approved court with no price is
    -- not a bookable court, and every query must agree on that.
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
    order by rv.created_at desc
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
    with approved_courts as (
      select c.id, c.branch_id,
             (select min(rb.price_centavos) from court_rate_bands rb where rb.court_id = c.id) as min_price
      from courts c where c.status = 'approved'
    ),
    branch_agg as (
      select ac.branch_id, count(*)::int as court_count, min(ac.min_price)::int as min_price_centavos
      from approved_courts ac
      where ac.min_price is not null
      group by ac.branch_id
    )
    select b.id, b.slug, b.name, b.city, b.address, b.amenities,
           ba.court_count, ba.min_price_centavos,
           null::float8 as distance_meters,
           r.rating_avg, r.rating_count,
           p.storage_path as cover_photo_path
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
    with approved_courts as (
      select c.id, c.branch_id,
             (select min(rb.price_centavos) from court_rate_bands rb where rb.court_id = c.id) as min_price
      from courts c where c.status = 'approved'
    ),
    branch_agg as (
      select ac.branch_id, count(*)::int as court_count, min(ac.min_price)::int as min_price_centavos
      from approved_courts ac
      where ac.min_price is not null
      group by ac.branch_id
    )
    select b.id, b.slug, b.name, b.city, b.address, b.amenities,
           ba.court_count, ba.min_price_centavos,
           null::float8 as distance_meters,
           r.rating_avg, r.rating_count,
           p.storage_path as cover_photo_path
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

  const cities = await db.execute(sql`
    select b.city, count(distinct b.id)::int as branch_count
    from branches b
    join courts c on c.branch_id = b.id and c.status = 'approved'
    group by b.city
    order by branch_count desc, b.city
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
            bk.status in ('confirmed', 'completed')
            or (bk.status = 'pending_payment' and bk.expires_at > now())
          )
      )
  `)

  return {
    featured: featured.rows.map(toSummary),
    cities: cities.rows.map((row) => ({
      city: row.city as string,
      branchCount: Number(row.branch_count),
    })),
    openNowCount: Number(openNow.rows[0].open_now),
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/branches/detail.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Sanity-check against real seeded data**

Write a throwaway `tsx` script (do not commit it) that calls `getBranchDetail('rally-republic-quezon-city')`, `getOwnerProfile('rally-republic')` and `getHomeData()`, and `console.log`s the results. Confirm with your own eyes: the ratings are plausible numbers not strings, `lat`/`lng` are decimal degrees not WKB hex, photo paths are present, and `openNowCount` is a sane integer.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/branches/queries.ts tests/branches/detail.test.ts && git commit -m "feat: add branch detail, owner profile and home queries"
```

---

## Task 7: Site chrome and card primitives

The first UI task. **Read `design/branding.md` in full before starting**, and open `design/mockups/home.html` and `design/mockups/search-results.html` to see the nav, footer, and card markup these components are ported from.

**Files:**
- Create: `src/components/site/wordmark.tsx`
- Create: `src/components/site/nav.tsx`
- Create: `src/components/site/footer.tsx`
- Create: `src/components/ui/rating.tsx`
- Create: `src/components/ui/amenity-chip.tsx`
- Create: `src/components/ui/branch-card.tsx`
- Modify: `src/app/globals.css` (add the tokens these components reference)

**Interfaces:**
- Consumes: `BranchSummary` (Task 5), `photoUrl` (Task 4), `formatPeso`/`formatPriceFrom` (Task 1).
- Produces:
  ```tsx
  export function Wordmark(props: { onDark?: boolean; className?: string }): JSX.Element
  export async function Nav(props: { variant?: 'overlay' | 'solid' }): Promise<JSX.Element>
  export function Footer(): JSX.Element
  export function Rating(props: { average: number | null; count: number; onDark?: boolean }): JSX.Element | null
  export function AmenityChip(props: { amenity: string }): JSX.Element
  export function BranchCard(props: { branch: BranchSummary; showDistance?: boolean; active?: boolean; onHoverChange?: (id: string | null) => void }): JSX.Element
  ```
  `BranchCard` must stay a plain presentational component. `onHoverChange` is optional so it can be rendered from a Server Component without a handler; Task 10's client wrapper supplies it.

- [ ] **Step 1: Add the missing brand tokens to `globals.css`**

`src/app/globals.css` currently defines only the tokens a built page references. Add the ones these components need, keeping the existing comment convention:

```css
  --control-h: 56px;
  --shadow-sm: 0 1px 2px rgba(12, 31, 22, .06), 0 4px 16px rgba(12, 31, 22, .05);
  --shadow-lg: 0 12px 32px rgba(12, 31, 22, .12);
```

Do **not** add `--band-peak`. `design/branding.md` records the rate-band time-spine tint as dropped, and the built app is authoritative where the mockups still render it.

- [ ] **Step 2: Write `src/components/site/wordmark.tsx`**

```tsx
/**
 * design/branding.md, Brand: "oncourt" in display font weight 800, followed
 * by a small lime square (8x8px, 2px radius, --ball fill). On light
 * backgrounds add a 1.5px solid var(--ink) border so the square keeps
 * contrast; on dark/photo backgrounds no border. Same rule at footer size.
 *
 * Always lowercase in the wordmark. The brand name is a placeholder — it is
 * only written here, so swapping it is a one-line change.
 */
export function Wordmark({
  onDark = false,
  className = '',
}: {
  onDark?: boolean
  className?: string
}) {
  return (
    <span className={`font-display inline-flex items-baseline gap-1.5 font-extrabold tracking-[-0.03em] ${className}`}>
      oncourt
      <span
        aria-hidden
        className={`h-2 w-2 self-center rounded-[2px] bg-[var(--ball)] ${
          onDark ? '' : 'border-[1.5px] border-[var(--ink)]'
        }`}
      />
    </span>
  )
}
```

- [ ] **Step 3: Write `src/components/site/nav.tsx`**

A Server Component. It must read the session with `getClaims()` — never `getSession()`. Read `src/lib/supabase/server.ts` and `src/lib/auth/guards.ts` first to match how this codebase resolves a session, and reuse that path rather than writing a new one.

```tsx
import Link from 'next/link'
import { Wordmark } from '@/components/site/wordmark'

/**
 * design/branding.md, Nav: floating over heroes (absolute, transparent,
 * white text + glass pill) or solid --surface with a hairline border on
 * utility pages. Right side: "List your court" pill + 36px avatar.
 *
 * Glass surfaces are for use over photos ONLY:
 * rgba(255,255,255,.09) bg + rgba(255,255,255,.18) 1px border + blur(22px).
 *
 * Session state is read with supabase.auth.getClaims(), never getSession() —
 * getSession() is not trustworthy in server code (see the product spec).
 *
 * NOTE: the signed-in branch is UNVERIFIED. Google OAuth is not yet
 * configured on the Supabase project (docs/foundation-review-notes.md, open
 * item 2), so only the signed-out rendering has been seen in a browser.
 */
export async function Nav({ variant = 'solid' }: { variant?: 'overlay' | 'solid' }) {
  const user = await getOptionalUser()   // see Step 4
  const onDark = variant === 'overlay'

  return (
    <header
      className={
        onDark
          ? 'absolute inset-x-0 top-0 z-20 px-[max(24px,calc((100vw-1120px)/2))] py-5'
          : 'border-b border-[var(--hairline)] bg-[var(--surface)] px-[max(24px,calc((100vw-1120px)/2))] py-4'
      }
    >
      <nav className="flex items-center justify-between gap-4">
        <Link href="/" className={onDark ? 'text-white' : 'text-[var(--ink)]'}>
          <Wordmark onDark={onDark} className="text-[22px]" />
        </Link>

        {/* Center links are hidden below 980px per branding.md's breakpoints. */}
        <div className={`hidden items-center gap-7 text-sm font-medium md:flex ${onDark ? 'text-white/85' : 'text-[var(--ink-soft)]'}`}>
          <Link href="/search">Find courts</Link>
          <Link href="/search?sort=rating">Top rated</Link>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className={
              onDark
                ? 'inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-white/[.18] bg-white/[.09] px-4 text-sm font-semibold text-white backdrop-blur-[22px]'
                : 'inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-4 text-sm font-semibold text-[var(--ink)]'
            }
          >
            List your court
          </Link>
          {user ? (
            <img
              src={user.avatarUrl ?? ''}
              alt=""
              className="h-9 w-9 rounded-full border border-[var(--hairline)] object-cover"
            />
          ) : (
            <Link
              href="/login"
              className={`text-sm font-semibold ${onDark ? 'text-white' : 'text-[var(--ink)]'}`}
            >
              Sign in
            </Link>
          )}
        </div>
      </nav>
    </header>
  )
}
```

- [ ] **Step 4: Add the optional-session helper**

`requireUser()` in `src/lib/auth/guards.ts` throws or redirects when there is no session — the nav needs a *non*-throwing read. Read that file, then add a sibling export next to it following the same pattern:

```ts
/**
 * The current user, or null when signed out. Unlike requireUser(), this
 * never throws or redirects — the public pages render for anonymous
 * visitors, and the nav only needs to know which of two states to draw.
 */
export async function getOptionalUser(): Promise<SessionUser | null>
```

Implement it by extracting whatever `requireUser()` already does to resolve claims and load `profiles`, returning `null` instead of throwing. Do not duplicate the claim-verification logic — factor it so both share one path.

Import it in `nav.tsx` as `import { getOptionalUser } from '@/lib/auth/guards'`.

- [ ] **Step 5: Write `src/components/site/footer.tsx`**

Port the footer markup from `design/mockups/home.html`. Use `<Wordmark onDark />` if the footer band is dark, `<Wordmark />` if light — match the mockup. Keep the columns stacking at the 560px breakpoint.

- [ ] **Step 6: Write `src/components/ui/rating.tsx`**

```tsx
/**
 * design/branding.md, Rating: lime dot (7px, ink outline) + bold number,
 * count in parens muted.
 *
 * Renders nothing at all when a branch has no reviews — a "0.0 (0)" badge
 * reads as a bad rating rather than an absent one.
 */
export function Rating({
  average,
  count,
  onDark = false,
}: {
  average: number | null
  count: number
  onDark?: boolean
}) {
  if (average === null || count === 0) return null
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span
        aria-hidden
        className="h-[7px] w-[7px] rounded-full border border-[var(--ink)] bg-[var(--ball)]"
      />
      <span className={`font-semibold ${onDark ? 'text-white' : 'text-[var(--ink)]'}`}>
        {average.toFixed(1)}
      </span>
      <span className={onDark ? 'text-white/70' : 'text-[var(--ink-soft)]'}>({count})</span>
    </span>
  )
}
```

- [ ] **Step 7: Write `src/components/ui/amenity-chip.tsx`**

Pill-shaped (`rounded-full`), per branding.md's rule that non-interactive chips stay 999px to distinguish them from buttons. Map the seeded amenity slugs to display labels in one exported record:

```tsx
const AMENITY_LABELS: Record<string, string> = {
  parking: 'Parking',
  showers: 'Showers',
  rentals: 'Paddle rentals',
  aircon: 'Aircon',
  'pro-shop': 'Pro shop',
  cafe: 'Café',
  lockers: 'Lockers',
  'night-lights': 'Night lights',
}
```
An unknown slug falls back to the slug itself with hyphens replaced by spaces — never render nothing.

- [ ] **Step 8: Write `src/components/ui/branch-card.tsx`**

Card styling per branding.md: white, `rounded-[20px]`, **no border**, `shadow-[var(--shadow-sm)]`; hover lifts `-4px` with `shadow-[var(--shadow-lg)]` and image `scale-[1.045]`; all motion guarded by `motion-reduce:transform-none motion-reduce:transition-none`.

Content: cover image (via `photoUrl('branch-photos', branch.coverPhotoPath)`, falling back to a flat `bg-[var(--band-off)]` block when null), name (display font), city + distance when `showDistance`, `<Rating />`, `formatPriceFrom(branch.minPriceCentavos)` in mono, court count, and up to three `<AmenityChip />`s. The whole card links to `/venues/${branch.slug}`.

Distance renders as `2.4 km away` — compute with `(distanceMeters / 1000).toFixed(1)`, and omit the line entirely when `distanceMeters` is null.

Wire hover as:
```tsx
onMouseEnter={() => onHoverChange?.(branch.id)}
onMouseLeave={() => onHoverChange?.(null)}
```
and add `data-branch-id={branch.id}` so Task 10 can scroll a card into view.

- [ ] **Step 9: Typecheck and build**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: success. A build error about a client-only hook in a Server Component means `BranchCard` needs `'use client'` — add it to `branch-card.tsx` only, not to the page.

- [ ] **Step 10: Commit**

```bash
git add src/components/site src/components/ui src/app/globals.css src/lib/auth/guards.ts && git commit -m "feat: add site chrome and card primitives"
```

---

## Task 8: Home page

**Files:**
- Modify: `src/app/page.tsx` (full replacement)
- Reference: `design/mockups/home.html`

**Interfaces:**
- Consumes: `getHomeData` (Task 6), `Nav`/`Footer`/`Wordmark` (Task 7), `BranchCard` (Task 7), `CITIES` (Task 5).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Read the mockup**

Open `design/mockups/home.html` in the browser pane and read the file:

```
preview_start with {name: "mockups"}, then navigate to http://localhost:4173/home.html
```

Note the section order, the hero's dark photo overlay (`rgba(6, 20, 13, .68)` — solid, no gradient), the search band, the live indicator, and the featured-courts grid.

- [ ] **Step 2: Build the page**

Replace `src/app/page.tsx` entirely. Structure:

```tsx
import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { BranchCard } from '@/components/ui/branch-card'
import { getHomeData } from '@/lib/branches/queries'
import { CITIES } from '@/lib/geo/cities'
import { manilaToday } from '@/lib/date-manila'

export default async function HomePage() {
  const { featured, cities, openNowCount } = await getHomeData()
  const today = manilaToday()

  return (
    <>
      <section className="relative">
        <Nav variant="overlay" />
        {/* hero: photo + solid rgba(6,20,13,.68) overlay, h1 68px/44px/38px */}
        {/* search band: city <select>, date input defaulting to `today`,
            hour <select>, submitting GET to /search  */}
      </section>
      {/* live indicator: pulsing dot + mono uppercase label, respecting
          prefers-reduced-motion, reading openNowCount */}
      {/* browse-by-city strip from `cities` */}
      {/* featured grid: featured.map(b => <BranchCard key={b.id} branch={b} />) */}
      <Footer />
    </>
  )
}
```

Requirements that are not negotiable:
- The hero search **is a plain `<form method="get" action="/search">`** with named inputs (`city`, `date`, `hour`). No client-side state, no JS submit handler — the whole point of URL-driven search is that this works without hydration.
- Hero fields and their primary button use `--control-h: 56px`; the button is lime (`--ball` bg, `--ball-ink` text). Only one lime button in the view.
- Headline scale: `text-[68px]` desktop, `text-[44px]` at 980px, `text-[38px]` at 560px, tracking `-0.035em` at the largest size.
- Copy follows branding.md's voice: buttons say exactly what they do ("Find open courts"), light Taglish is welcome ("Laro na.").
- Live indicator must be wrapped in `motion-reduce:animate-none`.
- The city strip links to `/search?city=<slug>` — map the DB `city` string to a `CITIES` slug; skip a city with no matching slug rather than emitting a dead link.
- Empty state: when `featured.length === 0`, render a short on-brand message instead of an empty grid.

- [ ] **Step 3: Start the dev server and load the page**

```
preview_start with {name: "oncourt-dev"}, then navigate to http://localhost:3000/
```

- [ ] **Step 4: Check for errors**

Run `read_console_messages` and `preview_logs` (level: error). Expected: no errors. A hydration mismatch here almost certainly means a date was computed in both the server and the client — the date must come from `manilaToday()` on the server and be passed down.

- [ ] **Step 5: Verify content and structure**

Run `read_page`. Confirm: one `h1`, the featured cards present with real branch names from the seed, the live count rendered, and the search form's method/action correct.

- [ ] **Step 6: Verify the search form actually navigates**

Use `computer` to submit the form with a city selected. Expected: navigation to `/search?city=…&date=…`. The page will 404 until Task 9 — confirm the **URL** is right, then come back.

- [ ] **Step 7: Check responsive behavior**

`resize_window` to mobile (375×812) and confirm with `read_page` plus a screenshot that the page does not scroll sideways and the headline drops to the 38px size. Repeat at 980px.

- [ ] **Step 8: Screenshot**

`computer {action: "screenshot"}` and save to `docs/screenshots/home-desktop.png` and `docs/screenshots/home-mobile.png`. **Never the project root.**

- [ ] **Step 9: Commit**

```bash
git add src/app/page.tsx docs/screenshots && git commit -m "feat: build the home page"
```

---

## Task 9: Search results page (list and filters)

**Files:**
- Create: `src/app/search/page.tsx`
- Create: `src/components/search/filter-bar.tsx`
- Reference: `design/mockups/search-results.html`

**Interfaces:**
- Consumes: `searchBranches`, `cityBySlug`, `CITIES`, `BranchCard`, `Nav`, `Footer`, `isValidCalendarDate`, `manilaToday`.
- Produces: the parsed-filters shape Task 10's map consumes, and a `<div id="search-map-slot">` the map mounts into.

- [ ] **Step 1: Read the mockup**

Load `http://localhost:4173/search-results.html`. Note the filter bar, the result count line, the card list, and the sticky map column (left out until Task 10 — leave its column reserved).

- [ ] **Step 2: Write the search-param parser inside the page**

Every param validated, every invalid value falling back to its default. Put this at the top of `src/app/search/page.tsx`:

```tsx
import { isValidCalendarDate, manilaToday } from '@/lib/date-manila'
import { CITIES, DEFAULT_CITY_SLUG, cityBySlug } from '@/lib/geo/cities'
import type { SearchFilters } from '@/lib/branches/queries'

const AMENITY_VOCAB = new Set([
  'parking', 'showers', 'rentals', 'aircon', 'pro-shop', 'cafe', 'lockers', 'night-lights',
])

/**
 * A search URL is public and hand-editable, so nothing here may throw. Each
 * param falls back to its default when absent or invalid — the same
 * treatment src/app/venues/[slug]/page.tsx already gives a bad ?date=.
 *
 * The region-wide default gets a wider radius than a specific city: picking
 * "All of Metro Manila" should not silently exclude Caloocan or Parañaque.
 */
function parseSearchParams(params: Record<string, string | string[] | undefined>) {
  const one = (key: string) => {
    const value = params[key]
    return Array.isArray(value) ? value[0] : value
  }

  const citySlug = CITIES.some((c) => c.slug === one('city')) ? one('city')! : DEFAULT_CITY_SLUG
  const city = cityBySlug(citySlug)

  const latRaw = Number(one('lat'))
  const lngRaw = Number(one('lng'))
  const hasCoords =
    Number.isFinite(latRaw) && Number.isFinite(lngRaw) &&
    latRaw >= -90 && latRaw <= 90 && lngRaw >= -180 && lngRaw <= 180

  const dateRaw = one('date')
  const date = dateRaw && isValidCalendarDate(dateRaw) ? dateRaw : manilaToday()

  const hourRaw = Number(one('hour'))
  const hour = Number.isInteger(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? hourRaw : undefined

  const envRaw = one('env')
  const environment = envRaw === 'indoor' || envRaw === 'outdoor' ? envRaw : undefined

  const maxRaw = Number(one('max'))
  const maxPriceCentavos = Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : undefined

  const amenities = (one('amenities') ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => AMENITY_VOCAB.has(a))

  const sortRaw = one('sort')
  const sort =
    sortRaw === 'price' || sortRaw === 'rating' || sortRaw === 'distance' ? sortRaw : 'distance'

  const filters: SearchFilters = {
    lat: hasCoords ? latRaw : city.lat,
    lng: hasCoords ? lngRaw : city.lng,
    radiusMeters: hasCoords ? 15_000 : citySlug === DEFAULT_CITY_SLUG ? 30_000 : 12_000,
    date,
    hour,
    environment,
    maxPriceCentavos,
    amenities: amenities.length > 0 ? amenities : undefined,
    sort,
  }

  return { filters, citySlug, date, hour, environment, maxPriceCentavos, amenities, sort, usingCoords: hasCoords }
}
```

- [ ] **Step 3: Build the page shell**

```tsx
export default async function SearchPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const parsed = parseSearchParams(await props.searchParams)
  const results = await searchBranches(parsed.filters)

  return (
    <>
      <Nav variant="solid" />
      <main className="mx-auto max-w-[1120px] px-6 py-8">
        <FilterBar {...parsed} />
        <p className="font-mono text-[11px] uppercase tracking-[.14em] text-[var(--court)]">
          {results.length} {results.length === 1 ? 'court venue' : 'court venues'}
        </p>
        {/* two-column grid: list left, map column right (reserved, filled in Task 10) */}
      </main>
      <Footer />
    </>
  )
}
```

- [ ] **Step 4: Write `src/components/search/filter-bar.tsx`**

`'use client'`. It writes to the URL and nothing else — no local result state, no fetching.

```tsx
'use client'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

/**
 * Filters are URL state, not component state. Every control pushes a new
 * query string and lets the Server Component re-render — which is what makes
 * a search linkable, shareable, and correct on back/forward.
 */
```

Implement a `setParam(key, value)` that clones `useSearchParams()`, sets or deletes the key, and calls `router.push(`${pathname}?${next}`)`. Controls: city `<select>` (from `CITIES`), date `<input type="date">`, hour `<select>` (labelled with `formatHour`), environment segmented control, max-price `<select>` of centavo values, amenity toggles, sort `<select>`, and a "Use my location" button:

```tsx
navigator.geolocation.getCurrentPosition(
  (position) => {
    const next = new URLSearchParams(searchParams)
    next.set('lat', position.coords.latitude.toFixed(5))
    next.set('lng', position.coords.longitude.toFixed(5))
    next.delete('city')
    router.push(`${pathname}?${next}`)
  },
  // Permission denied is a no-op: the city picker stays in charge and the
  // page never depends on geolocation.
  () => {},
)
```

All controls use `--btn-h-sm` / `--btn-radius`. Amenity toggles are interactive, so they use `--btn-radius`, **not** the 999px pill radius — that is reserved for non-interactive badges.

- [ ] **Step 5: Render the results list**

Map `results` to `<BranchCard branch={b} showDistance />`. Empty state: an on-brand message plus a "Clear filters" link back to `/search`, not a blank column.

- [ ] **Step 6: Load the page and check for errors**

Navigate to `http://localhost:3000/search`. Run `read_console_messages` and `preview_logs` (level: error). Expected: clean.

- [ ] **Step 7: Verify each filter actually filters**

For each of these, navigate and confirm with `read_page` that the result count changes in the expected direction:
- `/search?city=makati` — fewer results than `/search`
- `/search?env=outdoor` — only outdoor venues
- `/search?max=25000` — only the cheaper venues
- `/search?amenities=parking,aircon` — only venues with both
- `/search?sort=price` — first card's price ≤ last card's price
- `/search?sort=rating` — first card's rating ≥ last card's rating
- `/search?date=lol&hour=99&city=nope&sort=bogus` — renders the default view, no error

That last one is the important one. Confirm it returns 200 and not a 500.

- [ ] **Step 8: Verify back/forward works**

Apply two filters via the UI, then `navigate` back twice and confirm with `read_page` that the earlier result sets return. URL-driven state should make this free — if it does not work, the filter bar is holding local state it should not.

- [ ] **Step 9: Screenshot and commit**

Save `docs/screenshots/search-list.png`.

```bash
git add src/app/search src/components/search docs/screenshots && git commit -m "feat: build the search results list and filters"
```

---

## Task 10: Search map

**Files:**
- Create: `src/components/search/search-map.tsx`
- Create: `src/components/search/search-results.tsx`
- Modify: `src/app/search/page.tsx` (mount the map column)
- Modify: `package.json` (`leaflet`, `@types/leaflet`)

**Interfaces:**
- Consumes: `BranchSummary[]` from the page as props.
- Produces:
  ```tsx
  export type MapPin = { id: string; name: string; slug: string; lat: number; lng: number; priceCentavos: number }
  export function SearchMap(props: { pins: MapPin[]; activeId: string | null; onActiveChange: (id: string | null) => void }): JSX.Element
  export function SearchResults(props: { branches: BranchSummary[]; pins: MapPin[] }): JSX.Element
  ```

**`searchBranches` does not currently return coordinates.** Add `lat`/`lng` to `BranchSummary` and to the select list in `searchBranches` and `getOwnerProfile`/`getHomeData` (as `st_y(b.location::geometry)::float8 as lat, st_x(b.location::geometry)::float8 as lng`), and to `toSummary`. Update `tests/branches/search.test.ts` with an assertion that `lat`/`lng` come back as numbers.

- [ ] **Step 1: Add coordinates to `BranchSummary`**

Extend the type, the three queries' select lists, and `toSummary`:
```ts
lat: number | null
lng: number | null
```
```ts
lat: row.lat === null ? null : Number(row.lat),
lng: row.lng === null ? null : Number(row.lng),
```

Add to `tests/branches/search.test.ts`:
```ts
it('returns numeric coordinates', async () => {
  const origin = remoteOrigin()
  const fixture = await seedBranchAt({ ...origin })
  const results = await searchBranches({ ...origin, radiusMeters: 5000 })
  const mine = results.find((r) => r.slug === fixture.slug)!
  expect(typeof mine.lat).toBe('number')
  expect(typeof mine.lng).toBe('number')
  expect(mine.lat).toBeCloseTo(origin.lat, 3)
})
```

Run: `npx vitest run tests/branches/search.test.ts` — expect PASS.

- [ ] **Step 2: Install Leaflet**

```bash
npm install leaflet@1.9.4 && npm install --save-dev @types/leaflet
```

- [ ] **Step 3: Write `src/components/search/search-map.tsx`**

```tsx
'use client'
import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { formatPeso } from '@/lib/format'

/**
 * design/branding.md, Maps. Every value below is transcribed from that entry,
 * which was written to be reproducible from the doc alone.
 *
 * The two-tone look comes from an inline SVG duotone filter applied to
 * .leaflet-tile-pane: a feColorMatrix reduces the tile to luminance, feeding
 * a feComponentTransfer whose per-channel lookup tables remap that luminance
 * into two brand tones (dark -> --court-deep, light -> --band-off).
 *
 * Markers live in Leaflet's marker pane, a SIBLING of the tile pane, so the
 * filter does not touch them — price pills stay untinted. That is the whole
 * reason this is a pane filter and not a container overlay.
 *
 * WARNING (from branding.md): container-level blend-mode overlays do NOT work
 * with Leaflet. .leaflet-map-pane sits at z-index 400 on the map container, so
 * any overlay is either fully below the map or fully above the markers and can
 * never tint the tiles. Do not "simplify" this into an overlay.
 */
export type MapPin = {
  id: string
  name: string
  slug: string
  lat: number
  lng: number
  priceCentavos: number
}
```

The component body:
- `useRef` for the container div and the `L.Map` instance; create the map once in a `useEffect` with `[]` deps and `map.remove()` in the cleanup (React 19 StrictMode double-invokes effects in dev — without the cleanup you get "Map container is already initialized").
- Tile layer: `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png`, with CARTO's required attribution.
- Render the duotone filter as inline SVG inside the component, sized 0, and apply `filter: url(#duotone) contrast(1.06)` to `.leaflet-tile-pane` via a `<style>` block scoped by a wrapper class:
  ```tsx
  <svg width="0" height="0" aria-hidden style={{ position: 'absolute' }}>
    <filter id="duotone" colorInterpolationFilters="sRGB">
      <feColorMatrix type="matrix" values="
        .2126 .7152 .0722 0 0
        .2126 .7152 .0722 0 0
        .2126 .7152 .0722 0 0
        0 0 0 1 0" />
      <feComponentTransfer>
        <feFuncR type="table" tableValues="0.078 0.918" />
        <feFuncG type="table" tableValues="0.239 0.949" />
        <feFuncB type="table" tableValues="0.173 0.894" />
      </feComponentTransfer>
    </filter>
  </svg>
  ```
- Markers: one `L.marker` per pin with `L.divIcon({ className: '', html: ... })` rendering the price pill — white bg, `--ink` text, mono 12px, `--shadow-sm`, `border-radius: 999px`. The active pin inverts to `--ball` bg with a `1.5px solid --ink` border.
- A second `useEffect` keyed on `pins` rebuilds the marker layer and calls `map.fitBounds(L.latLngBounds(pins))` when there is at least one pin; skip `fitBounds` entirely when `pins.length === 0` (Leaflet throws on empty bounds).
- A third `useEffect` keyed on `activeId` updates only the marker classes — do not rebuild the layer on hover.
- `marker.on('mouseover', () => onActiveChange(pin.id))` and `mouseout` back to `null`; `marker.on('click', ...)` navigates to `/venues/${pin.slug}`.

- [ ] **Step 4: Write `src/components/search/search-results.tsx`**

```tsx
'use client'
import dynamic from 'next/dynamic'
import { useState } from 'react'

/**
 * Holds the single piece of genuinely client-side state on this page: which
 * card/pin is hovered. Everything else — filters, results, ordering — is
 * server-rendered from the URL.
 *
 * The map is dynamically imported with ssr: false because Leaflet touches
 * `window` at module scope and would crash the server render.
 */
const SearchMap = dynamic(() => import('./search-map').then((m) => m.SearchMap), {
  ssr: false,
  loading: () => <div className="h-full w-full rounded-[20px] bg-[var(--band-off)]" />,
})
```

Body: `const [activeId, setActiveId] = useState<string | null>(null)`, a left column mapping branches to `<BranchCard active={b.id === activeId} onHoverChange={setActiveId} />`, and a right column with `<SearchMap pins={pins} activeId={activeId} onActiveChange={setActiveId} />` inside a `sticky top-6 h-[calc(100dvh-6rem)]` wrapper. Below the 980px breakpoint the map column is hidden.

- [ ] **Step 5: Mount it from the page**

In `src/app/search/page.tsx`, replace the **entire** `grid grid-cols-[1fr_400px]` block — BOTH the left branch-card column and the reserved `search-map-slot` div — with a single `<SearchResults>`.

Do NOT replace only the map column. `SearchResults` (Step 4) renders both columns itself, so swapping it into just the map slot would leave the page's own card grid in place AND nest a second copy of the cards plus Leaflet inside a 400px sidebar.

Two things move with it, and two must stay put:
- **Moves into `SearchResults`:** the empty state (checking `branches.length === 0`), including its on-brand message and the working "Clear filters" link.
- **Stays in `page.tsx`, above `<SearchResults>`:** the result-count paragraph and its `aria-live="polite" aria-atomic="true"` wrapper. That wrapper must remain a stable node at a fixed position in the JSX tree with no `key` — React then updates the text node in place. A live region that unmounts and remounts may not announce at all, and it must not move inside a conditional branch.
- **Keep the page's existing nav-aware sticky offsets** (`top-[84px]`, `h-[calc(100vh-116px)]`), not the generic `top-6`/`calc(100dvh-6rem)` in Step 4's sketch — the generic values were written without accounting for the sticky solid nav and let the map overlap it.



```tsx
<SearchResults
  branches={results}
  pins={results
    .filter((b) => b.lat !== null && b.lng !== null)
    .map((b) => ({
      id: b.id, name: b.name, slug: b.slug,
      lat: b.lat!, lng: b.lng!, priceCentavos: b.minPriceCentavos,
    }))}
/>
```

- [ ] **Step 6: Load and check for errors**

Navigate to `http://localhost:3000/search`. Run `read_console_messages`. Expected: no errors. Specifically confirm there is no "Map container is already initialized" — that means the effect cleanup is missing.

- [ ] **Step 7: Verify the tiles actually load**

Run `read_network_requests` with urlPattern `basemaps.cartocdn.com`. Expected: multiple 200 responses. A 4xx here means the tile URL is wrong.

- [ ] **Step 8: Verify the duotone filter is actually applied**

Do not trust that it looks right. Run `javascript_tool`:
```js
getComputedStyle(document.querySelector('.leaflet-tile-pane')).filter
```
Expected: a string containing `url("#duotone")` and `contrast(1.06)`. If it returns `none`, the CSS is not reaching the pane — fix it before moving on.

Then confirm the markers are **not** filtered:
```js
getComputedStyle(document.querySelector('.leaflet-marker-pane')).filter
```
Expected: `none`.

- [ ] **Step 9: Verify hover sync both ways**

Hover a card with `computer {action: "hover"}` and confirm via `javascript_tool` that the corresponding marker element gained its active class. Then hover a marker and confirm the card did.

- [ ] **Step 10: Verify the empty case**

Navigate to a filter combination with zero results (e.g. `/search?city=caloocan&max=1000`). Expected: no console error, no Leaflet bounds exception, and the empty state renders.

- [ ] **Step 11: Screenshot and commit**

Save `docs/screenshots/search-map.png`.

```bash
git add src/components/search src/app/search src/lib/branches/queries.ts tests/branches/search.test.ts package.json package-lock.json docs/screenshots && git commit -m "feat: add the search map"
```

---

## Task 11: Full branch page

**Files:**
- Modify: `src/app/venues/[slug]/page.tsx`
- Create: `src/components/branch/photo-gallery.tsx`
- Create: `src/components/branch/review-list.tsx`
- Reference: `design/mockups/branch-page.html`

**Interfaces:**
- Consumes: `getBranchDetail` (Task 6), the existing `loadBranchDay` + `AvailabilityGrid`, `Nav`/`Footer`, `Rating`, `AmenityChip`.
- Produces: nothing consumed by later tasks.

**The availability grid stays exactly as it is.** Do not restyle it, do not add a rate-band tint to the time spine. `design/branding.md` records that tint as dropped and states the built app is authoritative where `branch-page.html` still renders it.

- [ ] **Step 1: Read the mockup and note the divergence**

Load `http://localhost:4173/branch-page.html`. It renders the dropped `--band-peak` time-spine tint. **Do not port that.** Everything else — gallery, header, amenity chips, map, reviews, owner strip — is in scope.

- [ ] **Step 2: Write `src/components/branch/photo-gallery.tsx`**

Takes `photoPaths: string[]`. Renders a lead photo plus a grid of the rest, `rounded-[20px]`, using `photoUrl('branch-photos', path)`. When `photoPaths` is empty, render a single flat `bg-[var(--band-off)]` block at the same aspect ratio — never a broken image, never a gradient placeholder.

- [ ] **Step 3: Write `src/components/branch/review-list.tsx`**

Takes `reviews: BranchReview[]`, `ratingAvg`, `ratingCount`. Header uses `<Rating />`. Each row: avatar (or an initial-letter block when `authorAvatarUrl` is null), name, rating, body, and the date via `formatDateLabel(review.createdAt.slice(0, 10))`. When `reviews` is empty, render "No reviews yet." — not an empty section.

- [ ] **Step 4: Extend the page**

Keep the existing date-nav and `AvailabilityGrid` block verbatim. Add `getBranchDetail(slug)` alongside the existing `loadBranchDay(slug, day)` call — run them concurrently:

```tsx
const [detail, result] = await Promise.all([
  getBranchDetail(slug),
  loadBranchDay(slug, day),
])
if (!detail || !result) notFound()
```

Then compose, per the mockup: `<Nav variant="solid" />`, gallery, header (name, city, `<Rating />`, price-from, amenity chips), the existing booking panel, a description block, a single-pin map (reuse `SearchMap` with one pin, or a static block when `lat`/`lng` are null), `<ReviewList />`, an owner strip linking to `/owners/${detail.owner.slug}` when that slug is non-null, and `<Footer />`.

The existing "Slot on hold" banner and its `?held=` handling stay exactly as they are.

- [ ] **Step 5: Load and check for errors**

Navigate to `http://localhost:3000/venues/rally-republic-quezon-city`. Run `read_console_messages` and `preview_logs`. Expected: clean.

- [ ] **Step 6: Verify the grid still works**

Confirm with `read_page` that the availability grid still renders with its price cells, and that the date nav still moves days. This page had working behavior before this task — a regression here is worse than a missing feature.

- [ ] **Step 7: Verify the dropped tint did not come back**

Run `javascript_tool` to check that no element in the time spine carries a background other than the plain surface:
```js
[...document.querySelectorAll('[data-time-spine], .time-spine')].map(el => getComputedStyle(el).backgroundColor)
```
Expected: no tinted values. (If the grid uses different markup, inspect the first column directly.)

- [ ] **Step 8: Verify the bad-date path still 200s**

Navigate to `http://localhost:3000/venues/rally-republic-quezon-city?date=lol`. Expected: 200, today's grid, no 500. This was a real bug once — confirm the refactor in Task 1 did not undo the fix.

- [ ] **Step 9: Verify a branch with no reviews**

Find a seeded branch with zero reviews (`smash-zone-marikina` has none) and load it. Expected: the rating element is absent (not "0.0"), and the review section says "No reviews yet."

- [ ] **Step 10: Screenshot and commit**

Save `docs/screenshots/branch-page-full.png`.

```bash
git add "src/app/venues/[slug]/page.tsx" src/components/branch docs/screenshots && git commit -m "feat: build out the full branch page"
```

---

## Task 12: Owner profile page

**Files:**
- Create: `src/app/owners/[slug]/page.tsx`
- Reference: `design/mockups/owner-profile.html`

**Interfaces:**
- Consumes: `getOwnerProfile` (Task 6), `BranchCard`, `Nav`, `Footer`.

- [ ] **Step 1: Read the mockup**

Load `http://localhost:4173/owner-profile.html`.

- [ ] **Step 2: Build the page**

```tsx
import { notFound } from 'next/navigation'
import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { BranchCard } from '@/components/ui/branch-card'
import { getOwnerProfile } from '@/lib/branches/queries'

export default async function OwnerPage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params
  const profile = await getOwnerProfile(slug)
  if (!profile) notFound()

  return (
    <>
      <Nav variant="solid" />
      <main className="px-[max(24px,calc((100vw-1120px)/2))] py-10">
        {/* brand header: an initial-letter badge, business name as h1, branch
            count in mono.

            Do NOT use `mx-auto max-w-[1120px]` here — <body> is `flex flex-col`
            and a flex item's cross-axis `margin:auto` disables stretch-to-fill,
            which caused a real 375px overflow bug in Task 8. Padding-only.

            Do NOT call `photoUrl('branch-photos', profile.logoPath)` — no
            Storage bucket was ever provisioned for owner logos (`PhotoBucket`
            allows only 'branch-photos' | 'court-photos'), so that path 404s.
            Render an initial-letter badge, matching the branch page's owner
            strip. Provisioning an owner-logo bucket needs its own migration. */}
        {/* branch grid: profile.branches.map(b => <BranchCard key={b.id} branch={b} />) */}
      </main>
      <Footer />
    </>
  )
}
```

Requirements:
- Falls back to `profile.fullName` when `businessName` is null, and to the slug when both are null — never render an empty heading.
- Branch count in mono uppercase: `4 branches` / `1 branch`.
- Empty state when the owner has no branches with approved courts.

- [ ] **Step 3: Load and check for errors**

Navigate to `http://localhost:3000/owners/rally-republic`. Run `read_console_messages`. Expected: clean, four branch cards.

- [ ] **Step 4: Verify the 404 path**

Navigate to `http://localhost:3000/owners/no-such-owner`. Expected: the Next.js 404, not a 500.

- [ ] **Step 5: Verify a non-owner slug 404s**

`getOwnerProfile` filters on `role in ('owner', 'admin')`. Confirm a player's slug — if any player has one — does not resolve. If no player has a slug, note that and move on; the filter is still correct.

- [ ] **Step 6: Screenshot and commit**

Save `docs/screenshots/owner-profile.png`.

```bash
git add "src/app/owners" docs/screenshots && git commit -m "feat: build the owner profile page"
```

---

## Task 13: Cross-page verification and cleanup

**Files:**
- Modify: `docs/foundation-review-notes.md` (update the resolved deferred items)
- Possibly modify: `design/branding.md` (only if the map work forced a correction)

- [ ] **Step 1: Full green suite**

Run: `npm test`
Expected: PASS, every file. Capture the actual test/file counts.

Run it a **second** time immediately. Expected: PASS again. The database is shared and persistent, so a test that only passes on a clean run is broken. `docs/foundation-review-notes.md` records one unexplained intermittent failure — if anything flakes, capture full `--reporter=verbose` output before rerunning:

```bash
npx vitest run --reporter=verbose 2>&1 | tee /tmp/oncourt-verbose.log
```

- [ ] **Step 2: Typecheck, lint, build**

```bash
npx tsc --noEmit && npm run lint && npm run build
```
Expected: all clean. `npm run build` catching a server-only import in a client component is the check that matters most here.

- [ ] **Step 3: Walk the whole flow in the browser**

With `oncourt-dev` running, walk: `/` → submit the hero search → `/search` → apply two filters → click a card → `/venues/[slug]` → click the owner strip → `/owners/[slug]` → click a branch card → back to a branch page.

At each step run `read_console_messages` and `preview_logs` (level: error). Expected: zero errors across the entire walk.

- [ ] **Step 4: Check every page at all three breakpoints**

For each of the four pages, `resize_window` to 1280×800, 980×800, and 375×812. Confirm via screenshot and `read_page` that the page body never scrolls horizontally. Per branding.md, wide grids scroll inside their own container with a sticky first column — the page itself never scrolls sideways.

- [ ] **Step 5: Verify the no-gradient rule held**

```bash
grep -rniE "linear-gradient|radial-gradient|repeating-.*-gradient|bg-gradient" src/
```
Expected: zero matches. branding.md: "Solid colors ONLY. No gradients of any kind."

- [ ] **Step 6: Verify no `--band-peak` crept in**

```bash
grep -rn -- "--band-peak" src/ | grep -v "was removed"
```
Expected: zero matches. Note `src/app/globals.css` carries a legitimate *explanatory comment* recording that `--band-peak` was removed and why — that comment is the point, not a violation, so a bare `grep -rn "band-peak" src/` will false-positive on it. What must not exist is a live `--band-peak` declaration or any use of one. Matches in `design/mockups/` are expected and intentionally left alone.

- [ ] **Step 7: Update the foundation review notes**

In `docs/foundation-review-notes.md`, under "Smaller deferred items", the entry about duplicated Manila date helpers is now resolved (Task 1) — mark it done with a pointer to `src/lib/date-manila.ts`, rather than deleting it. Same for the `font-display` retrofit if Tasks 7-12 applied it. Leave every other item alone; do not touch the "Decisions worth not re-litigating" section.

- [ ] **Step 8: Record what could not be verified**

Add a short section to `docs/foundation-review-notes.md` stating plainly:
- The signed-in nav state has never rendered against a real session, because Google OAuth is still unconfigured (open item 2 in that same file).
- The database is now also carrying ~10 branches of demo content, which strengthens the existing case for a separate throwaway test project.

Write what is actually true. Do not claim verification that did not happen.

- [ ] **Step 9: Final commit**

```bash
git add docs/foundation-review-notes.md design/branding.md && git commit -m "docs: record public browse verification results"
```

---

## Self-Review Notes

Checked against the spec:

- **Routes table** → Tasks 8, 9, 11, 12. All four covered.
- **Search param table** → Task 9, Step 2 implements every param with its documented default.
- **Page chrome (Wordmark/Nav/Footer)** → Task 7.
- **Shared primitives (format, date-manila, photos, rating, branch-card, amenity-chip)** → Tasks 1, 4, 7.
- **Data layer (four query functions)** → Tasks 5 and 6.
- **Geography / cities** → Task 5, Step 1; the geolocation button is Task 9, Step 4.
- **Map, with exact duotone values** → Task 10, with a computed-style assertion rather than a visual check.
- **`reviews` table** → Task 2, including the RLS, index, and FK-behavior assertions the spec calls for.
- **Seed** → Task 3; photo upload → Task 4.
- **Testing table** → Tasks 1, 2, 4, 5, 6 cover every row; the lockdown-suite check is Task 2, Step 8.
- **Verification section, incl. the two explicitly unverifiable items** → Task 13, Steps 3-4 and 8.
- **Risks section** → the map risk is met by Task 10's Steps 7-8; the seed-size risk by Task 3's verification steps; the shared-database risk by Task 13, Step 1's double run.

One deviation from the spec worth flagging: the spec's `BranchSummary` did not include `lat`/`lng`, but the map needs them. Task 10, Step 1 adds them explicitly rather than leaving later tasks to discover the gap.
