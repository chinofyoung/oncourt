# Listings Management (Slice B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give owners (and staff holding `manage_courts`) real screens to create and edit branches and courts — fields, map pin, photos, weekly operating hours, and rate bands — with the approval lifecycle made precise: a new court enters `pending`, and a key-field edit (rate bands, operating hours, `environment`) re-queues an `approved` or `rejected` court back to `pending` and clears its `rejection_reason`.

**Architecture:** Three new server-only libraries under `src/lib/listings/` — `fields.ts` and `schedule.ts` (both **pure**: no database, no session, exhaustively unit-tested; they are the heart of the slice) and `write.ts`/`queries.ts` (all SQL). Three thin `'use server'` files under `src/app/dashboard/listings/` export nothing but guarded actions. Court-scoped writes resolve the branch **from the court row** via a new shared `src/lib/courts/lookup.ts` and guard `requireBranchAccess(branchId, 'manage_courts')`; branch-scoped writes guard `requireOwnerOf(branchId)` and additionally scope every `WHERE` clause by that same branch id. Photos take a `StorageClient` parameter so the storage boundary — and only that boundary — can be faked in tests. Geocoding sits behind a `Geocoder` function type with a Nominatim implementation. **No migrations:** every table, column, enum, index, and storage bucket this slice needs already exists.

**Tech Stack:** Next.js 16 App Router (TypeScript), Tailwind v4 with brand tokens in `src/app/globals.css`, Drizzle `sql` template over Postgres (never the query builder), Supabase Auth (Google) + Supabase Storage service-role client, Leaflet 1.9.4, Vitest against the hosted Supabase project.

**Spec:** `docs/superpowers/specs/2026-08-06-listings-and-admin-design.md` — **Slice B only.** Slice C (the `/admin` surface: approval queue, promote-to-owner, suspend/unsuspend) gets its own plan and must not be started here.

**Previous slice:** `docs/superpowers/plans/2026-08-05-roles-and-staff.md` — this plan consumes its guards (`requireOwner`, `requireOwnerOf`, `requireBranchAccess`), its `loadDashboardAccess`/`branchIdsWith` scoping layer, and its blocks-write pattern. Nothing it built is discarded.

## Global Constraints

- **NO MIGRATIONS IN THIS SLICE.** `branches`, `courts`, `branch_photos`, `court_photos`, `court_rate_bands`, `court_operating_hours`, the `court_status` / `court_environment` enums, and the `branch-photos` / `court-photos` buckets all already exist (`supabase/migrations/20260801063910_listings.sql`, `20260801042931_settings_and_enums.sql`, `20260801110350_storage_and_cron.sql`). If you believe a column is missing, you have misread the schema — re-read those files. Do not run `npx supabase db push`, do not run `npx drizzle-kit pull`, do not add a file under `supabase/migrations/`.
- **Data access is server-only.** Every read/write goes through a Server Component, Server Action, or Route Handler guarded by `requireUser` / `requirePlayer` / `requireOwner` / `requireOwnerOf` / `requireBranchAccess` / `requireAdmin`. The browser never queries Postgres. TypeScript is the security boundary.
- **Never use the Drizzle query builder.** Only `db.execute(sql\`...\`)`. Do not import `src/db/schema.ts` — it is excluded from `tsconfig.json` and importing it resurfaces a `TS2304`.
- **`'use server'` rule.** Every export of a `'use server'` file must be an async function AND becomes a client-invokable endpoint. Therefore: testable logic lives in `import 'server-only'` modules and the `'use server'` file exports **only** thin guarded actions plus the state `type` its forms bind to. `tests/auth/action-coverage.test.ts` globs every `'use server'` file and requires one of its `GUARDS` substrings; that list already contains `requireUser`, `requireAdmin`, `requireOwnerOf`, `requireOwner`, `requirePlayer`, `requireBranchAccess` — **this slice introduces no new guard name, so `GUARDS` needs no edit.** If you find yourself wanting a new guard, stop: the spec's permission table is satisfied by the six that exist.
- **The blocks pattern is the template for every write** (`src/lib/blocks/write.ts` + `src/app/dashboard/blocks/actions.ts`; read both before Task 3):
  1. `requireUser()` first, before any DB lookup derived from submitted input, so a signed-out caller cannot use the response as a row-existence oracle.
  2. For court-scoped writes the branch id is **resolved server-side from the target row** (`branchIdOfCourt`), never taken from the form — the guard and the write must refer to the same branch.
  3. Friendly typed reasons (`{ ok: false; reason: '…' }`), never thrown strings; the action maps reason → sentence.
  4. Status transitions are **single-statement status-scoped UPDATEs** — `set status='pending', rejection_reason=null where id=$ and status in ('approved','rejected')` — so zero rows means "it already moved", with no read-then-write race.
  5. `sqlStateOf(error)` from `src/lib/db/sql-state.ts` translates `23505` / `23514` / `23503` into reasons; anything else re-throws.
- **Key-field re-queue semantics (spec-pinned, do not improvise).** Rate bands, operating hours, and `environment` re-queue the court to `pending` and clear `rejection_reason`. Court `name`, `surface`, court photos, branch photos, and every branch-level edit **never** re-queue. A `rejected` court re-queues on any key-field edit — that is the owner's fix-and-resubmit path, and there is no separate resubmit button. A `suspended` court **never** re-queues: suspension is an admin action and an owner must not be able to edit their way out of it (this is why the transition predicate is `status in ('approved','rejected')` and not `status <> 'suspended'`). Rate bands and operating hours are stored **atomically** — delete + insert + the status flip in ONE transaction, never partial.
- **Money is integer centavos, percentages integer basis points.** Never floats, never `numeric`. Coerce every numeric column out of the driver with `Number()`. Rate-band price inputs are **whole pesos** in the form and become centavos by `× 100` (integer × integer, exact in JS) — sub-peso court pricing does not exist in this market, and a decimal field would invite float money.
- **Manila time.** All day/hour semantics via `src/lib/date-manila.ts` and the existing `to_char(... at time zone 'Asia/Manila', 'YYYY-MM-DD')` convention. `court_operating_hours.day_of_week` is 0=Sunday..6=Saturday, matching `manilaWeekday()`. `closes_hour` may be `24` (local midnight) and `formatHour(24)` already renders it as `12 AM`.
- **All user-facing copy is English only.** No Taglish (see the Language entry in `design/branding.md`).
- **Read `design/branding.md` before any UI work.** Solid colors only — no gradients, no glows. Cards: white, `border-radius: 20px`, no border, shadow `--shadow-sm`. Buttons: `--btn-h` 48px / `--btn-h-sm` 38px, `--btn-radius` 12px, display font weight 700. Mono (`font-mono`) for times, prices, and uppercase kickers. **Never two lime (`--ball`) buttons in one view** — where a control repeats per row (per branch, per court, per photo), use branding.md's alternative primary (`--ink` bg, `--ball` text) or the bordered secondary. Non-interactive chips/badges stay pill-shaped (`999px`). Content column 1120px max. Breakpoints 980px and 560px.
- **Branded focus ring on EVERY interactive element.** Declare, in every file that renders one, exactly:
  ```ts
  const FOCUS_RING =
    'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'
  ```
  and append it to the `className` of every `<Link>`, `<button>`, `<select>`, `<input>`, and `<textarea>` — including `type="checkbox"` and `type="file"`. Reviews rejected its omission four times in an earlier slice. **One exception, introduced in Task 5:** the listings client components import `FOCUS_RING` and the shared control classes from `src/app/dashboard/listings/form-ui.tsx` instead of redeclaring them, because six forms across four files would otherwise carry six copies of the same eight class strings. Server Components under `/dashboard/listings` still declare their own `FOCUS_RING` locally — they cannot import from a `'use client'` module without pulling it into the client bundle.
- **Tests run against the hosted Supabase project** via `DATABASE_URL` in `.env.local` — the Supavisor session pooler on port **5432**, never 6543. The database is **shared and persistent**: tests must pass on repeated runs, must create their own rows under their own ids, must clean up through `teardownFixtures()`'s id tracking, and must **never mutate seeded singleton rows** (`smash-zone-marikina` and the nine demo branches). **Run every DB-touching test file twice.** The suite has known pool-contention flakes under `npm test` (`tests/booking/hold.test.ts`, `tests/branches/detail.test.ts`, `tests/owner/queries.test.ts`, `tests/schema/bookings.test.ts`, `tests/bookings/queries.test.ts`): if one of those times out during a full run, **re-run that file on its own** before treating it as a regression.
- **Only two test doubles are permitted in this slice**, both at an external boundary: the **storage client** (the bucket is shared and an upload has no rollback) and **`fetch`** for the geocoder (external HTTP). Database rows are always real. The session boundary may be stubbed exactly as `tests/auth/guards.test.ts` already stubs it (`vi.mock('@/lib/supabase/server')`), because that is the guards' own established pattern.
- **Do not test `'use server'` actions directly.** They call `revalidatePath`/`redirect`, which throw outside a request context. The project's convention (see `tests/bookings/review-action.test.ts`, which tests the *lib*) is to test the server-only lib and the guards; the actions are thin enough that `tests/auth/action-coverage.test.ts` plus the final manual-verification task cover them.
- **No browser or dev-server steps inside implementation tasks.** Verification is tests + `npx tsc --noEmit` + `npm run lint` + `npm run build`. Everything that genuinely needs a browser is collected into the single final task.
- **Commit after every task**, with the exact `git add` paths given in that task's final step. Do not squash tasks into one commit.

---

### Task 1: The schedule validation library — operating hours and rate-band tiling

**Files:**
- Create: `src/lib/listings/schedule.ts`
- Create: `tests/listings/schedule.test.ts`

**Interfaces:**
- Produces, from `src/lib/listings/schedule.ts` (a **pure** module — deliberately NOT `server-only`, so the client court forms can import `WEEKDAY_LABELS` and the failure-message map):

```ts
export type OperatingHoursDay = { dayOfWeek: number; opensHour: number; closesHour: number }
export type RateBand = { startHour: number; endHour: number; priceCentavos: number }
export type HourSpan = { startHour: number; endHour: number }

export const WEEKDAY_LABELS: readonly string[]
export const PESOS_TO_CENTAVOS: 100

export type HoursFailure = 'no_open_day' | 'invalid_window'
export type BandsFailure = 'no_bands' | 'invalid_band' | 'bands_do_not_tile'
export type ParsedHours = { ok: true; days: OperatingHoursDay[] } | { ok: false; reason: HoursFailure }
export type ParsedBands = { ok: true; bands: RateBand[] } | { ok: false; reason: BandsFailure }

export function validateOperatingHours(days: OperatingHoursDay[]): HoursFailure | null
export function parseOperatingHours(formData: FormData): ParsedHours
export function operatingSpan(days: OperatingHoursDay[]): HourSpan | null
export function validateBandShapes(bands: RateBand[]): BandsFailure | null
export function validateRateBands(bands: RateBand[], span: HourSpan): BandsFailure | null
export function parseRateBands(formData: FormData): ParsedBands
export const HOURS_FAILURE_MESSAGES: Record<HoursFailure, string>
export const BANDS_FAILURE_MESSAGES: Record<BandsFailure, string>
```
- Consumes: nothing. This module imports no other module in the project.

**Why first, and why pure:** the spec calls this "the heart of the slice". A gap or overlap in the bands is not a cosmetic bug — `priceSlots` in `src/lib/booking/pricing.ts` throws `No rate band covers hour N` for an uncovered hour, which surfaces to a player mid-checkout. Keeping the rules in a module with no database and no session means every edge can be enumerated cheaply, and the write layer built on top of it in Task 3 has nothing left to guess.

- [ ] **Step 1: Create the test directory and write the failing tests**

Create `tests/listings/schedule.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  BANDS_FAILURE_MESSAGES,
  HOURS_FAILURE_MESSAGES,
  operatingSpan,
  parseOperatingHours,
  parseRateBands,
  validateBandShapes,
  validateOperatingHours,
  validateRateBands,
  type OperatingHoursDay,
  type RateBand,
} from '@/lib/listings/schedule'

/**
 * Pure module: no database, no fixtures, no teardown. Every case here is a
 * rule the court forms must not be able to violate, because the layer below
 * (court_operating_hours' CHECKs, court_rate_bands_no_overlap, and
 * priceSlots' "No rate band covers hour N" throw) either raises an opaque
 * SQLSTATE or fails a player mid-checkout.
 */
function hoursForm(entries: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.set(key, value)
  return data
}

function bandsForm(bands: { start: string; end: string; pesos: string }[]): FormData {
  const data = new FormData()
  for (const band of bands) {
    data.append('bandStart', band.start)
    data.append('bandEnd', band.end)
    data.append('bandPrice', band.pesos)
  }
  return data
}

const OPEN_ALL_WEEK: OperatingHoursDay[] = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek,
  opensHour: 11,
  closesHour: 24,
}))

// ---------------------------------------------------------- operating hours

test('validateOperatingHours accepts one window per open weekday', () => {
  expect(validateOperatingHours(OPEN_ALL_WEEK)).toBeNull()
})

test('validateOperatingHours accepts a single open weekday', () => {
  // "At least one open weekday" is the floor, not "all seven": a venue that
  // only opens on Saturdays is a real venue.
  expect(validateOperatingHours([{ dayOfWeek: 6, opensHour: 8, closesHour: 20 }])).toBeNull()
})

test('validateOperatingHours accepts a window closing at 24', () => {
  // court_operating_hours.closes_hour permits 24 (local midnight) and the
  // seeded fixtures use it. formatHour(24) already renders "12 AM".
  expect(validateOperatingHours([{ dayOfWeek: 3, opensHour: 11, closesHour: 24 }])).toBeNull()
})

test('validateOperatingHours rejects an all-closed week', () => {
  // A court with no open day is unbookable and would make operatingSpan()
  // null, leaving the rate bands with nothing to tile.
  expect(validateOperatingHours([])).toBe('no_open_day')
})

test('validateOperatingHours rejects a window that closes before it opens', () => {
  expect(validateOperatingHours([{ dayOfWeek: 1, opensHour: 20, closesHour: 8 }])).toBe(
    'invalid_window',
  )
})

test('validateOperatingHours rejects a zero-length window', () => {
  // court_operating_hours_order is `closes_hour > opens_hour`, so this would
  // be a 23514 rather than a form error.
  expect(validateOperatingHours([{ dayOfWeek: 1, opensHour: 9, closesHour: 9 }])).toBe(
    'invalid_window',
  )
})

test('validateOperatingHours rejects hours outside 0..24', () => {
  expect(validateOperatingHours([{ dayOfWeek: 1, opensHour: -1, closesHour: 9 }])).toBe(
    'invalid_window',
  )
  expect(validateOperatingHours([{ dayOfWeek: 1, opensHour: 9, closesHour: 25 }])).toBe(
    'invalid_window',
  )
  // opens_hour's CHECK is `>= 0 and < 24`: a window opening AT midnight-end
  // has no room to close after it.
  expect(validateOperatingHours([{ dayOfWeek: 1, opensHour: 24, closesHour: 24 }])).toBe(
    'invalid_window',
  )
})

test('validateOperatingHours rejects non-integer hours', () => {
  // The columns are `integer`; 9.5 would be silently truncated by the driver.
  expect(validateOperatingHours([{ dayOfWeek: 1, opensHour: 9.5, closesHour: 17 }])).toBe(
    'invalid_window',
  )
})

test('validateOperatingHours rejects a weekday outside 0..6', () => {
  expect(validateOperatingHours([{ dayOfWeek: 7, opensHour: 9, closesHour: 17 }])).toBe(
    'invalid_window',
  )
})

test('validateOperatingHours rejects two windows on the same weekday', () => {
  // court_operating_hours_unique_day is UNIQUE (court_id, day_of_week), so a
  // split day (open 6-9, closed for a league, open 18-22) is not
  // representable. Caught here as a form error rather than as a 23505.
  expect(
    validateOperatingHours([
      { dayOfWeek: 2, opensHour: 6, closesHour: 9 },
      { dayOfWeek: 2, opensHour: 18, closesHour: 22 },
    ]),
  ).toBe('invalid_window')
})

test('parseOperatingHours reads only the weekdays whose checkbox was submitted', () => {
  // An unchecked HTML checkbox submits nothing at all, so absence IS closed.
  // The form always renders all seven rows for exactly this reason.
  const result = parseOperatingHours(
    hoursForm({
      'open-1': 'on',
      'opens-1': '6',
      'closes-1': '22',
      'open-6': 'on',
      'opens-6': '8',
      'closes-6': '24',
      // Sunday's hour inputs are submitted but its checkbox is not — the
      // browser still posts a disabled-looking-but-enabled number field, so
      // the checkbox has to be the only thing that decides.
      'opens-0': '9',
      'closes-0': '17',
    }),
  )
  expect(result).toEqual({
    ok: true,
    days: [
      { dayOfWeek: 1, opensHour: 6, closesHour: 22 },
      { dayOfWeek: 6, opensHour: 8, closesHour: 24 },
    ],
  })
})

test('parseOperatingHours reports no_open_day when nothing is checked', () => {
  expect(parseOperatingHours(hoursForm({}))).toEqual({ ok: false, reason: 'no_open_day' })
})

test('parseOperatingHours reports invalid_window for a blank or junk hour', () => {
  // Number('') and Number(null) are both 0, which would pass a naive
  // `Number.isInteger` check and silently store a midnight-to-midnight day.
  for (const closes of ['', 'noon']) {
    expect(
      parseOperatingHours(hoursForm({ 'open-4': 'on', 'opens-4': '9', 'closes-4': closes })),
    ).toEqual({ ok: false, reason: 'invalid_window' })
  }
})

// -------------------------------------------------------------- rate bands

test('operatingSpan takes the widest window across the week', () => {
  // The span is per-COURT and per-WEEK, not per-day: bands have no weekday
  // column (court_rate_bands is court_id + hours only), so they must cover
  // the union of every open day's window.
  expect(
    operatingSpan([
      { dayOfWeek: 1, opensHour: 11, closesHour: 22 },
      { dayOfWeek: 6, opensHour: 7, closesHour: 24 },
    ]),
  ).toEqual({ startHour: 7, endHour: 24 })
})

test('operatingSpan is null for a closed week', () => {
  expect(operatingSpan([])).toBeNull()
})

test('validateRateBands accepts bands that exactly tile the span', () => {
  const bands: RateBand[] = [
    { startHour: 11, endHour: 15, priceCentavos: 26500 },
    { startHour: 15, endHour: 17, priceCentavos: 31500 },
    { startHour: 17, endHour: 24, priceCentavos: 36500 },
  ]
  expect(validateRateBands(bands, { startHour: 11, endHour: 24 })).toBeNull()
})

test('validateRateBands accepts a single band covering the whole span', () => {
  expect(
    validateRateBands([{ startHour: 6, endHour: 22, priceCentavos: 20000 }], {
      startHour: 6,
      endHour: 22,
    }),
  ).toBeNull()
})

test('validateRateBands accepts bands submitted out of order', () => {
  // The form appends rows in DOM order; an owner inserting a band in the
  // middle should not have to re-sort by hand.
  expect(
    validateRateBands(
      [
        { startHour: 17, endHour: 24, priceCentavos: 36500 },
        { startHour: 11, endHour: 17, priceCentavos: 26500 },
      ],
      { startHour: 11, endHour: 24 },
    ),
  ).toBeNull()
})

test('validateRateBands rejects a gap between bands', () => {
  expect(
    validateRateBands(
      [
        { startHour: 11, endHour: 15, priceCentavos: 26500 },
        { startHour: 16, endHour: 24, priceCentavos: 36500 },
      ],
      { startHour: 11, endHour: 24 },
    ),
  ).toBe('bands_do_not_tile')
})

test('validateRateBands rejects overlapping bands', () => {
  // court_rate_bands_no_overlap would raise 23P01 on the INSERT; catching it
  // here makes it a sentence instead of an exclusion-constraint violation.
  expect(
    validateRateBands(
      [
        { startHour: 11, endHour: 16, priceCentavos: 26500 },
        { startHour: 15, endHour: 24, priceCentavos: 36500 },
      ],
      { startHour: 11, endHour: 24 },
    ),
  ).toBe('bands_do_not_tile')
})

test('validateRateBands rejects two bands starting at the same hour', () => {
  expect(
    validateRateBands(
      [
        { startHour: 11, endHour: 24, priceCentavos: 26500 },
        { startHour: 11, endHour: 15, priceCentavos: 31500 },
      ],
      { startHour: 11, endHour: 24 },
    ),
  ).toBe('bands_do_not_tile')
})

test('validateRateBands rejects bands that start after the court opens', () => {
  // The uncovered 11:00 and 12:00 hours are exactly what makes priceSlots
  // throw mid-checkout.
  expect(
    validateRateBands([{ startHour: 13, endHour: 24, priceCentavos: 26500 }], {
      startHour: 11,
      endHour: 24,
    }),
  ).toBe('bands_do_not_tile')
})

test('validateRateBands rejects bands that stop before the court closes', () => {
  expect(
    validateRateBands([{ startHour: 11, endHour: 20, priceCentavos: 26500 }], {
      startHour: 11,
      endHour: 24,
    }),
  ).toBe('bands_do_not_tile')
})

test('validateRateBands rejects bands wider than the span', () => {
  // Overshooting is not harmless: it prices hours the court is never open,
  // which reads on the court page as availability that does not exist.
  expect(
    validateRateBands([{ startHour: 6, endHour: 24, priceCentavos: 26500 }], {
      startHour: 11,
      endHour: 24,
    }),
  ).toBe('bands_do_not_tile')
})

test('validateRateBands rejects an empty band list', () => {
  expect(validateRateBands([], { startHour: 11, endHour: 24 })).toBe('no_bands')
})

test('validateBandShapes rejects a zero or negative price', () => {
  // court_rate_bands' CHECK is `price_centavos > 0`. A free court is not a
  // pricing tier, it is a data-entry mistake.
  for (const priceCentavos of [0, -100]) {
    expect(validateBandShapes([{ startHour: 11, endHour: 24, priceCentavos }])).toBe('invalid_band')
  }
})

test('validateBandShapes rejects a non-integer price', () => {
  expect(validateBandShapes([{ startHour: 11, endHour: 24, priceCentavos: 26500.5 }])).toBe(
    'invalid_band',
  )
})

test('validateBandShapes rejects non-integer or out-of-range hours', () => {
  expect(validateBandShapes([{ startHour: 11.5, endHour: 24, priceCentavos: 100 }])).toBe(
    'invalid_band',
  )
  expect(validateBandShapes([{ startHour: 11, endHour: 25, priceCentavos: 100 }])).toBe(
    'invalid_band',
  )
  expect(validateBandShapes([{ startHour: -1, endHour: 24, priceCentavos: 100 }])).toBe(
    'invalid_band',
  )
})

test('validateBandShapes rejects a band that ends before it starts', () => {
  expect(validateBandShapes([{ startHour: 17, endHour: 11, priceCentavos: 100 }])).toBe(
    'invalid_band',
  )
  expect(validateBandShapes([{ startHour: 17, endHour: 17, priceCentavos: 100 }])).toBe(
    'invalid_band',
  )
})

test('parseRateBands converts whole pesos to integer centavos', () => {
  // The form takes pesos because that is what an owner types; centavos are
  // what the database stores. Integer x 100 is exact — no float money.
  expect(
    parseRateBands(
      bandsForm([
        { start: '11', end: '15', pesos: '265' },
        { start: '15', end: '24', pesos: '365' },
      ]),
    ),
  ).toEqual({
    ok: true,
    bands: [
      { startHour: 11, endHour: 15, priceCentavos: 26500 },
      { startHour: 15, endHour: 24, priceCentavos: 36500 },
    ],
  })
})

test('parseRateBands rejects a fractional peso price', () => {
  expect(parseRateBands(bandsForm([{ start: '11', end: '24', pesos: '265.5' }]))).toEqual({
    ok: false,
    reason: 'invalid_band',
  })
})

test('parseRateBands rejects a blank price', () => {
  expect(parseRateBands(bandsForm([{ start: '11', end: '24', pesos: '' }]))).toEqual({
    ok: false,
    reason: 'invalid_band',
  })
})

test('parseRateBands reports no_bands for an empty submission', () => {
  expect(parseRateBands(new FormData())).toEqual({ ok: false, reason: 'no_bands' })
})

test('parseRateBands rejects a submission whose three lists disagree in length', () => {
  // A hand-crafted POST could send two starts and one price. Zipping them
  // blindly would produce a band with a NaN price.
  const data = new FormData()
  data.append('bandStart', '11')
  data.append('bandStart', '15')
  data.append('bandEnd', '15')
  data.append('bandEnd', '24')
  data.append('bandPrice', '265')
  expect(parseRateBands(data)).toEqual({ ok: false, reason: 'invalid_band' })
})

test('every failure reason has a message', () => {
  // The forms render these verbatim; a missing key would render "undefined".
  expect(Object.keys(HOURS_FAILURE_MESSAGES).sort()).toEqual(['invalid_window', 'no_open_day'])
  expect(Object.keys(BANDS_FAILURE_MESSAGES).sort()).toEqual([
    'bands_do_not_tile',
    'invalid_band',
    'no_bands',
  ])
  for (const message of [
    ...Object.values(HOURS_FAILURE_MESSAGES),
    ...Object.values(BANDS_FAILURE_MESSAGES),
  ]) {
    expect(message.length).toBeGreaterThan(0)
  }
})
```

- [ ] **Step 2: Run the new test file and confirm it fails**

```bash
npx vitest run tests/listings/schedule.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/listings/schedule"`. No test executes.

- [ ] **Step 3: Write the module**

Create `src/lib/listings/schedule.ts`:

```ts
/**
 * Operating-hours and rate-band rules.
 *
 * PURE on purpose — no `import 'server-only'`, no database, no session. Two
 * reasons: the court forms are client components and need WEEKDAY_LABELS and
 * the failure-message maps to render, and every rule below is cheap to
 * enumerate as a unit test precisely because nothing here can fail for an
 * environmental reason.
 *
 * These rules exist because the layer underneath them fails badly:
 *   - court_operating_hours' CHECKs (`opens_hour >= 0 and < 24`,
 *     `closes_hour > 0 and <= 24`, `closes_hour > opens_hour`) and its
 *     UNIQUE (court_id, day_of_week) raise 23514/23505, which reach a form
 *     as an unhandled exception;
 *   - court_rate_bands_no_overlap raises 23P01 for overlapping bands;
 *   - and a GAP in the bands raises nothing at all until a player is
 *     mid-checkout, when priceSlots() (src/lib/booking/pricing.ts) throws
 *     "No rate band covers hour N". That last one is why the tiling rule is
 *     enforced in TypeScript: the database deliberately does not, and says
 *     so in supabase/migrations/20260801063910_listings.sql's comment.
 */

export type OperatingHoursDay = { dayOfWeek: number; opensHour: number; closesHour: number }
export type RateBand = { startHour: number; endHour: number; priceCentavos: number }
export type HourSpan = { startHour: number; endHour: number }

/**
 * Index IS `court_operating_hours.day_of_week`: 0=Sunday..6=Saturday, the
 * same convention as manilaWeekday() and `extract(dow from ...)`. Do not
 * reorder to start on Monday without also remapping the column.
 */
export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

/**
 * The form asks for whole pesos; the column stores integer centavos.
 * Integer x 100 is exact in JS, which is the whole reason the field is not a
 * decimal one — see the money rule in the plan's Global Constraints.
 */
export const PESOS_TO_CENTAVOS = 100

export type HoursFailure = 'no_open_day' | 'invalid_window'
export type BandsFailure = 'no_bands' | 'invalid_band' | 'bands_do_not_tile'

export type ParsedHours =
  | { ok: true; days: OperatingHoursDay[] }
  | { ok: false; reason: HoursFailure }
export type ParsedBands = { ok: true; bands: RateBand[] } | { ok: false; reason: BandsFailure }

export const HOURS_FAILURE_MESSAGES: Record<HoursFailure, string> = {
  no_open_day: 'Open the court on at least one day of the week.',
  invalid_window:
    'Each open day needs one window with whole-hour opening and closing times, closing after it opens (midnight is 24).',
}

export const BANDS_FAILURE_MESSAGES: Record<BandsFailure, string> = {
  no_bands: 'Add at least one rate band.',
  invalid_band: 'Each band needs whole-hour start and end times and a whole-peso price above zero.',
  bands_do_not_tile:
    'The bands must cover every open hour exactly once — no gaps, no overlaps, and nothing outside your opening hours.',
}

/** Integer in [min, max], inclusive. The columns are `integer`, so 9.5 would truncate silently. */
function isHourInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max
}

/**
 * Per weekday: either closed (absent from the list) or exactly one window
 * `0 <= opens < closes <= 24`. At least one open weekday.
 *
 * The duplicate-weekday check mirrors court_operating_hours_unique_day: a
 * split day (open in the morning, closed midday, open again at night) is not
 * representable in this schema, and the spec puts multi-window days out of
 * scope. Catching it here turns a 23505 into a sentence.
 */
export function validateOperatingHours(days: OperatingHoursDay[]): HoursFailure | null {
  if (days.length === 0) return 'no_open_day'

  const seen = new Set<number>()
  for (const day of days) {
    if (!isHourInRange(day.dayOfWeek, 0, 6)) return 'invalid_window'
    if (seen.has(day.dayOfWeek)) return 'invalid_window'
    seen.add(day.dayOfWeek)
    // Mirrors the columns' own CHECKs exactly: opens_hour in [0, 23],
    // closes_hour in [1, 24], closes > opens.
    if (!isHourInRange(day.opensHour, 0, 23)) return 'invalid_window'
    if (!isHourInRange(day.closesHour, 1, 24)) return 'invalid_window'
    if (day.closesHour <= day.opensHour) return 'invalid_window'
  }
  return null
}

/**
 * Reads the seven weekday rows the hours form always renders.
 *
 * The `open-<d>` checkbox is the ONLY thing that decides whether a day is
 * open: an unchecked HTML checkbox submits nothing at all, while its
 * sibling number inputs still post their values. Deriving "closed" from a
 * blank hour instead would make a day silently closed the moment someone
 * cleared a field they meant to retype.
 */
export function parseOperatingHours(formData: FormData): ParsedHours {
  const days: OperatingHoursDay[] = []
  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek++) {
    if (formData.get(`open-${dayOfWeek}`) === null) continue
    days.push({
      dayOfWeek,
      // Number('') and Number(null) are both 0 — harmless here because
      // validateOperatingHours requires closes_hour >= 1, so a blank closing
      // time is rejected rather than stored as midnight.
      opensHour: Number(formData.get(`opens-${dayOfWeek}`)),
      closesHour: Number(formData.get(`closes-${dayOfWeek}`)),
    })
  }

  const failure = validateOperatingHours(days)
  return failure === null ? { ok: true, days } : { ok: false, reason: failure }
}

/**
 * The hour range the bands must tile: `[min(opens_hour), max(closes_hour)]`
 * across the whole week.
 *
 * Per COURT and per WEEK, not per day, because court_rate_bands has no
 * weekday column — one price schedule serves every open day. A court open
 * 11-22 on weekdays and 7-24 on Saturday must therefore price 7 through 24.
 */
export function operatingSpan(days: OperatingHoursDay[]): HourSpan | null {
  if (days.length === 0) return null
  return {
    startHour: Math.min(...days.map((day) => day.opensHour)),
    endHour: Math.max(...days.map((day) => day.closesHour)),
  }
}

/** Per-band rules only — the shape each row must have before tiling is even meaningful. */
export function validateBandShapes(bands: RateBand[]): BandsFailure | null {
  for (const band of bands) {
    if (!isHourInRange(band.startHour, 0, 23)) return 'invalid_band'
    if (!isHourInRange(band.endHour, 1, 24)) return 'invalid_band'
    if (band.endHour <= band.startHour) return 'invalid_band'
    if (!Number.isInteger(band.priceCentavos) || band.priceCentavos <= 0) return 'invalid_band'
  }
  return null
}

/**
 * The tiling rule: the bands must cover `span` exactly once — contiguous,
 * no gaps, no overlaps, nothing outside it.
 *
 * Sorting by start hour and walking the chain catches all three failures with
 * one pass: a gap or an overlap both show up as `next.startHour !==
 * prev.endHour`, and two bands sharing a start hour do too (whichever sorts
 * second cannot begin where the first ended). The ends are pinned to the span
 * separately, which is what rejects bands that start late, stop early, or
 * overshoot the opening hours.
 */
export function validateRateBands(bands: RateBand[], span: HourSpan): BandsFailure | null {
  if (bands.length === 0) return 'no_bands'

  const shapeFailure = validateBandShapes(bands)
  if (shapeFailure !== null) return shapeFailure

  const sorted = [...bands].sort((a, b) => a.startHour - b.startHour)
  if (sorted[0].startHour !== span.startHour) return 'bands_do_not_tile'
  if (sorted[sorted.length - 1].endHour !== span.endHour) return 'bands_do_not_tile'
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].startHour !== sorted[index - 1].endHour) return 'bands_do_not_tile'
  }
  return null
}

/**
 * Reads the repeating band rows.
 *
 * Three parallel `getAll()` lists rather than indexed field names
 * (`band-0-start`): rows are added and removed client-side, and index-based
 * names would need renumbering on every removal — a source of silent holes.
 * The equal-length check is what makes zipping them safe against a
 * hand-crafted POST.
 *
 * Does NOT check tiling: the span comes from the court's stored operating
 * hours, which only the write layer has. Callers run validateRateBands()
 * after loading it.
 */
export function parseRateBands(formData: FormData): ParsedBands {
  const starts = formData.getAll('bandStart')
  const ends = formData.getAll('bandEnd')
  const prices = formData.getAll('bandPrice')

  if (starts.length === 0) return { ok: false, reason: 'no_bands' }
  if (ends.length !== starts.length || prices.length !== starts.length) {
    return { ok: false, reason: 'invalid_band' }
  }

  const bands: RateBand[] = starts.map((start, index) => {
    const pesos = Number(String(prices[index]).trim())
    return {
      startHour: Number(String(start).trim()),
      endHour: Number(String(ends[index]).trim()),
      // A fractional or blank peso value becomes NaN rather than a rounded
      // number, so validateBandShapes rejects it instead of quietly storing
      // a price the owner did not type.
      priceCentavos: Number.isInteger(pesos) ? pesos * PESOS_TO_CENTAVOS : Number.NaN,
    }
  })

  const failure = validateBandShapes(bands)
  return failure === null ? { ok: true, bands } : { ok: false, reason: failure }
}
```

Note: `Number('')` is `0`, which is an integer, so a blank price would become `0 * 100 = 0` — rejected by `validateBandShapes`'s `priceCentavos <= 0`. That is why the blank-price test asserts `invalid_band` rather than a NaN path.

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run tests/listings/schedule.test.ts
```

Expected: PASS — `Tests  35 passed (35)`.

- [ ] **Step 5: Typecheck and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors; lint reports only the pre-existing `<img>` and unused-`table` warnings.

- [ ] **Step 6: Commit**

```bash
git add src/lib/listings/schedule.ts tests/listings/schedule.test.ts
git commit -m "Add operating-hours and rate-band tiling validation"
```

---

### Task 2: The field validation library — branch fields, court fields, PH bounding box, slugs

**Files:**
- Create: `src/lib/listings/fields.ts`
- Create: `tests/listings/fields.test.ts`

**Interfaces:**
- Produces, from `src/lib/listings/fields.ts` (a **pure** module, same reasoning as Task 1 — the branch form is a client component and imports the failure-message maps):

```ts
export type BranchFields = {
  name: string
  description: string | null
  address: string
  city: string
  contactPhone: string | null
  contactEmail: string | null
  amenities: string[]
  lat: number | null
  lng: number | null
}
export type CourtEnvironment = 'indoor' | 'outdoor'
export type CourtFields = { name: string; environment: CourtEnvironment; surface: string | null }

export const COURT_ENVIRONMENTS: readonly ['indoor', 'outdoor']
export const PH_BOUNDS: { minLat: 4.2; maxLat: 21.4; minLng: 116.7; maxLng: 126.7 }
export const MAX_BRANCH_NAME: 120
export const MAX_DESCRIPTION: 2000
export const MAX_ADDRESS: 240
export const MAX_CITY: 80
export const MAX_PHONE: 40
export const MAX_EMAIL: 160
export const MAX_COURT_NAME: 80
export const MAX_SURFACE: 80

export type BranchFieldsFailure =
  | 'missing_name' | 'missing_address' | 'missing_city'
  | 'too_long' | 'invalid_email' | 'invalid_amenity' | 'invalid_location'
export type CourtFieldsFailure = 'missing_name' | 'invalid_environment' | 'too_long'

export function isInPhilippines(lat: number, lng: number): boolean
export function parseBranchFields(formData: FormData):
  | { ok: true; fields: BranchFields }
  | { ok: false; reason: BranchFieldsFailure }
export function parseCourtFields(formData: FormData):
  | { ok: true; fields: CourtFields }
  | { ok: false; reason: CourtFieldsFailure }
export function slugifyBranchName(name: string): string
export const BRANCH_FIELDS_FAILURE_MESSAGES: Record<BranchFieldsFailure, string>
export const COURT_FIELDS_FAILURE_MESSAGES: Record<CourtFieldsFailure, string>
```
- Consumes: `AMENITY_SLUGS` from `@/components/ui/amenity-chip`. That is the single source of truth for the amenity vocabulary, and `src/lib/search/params.ts` already imports it from exactly there to whitelist `?amenities=` — the spec's "amenities from a fixed vocabulary (the one the search filters already use)" means **that list**, not a new one. Do not copy the eight slugs into this module.

**Why the slug is generated, not typed:** `branches.slug` is `not null unique` and appears in the public `/venues/<slug>` URL, but the spec's branch-field list (name, description, address, city, contact phone/email, amenities) has no slug field — owners are not asked for one. So it is derived from the name here, and Task 3's `createBranch` resolves collisions. A **rename never changes the slug** (Task 3), because changing it would break every link and QR code already pointing at the branch.

- [ ] **Step 1: Write the failing tests**

Create `tests/listings/fields.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  BRANCH_FIELDS_FAILURE_MESSAGES,
  COURT_FIELDS_FAILURE_MESSAGES,
  isInPhilippines,
  MAX_BRANCH_NAME,
  parseBranchFields,
  parseCourtFields,
  slugifyBranchName,
} from '@/lib/listings/fields'
import { AMENITY_SLUGS } from '@/components/ui/amenity-chip'

/** The minimum a branch form must supply for the required-field checks to pass. */
function branchForm(
  overrides: Record<string, string> = {},
  amenities: string[] = [],
): FormData {
  const data = new FormData()
  data.set('name', 'Smash Zone Marikina')
  data.set('address', '12 Shoe Ave')
  data.set('city', 'Marikina')
  for (const [key, value] of Object.entries(overrides)) data.set(key, value)
  for (const amenity of amenities) data.append('amenities', amenity)
  return data
}

function courtForm(overrides: Record<string, string> = {}): FormData {
  const data = new FormData()
  data.set('name', 'Court 1')
  data.set('environment', 'indoor')
  for (const [key, value] of Object.entries(overrides)) data.set(key, value)
  return data
}

// ------------------------------------------------------------ branch fields

test('parseBranchFields accepts the minimum required fields', () => {
  expect(parseBranchFields(branchForm())).toEqual({
    ok: true,
    fields: {
      name: 'Smash Zone Marikina',
      description: null,
      address: '12 Shoe Ave',
      city: 'Marikina',
      contactPhone: null,
      contactEmail: null,
      amenities: [],
      lat: null,
      lng: null,
    },
  })
})

test('parseBranchFields trims every text field and normalizes blanks to null', () => {
  // '' and null are two representations of "no phone number"; the column is
  // nullable, so only one of them should ever reach it.
  const result = parseBranchFields(
    branchForm({
      name: '  Smash Zone  ',
      description: '   ',
      contactPhone: '  ',
      contactEmail: '   ',
    }),
  )
  expect(result).toEqual({
    ok: true,
    fields: {
      name: 'Smash Zone',
      description: null,
      address: '12 Shoe Ave',
      city: 'Marikina',
      contactPhone: null,
      contactEmail: null,
      amenities: [],
      lat: null,
      lng: null,
    },
  })
})

test('parseBranchFields rejects a missing or whitespace-only name, address, or city', () => {
  expect(parseBranchFields(branchForm({ name: '   ' }))).toEqual({
    ok: false,
    reason: 'missing_name',
  })
  expect(parseBranchFields(branchForm({ address: '' }))).toEqual({
    ok: false,
    reason: 'missing_address',
  })
  expect(parseBranchFields(branchForm({ city: '' }))).toEqual({
    ok: false,
    reason: 'missing_city',
  })
})

test('parseBranchFields rejects an over-long field', () => {
  expect(parseBranchFields(branchForm({ name: 'x'.repeat(MAX_BRANCH_NAME + 1) }))).toEqual({
    ok: false,
    reason: 'too_long',
  })
})

test('parseBranchFields accepts a well-formed contact email', () => {
  const result = parseBranchFields(branchForm({ contactEmail: 'desk@smashzone.ph' }))
  expect(result).toMatchObject({ ok: true, fields: { contactEmail: 'desk@smashzone.ph' } })
})

test('parseBranchFields rejects an obviously malformed contact email', () => {
  // Deliberately loose, same rule as src/lib/staff/write.ts's EMAIL_RE: one
  // '@' with something either side and a dot in the domain. It only has to
  // reject input that is not an address at all.
  for (const contactEmail of ['desk', 'desk@', '@smashzone.ph', 'desk@smashzone']) {
    expect(parseBranchFields(branchForm({ contactEmail }))).toEqual({
      ok: false,
      reason: 'invalid_email',
    })
  }
})

test('parseBranchFields accepts every amenity in the search vocabulary', () => {
  const result = parseBranchFields(branchForm({}, [...AMENITY_SLUGS]))
  expect(result).toMatchObject({ ok: true, fields: { amenities: [...AMENITY_SLUGS] } })
})

test('parseBranchFields rejects an amenity outside the vocabulary', () => {
  // branches.amenities is a bare text[] with no constraint, and the search
  // filter (`b.amenities @> $`) can only ever match slugs it renders a chip
  // for — so an off-vocabulary value would be stored, displayed as a
  // hyphen-stripped fallback, and unfilterable forever.
  expect(parseBranchFields(branchForm({}, ['parking', 'helipad']))).toEqual({
    ok: false,
    reason: 'invalid_amenity',
  })
})

test('parseBranchFields rejects a duplicated amenity', () => {
  expect(parseBranchFields(branchForm({}, ['parking', 'parking']))).toEqual({
    ok: false,
    reason: 'invalid_amenity',
  })
})

test('parseBranchFields accepts a coordinate inside the Philippines', () => {
  const result = parseBranchFields(branchForm({ lat: '14.6507', lng: '121.1029' }))
  expect(result).toMatchObject({ ok: true, fields: { lat: 14.6507, lng: 121.1029 } })
})

test('parseBranchFields rejects a pin at 0,0', () => {
  // The mis-dragged-pin case the spec calls out by name: Null Island is off
  // the coast of Ghana, and a branch there is invisible in every radius
  // search while looking perfectly saved.
  expect(parseBranchFields(branchForm({ lat: '0', lng: '0' }))).toEqual({
    ok: false,
    reason: 'invalid_location',
  })
})

test('parseBranchFields rejects a coordinate outside the Philippines', () => {
  // Swapped lat/lng is the common form of this mistake: 121.1, 14.65 is a
  // latitude that does not exist.
  expect(parseBranchFields(branchForm({ lat: '121.1029', lng: '14.6507' }))).toEqual({
    ok: false,
    reason: 'invalid_location',
  })
})

test('parseBranchFields rejects half a coordinate', () => {
  // branches.location is a single Point column: half of one is not storable,
  // and defaulting the missing half to 0 would put the branch in the ocean.
  expect(parseBranchFields(branchForm({ lat: '14.6507' }))).toEqual({
    ok: false,
    reason: 'invalid_location',
  })
  expect(parseBranchFields(branchForm({ lng: '121.1029' }))).toEqual({
    ok: false,
    reason: 'invalid_location',
  })
})

test('parseBranchFields rejects a non-numeric coordinate', () => {
  expect(parseBranchFields(branchForm({ lat: 'north', lng: '121.1029' }))).toEqual({
    ok: false,
    reason: 'invalid_location',
  })
})

test('isInPhilippines brackets the archipelago', () => {
  expect(isInPhilippines(14.5995, 121.0359)).toBe(true) // Metro Manila
  expect(isInPhilippines(20.45, 121.97)).toBe(true) // Batanes
  expect(isInPhilippines(5.05, 119.78)).toBe(true) // Tawi-Tawi
  expect(isInPhilippines(0, 0)).toBe(false)
  expect(isInPhilippines(1.35, 103.82)).toBe(false) // Singapore
  expect(isInPhilippines(Number.NaN, 121)).toBe(false)
})

// ------------------------------------------------------------- court fields

test('parseCourtFields accepts a name and environment, with surface optional', () => {
  expect(parseCourtFields(courtForm())).toEqual({
    ok: true,
    fields: { name: 'Court 1', environment: 'indoor', surface: null },
  })
})

test('parseCourtFields keeps a trimmed surface', () => {
  expect(parseCourtFields(courtForm({ surface: '  Acrylic  ' }))).toMatchObject({
    ok: true,
    fields: { surface: 'Acrylic' },
  })
})

test('parseCourtFields rejects a missing name', () => {
  expect(parseCourtFields(courtForm({ name: '  ' }))).toEqual({ ok: false, reason: 'missing_name' })
})

test('parseCourtFields rejects an environment outside the enum', () => {
  // courts.environment is the court_environment enum; anything else reaches
  // a ::court_environment cast and raises 22P02.
  for (const environment of ['', 'rooftop', 'INDOOR']) {
    expect(parseCourtFields(courtForm({ environment }))).toEqual({
      ok: false,
      reason: 'invalid_environment',
    })
  }
})

test('parseCourtFields rejects an over-long name or surface', () => {
  expect(parseCourtFields(courtForm({ name: 'x'.repeat(81) }))).toEqual({
    ok: false,
    reason: 'too_long',
  })
  expect(parseCourtFields(courtForm({ surface: 'x'.repeat(81) }))).toEqual({
    ok: false,
    reason: 'too_long',
  })
})

// -------------------------------------------------------------------- slugs

test('slugifyBranchName produces the shape branches.slug already uses', () => {
  expect(slugifyBranchName('Smash Zone Marikina')).toBe('smash-zone-marikina')
})

test('slugifyBranchName strips diacritics and punctuation', () => {
  // Parañaque is a real Metro Manila city (src/lib/geo/cities.ts lists it),
  // and 'para%C3%B1aque' in a URL is not a slug anybody can type.
  expect(slugifyBranchName('Parañaque Pickleball Café')).toBe('paranaque-pickleball-cafe')
  expect(slugifyBranchName('  The Court (BGC) — #2  ')).toBe('the-court-bgc-2')
})

test('slugifyBranchName falls back rather than returning an empty slug', () => {
  // branches.slug is NOT NULL; a name of only emoji or CJK would otherwise
  // produce '' and raise 23502.
  expect(slugifyBranchName('!!!')).toBe('branch')
})

test('slugifyBranchName never ends in a hyphen after truncation', () => {
  // 59 characters then a space puts the hyphen at index 59 — exactly the
  // last character the 60-char cap keeps, which is why the trailing-hyphen
  // strip has to run a second time after the slice.
  const slug = slugifyBranchName('a'.repeat(59) + ' bbbbbbbbbb')
  expect(slug).toBe('a'.repeat(59))
  expect(slug.endsWith('-')).toBe(false)
})

test('every failure reason has a message', () => {
  expect(Object.keys(BRANCH_FIELDS_FAILURE_MESSAGES).sort()).toEqual([
    'invalid_amenity',
    'invalid_email',
    'invalid_location',
    'missing_address',
    'missing_city',
    'missing_name',
    'too_long',
  ])
  expect(Object.keys(COURT_FIELDS_FAILURE_MESSAGES).sort()).toEqual([
    'invalid_environment',
    'missing_name',
    'too_long',
  ])
})
```

- [ ] **Step 2: Run the new test file and confirm it fails**

```bash
npx vitest run tests/listings/fields.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/listings/fields"`.

- [ ] **Step 3: Write the module**

Create `src/lib/listings/fields.ts`:

```ts
/**
 * Branch and court field rules.
 *
 * PURE, for the same two reasons as src/lib/listings/schedule.ts: the branch
 * and court forms are client components that render the failure messages, and
 * nothing here touches a database or a session.
 *
 * The amenity vocabulary is IMPORTED, never redeclared. AMENITY_SLUGS in
 * src/components/ui/amenity-chip.tsx is the single source of truth already
 * shared by the search query-param whitelist (src/lib/search/params.ts) and
 * the filter chips; branches.amenities is a bare `text[]` with no constraint,
 * so a slug outside that list would be stored, rendered as a hyphen-stripped
 * fallback chip, and permanently unmatched by the search filter's
 * `b.amenities @> $` predicate.
 */
import { AMENITY_SLUGS } from '@/components/ui/amenity-chip'

export type BranchFields = {
  name: string
  description: string | null
  address: string
  city: string
  contactPhone: string | null
  contactEmail: string | null
  amenities: string[]
  /** Both null, or both set. `branches.location` is one Point column. */
  lat: number | null
  lng: number | null
}

export type CourtEnvironment = 'indoor' | 'outdoor'
export type CourtFields = { name: string; environment: CourtEnvironment; surface: string | null }

/** Mirrors the `court_environment` enum exactly. */
export const COURT_ENVIRONMENTS = ['indoor', 'outdoor'] as const

/**
 * A generous box around the archipelago — Batanes in the north (~21.1 N),
 * Tawi-Tawi in the south (~4.6 N), Palawan's west coast (~116.9 E), and the
 * eastern seaboard (~126.6 E).
 *
 * A sanity check, not a service area: its job is to catch a pin dragged to
 * 0,0 (Null Island, off Ghana) or a swapped lat/lng, both of which save
 * cleanly and then make the branch invisible to every radius search while
 * looking perfectly fine on the form.
 */
export const PH_BOUNDS = { minLat: 4.2, maxLat: 21.4, minLng: 116.7, maxLng: 126.7 } as const

export const MAX_BRANCH_NAME = 120
export const MAX_DESCRIPTION = 2000
export const MAX_ADDRESS = 240
export const MAX_CITY = 80
export const MAX_PHONE = 40
export const MAX_EMAIL = 160
export const MAX_COURT_NAME = 80
export const MAX_SURFACE = 80
/** branches.slug is UNIQUE and public; long enough to stay readable, short enough to type. */
const MAX_SLUG = 60

/** Same deliberately-loose rule as src/lib/staff/write.ts — see that module's comment. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type BranchFieldsFailure =
  | 'missing_name'
  | 'missing_address'
  | 'missing_city'
  | 'too_long'
  | 'invalid_email'
  | 'invalid_amenity'
  | 'invalid_location'

export type CourtFieldsFailure = 'missing_name' | 'invalid_environment' | 'too_long'

export const BRANCH_FIELDS_FAILURE_MESSAGES: Record<BranchFieldsFailure, string> = {
  missing_name: 'Give the branch a name.',
  missing_address: 'Enter the street address.',
  missing_city: 'Enter the city.',
  too_long: 'One of those fields is too long — shorten it and try again.',
  invalid_email: "That contact email doesn't look right.",
  invalid_amenity: 'Pick amenities from the list, without repeating one.',
  invalid_location:
    'Set the map pin somewhere in the Philippines, or leave it unset and place it later.',
}

export const COURT_FIELDS_FAILURE_MESSAGES: Record<CourtFieldsFailure, string> = {
  missing_name: 'Give the court a name.',
  invalid_environment: 'Choose indoor or outdoor.',
  too_long: 'The name or surface is too long — shorten it and try again.',
}

export function isInPhilippines(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= PH_BOUNDS.minLat &&
    lat <= PH_BOUNDS.maxLat &&
    lng >= PH_BOUNDS.minLng &&
    lng <= PH_BOUNDS.maxLng
  )
}

/** Trimmed string for a form field; '' for anything absent. */
function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

export function parseBranchFields(
  formData: FormData,
): { ok: true; fields: BranchFields } | { ok: false; reason: BranchFieldsFailure } {
  const name = text(formData, 'name')
  const address = text(formData, 'address')
  const city = text(formData, 'city')
  const description = text(formData, 'description')
  const contactPhone = text(formData, 'contactPhone')
  const contactEmail = text(formData, 'contactEmail')
  const amenities = formData.getAll('amenities').map((value) => String(value))
  const rawLat = text(formData, 'lat')
  const rawLng = text(formData, 'lng')

  if (name.length === 0) return { ok: false, reason: 'missing_name' }
  if (address.length === 0) return { ok: false, reason: 'missing_address' }
  if (city.length === 0) return { ok: false, reason: 'missing_city' }

  if (
    name.length > MAX_BRANCH_NAME ||
    address.length > MAX_ADDRESS ||
    city.length > MAX_CITY ||
    description.length > MAX_DESCRIPTION ||
    contactPhone.length > MAX_PHONE ||
    contactEmail.length > MAX_EMAIL
  ) {
    return { ok: false, reason: 'too_long' }
  }

  if (contactEmail.length > 0 && !EMAIL_RE.test(contactEmail)) {
    return { ok: false, reason: 'invalid_email' }
  }

  for (const amenity of amenities) {
    if (!(AMENITY_SLUGS as readonly string[]).includes(amenity)) {
      return { ok: false, reason: 'invalid_amenity' }
    }
  }
  // A duplicate is never something a checkbox set can produce; it means the
  // POST was hand-crafted, and `amenities @> '{parking,parking}'` would still
  // match, so storing it achieves nothing but a doubled chip.
  if (new Set(amenities).size !== amenities.length) {
    return { ok: false, reason: 'invalid_amenity' }
  }

  // Both or neither. `branches.location` is nullable, so "no pin yet" is a
  // legitimate state — geocoding is non-blocking per the spec — but half a
  // coordinate is not storable and defaulting the missing half to 0 would
  // drop the branch in the ocean.
  if ((rawLat === '') !== (rawLng === '')) return { ok: false, reason: 'invalid_location' }

  let lat: number | null = null
  let lng: number | null = null
  if (rawLat !== '') {
    lat = Number(rawLat)
    lng = Number(rawLng)
    if (!isInPhilippines(lat, lng)) return { ok: false, reason: 'invalid_location' }
  }

  return {
    ok: true,
    fields: {
      name,
      description: description.length > 0 ? description : null,
      address,
      city,
      contactPhone: contactPhone.length > 0 ? contactPhone : null,
      contactEmail: contactEmail.length > 0 ? contactEmail : null,
      amenities,
      lat,
      lng,
    },
  }
}

export function parseCourtFields(
  formData: FormData,
): { ok: true; fields: CourtFields } | { ok: false; reason: CourtFieldsFailure } {
  const name = text(formData, 'name')
  const environment = text(formData, 'environment')
  const surface = text(formData, 'surface')

  if (name.length === 0) return { ok: false, reason: 'missing_name' }
  if (!(COURT_ENVIRONMENTS as readonly string[]).includes(environment)) {
    return { ok: false, reason: 'invalid_environment' }
  }
  if (name.length > MAX_COURT_NAME || surface.length > MAX_SURFACE) {
    return { ok: false, reason: 'too_long' }
  }

  return {
    ok: true,
    fields: {
      name,
      environment: environment as CourtEnvironment,
      surface: surface.length > 0 ? surface : null,
    },
  }
}

/**
 * Derives the public `/venues/<slug>` segment from the branch name.
 *
 * Owners are never asked for a slug — the spec's branch-field list has no
 * such field — but branches.slug is `not null unique`, so one has to come
 * from somewhere. Collisions are resolved by createBranch (see
 * src/lib/listings/write.ts), which is the only layer that can see them.
 *
 * NFD + combining-mark strip is what turns 'Parañaque' into 'paranaque'
 * rather than percent-encoded noise in the URL. The trailing-hyphen strip
 * runs twice on purpose: once before the length cap, once after, because
 * slicing mid-word can leave a hyphen at the new end.
 */
export function slugifyBranchName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '')

  // branches.slug is NOT NULL, so a name with no ASCII-able characters at
  // all (emoji, pure CJK) must still produce something insertable.
  return slug.length > 0 ? slug : 'branch'
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run tests/listings/fields.test.ts
```

Expected: PASS — `Tests  25 passed (25)`.

- [ ] **Step 5: Typecheck and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors; only the pre-existing warnings.

- [ ] **Step 6: Commit**

```bash
git add src/lib/listings/fields.ts tests/listings/fields.test.ts
git commit -m "Add branch and court field validation with a PH bounding box"
```

---

### Task 3: The listing write library, the shared court→branch lookup, and the read queries

**Files:**
- Create: `src/lib/courts/lookup.ts`
- Create: `src/lib/listings/status.ts`
- Create: `src/lib/listings/write.ts`
- Create: `src/lib/listings/queries.ts`
- Create: `tests/listings/write.test.ts`
- Create: `tests/listings/queries.test.ts`
- Modify: `src/lib/db/sql-state.ts` (add `PG_FOREIGN_KEY_VIOLATION`)
- Modify: `src/lib/blocks/write.ts` (delete its local `branchIdOfCourt`, re-import nothing — see Step 1)
- Modify: `src/app/dashboard/blocks/actions.ts` (import `branchIdOfCourt` from its new home)
- Modify: `tests/blocks/write.test.ts` (same import move)

**Interfaces:**
- Produces, from `src/lib/courts/lookup.ts`:

```ts
export async function branchIdOfCourt(courtId: string): Promise<string | null>
```
- Produces, from `src/lib/listings/status.ts` (a **pure** module — the court pages and their client forms both render these):

```ts
export type CourtStatus = 'pending' | 'approved' | 'rejected' | 'suspended'
export const COURT_STATUSES: readonly ['approved', 'pending', 'rejected', 'suspended']
export const COURT_STATUS_LABELS: Record<CourtStatus, string>
export const COURT_STATUS_BANNERS: Record<CourtStatus, { title: string; body: string }>
```
- Produces, from `src/lib/listings/write.ts`:

```ts
export type CreateBranchResult =
  | { ok: true; branchId: string; slug: string }
  | { ok: false; reason: 'slug_unavailable' }
export type UpdateBranchResult = { ok: true } | { ok: false; reason: 'not_found' }
export type CreateCourtResult = { ok: true; courtId: string } | { ok: false; reason: 'branch_missing' }
export type CourtWriteResult =
  | { ok: true; requeued: boolean }
  | { ok: false; reason: 'not_found' | 'no_operating_hours' | HoursFailure | BandsFailure }

export async function createBranch(input: { ownerId: string; fields: BranchFields }): Promise<CreateBranchResult>
export async function updateBranch(input: { branchId: string; fields: BranchFields }): Promise<UpdateBranchResult>
export async function createCourt(input: { branchId: string; fields: CourtFields }): Promise<CreateCourtResult>
export async function updateCourtFields(input: { courtId: string; fields: CourtFields }): Promise<CourtWriteResult>
export async function replaceOperatingHours(input: { courtId: string; days: OperatingHoursDay[] }): Promise<CourtWriteResult>
export async function replaceRateBands(input: { courtId: string; bands: RateBand[] }): Promise<CourtWriteResult>
```
- Produces, from `src/lib/listings/queries.ts`:

```ts
export type ListingPhoto = { id: string; storagePath: string; sortOrder: number }
export type { CourtStatus } from '@/lib/listings/status'
export type ListingBranchSummary = {
  id: string; name: string; city: string; slug: string
  photoCount: number; courtCounts: Record<CourtStatus, number>
}
export type ListingCourtSummary = {
  id: string; name: string; environment: CourtEnvironment
  surface: string | null; status: CourtStatus; rejectionReason: string | null
}
export type ListingBranch = {
  id: string; name: string; slug: string; description: string | null
  address: string; city: string; contactPhone: string | null; contactEmail: string | null
  amenities: string[]; lat: number | null; lng: number | null
  photos: ListingPhoto[]; courts: ListingCourtSummary[]
}
export type ListingCourt = {
  id: string; branchId: string; branchName: string; branchCity: string
  name: string; environment: CourtEnvironment; surface: string | null
  status: CourtStatus; rejectionReason: string | null
  days: OperatingHoursDay[]; bands: RateBand[]; photos: ListingPhoto[]
  scheduleWarning: HoursFailure | BandsFailure | null
}

export async function getListingBranches(branchIds: string[]): Promise<ListingBranchSummary[]>
export async function getListingBranch(branchId: string): Promise<ListingBranch | null>
export async function getListingCourt(courtId: string): Promise<ListingCourt | null>
```
- Consumes: `src/lib/listings/fields.ts`, `src/lib/listings/schedule.ts` (Tasks 1–2), `src/lib/db/sql-state.ts`, `@/db`.

**Why `branchIdOfCourt` moves out of `src/lib/blocks/write.ts`:** it is now the security primitive for *two* features — "resolve the branch from the court row so the guard and the write agree" is what the blocks actions do and what every court-scoped listings action must do. Leaving it in `blocks/write.ts` would force the listings actions to import from the blocks module (nonsense coupling) or to keep a second copy (a DRY violation on the one function whose duplication is a security bug waiting to happen). One definition, three callers.

**Why the hours form does not validate the rate bands:** changing opening hours widens or narrows the span the bands must tile, so refusing an hours change whose stored bands no longer fit would deadlock the owner — the bands form validates against the *stored* hours, so they could not fix the bands first either. Instead the hours change is allowed, the court is re-queued to `pending` (so it is off every public surface immediately — public reads filter to `approved`), and `getListingCourt` returns a `scheduleWarning` the court page renders until the owner updates the bands. `validateRateBands` remains the gate on the *bands* form, which is where the two must agree.

- [ ] **Step 1: Move `branchIdOfCourt` into its own module**

Create `src/lib/courts/lookup.ts`:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

/**
 * The court's real branch, read from the database.
 *
 * This is what makes a court-scoped action's guard trustworthy. If the form
 * supplied a branchId, an attacker would choose one value for
 * requireBranchAccess and the write would use another — a confused deputy.
 * Reading it here means the guard and the write always refer to the same
 * branch, and it is why none of the court actions has an `invalid_branch`
 * failure reason at all.
 *
 * Moved out of src/lib/blocks/write.ts (where it started) when the listings
 * slice needed the same primitive: `manage_courts` writes resolve their
 * branch exactly like `block_slots` writes do, and two copies of the one
 * function whose duplication is a security bug is not a trade worth making.
 *
 * `courtId` must already be UUID-shaped — it reaches a `::uuid` cast, and a
 * malformed value raises 22P02 rather than returning null. Every caller
 * shape-checks first.
 */
export async function branchIdOfCourt(courtId: string): Promise<string | null> {
  const result = await db.execute(sql`
    select branch_id from courts where id = ${courtId}::uuid
  `)
  return (result.rows[0]?.branch_id as string | undefined) ?? null
}
```

In `src/lib/blocks/write.ts`, **delete** the `branchIdOfCourt` function and its docstring entirely (the block starting `/**\n * The court's real branch, read from the database.` through the closing `}` of the function). Leave `branchIdOfBlock` — it filters `status = 'blocked'` and is specific to blocks.

In `src/app/dashboard/blocks/actions.ts`, change the import block from:

```ts
import {
  branchIdOfBlock,
  branchIdOfCourt,
  createBlock,
  deleteBlock,
  parseBlockId,
  parseBlockInput,
} from '@/lib/blocks/write'
```

to:

```ts
import { branchIdOfCourt } from '@/lib/courts/lookup'
import {
  branchIdOfBlock,
  createBlock,
  deleteBlock,
  parseBlockId,
  parseBlockInput,
} from '@/lib/blocks/write'
```

In `tests/blocks/write.test.ts`, apply the same split to its import of `@/lib/blocks/write`: remove `branchIdOfCourt` from that list and add `import { branchIdOfCourt } from '@/lib/courts/lookup'` above it.

- [ ] **Step 2: Confirm the move broke nothing**

```bash
npx tsc --noEmit && npx vitest run tests/blocks/write.test.ts
```

Expected: no type errors, and `tests/blocks/write.test.ts` PASSES with the same test count as before the move. A `TS2305` naming `branchIdOfCourt` means one of the three import sites was missed.

- [ ] **Step 2b: Create the court-status vocabulary**

Create `src/lib/listings/status.ts`:

```ts
/**
 * The `court_status` enum, its labels, and the banner copy each status shows
 * on the court page.
 *
 * PURE — the court forms are client components and render these, so this
 * module must not be `server-only`. It is also the single home for the union
 * itself: src/lib/listings/queries.ts re-exports the type rather than
 * declaring a second copy, which is what keeps a future fifth status from
 * being added in one place and missed in the other.
 *
 * The banner copy is deliberately different in kind per status: pending and
 * rejected tell the owner what THEY do next, while suspended tells them the
 * next move is not theirs — suspension is an admin action and no edit on
 * this page reverses it (see the re-queue predicate in
 * src/lib/listings/write.ts).
 */
export type CourtStatus = 'pending' | 'approved' | 'rejected' | 'suspended'

/** Display order: what an owner wants to see first, not enum order. */
export const COURT_STATUSES = ['approved', 'pending', 'rejected', 'suspended'] as const

export const COURT_STATUS_LABELS: Record<CourtStatus, string> = {
  approved: 'Approved',
  pending: 'Pending',
  rejected: 'Rejected',
  suspended: 'Suspended',
}

export const COURT_STATUS_BANNERS: Record<CourtStatus, { title: string; body: string }> = {
  approved: {
    title: 'Approved',
    body: 'Players can find and book this court. Changing its hours, prices, or environment sends it back for approval.',
  },
  pending: {
    title: 'Awaiting approval',
    body: 'Our team is reviewing this court. It stays off search and your venue page until it is approved.',
  },
  rejected: {
    title: 'Changes needed',
    body: 'Fix the point below and save — any change to the hours, prices, or environment puts this court back in the queue automatically.',
  },
  suspended: {
    title: 'Suspended',
    body: 'This court has been taken off the market by our team. Editing it here will not restore it — contact support.',
  },
}
```

- [ ] **Step 3: Add the foreign-key SQLSTATE constant**

In `src/lib/db/sql-state.ts`, append after `PG_CHECK_VIOLATION`:

```ts
/**
 * A referenced row does not exist (or a referencing row still does). Raised
 * here when a court is inserted against a branch that was deleted between the
 * guard and the write — a normal outcome to report, not an exception.
 */
export const PG_FOREIGN_KEY_VIOLATION = '23503'
```

- [ ] **Step 4: Write the failing write tests**

Create `tests/listings/write.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBranchWithCourts, seedOwner, teardownFixtures } from '../helpers/fixtures'
import { branchIdOfCourt } from '@/lib/courts/lookup'
import {
  createBranch,
  createCourt,
  replaceOperatingHours,
  replaceRateBands,
  updateBranch,
  updateCourtFields,
} from '@/lib/listings/write'
import type { BranchFields } from '@/lib/listings/fields'

afterAll(teardownFixtures)

const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555'

/**
 * Court statuses are flipped with raw SQL rather than through an admin
 * action: Slice C's approval queue does not exist yet, and the spec
 * explicitly sequences B before C by having B's tests do exactly this.
 */
async function setStatus(courtId: string, status: string, rejectionReason: string | null = null) {
  await db.execute(sql`
    update courts set status = ${status}::court_status, rejection_reason = ${rejectionReason}
    where id = ${courtId}::uuid
  `)
}

async function statusOf(courtId: string) {
  const result = await db.execute(sql`
    select status::text as status, rejection_reason from courts where id = ${courtId}::uuid
  `)
  return result.rows[0] as { status: string; rejection_reason: string | null }
}

function branchFields(overrides: Partial<BranchFields> = {}): BranchFields {
  return {
    name: 'Rally Point',
    description: null,
    address: '9 Katipunan Ave',
    city: 'Quezon City',
    contactPhone: null,
    contactEmail: null,
    amenities: [],
    lat: null,
    lng: null,
    ...overrides,
  }
}

// ----------------------------------------------------------------- branches

test('createBranch inserts a branch whose slug is derived from its name', async () => {
  const ownerId = await seedOwner()
  const result = await createBranch({ ownerId, fields: branchFields({ name: 'Rally Point BGC' }) })

  expect(result).toMatchObject({ ok: true, slug: 'rally-point-bgc' })
  if (!result.ok) throw new Error('unreachable')

  const row = await db.execute(sql`
    select owner_id, name, city, address from branches where id = ${result.branchId}::uuid
  `)
  expect(row.rows[0]).toMatchObject({
    owner_id: ownerId,
    name: 'Rally Point BGC',
    city: 'Quezon City',
    address: '9 Katipunan Ave',
  })
})

test('createBranch gives a second branch of the same name a different slug', async () => {
  // branches.slug is UNIQUE and public. Two owners naming their venue
  // "Rally Point" is normal; a 23505 escaping to the form is not.
  const ownerId = await seedOwner()
  const first = await createBranch({ ownerId, fields: branchFields({ name: 'Rally Point' }) })
  const second = await createBranch({ ownerId, fields: branchFields({ name: 'Rally Point' }) })

  expect(first).toMatchObject({ ok: true })
  expect(second).toMatchObject({ ok: true })
  if (!first.ok || !second.ok) throw new Error('unreachable')
  expect(second.slug).not.toBe(first.slug)
  expect(second.slug.startsWith('rally-point-')).toBe(true)
})

test('createBranch stores amenities and the map pin', async () => {
  const ownerId = await seedOwner()
  const result = await createBranch({
    ownerId,
    fields: branchFields({
      amenities: ['parking', 'showers'],
      lat: 14.6507,
      lng: 121.1029,
      description: 'Two indoor courts.',
      contactPhone: '0917 000 0000',
      contactEmail: 'desk@rallypoint.ph',
    }),
  })
  if (!result.ok) throw new Error('createBranch failed')

  // st_y/st_x, not the raw geography value: the driver hands geography back
  // as a WKB hex string, exactly as getBranchDetail documents.
  const row = await db.execute(sql`
    select amenities, description, contact_phone, contact_email,
           st_y(location::geometry)::float8 as lat, st_x(location::geometry)::float8 as lng
    from branches where id = ${result.branchId}::uuid
  `)
  expect(row.rows[0]).toMatchObject({
    amenities: ['parking', 'showers'],
    description: 'Two indoor courts.',
    contact_phone: '0917 000 0000',
    contact_email: 'desk@rallypoint.ph',
  })
  expect(Number(row.rows[0].lat)).toBeCloseTo(14.6507, 5)
  expect(Number(row.rows[0].lng)).toBeCloseTo(121.1029, 5)
})

test('createBranch stores a null location when no pin was set', async () => {
  // Geocoding is non-blocking per the spec, so "no pin yet" is a real state.
  const ownerId = await seedOwner()
  const result = await createBranch({ ownerId, fields: branchFields() })
  if (!result.ok) throw new Error('createBranch failed')

  const row = await db.execute(
    sql`select location is null as no_pin from branches where id = ${result.branchId}::uuid`,
  )
  expect(row.rows[0].no_pin).toBe(true)
})

test('updateBranch replaces every editable field and leaves the slug alone', async () => {
  // The slug is public (/venues/<slug>) and printed on posters and QR codes.
  // A rename must not break every link that already exists.
  const { branchId } = await seedBranchWithCourts(1)
  const before = await db.execute(sql`select slug from branches where id = ${branchId}::uuid`)

  const result = await updateBranch({
    branchId,
    fields: branchFields({
      name: 'Renamed Courts',
      city: 'Pasig',
      amenities: ['cafe'],
      lat: 14.5764,
      lng: 121.0851,
    }),
  })
  expect(result).toEqual({ ok: true })

  const after = await db.execute(sql`
    select name, city, slug, amenities from branches where id = ${branchId}::uuid
  `)
  expect(after.rows[0]).toMatchObject({
    name: 'Renamed Courts',
    city: 'Pasig',
    slug: before.rows[0].slug,
    amenities: ['cafe'],
  })
})

test('updateBranch never re-queues the branch approved courts', async () => {
  // Spec: "Name, surface, photos, and all branch-level edits do NOT
  // re-queue." A branch rename is not a moderation event.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await updateBranch({ branchId, fields: branchFields({ name: 'Still Approved' }) })
  expect((await statusOf(courtIds[0])).status).toBe('approved')
})

test('updateBranch reports not_found for an unknown branch', async () => {
  expect(await updateBranch({ branchId: UNKNOWN_ID, fields: branchFields() })).toEqual({
    ok: false,
    reason: 'not_found',
  })
})

// ------------------------------------------------------------------- courts

test('createCourt inserts a pending court with no rejection reason', async () => {
  // "A new court inserts as pending" — from the column default, not from an
  // explicit value, so the default can never drift away from the rule.
  const { branchId } = await seedBranchWithCourts(0)
  const result = await createCourt({
    branchId,
    fields: { name: 'Court A', environment: 'outdoor', surface: 'Acrylic' },
  })
  expect(result).toMatchObject({ ok: true })
  if (!result.ok) throw new Error('unreachable')

  const row = await db.execute(sql`
    select name, environment::text as environment, surface, status::text as status, rejection_reason
    from courts where id = ${result.courtId}::uuid
  `)
  expect(row.rows[0]).toEqual({
    name: 'Court A',
    environment: 'outdoor',
    surface: 'Acrylic',
    status: 'pending',
    rejection_reason: null,
  })
  // The court is immediately resolvable back to its branch, which is what
  // every court-scoped guard depends on.
  expect(await branchIdOfCourt(result.courtId)).toBe(branchId)
})

test('createCourt reports branch_missing for an unknown branch', async () => {
  expect(
    await createCourt({
      branchId: UNKNOWN_ID,
      fields: { name: 'Ghost', environment: 'indoor', surface: null },
    }),
  ).toEqual({ ok: false, reason: 'branch_missing' })
})

test('updateCourtFields renames an approved court without re-queueing it', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  const result = await updateCourtFields({
    courtId: courtIds[0],
    fields: { name: 'Center Court', environment: 'indoor', surface: 'Cushioned' },
  })

  expect(result).toEqual({ ok: true, requeued: false })
  const after = await statusOf(courtIds[0])
  expect(after.status).toBe('approved')
  const row = await db.execute(
    sql`select name, surface from courts where id = ${courtIds[0]}::uuid`,
  )
  expect(row.rows[0]).toEqual({ name: 'Center Court', surface: 'Cushioned' })
})

test('updateCourtFields re-queues an approved court when the environment changes', async () => {
  // environment IS a key field: an indoor court that became outdoor is a
  // materially different listing and has to be looked at again.
  const { courtIds } = await seedBranchWithCourts(1)
  const result = await updateCourtFields({
    courtId: courtIds[0],
    fields: { name: 'Court 1', environment: 'outdoor', surface: null },
  })

  expect(result).toEqual({ ok: true, requeued: true })
  expect(await statusOf(courtIds[0])).toEqual({ status: 'pending', rejection_reason: null })
})

test('updateCourtFields re-queues a rejected court and clears its rejection reason', async () => {
  // The fix-and-resubmit path. There is no separate resubmit button by
  // design; the edit IS the resubmission, and a stale rejection reason on a
  // pending court would read as a fresh rejection.
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'rejected', 'Photos do not show the court.')

  const result = await updateCourtFields({
    courtId: courtIds[0],
    fields: { name: 'Court 1', environment: 'outdoor', surface: null },
  })

  expect(result).toEqual({ ok: true, requeued: true })
  expect(await statusOf(courtIds[0])).toEqual({ status: 'pending', rejection_reason: null })
})

test('updateCourtFields leaves a suspended court suspended', async () => {
  // Suspension is an admin action. An owner must not be able to edit their
  // way back onto the market — which is why the transition predicate is
  // `status in ('approved','rejected')`, not `status <> 'suspended'`.
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'suspended')

  const result = await updateCourtFields({
    courtId: courtIds[0],
    fields: { name: 'Court 1', environment: 'outdoor', surface: null },
  })

  expect(result).toEqual({ ok: true, requeued: false })
  expect((await statusOf(courtIds[0])).status).toBe('suspended')
  // The edit itself still landed — suspension freezes the STATUS, not the row.
  const row = await db.execute(
    sql`select environment::text as environment from courts where id = ${courtIds[0]}::uuid`,
  )
  expect(row.rows[0].environment).toBe('outdoor')
})

test('updateCourtFields reports requeued false for a court already pending', async () => {
  // Nothing visible changed, so the form must not claim "back in the queue".
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')

  const result = await updateCourtFields({
    courtId: courtIds[0],
    fields: { name: 'Court 1', environment: 'outdoor', surface: null },
  })

  expect(result).toEqual({ ok: true, requeued: false })
  expect((await statusOf(courtIds[0])).status).toBe('pending')
})

test('updateCourtFields reports not_found for an unknown court', async () => {
  expect(
    await updateCourtFields({
      courtId: UNKNOWN_ID,
      fields: { name: 'Ghost', environment: 'indoor', surface: null },
    }),
  ).toEqual({ ok: false, reason: 'not_found' })
})

// ---------------------------------------------------------- operating hours

test('replaceOperatingHours replaces the whole week and re-queues an approved court', async () => {
  // A REPLACE, not a merge: the form always submits all seven rows, so the
  // submitted set IS the new week. Merging would make a day impossible to
  // close.
  const { courtIds } = await seedBranchWithCourts(1)
  const result = await replaceOperatingHours({
    courtId: courtIds[0],
    days: [
      { dayOfWeek: 5, opensHour: 7, closesHour: 22 },
      { dayOfWeek: 6, opensHour: 6, closesHour: 24 },
    ],
  })

  expect(result).toEqual({ ok: true, requeued: true })
  expect(await statusOf(courtIds[0])).toEqual({ status: 'pending', rejection_reason: null })

  const rows = await db.execute(sql`
    select day_of_week, opens_hour, closes_hour from court_operating_hours
    where court_id = ${courtIds[0]}::uuid order by day_of_week
  `)
  expect(rows.rows.map((r) => Number(r.day_of_week))).toEqual([5, 6])
  expect(rows.rows.map((r) => Number(r.opens_hour))).toEqual([7, 6])
})

test('replaceOperatingHours rejects an invalid week without touching the stored rows', async () => {
  // Atomicity that matters: a half-applied week would leave the court open
  // on days the owner closed.
  const { courtIds } = await seedBranchWithCourts(1)
  const result = await replaceOperatingHours({
    courtId: courtIds[0],
    days: [{ dayOfWeek: 1, opensHour: 20, closesHour: 8 }],
  })

  expect(result).toEqual({ ok: false, reason: 'invalid_window' })
  const rows = await db.execute(
    sql`select count(*)::int as n from court_operating_hours where court_id = ${courtIds[0]}::uuid`,
  )
  expect(Number(rows.rows[0].n)).toBe(7)
  expect((await statusOf(courtIds[0])).status).toBe('approved')
})

test('replaceOperatingHours rejects an all-closed week', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  expect(await replaceOperatingHours({ courtId: courtIds[0], days: [] })).toEqual({
    ok: false,
    reason: 'no_open_day',
  })
})

test('replaceOperatingHours reports not_found for an unknown court', async () => {
  expect(
    await replaceOperatingHours({
      courtId: UNKNOWN_ID,
      days: [{ dayOfWeek: 1, opensHour: 9, closesHour: 17 }],
    }),
  ).toEqual({ ok: false, reason: 'not_found' })
})

// -------------------------------------------------------------- rate bands

test('replaceRateBands replaces the bands and re-queues an approved court', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  const result = await replaceRateBands({
    courtId: courtIds[0],
    bands: [
      { startHour: 11, endHour: 18, priceCentavos: 28000 },
      { startHour: 18, endHour: 24, priceCentavos: 39000 },
    ],
  })

  expect(result).toEqual({ ok: true, requeued: true })
  expect(await statusOf(courtIds[0])).toEqual({ status: 'pending', rejection_reason: null })

  const rows = await db.execute(sql`
    select start_hour, end_hour, price_centavos from court_rate_bands
    where court_id = ${courtIds[0]}::uuid order by start_hour
  `)
  expect(rows.rows.map((r) => Number(r.price_centavos))).toEqual([28000, 39000])
})

test('replaceRateBands rejects bands that do not tile the stored hours, keeping the old bands', async () => {
  // The fixture court is open 11-24 every day. Bands covering only 11-20
  // leave four unpriced hours, which is what makes priceSlots throw
  // "No rate band covers hour 20" in the middle of a player's checkout.
  const { courtIds } = await seedBranchWithCourts(1)
  const result = await replaceRateBands({
    courtId: courtIds[0],
    bands: [{ startHour: 11, endHour: 20, priceCentavos: 28000 }],
  })

  expect(result).toEqual({ ok: false, reason: 'bands_do_not_tile' })
  const rows = await db.execute(
    sql`select count(*)::int as n from court_rate_bands where court_id = ${courtIds[0]}::uuid`,
  )
  expect(Number(rows.rows[0].n)).toBe(3)
  expect((await statusOf(courtIds[0])).status).toBe('approved')
})

test('replaceRateBands reports no_operating_hours when the court has none', async () => {
  // A brand-new court has no hours yet, so there is no span to tile and the
  // bands form has nothing to validate against. Reported as its own reason
  // so the page can say "set your opening hours first".
  const { branchId } = await seedBranchWithCourts(0)
  const created = await createCourt({
    branchId,
    fields: { name: 'Court B', environment: 'indoor', surface: null },
  })
  if (!created.ok) throw new Error('createCourt failed')

  expect(
    await replaceRateBands({
      courtId: created.courtId,
      bands: [{ startHour: 8, endHour: 20, priceCentavos: 25000 }],
    }),
  ).toEqual({ ok: false, reason: 'no_operating_hours' })
})

test('replaceRateBands rejects an empty band list', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  expect(await replaceRateBands({ courtId: courtIds[0], bands: [] })).toEqual({
    ok: false,
    reason: 'no_bands',
  })
})

test('replaceRateBands reports not_found for an unknown court', async () => {
  expect(
    await replaceRateBands({
      courtId: UNKNOWN_ID,
      bands: [{ startHour: 11, endHour: 24, priceCentavos: 25000 }],
    }),
  ).toEqual({ ok: false, reason: 'not_found' })
})

test('a rejected court returns to pending through a rate-band edit', async () => {
  // The full spec'd path, end to end: rejected -> key-field edit -> pending
  // with the reason cleared, no resubmit button anywhere.
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'rejected', 'Peak pricing is missing.')

  const result = await replaceRateBands({
    courtId: courtIds[0],
    bands: [
      { startHour: 11, endHour: 17, priceCentavos: 26500 },
      { startHour: 17, endHour: 24, priceCentavos: 38000 },
    ],
  })

  expect(result).toEqual({ ok: true, requeued: true })
  expect(await statusOf(courtIds[0])).toEqual({ status: 'pending', rejection_reason: null })
})

test('an hours edit re-queues a rejected court too', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'rejected', 'Opening hours look wrong.')

  const result = await replaceOperatingHours({
    courtId: courtIds[0],
    days: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opensHour: 11, closesHour: 24 })),
  })

  expect(result).toEqual({ ok: true, requeued: true })
  expect(await statusOf(courtIds[0])).toEqual({ status: 'pending', rejection_reason: null })
})
```

- [ ] **Step 5: Write the failing query tests**

Create `tests/listings/queries.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBranchWithCourts, teardownFixtures } from '../helpers/fixtures'
import { getListingBranch, getListingBranches, getListingCourt } from '@/lib/listings/queries'

afterAll(teardownFixtures)

const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555'

async function setStatus(courtId: string, status: string, rejectionReason: string | null = null) {
  await db.execute(sql`
    update courts set status = ${status}::court_status, rejection_reason = ${rejectionReason}
    where id = ${courtId}::uuid
  `)
}

async function addBranchPhoto(branchId: string, storagePath: string, sortOrder: number) {
  await db.execute(sql`
    insert into branch_photos (branch_id, storage_path, sort_order)
    values (${branchId}::uuid, ${storagePath}, ${sortOrder})
  `)
}

test('getListingBranches counts courts by status and photos per branch', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(3)
  await setStatus(courtIds[0], 'pending')
  await setStatus(courtIds[1], 'rejected', 'Blurry photos.')
  await setStatus(courtIds[2], 'suspended')
  await addBranchPhoto(branchId, `branches/${branchId}/a.jpg`, 0)

  const rows = await getListingBranches([branchId])
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    id: branchId,
    name: 'Fixture Branch',
    city: 'Marikina',
    photoCount: 1,
    courtCounts: { pending: 1, approved: 0, rejected: 1, suspended: 1 },
  })
})

test('getListingBranches returns nothing for an empty scope', async () => {
  // An empty array serializes to the Postgres empty array, so
  // `= any ('{}'::uuid[])` matches nothing — the correct answer for a staff
  // member with no manage_courts grant anywhere.
  expect(await getListingBranches([])).toEqual([])
})

test('getListingBranch returns the editable fields, photos in order, and courts', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  await setStatus(courtIds[0], 'rejected', 'Add a photo of the net.')
  // Deliberately inserted out of order so the ORDER BY is doing real work.
  await addBranchPhoto(branchId, `branches/${branchId}/second.jpg`, 1)
  await addBranchPhoto(branchId, `branches/${branchId}/first.jpg`, 0)

  const branch = await getListingBranch(branchId)
  expect(branch).not.toBeNull()
  expect(branch!.name).toBe('Fixture Branch')
  expect(branch!.city).toBe('Marikina')
  expect(branch!.address).toBe('1 Fixture St')
  expect(branch!.lat).toBeCloseTo(14.6507, 4)
  expect(branch!.lng).toBeCloseTo(121.1029, 4)
  expect(branch!.photos.map((photo) => photo.storagePath)).toEqual([
    `branches/${branchId}/first.jpg`,
    `branches/${branchId}/second.jpg`,
  ])
  expect(branch!.courts).toHaveLength(2)
  const rejected = branch!.courts.find((court) => court.id === courtIds[0])
  expect(rejected).toMatchObject({ status: 'rejected', rejectionReason: 'Add a photo of the net.' })
})

test('getListingBranch returns null for an unknown branch', async () => {
  expect(await getListingBranch(UNKNOWN_ID)).toBeNull()
})

test('getListingCourt returns hours, bands, photos and no warning when the bands tile', async () => {
  // The fixture court is open 11-24 all week with bands 11-15/15-17/17-24 —
  // an exact tiling, which is what "no warning" has to mean.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await db.execute(sql`
    insert into court_photos (court_id, storage_path, sort_order)
    values (${courtIds[0]}::uuid, ${`courts/${courtIds[0]}/a.jpg`}, 0)
  `)

  const court = await getListingCourt(courtIds[0])
  expect(court).not.toBeNull()
  expect(court!.branchId).toBe(branchId)
  expect(court!.branchName).toBe('Fixture Branch')
  expect(court!.status).toBe('approved')
  expect(court!.days).toHaveLength(7)
  expect(court!.days.map((day) => day.dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6])
  expect(court!.bands.map((band) => band.startHour)).toEqual([11, 15, 17])
  expect(court!.bands[0].priceCentavos).toBe(26500)
  expect(court!.photos).toHaveLength(1)
  expect(court!.scheduleWarning).toBeNull()
})

test('getListingCourt warns when the bands no longer cover the opening hours', async () => {
  // Exactly the state an hours-only edit can leave behind: the court page
  // has to say so, because nothing else will until a player hits checkout.
  const { courtIds } = await seedBranchWithCourts(1)
  await db.execute(sql`
    update court_operating_hours set opens_hour = 7 where court_id = ${courtIds[0]}::uuid
  `)

  const court = await getListingCourt(courtIds[0])
  expect(court!.scheduleWarning).toBe('bands_do_not_tile')
})

test('getListingCourt warns when a court has no opening hours at all', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await db.execute(sql`delete from court_operating_hours where court_id = ${courtIds[0]}::uuid`)

  const court = await getListingCourt(courtIds[0])
  expect(court!.scheduleWarning).toBe('no_open_day')
})

test('getListingCourt returns null for an unknown court', async () => {
  expect(await getListingCourt(UNKNOWN_ID)).toBeNull()
})
```

- [ ] **Step 6: Run both new test files and confirm they fail**

```bash
npx vitest run tests/listings/write.test.ts tests/listings/queries.test.ts
```

Expected: FAIL — `Failed to resolve import "@/lib/listings/write"` and `"@/lib/listings/queries"`.

- [ ] **Step 7: Write the write library**

Create `src/lib/listings/write.ts`:

```ts
import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import {
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  sqlStateOf,
} from '@/lib/db/sql-state'
import { slugifyBranchName, type BranchFields, type CourtFields } from '@/lib/listings/fields'
import {
  operatingSpan,
  validateBandShapes,
  validateOperatingHours,
  validateRateBands,
  type BandsFailure,
  type HoursFailure,
  type OperatingHoursDay,
  type RateBand,
} from '@/lib/listings/schedule'

/**
 * Every listing write. Exported for the guarded actions in
 * src/app/dashboard/listings/*.ts, which are the only production callers.
 *
 * The lifecycle rules live here rather than in the actions because they are
 * the part worth testing: a key-field edit (rate bands, operating hours,
 * environment) re-queues an `approved` or `rejected` court to `pending` and
 * clears its rejection_reason; a name/surface/photo/branch edit does not; and
 * a `suspended` court never moves, because suspension is an admin action an
 * owner must not be able to edit their way out of.
 */

/**
 * The status transition, as ONE status-scoped UPDATE.
 *
 * Zero rows is a meaningful answer, not an error: the court was already
 * `pending` (nothing visible changed) or `suspended` (it must not move). No
 * read-then-write, so two concurrent edits cannot race into an inconsistent
 * status — the same shape as the blocks slice's writes and as Slice C's
 * approve/reject will use.
 */
function requeueCourtSql(courtId: string): SQL {
  return sql`
    update courts set status = 'pending', rejection_reason = null
    where id = ${courtId}::uuid and status in ('approved', 'rejected')
    returning id
  `
}

/**
 * `branches.location` is `geography(Point, 4326)`. st_makepoint takes
 * (x, y) = (longitude, latitude) — in that order, which is the reverse of
 * how humans say it and the single easiest thing to get wrong here.
 * Matches tests/helpers/fixtures.ts's seed exactly.
 */
function locationSql(fields: BranchFields): SQL {
  if (fields.lat === null || fields.lng === null) return sql`null`
  return sql`st_setsrid(st_makepoint(${fields.lng}, ${fields.lat}), 4326)::geography`
}

export type CreateBranchResult =
  | { ok: true; branchId: string; slug: string }
  | { ok: false; reason: 'slug_unavailable' }

/**
 * How many slugs to try before giving up. The first is the clean one derived
 * from the name; the rest carry a short random suffix. Five is far past the
 * point where a collision is anything but a name every owner in the country
 * chose — and giving up with a friendly reason beats looping forever.
 */
const SLUG_ATTEMPTS = 5

export async function createBranch(input: {
  ownerId: string
  fields: BranchFields
}): Promise<CreateBranchResult> {
  const base = slugifyBranchName(input.fields.name)

  // Try-and-catch rather than select-then-insert: branches.slug is UNIQUE, so
  // the constraint is the authority. A "is this slug free?" SELECT would be
  // a TOCTOU window that two owners registering "Rally Point" at the same
  // moment would walk straight through.
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${crypto.randomUUID().slice(0, 6)}`
    try {
      const result = await db.execute(sql`
        insert into branches (
          owner_id, name, slug, description, address, city, amenities,
          contact_phone, contact_email, location
        ) values (
          ${input.ownerId}::uuid, ${input.fields.name}, ${slug}, ${input.fields.description},
          ${input.fields.address}, ${input.fields.city},
          ${sql.param(input.fields.amenities)}::text[],
          ${input.fields.contactPhone}, ${input.fields.contactEmail},
          ${locationSql(input.fields)}
        )
        returning id, slug
      `)
      return {
        ok: true,
        branchId: result.rows[0].id as string,
        slug: result.rows[0].slug as string,
      }
    } catch (error) {
      if (sqlStateOf(error) !== PG_UNIQUE_VIOLATION) throw error
    }
  }

  return { ok: false, reason: 'slug_unavailable' }
}

export type UpdateBranchResult = { ok: true } | { ok: false; reason: 'not_found' }

/**
 * Replaces every editable branch field.
 *
 * The SLUG IS NOT TOUCHED. It is the public /venues/<slug> URL, printed on
 * posters and linked from search results and player receipts; a rename that
 * silently moved the page would break all of them. Renaming the URL is a
 * separate, deliberate operation that this product does not offer.
 *
 * Branch edits never touch court statuses — spec: "all branch-level edits do
 * not re-queue."
 */
export async function updateBranch(input: {
  branchId: string
  fields: BranchFields
}): Promise<UpdateBranchResult> {
  const result = await db.execute(sql`
    update branches set
      name = ${input.fields.name},
      description = ${input.fields.description},
      address = ${input.fields.address},
      city = ${input.fields.city},
      amenities = ${sql.param(input.fields.amenities)}::text[],
      contact_phone = ${input.fields.contactPhone},
      contact_email = ${input.fields.contactEmail},
      location = ${locationSql(input.fields)}
    where id = ${input.branchId}::uuid
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'not_found' }
}

export type CreateCourtResult =
  | { ok: true; courtId: string }
  | { ok: false; reason: 'branch_missing' }

/**
 * A new court. `status` and `rejection_reason` are left to the column
 * defaults ('pending', null) rather than written explicitly, so the rule "a
 * new court inserts as pending" has exactly one home — the schema.
 */
export async function createCourt(input: {
  branchId: string
  fields: CourtFields
}): Promise<CreateCourtResult> {
  try {
    const result = await db.execute(sql`
      insert into courts (branch_id, name, environment, surface)
      values (
        ${input.branchId}::uuid, ${input.fields.name},
        ${input.fields.environment}::court_environment, ${input.fields.surface}
      )
      returning id
    `)
    return { ok: true, courtId: result.rows[0].id as string }
  } catch (error) {
    // The branch was deleted between the guard and the write. Reported, not
    // thrown — the form says "that branch no longer exists".
    if (sqlStateOf(error) === PG_FOREIGN_KEY_VIOLATION) {
      return { ok: false, reason: 'branch_missing' }
    }
    throw error
  }
}

export type CourtWriteResult =
  | { ok: true; requeued: boolean }
  | { ok: false; reason: 'not_found' | 'no_operating_hours' | HoursFailure | BandsFailure }

/**
 * Court name, environment and surface.
 *
 * `environment` is the only key field of the three, so the re-queue is
 * conditional on it actually CHANGING — saving the form without touching the
 * radio must not knock an approved court off the market. The `for update`
 * lock on the pre-read is what makes "did it change?" trustworthy against a
 * concurrent edit: without it two simultaneous saves could both read the old
 * value and both decide nothing changed.
 *
 * Returning `{ ok: false }` from inside the transaction does NOT roll it
 * back in Drizzle — that is fine here and in the two functions below, because
 * every early return happens before any write.
 */
export async function updateCourtFields(input: {
  courtId: string
  fields: CourtFields
}): Promise<CourtWriteResult> {
  return db.transaction(
    async (tx) => {
      const before = await tx.execute(sql`
        select environment::text as environment from courts
        where id = ${input.courtId}::uuid
        for update
      `)
      if (before.rows.length === 0) return { ok: false as const, reason: 'not_found' as const }

      await tx.execute(sql`
        update courts set
          name = ${input.fields.name},
          surface = ${input.fields.surface},
          environment = ${input.fields.environment}::court_environment
        where id = ${input.courtId}::uuid
      `)

      if (before.rows[0].environment === input.fields.environment) {
        return { ok: true as const, requeued: false }
      }

      const requeued = await tx.execute(requeueCourtSql(input.courtId))
      return { ok: true as const, requeued: requeued.rows.length > 0 }
    },
    { isolationLevel: 'read committed' },
  )
}

/**
 * The court's whole week, replaced atomically.
 *
 * Delete-then-insert-then-re-queue in ONE transaction: a partially applied
 * week would leave the court open on days the owner just closed, and
 * court_operating_hours_unique_day means an insert-first strategy would
 * collide with the rows it is replacing.
 *
 * Deliberately does NOT check that the existing rate bands still tile the new
 * hours. Refusing here would deadlock the owner — the bands form validates
 * against the STORED hours, so they could not widen the bands first either.
 * The court is re-queued to `pending` (off every public surface, since public
 * reads filter to `approved`) and getListingCourt's `scheduleWarning` tells
 * them to fix the bands next.
 */
export async function replaceOperatingHours(input: {
  courtId: string
  days: OperatingHoursDay[]
}): Promise<CourtWriteResult> {
  // Re-validated here, not merely trusted from the action: this module is the
  // last thing between a caller and a 23514/23505 from the column CHECKs.
  const failure = validateOperatingHours(input.days)
  if (failure !== null) return { ok: false, reason: failure }

  return db.transaction(
    async (tx) => {
      const court = await tx.execute(sql`
        select id from courts where id = ${input.courtId}::uuid for update
      `)
      if (court.rows.length === 0) return { ok: false as const, reason: 'not_found' as const }

      await tx.execute(sql`
        delete from court_operating_hours where court_id = ${input.courtId}::uuid
      `)
      for (const day of input.days) {
        await tx.execute(sql`
          insert into court_operating_hours (court_id, day_of_week, opens_hour, closes_hour)
          values (${input.courtId}::uuid, ${day.dayOfWeek}, ${day.opensHour}, ${day.closesHour})
        `)
      }

      const requeued = await tx.execute(requeueCourtSql(input.courtId))
      return { ok: true as const, requeued: requeued.rows.length > 0 }
    },
    { isolationLevel: 'read committed' },
  )
}

/**
 * The court's whole price schedule, replaced atomically.
 *
 * The tiling check lives HERE and not in the pure parser because the span it
 * validates against — `[min(opens_hour), max(closes_hour)]` across the week —
 * is stored data. Read inside the same transaction as the write, behind the
 * court's `for update` lock, so a concurrent hours change cannot slip a
 * different span between the check and the insert.
 *
 * court_rate_bands_no_overlap would catch overlaps on its own (23P01), but
 * never gaps — supabase/migrations/20260801063910_listings.sql says so
 * explicitly — and a gap is the worse failure: it surfaces as priceSlots()
 * throwing "No rate band covers hour N" in the middle of a player's checkout.
 */
export async function replaceRateBands(input: {
  courtId: string
  bands: RateBand[]
}): Promise<CourtWriteResult> {
  if (input.bands.length === 0) return { ok: false, reason: 'no_bands' }
  const shapeFailure = validateBandShapes(input.bands)
  if (shapeFailure !== null) return { ok: false, reason: shapeFailure }

  return db.transaction(
    async (tx) => {
      const court = await tx.execute(sql`
        select id from courts where id = ${input.courtId}::uuid for update
      `)
      if (court.rows.length === 0) return { ok: false as const, reason: 'not_found' as const }

      const hours = await tx.execute(sql`
        select day_of_week, opens_hour, closes_hour from court_operating_hours
        where court_id = ${input.courtId}::uuid
      `)
      const span = operatingSpan(
        hours.rows.map((row) => ({
          dayOfWeek: Number(row.day_of_week),
          opensHour: Number(row.opens_hour),
          closesHour: Number(row.closes_hour),
        })),
      )
      if (span === null) return { ok: false as const, reason: 'no_operating_hours' as const }

      const failure = validateRateBands(input.bands, span)
      if (failure !== null) return { ok: false as const, reason: failure }

      await tx.execute(sql`
        delete from court_rate_bands where court_id = ${input.courtId}::uuid
      `)
      for (const band of input.bands) {
        await tx.execute(sql`
          insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
          values (
            ${input.courtId}::uuid, ${band.startHour}, ${band.endHour}, ${band.priceCentavos}
          )
        `)
      }

      const requeued = await tx.execute(requeueCourtSql(input.courtId))
      return { ok: true as const, requeued: requeued.rows.length > 0 }
    },
    { isolationLevel: 'read committed' },
  )
}
```

- [ ] **Step 8: Write the query library**

Create `src/lib/listings/queries.ts`:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { CourtEnvironment } from '@/lib/listings/fields'
import type { CourtStatus } from '@/lib/listings/status'
import {
  operatingSpan,
  validateRateBands,
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
  courtCounts: Record<CourtStatus, number>
}

export type ListingCourtSummary = {
  id: string
  name: string
  environment: CourtEnvironment
  surface: string | null
  status: CourtStatus
  rejectionReason: string | null
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

  const courts = await db.execute(sql`
    select id, name, environment::text as environment, surface,
           status::text as status, rejection_reason
    from courts where branch_id = ${branchId}::uuid
    order by name, id
  `)

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
    courts: courts.rows.map((court) => ({
      id: court.id as string,
      name: court.name as string,
      environment: court.environment as CourtEnvironment,
      surface: (court.surface as string | null) ?? null,
      status: court.status as CourtStatus,
      rejectionReason: (court.rejection_reason as string | null) ?? null,
    })),
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

  const span = operatingSpan(days)
  // 'no_open_day' covers the brand-new court that has no hours yet as well as
  // one whose hours were deleted: either way the bands have nothing to tile
  // and the page's next instruction is the same.
  const scheduleWarning = span === null ? 'no_open_day' : validateRateBands(bands, span)

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
```

- [ ] **Step 9: Run the new tests and confirm they pass**

```bash
npx vitest run tests/listings/write.test.ts tests/listings/queries.test.ts
```

Expected: PASS — 26 tests in `write.test.ts`, 8 in `queries.test.ts`.

- [ ] **Step 10: Run them a second time**

```bash
npx vitest run tests/listings/write.test.ts tests/listings/queries.test.ts
```

Expected: PASS again. The database keeps rows between runs, so a test that only passes once is a broken test. Every row above hangs off a freshly seeded owner/branch, and `createBranch`'s slug retry is exactly what keeps the repeated `'Rally Point'` names from colliding across runs — a second failure here on run two means the retry loop is wrong.

- [ ] **Step 11: Typecheck, lint, full suite**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: no type errors; lint reports only the pre-existing warnings; all tests pass. If one of the known flaky files times out, re-run that file alone before investigating.

- [ ] **Step 12: Commit**

```bash
git add src/lib/courts/lookup.ts src/lib/listings/status.ts src/lib/listings/write.ts src/lib/listings/queries.ts src/lib/db/sql-state.ts src/lib/blocks/write.ts src/app/dashboard/blocks/actions.ts tests/blocks/write.test.ts tests/listings/write.test.ts tests/listings/queries.test.ts
git commit -m "Add listing write and read libraries with the court re-queue lifecycle"
```

---

### Task 4: The guarded listing actions, and the permission matrix that pins them

**Files:**
- Create: `src/app/dashboard/listings/actions.ts`
- Create: `tests/listings/permissions.test.ts`

**Interfaces:**
- Produces, from `src/app/dashboard/listings/actions.ts` (a `'use server'` file — **every export below is async, and the only non-function export is the state `type`**):

```ts
export type ListingFormState = { ok: true; message: string } | { error: string } | null

export async function createBranchAction(prev: ListingFormState, formData: FormData): Promise<ListingFormState>
export async function updateBranchAction(prev: ListingFormState, formData: FormData): Promise<ListingFormState>
export async function createCourtAction(prev: ListingFormState, formData: FormData): Promise<ListingFormState>
export async function updateCourtAction(prev: ListingFormState, formData: FormData): Promise<ListingFormState>
export async function updateOperatingHoursAction(prev: ListingFormState, formData: FormData): Promise<ListingFormState>
export async function updateRateBandsAction(prev: ListingFormState, formData: FormData): Promise<ListingFormState>
```
- Consumes: `requireOwner` / `requireOwnerOf` / `requireBranchAccess` / `requireUser` / `AuthError` from `@/lib/auth/guards`, `branchIdOfCourt` from `@/lib/courts/lookup`, and Tasks 1–3's libraries.

**The permission table, implemented exactly as the spec states it:**

| Action | Guard | Branch id from |
|---|---|---|
| `createBranchAction` | `requireOwner` | — (owner creates under their own id) |
| `updateBranchAction` | `requireOwnerOf(branchId)` | the form, **and** every `WHERE` is scoped by the same id |
| `createCourtAction` | `requireOwnerOf(branchId)` | the form, same scoping |
| `updateCourtAction` | `requireBranchAccess(branchId, 'manage_courts')` | **the court row** |
| `updateOperatingHoursAction` | `requireBranchAccess(branchId, 'manage_courts')` | **the court row** |
| `updateRateBandsAction` | `requireBranchAccess(branchId, 'manage_courts')` | **the court row** |

A submitted `branchId` is safe to guard on for the three branch-scoped actions — exactly as `src/app/dashboard/staff/actions.ts` documents — because each write is *also* scoped by that same id in its own `WHERE`: an owner who forges one either fails the guard (not their branch) or passes it and matches no row. The three court-scoped actions cannot do that, because the write targets a court, so they resolve the branch from the court row instead (the blocks pattern).

- [ ] **Step 1: Write the failing permission matrix tests**

Create `tests/listings/permissions.test.ts`:

```ts
import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  seedBranchWithCourts,
  seedPlayer,
  seedStaffGrant,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

/**
 * The spec's permission table, asserted against the real guards.
 *
 * Only the SESSION boundary is stubbed — the same `vi.mock` the guards' own
 * tests use (tests/auth/guards.test.ts). Everything below it (the profiles
 * lookup, the ownership join, the branch_staff grant read) hits the real
 * database, which is the whole point: this is the file that would fail if
 * `manage_courts` ever stopped meaning what the listings actions assume.
 *
 * The actions themselves are not called here. They invoke revalidatePath()
 * and redirect(), which throw outside a request context; the project's
 * convention (tests/bookings/review-action.test.ts) is to test the guards and
 * the server-only lib, with tests/auth/action-coverage.test.ts proving every
 * 'use server' file calls a guard at all.
 */
const claims = vi.hoisted(() => ({ value: null as null | { sub: string } }))

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getClaims: async () => ({ data: claims.value ? { claims: claims.value } : null }) },
  }),
}))

const { AuthError, requireBranchAccess, requireOwner, requireOwnerOf } = await import(
  '@/lib/auth/guards'
)
const { branchIdOfCourt } = await import('@/lib/courts/lookup')

function signInAs(userId: string) {
  claims.value = { sub: userId }
}

beforeEach(() => {
  claims.value = null
})

async function expectForbidden(promise: Promise<unknown>) {
  await expect(promise).rejects.toBeInstanceOf(AuthError)
  await promise.catch((error) => expect((error as InstanceType<typeof AuthError>).status).toBe(403))
}

test('the branch owner may manage courts on their own branch', async () => {
  const { ownerId, branchId } = await seedBranchWithCourts(1)
  signInAs(ownerId)
  await expect(requireBranchAccess(branchId, 'manage_courts')).resolves.toMatchObject({
    id: ownerId,
  })
})

test('staff holding manage_courts on that branch may manage its courts', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, manageCourts: true })

  signInAs(staffId)
  await expect(requireBranchAccess(branchId, 'manage_courts')).resolves.toMatchObject({
    id: staffId,
  })
})

test('staff with a grant on that branch but no manage_courts flag are refused', async () => {
  // The grant exists, so requireBranchAccess finds a row — this asserts it
  // reads the FLAG, not merely the row's existence.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, viewBookings: true, blockSlots: true })

  signInAs(staffId)
  await expectForbidden(requireBranchAccess(branchId, 'manage_courts'))
})

test('staff holding manage_courts on a different branch are refused', async () => {
  // Per-branch, not per-person: the permission model's whole point.
  const granted = await seedBranchWithCourts(1)
  const other = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: granted.branchId, userId: staffId, manageCourts: true })

  signInAs(staffId)
  await expect(requireBranchAccess(granted.branchId, 'manage_courts')).resolves.toBeTruthy()
  await expectForbidden(requireBranchAccess(other.branchId, 'manage_courts'))
})

test('a signed-in stranger is refused', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const strangerId = await seedPlayer()

  signInAs(strangerId)
  await expectForbidden(requireBranchAccess(branchId, 'manage_courts'))
})

test('a signed-out visitor is refused with 401', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  await expect(requireBranchAccess(branchId, 'manage_courts')).rejects.toMatchObject({ status: 401 })
})

test('staff with manage_courts still cannot create courts or edit branch fields', async () => {
  // createCourtAction and updateBranchAction guard requireOwnerOf, not
  // requireBranchAccess — the spec is explicit that staff never create
  // branches or courts and never edit branch-level fields.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, manageCourts: true })

  signInAs(staffId)
  await expectForbidden(requireOwnerOf(branchId))
})

test('staff with manage_courts still cannot create a branch', async () => {
  // createBranchAction guards requireOwner, which is a ROLE check: staff
  // remain role='player' by construction (see the roles slice).
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, manageCourts: true })

  signInAs(staffId)
  await expectForbidden(requireOwner())
})

test('the owner passes both the branch-scoped and the role-level owner guards', async () => {
  const { ownerId, branchId } = await seedBranchWithCourts(1)
  signInAs(ownerId)
  await expect(requireOwnerOf(branchId)).resolves.toMatchObject({ id: ownerId })
  await expect(requireOwner()).resolves.toMatchObject({ id: ownerId })
})

test('a court resolves to its own branch, so a granted branch cannot be borrowed', async () => {
  // The confused-deputy case the court-scoped actions are built to prevent:
  // a staff member with manage_courts on branch A submits branch B's court
  // id. Because the branch is read from the COURT row rather than the form,
  // the guard is asked about B and refuses.
  const granted = await seedBranchWithCourts(1)
  const other = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: granted.branchId, userId: staffId, manageCourts: true })

  const resolved = await branchIdOfCourt(other.courtIds[0])
  expect(resolved).toBe(other.branchId)
  expect(resolved).not.toBe(granted.branchId)

  signInAs(staffId)
  await expectForbidden(requireBranchAccess(resolved!, 'manage_courts'))
})

test('a court id that does not exist resolves to null and never reaches a guard', async () => {
  // The action returns its generic bad-input message on null, so a forged id
  // cannot be used to probe which court ids exist.
  expect(await branchIdOfCourt('11111111-2222-3333-4444-555555555555')).toBeNull()
})

test('an admin passes the branch-scoped guard on a branch they do not own', async () => {
  // requireBranchAccess short-circuits for admins by design (see its
  // docstring). Pinned here so a future narrowing of the listings guards
  // cannot lock moderators out silently.
  const { branchId } = await seedBranchWithCourts(1)
  const adminId = await seedPlayer()
  await db.execute(sql`update profiles set role = 'admin' where id = ${adminId}::uuid`)

  signInAs(adminId)
  await expect(requireBranchAccess(branchId, 'manage_courts')).resolves.toMatchObject({
    id: adminId,
  })
})
```

- [ ] **Step 2: Run the permission tests and confirm they pass already**

```bash
npx vitest run tests/listings/permissions.test.ts
```

Expected: PASS — 12 tests. **These pass before the actions exist**, and that is the point: they pin the guards the actions are about to be written against, so Step 3 has a specification rather than a preference. If any fails, the guards do not mean what this task assumes and the actions must not be written yet.

- [ ] **Step 3: Write the actions**

Create `src/app/dashboard/listings/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import {
  AuthError,
  requireBranchAccess,
  requireOwner,
  requireOwnerOf,
  requireUser,
} from '@/lib/auth/guards'
import { branchIdOfCourt } from '@/lib/courts/lookup'
import {
  BRANCH_FIELDS_FAILURE_MESSAGES,
  COURT_FIELDS_FAILURE_MESSAGES,
  parseBranchFields,
  parseCourtFields,
} from '@/lib/listings/fields'
import {
  BANDS_FAILURE_MESSAGES,
  HOURS_FAILURE_MESSAGES,
  parseOperatingHours,
  parseRateBands,
} from '@/lib/listings/schedule'
import {
  createBranch,
  createCourt,
  replaceOperatingHours,
  replaceRateBands,
  updateBranch,
  updateCourtFields,
  type CourtWriteResult,
} from '@/lib/listings/write'

/**
 * Listings management, for /dashboard/listings/*.
 *
 * This file exports nothing but six async guarded actions and the
 * `ListingFormState` type they return — every OTHER export of a 'use server'
 * file becomes a client-invokable endpoint. All parsing and all SQL live in
 * the `import 'server-only'` modules under src/lib/listings/ and src/lib/
 * courts/, where they are unit-tested; the helpers below are module-private
 * for exactly that reason.
 *
 * TWO GUARD SHAPES, per the spec's permission table:
 *   - Branch-scoped writes (create branch, edit branch fields, create court)
 *     are OWNER-ONLY: requireOwner / requireOwnerOf. A submitted branchId is
 *     safe to guard on because every write is also scoped by that same id in
 *     its WHERE clause — the same argument src/app/dashboard/staff/actions.ts
 *     makes.
 *   - Court-scoped writes (court fields, operating hours, rate bands) are
 *     shared with staff: requireBranchAccess(branchId, 'manage_courts'), with
 *     branchId read from the COURT ROW, never from the form. That is what
 *     stops a staff member with a grant on branch A from editing branch B's
 *     court by submitting its id.
 *
 * Every action takes useActionState's (prevState, formData) shape. The
 * previous state is unused — each submission is judged on its own input — but
 * the parameter must exist for React to bind the action to the form's state.
 */
export type ListingFormState = { ok: true; message: string } | { error: string } | null

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOT_YOUR_BRANCH = "That branch isn't yours to manage."
const NO_COURT_ACCESS = "You don't have permission to manage courts at that branch."
const BAD_TARGET = "That doesn't look right — reload the page and try again."
const SAVED = 'Saved.'
const SAVED_AND_REQUEUED = 'Saved. This court is back in the approval queue.'

/**
 * Shape-checks an id before it reaches a guard that interpolates it into a
 * `::uuid` cast — a malformed value raises 22P02 and escapes as an unhandled
 * exception instead of a form error.
 */
function idFrom(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '')
  return UUID_RE.test(value) ? value : null
}

/** Maps a CourtWriteResult failure to a sentence, reusing the libraries' own message maps. */
function courtWriteMessage(reason: Extract<CourtWriteResult, { ok: false }>['reason']): string {
  if (reason === 'not_found') return 'That court no longer exists.'
  if (reason === 'no_operating_hours') {
    return "Set this court's opening hours before you price it."
  }
  // Narrowed to HoursFailure here and to BandsFailure below, so both message
  // maps are reused verbatim rather than restated — one wording per rule.
  if (reason === 'no_open_day' || reason === 'invalid_window') {
    return HOURS_FAILURE_MESSAGES[reason]
  }
  return BANDS_FAILURE_MESSAGES[reason]
}

/**
 * A branch edit changes what search and the public branch page render (city,
 * amenities, location, contact details), so those caches go too. Court edits
 * additionally change availability and pricing.
 */
function revalidateListing(branchId: string): void {
  revalidatePath('/dashboard/listings')
  revalidatePath(`/dashboard/listings/${branchId}`)
  revalidatePath('/dashboard')
  revalidatePath('/venues', 'layout')
  revalidatePath('/search')
  revalidatePath('/')
}

export async function createBranchAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  let user
  try {
    user = await requireOwner()
  } catch (error) {
    if (error instanceof AuthError) return { error: 'Only court owners can add a branch.' }
    throw error
  }

  const parsed = parseBranchFields(formData)
  if (!parsed.ok) return { error: BRANCH_FIELDS_FAILURE_MESSAGES[parsed.reason] }

  const result = await createBranch({ ownerId: user.id, fields: parsed.fields })
  if (!result.ok) {
    return { error: 'That branch name is taken too many times over — try a more specific one.' }
  }

  revalidateListing(result.branchId)
  // redirect() throws a control-flow signal Next catches, so it MUST be the
  // last statement and MUST NOT sit inside a try/catch that swallows it.
  redirect(`/dashboard/listings/${result.branchId}`)
}

export async function updateBranchAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const branchId = idFrom(formData, 'branchId')
  if (!branchId) return { error: NOT_YOUR_BRANCH }

  try {
    await requireOwnerOf(branchId)
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_YOUR_BRANCH }
    throw error
  }

  const parsed = parseBranchFields(formData)
  if (!parsed.ok) return { error: BRANCH_FIELDS_FAILURE_MESSAGES[parsed.reason] }

  const result = await updateBranch({ branchId, fields: parsed.fields })
  if (!result.ok) return { error: 'That branch no longer exists.' }

  revalidateListing(branchId)
  return { ok: true, message: SAVED }
}

export async function createCourtAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const branchId = idFrom(formData, 'branchId')
  if (!branchId) return { error: NOT_YOUR_BRANCH }

  try {
    await requireOwnerOf(branchId)
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_YOUR_BRANCH }
    throw error
  }

  const parsed = parseCourtFields(formData)
  if (!parsed.ok) return { error: COURT_FIELDS_FAILURE_MESSAGES[parsed.reason] }

  const result = await createCourt({ branchId, fields: parsed.fields })
  if (!result.ok) return { error: 'That branch no longer exists.' }

  revalidateListing(branchId)
  redirect(`/dashboard/listings/${branchId}/courts/${result.courtId}`)
}

/**
 * Resolves a submitted court id to its branch and checks `manage_courts` on
 * THAT branch. Returns null once the caller has been told why, so each court
 * action below is four lines of its own logic.
 *
 * requireUser() runs before branchIdOfCourt for the reason the blocks actions
 * document: without it an unauthenticated POST would still run the lookup and
 * learn from the response whether a given court id exists — a row-existence
 * oracle open to anyone.
 */
async function courtContext(
  formData: FormData,
): Promise<{ courtId: string; branchId: string } | { error: string }> {
  try {
    await requireUser()
  } catch (error) {
    if (error instanceof AuthError) return { error: NO_COURT_ACCESS }
    throw error
  }

  const courtId = idFrom(formData, 'courtId')
  if (!courtId) return { error: BAD_TARGET }

  const branchId = await branchIdOfCourt(courtId)
  // Same message as a malformed id: whether the court does not exist or the
  // id was forged, the caller learns only that the request was wrong.
  if (!branchId) return { error: BAD_TARGET }

  try {
    await requireBranchAccess(branchId, 'manage_courts')
  } catch (error) {
    if (error instanceof AuthError) return { error: NO_COURT_ACCESS }
    throw error
  }

  return { courtId, branchId }
}

export async function updateCourtAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const context = await courtContext(formData)
  if ('error' in context) return context

  const parsed = parseCourtFields(formData)
  if (!parsed.ok) return { error: COURT_FIELDS_FAILURE_MESSAGES[parsed.reason] }

  const result = await updateCourtFields({ courtId: context.courtId, fields: parsed.fields })
  if (!result.ok) return { error: courtWriteMessage(result.reason) }

  revalidateListing(context.branchId)
  return { ok: true, message: result.requeued ? SAVED_AND_REQUEUED : SAVED }
}

export async function updateOperatingHoursAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const context = await courtContext(formData)
  if ('error' in context) return context

  const parsed = parseOperatingHours(formData)
  if (!parsed.ok) return { error: HOURS_FAILURE_MESSAGES[parsed.reason] }

  const result = await replaceOperatingHours({ courtId: context.courtId, days: parsed.days })
  if (!result.ok) return { error: courtWriteMessage(result.reason) }

  revalidateListing(context.branchId)
  return { ok: true, message: result.requeued ? SAVED_AND_REQUEUED : SAVED }
}

export async function updateRateBandsAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const context = await courtContext(formData)
  if ('error' in context) return context

  const parsed = parseRateBands(formData)
  if (!parsed.ok) return { error: BANDS_FAILURE_MESSAGES[parsed.reason] }

  const result = await replaceRateBands({ courtId: context.courtId, bands: parsed.bands })
  if (!result.ok) return { error: courtWriteMessage(result.reason) }

  revalidateListing(context.branchId)
  return { ok: true, message: result.requeued ? SAVED_AND_REQUEUED : SAVED }
}
```

- [ ] **Step 4: Confirm the action-coverage contract still holds**

```bash
npx vitest run tests/auth/action-coverage.test.ts
```

Expected: PASS. `src/app/dashboard/listings/actions.ts` contains `requireOwner`, `requireOwnerOf`, `requireBranchAccess` and `requireUser`, all already in that test's `GUARDS` list — **no edit to `GUARDS` is needed or wanted in this slice.**

- [ ] **Step 5: Typecheck and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors; only the pre-existing warnings. A `TS2322` on `createBranchAction`/`createCourtAction` means `redirect()`'s `never` return is not being accepted — it is the last statement in both, so the function needs no explicit `return` after it.

- [ ] **Step 6: Run the permission tests twice**

```bash
npx vitest run tests/listings/permissions.test.ts && npx vitest run tests/listings/permissions.test.ts
```

Expected: PASS both times, 12 tests each run.

- [ ] **Step 7: Commit**

```bash
git add src/app/dashboard/listings/actions.ts tests/listings/permissions.test.ts
git commit -m "Add guarded listing actions and pin the manage_courts permission matrix"
```

---

### Task 5: `/dashboard/listings` — the branch list, the shared form chrome, and the add-branch form

**Files:**
- Create: `src/app/dashboard/listings/form-ui.tsx`
- Create: `src/app/dashboard/listings/branch-fieldset.tsx`
- Create: `src/app/dashboard/listings/branch-forms.tsx`
- Create: `src/app/dashboard/listings/page.tsx`

**Interfaces:**
- Produces, from `src/app/dashboard/listings/form-ui.tsx` (`'use client'`):

```ts
export const FOCUS_RING: string
export const LABEL: string
export const FIELD: string
export const TEXTAREA: string
export const CHECKBOX: string
export const CHECK_LABEL: string
export const LIME_BUTTON: string
export const DARK_BUTTON: string
export const BORDERED_BUTTON: string
export function FormMessage({ state }: { state: ListingFormState }): React.ReactElement | null
```
- Produces, from `src/app/dashboard/listings/branch-fieldset.tsx` (`'use client'`):

```ts
export type BranchDefaults = {
  name?: string; description?: string | null; address?: string; city?: string
  contactPhone?: string | null; contactEmail?: string | null
  amenities?: string[]; lat?: number | null; lng?: number | null
}
export function BranchFieldset(props: { idPrefix: string; defaults?: BranchDefaults }): React.ReactElement
```
- Produces, from `src/app/dashboard/listings/branch-forms.tsx` (`'use client'`):

```ts
export function AddBranchForm(): React.ReactElement
```
- Produces: the route `/dashboard/listings`.

**Access:** `requireDashboardPage('/dashboard/listings')`, then scope to `branchIdsWith(access, 'manage_courts')`. A session with an empty scope and no owner role is redirected to `/dashboard` — the sidebar hides the item for them (Task 10) and this is the boundary for a typed URL. "Add branch" renders only when `access.isOwner`.

**The lat/lng fields are temporary chrome.** `BranchFieldset` renders two plain number inputs named `lat` and `lng` in this task. Task 9 replaces that one block with `<LocationPicker>`, which renders the same two field names as hidden inputs plus a draggable map. Nothing else in the fieldset changes, and `parseBranchFields` reads the same names either way — which is exactly why the map can be added later without reopening this task.

- [ ] **Step 1: Create the shared form chrome**

Create `src/app/dashboard/listings/form-ui.tsx`:

```tsx
'use client'

import type { ListingFormState } from './actions'

/**
 * The control classes every listings form shares.
 *
 * A single module rather than a copy per file: six forms across four files
 * would otherwise carry six copies of the same eight strings, and the one
 * that mattered most — FOCUS_RING — is exactly the one that got dropped four
 * times in the previous slice's review. design/branding.md is the source for
 * every value here: --btn-h-sm 38px controls, --btn-radius 12px, display font
 * at weight 700 on buttons, mono uppercase kickers for labels.
 */
export const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

export const LABEL =
  'font-mono mb-1 block text-[10.5px] tracking-[.12em] text-[var(--ink-soft)] uppercase'

export const FIELD =
  `h-[var(--btn-h-sm)] w-full rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2.5 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-soft)] ${FOCUS_RING}`

export const TEXTAREA =
  `w-full rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2.5 py-2 text-[13px] leading-[1.55] text-[var(--ink)] placeholder:text-[var(--ink-soft)] ${FOCUS_RING}`

export const CHECKBOX = `h-4 w-4 shrink-0 accent-[var(--court)] ${FOCUS_RING}`

export const CHECK_LABEL =
  'inline-flex cursor-pointer items-center gap-1.5 text-[12.5px] text-[var(--ink)]'

/**
 * branding.md's primary: lime background, --ball-ink text. NEVER two of these
 * in one view — where a control repeats per row, use DARK_BUTTON (the
 * alternative primary) or BORDERED_BUTTON instead.
 */
export const LIME_BUTTON =
  `font-display inline-flex h-[var(--btn-h)] items-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-5 text-[14px] font-bold text-[var(--ball-ink)] transition-[filter] duration-150 hover:brightness-[1.06] disabled:opacity-60 motion-reduce:transition-none ${FOCUS_RING}`

export const DARK_BUTTON =
  `font-display inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] bg-[var(--ink)] px-4 text-[13px] font-bold text-[var(--ball)] transition-[filter] duration-150 hover:brightness-[1.25] disabled:opacity-60 motion-reduce:transition-none ${FOCUS_RING}`

export const BORDERED_BUTTON =
  `inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3.5 text-[13px] font-semibold whitespace-nowrap text-[var(--ink)] hover:border-[var(--court)] disabled:opacity-60 ${FOCUS_RING}`

/**
 * Renders whatever a listings action returned. `role="alert"` for failures so
 * a screen reader announces them without the user hunting for the change;
 * `role="status"` for successes, which are polite by comparison.
 */
export function FormMessage({ state }: { state: ListingFormState }) {
  if (!state) return null
  return 'error' in state ? (
    <p role="alert" className="mt-2 text-[12.5px] font-medium text-[var(--ink)]">
      {state.error}
    </p>
  ) : (
    <p role="status" className="mt-2 text-[12.5px] font-medium text-[var(--court)]">
      {state.message}
    </p>
  )
}
```

- [ ] **Step 2: Create the shared branch fieldset**

Create `src/app/dashboard/listings/branch-fieldset.tsx`:

```tsx
'use client'

import { AMENITY_LABELS, AMENITY_SLUGS } from '@/components/ui/amenity-chip'
import {
  MAX_ADDRESS,
  MAX_BRANCH_NAME,
  MAX_CITY,
  MAX_DESCRIPTION,
  MAX_EMAIL,
  MAX_PHONE,
} from '@/lib/listings/fields'
import { CHECKBOX, CHECK_LABEL, FIELD, LABEL, TEXTAREA } from './form-ui'

/**
 * Every editable branch field, shared by the add form and the edit form.
 *
 * One component rather than two near-identical blocks: the two forms differ
 * only in their action, their button, and whether `defaults` is supplied.
 * Splitting them would guarantee that a field added to one gets forgotten in
 * the other — and `parseBranchFields` reads by NAME, so a forgotten field is
 * silently cleared on save, not merely missing from the form.
 *
 * `maxLength` mirrors the limits in src/lib/listings/fields.ts so the browser
 * stops the user before the server has to. The server check remains the real
 * one; this is only courtesy.
 *
 * The amenity checkboxes are ALL rendered, always. An unchecked HTML checkbox
 * submits nothing, so the submitted set IS the new set — a partial form would
 * silently drop the amenities it omitted, exactly as the staff permission
 * checkboxes document.
 */
export type BranchDefaults = {
  name?: string
  description?: string | null
  address?: string
  city?: string
  contactPhone?: string | null
  contactEmail?: string | null
  amenities?: string[]
  lat?: number | null
  lng?: number | null
}

export function BranchFieldset({
  idPrefix,
  defaults,
}: {
  idPrefix: string
  defaults?: BranchDefaults
}) {
  const amenities = defaults?.amenities ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
        <div>
          <label className={LABEL} htmlFor={`${idPrefix}-name`}>
            Branch name
          </label>
          <input
            id={`${idPrefix}-name`}
            name="name"
            required
            maxLength={MAX_BRANCH_NAME}
            defaultValue={defaults?.name ?? ''}
            placeholder="Smash Zone Marikina"
            className={FIELD}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor={`${idPrefix}-city`}>
            City
          </label>
          <input
            id={`${idPrefix}-city`}
            name="city"
            required
            maxLength={MAX_CITY}
            defaultValue={defaults?.city ?? ''}
            placeholder="Marikina"
            className={FIELD}
          />
        </div>
      </div>

      <div>
        <label className={LABEL} htmlFor={`${idPrefix}-address`}>
          Street address
        </label>
        <input
          id={`${idPrefix}-address`}
          name="address"
          required
          maxLength={MAX_ADDRESS}
          defaultValue={defaults?.address ?? ''}
          placeholder="12 Shoe Ave, Barangay Sto. Niño"
          className={FIELD}
        />
      </div>

      <div>
        <label className={LABEL} htmlFor={`${idPrefix}-description`}>
          Description
        </label>
        <textarea
          id={`${idPrefix}-description`}
          name="description"
          rows={3}
          maxLength={MAX_DESCRIPTION}
          defaultValue={defaults?.description ?? ''}
          placeholder="What players should know before they arrive."
          className={TEXTAREA}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
        <div>
          <label className={LABEL} htmlFor={`${idPrefix}-phone`}>
            Contact phone
          </label>
          <input
            id={`${idPrefix}-phone`}
            name="contactPhone"
            maxLength={MAX_PHONE}
            defaultValue={defaults?.contactPhone ?? ''}
            placeholder="0917 000 0000"
            className={FIELD}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor={`${idPrefix}-email`}>
            Contact email
          </label>
          <input
            id={`${idPrefix}-email`}
            name="contactEmail"
            type="email"
            maxLength={MAX_EMAIL}
            defaultValue={defaults?.contactEmail ?? ''}
            placeholder="desk@example.com"
            className={FIELD}
          />
        </div>
      </div>

      <fieldset>
        <legend className={LABEL}>Amenities</legend>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {AMENITY_SLUGS.map((amenity) => (
            <label key={amenity} className={CHECK_LABEL} htmlFor={`${idPrefix}-${amenity}`}>
              <input
                id={`${idPrefix}-${amenity}`}
                type="checkbox"
                name="amenities"
                value={amenity}
                defaultChecked={amenities.includes(amenity)}
                className={CHECKBOX}
              />
              {AMENITY_LABELS[amenity]}
            </label>
          ))}
        </div>
      </fieldset>

      {/*
        TEMPORARY CHROME — replaced wholesale by <LocationPicker> in the
        map-pin task. The field NAMES (`lat`, `lng`) are the contract with
        parseBranchFields and do not change; only the control around them
        does. Left as plain number inputs meanwhile so a branch created
        before the map lands can still carry a real location.
      */}
      <fieldset>
        <legend className={LABEL}>Map location</legend>
        <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
          <div>
            <label className={LABEL} htmlFor={`${idPrefix}-lat`}>
              Latitude
            </label>
            <input
              id={`${idPrefix}-lat`}
              name="lat"
              type="number"
              step="any"
              inputMode="decimal"
              defaultValue={defaults?.lat ?? ''}
              placeholder="14.6507"
              className={`font-mono ${FIELD}`}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor={`${idPrefix}-lng`}>
              Longitude
            </label>
            <input
              id={`${idPrefix}-lng`}
              name="lng"
              type="number"
              step="any"
              inputMode="decimal"
              defaultValue={defaults?.lng ?? ''}
              placeholder="121.1029"
              className={`font-mono ${FIELD}`}
            />
          </div>
        </div>
        <p className="mt-1.5 text-[11.5px] text-[var(--ink-soft)]">
          Leave both empty to set the pin later. A branch with no pin will not appear in map or
          distance searches.
        </p>
      </fieldset>
    </div>
  )
}
```

- [ ] **Step 3: Create the add-branch form**

Create `src/app/dashboard/listings/branch-forms.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { createBranchAction, type ListingFormState } from './actions'
import { BranchFieldset } from './branch-fieldset'
import { FormMessage, LIME_BUTTON } from './form-ui'

/**
 * A client component for one reason: a Server Component cannot render what a
 * Server Action returned, so "that contact email doesn't look right" would
 * look like nothing happening. Same pattern as
 * src/app/dashboard/staff/staff-forms.tsx.
 *
 * There is no success state to render — createBranchAction redirects to the
 * new branch's page — so FormMessage only ever shows a failure here.
 */
export function AddBranchForm() {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    createBranchAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <BranchFieldset idPrefix="add-branch" />
      <div>
        {/* The only lime button on this page: the branch rows are links and
            the page has no other primary. */}
        <button type="submit" disabled={pending} className={LIME_BUTTON}>
          {pending ? 'Adding…' : 'Add branch'}
        </button>
        <FormMessage state={state} />
      </div>
    </form>
  )
}
```

- [ ] **Step 4: Create the branch list page**

Create `src/app/dashboard/listings/page.tsx`:

```tsx
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { getListingBranches } from '@/lib/listings/queries'
import { COURT_STATUSES, COURT_STATUS_LABELS } from '@/lib/listings/status'
import { AddBranchForm } from './branch-forms'

// Declared locally, not imported from ./form-ui: that module is 'use client',
// and importing it here would pull this Server Component's chrome into the
// client bundle for no benefit.
const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

/**
 * Branches and courts.
 *
 * requireDashboardPage, NOT requireOwnerPage: staff holding `manage_courts`
 * belong here too. The scope list is branchIdsWith(access, 'manage_courts'),
 * never access.branches — a staff member with view_bookings on branch A and
 * manage_courts on branch B must see only B (see branchIdsWith's contract in
 * src/lib/staff/access.ts).
 *
 * Creating a branch is owner-only, so the form renders only for owners; the
 * action re-asserts it with requireOwner regardless.
 */
export default async function ListingsPage() {
  const access = await requireDashboardPage('/dashboard/listings')
  const branchIds = branchIdsWith(access, 'manage_courts')

  // An owner with zero branches still belongs here — the empty state below is
  // their "add your first branch" screen. A staff member with no
  // manage_courts grant anywhere has nothing to do on this page at all.
  if (!access.isOwner && branchIds.length === 0) redirect('/dashboard')

  const branches = await getListingBranches(branchIds)

  return (
    <>
      <header className="mb-8">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Branches &amp; courts
        </h1>
        <p className="mt-2 max-w-[560px] text-[15px] text-[var(--ink-soft)]">
          Every venue you run, and the courts inside it. New and edited courts go to our team for
          approval before players can book them.
        </p>
      </header>

      {branches.length === 0 ? (
        <p className={`${EMPTY_PANEL} mb-6`}>
          {access.isOwner
            ? 'No branches yet — add your first one below.'
            : 'No branches are shared with you for court management yet.'}
        </p>
      ) : (
        <ul className="mb-8 flex flex-col gap-4">
          {branches.map((branch) => (
            <li key={branch.id}>
              <Link
                href={`/dashboard/listings/${branch.id}`}
                className={`flex flex-wrap items-center justify-between gap-4 rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)] transition-[box-shadow,transform] duration-[220ms] ease-[cubic-bezier(.2,.7,.3,1)] hover:-translate-y-1 hover:shadow-[var(--shadow-lg)] motion-reduce:transform-none motion-reduce:transition-none ${FOCUS_RING}`}
              >
                <div className="min-w-0">
                  <div className="font-display text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                    {branch.name}
                  </div>
                  <div className="font-mono mt-1 text-[11px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
                    {branch.city} · {branch.photoCount}{' '}
                    {branch.photoCount === 1 ? 'photo' : 'photos'}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {COURT_STATUSES.filter((status) => branch.courtCounts[status] > 0).map(
                    (status) => (
                      <span
                        key={status}
                        className="font-mono rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[10.5px] tracking-[.05em] text-[var(--court-deep)] uppercase"
                      >
                        {branch.courtCounts[status]} {COURT_STATUS_LABELS[status]}
                      </span>
                    ),
                  )}
                  {COURT_STATUSES.every((status) => branch.courtCounts[status] === 0) && (
                    <span className="text-[12.5px] text-[var(--ink-soft)]">No courts yet</span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {access.isOwner && (
        <section
          aria-label="Add a branch"
          className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
        >
          <h2 className="font-display mb-1 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
            Add a branch
          </h2>
          <p className="mb-4 text-[12.5px] text-[var(--ink-soft)]">
            A branch is one venue. Add its courts once it exists.
          </p>
          <AddBranchForm />
        </section>
      )}
    </>
  )
}
```

- [ ] **Step 5: Typecheck, lint, build**

```bash
npx tsc --noEmit && npm run lint && npm run build
```

Expected: no type errors; lint reports only the pre-existing warnings; the build succeeds and lists `/dashboard/listings` among the routes. A build failure naming `useActionState` means a `'use client'` directive is missing from one of the three new `.tsx` files.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/listings/form-ui.tsx src/app/dashboard/listings/branch-fieldset.tsx src/app/dashboard/listings/branch-forms.tsx src/app/dashboard/listings/page.tsx
git commit -m "Add the branch list page and the add-branch form"
```

---

### Task 6: `/dashboard/listings/[branchId]` — branch detail, branch editing, and the court list

**Files:**
- Create: `src/app/dashboard/listings/[branchId]/branch-detail-forms.tsx`
- Create: `src/app/dashboard/listings/[branchId]/page.tsx`

**Interfaces:**
- Produces, from `src/app/dashboard/listings/[branchId]/branch-detail-forms.tsx` (`'use client'`):

```ts
export function EditBranchForm(props: { branchId: string; defaults: BranchDefaults }): React.ReactElement
export function AddCourtForm(props: { branchId: string }): React.ReactElement
```
- Produces: the route `/dashboard/listings/[branchId]`.
- Consumes: `getListingBranch` (Task 3), `updateBranchAction` / `createCourtAction` (Task 4), `BranchFieldset` / `form-ui` (Task 5).

**Access, in three layers:**
1. `requireDashboardPage('/dashboard/listings')` — signed in, and admitted to the dashboard at all.
2. `branchIdsWith(access, 'manage_courts').includes(branchId)` — otherwise `notFound()`, **not** a redirect: telling a stranger "that branch exists but is not yours" confirms the id. A malformed (non-UUID) id takes the same path before any SQL runs, so it never reaches a `::uuid` cast.
3. `access.isOwner` gates the branch-edit form and the add-court form. Staff with `manage_courts` see the branch's details **read-only** plus the court list they can open and edit — the spec is explicit that editing branch fields and creating courts are owner-only. Both actions re-assert `requireOwnerOf` regardless.

**Branch photos are not in this task.** The photos task inserts a section into this page; leaving it out here keeps the two independently reviewable.

**There is no delete control for a branch or a court, on this page or anywhere else** — deliberately, per the spec. A branch cascade would eat courts that carry booking history, and `bookings.branch_id` is RESTRICT so the database would refuse anyway; status is the lifecycle tool for courts. Do not add one "for completeness".

- [ ] **Step 1: Create the branch detail forms**

Create `src/app/dashboard/listings/[branchId]/branch-detail-forms.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { createCourtAction, updateBranchAction, type ListingFormState } from '../actions'
import { BranchFieldset, type BranchDefaults } from '../branch-fieldset'
import {
  BORDERED_BUTTON,
  CHECK_LABEL,
  DARK_BUTTON,
  FIELD,
  FOCUS_RING,
  FormMessage,
  LABEL,
} from '../form-ui'
import { COURT_ENVIRONMENTS, MAX_COURT_NAME, MAX_SURFACE } from '@/lib/listings/fields'

const RADIO = `h-4 w-4 shrink-0 accent-[var(--court)] ${FOCUS_RING}`

/**
 * The two owner-only forms on the branch page.
 *
 * Client components for the same reason as every other form in this slice: a
 * Server Component cannot render what a Server Action returned, so a
 * validation failure would look like nothing happening.
 *
 * Both submit a hidden `branchId`. That is safe to guard on because
 * updateBranch/createCourt also scope their writes by the same id — see the
 * header comment in src/app/dashboard/listings/actions.ts. It is NOT the
 * pattern the court forms use, and the difference is deliberate.
 */
export function EditBranchForm({
  branchId,
  defaults,
}: {
  branchId: string
  defaults: BranchDefaults
}) {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    updateBranchAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="branchId" value={branchId} />
      <BranchFieldset idPrefix={`branch-${branchId}`} defaults={defaults} />
      <div>
        {/* branding.md's alternative primary, not lime: this page also
            renders an "Add court" submit, and two lime buttons in one view
            is forbidden. */}
        <button type="submit" disabled={pending} className={DARK_BUTTON}>
          {pending ? 'Saving…' : 'Save branch'}
        </button>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function AddCourtForm({ branchId }: { branchId: string }) {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    createCourtAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="branchId" value={branchId} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[180px] flex-1">
          <label className={LABEL} htmlFor={`add-court-name-${branchId}`}>
            Court name
          </label>
          <input
            id={`add-court-name-${branchId}`}
            name="name"
            required
            maxLength={MAX_COURT_NAME}
            placeholder="Court 1"
            className={FIELD}
          />
        </div>
        <div className="min-w-[180px] flex-1">
          <label className={LABEL} htmlFor={`add-court-surface-${branchId}`}>
            Surface (optional)
          </label>
          <input
            id={`add-court-surface-${branchId}`}
            name="surface"
            maxLength={MAX_SURFACE}
            placeholder="Acrylic"
            className={FIELD}
          />
        </div>
        <button type="submit" disabled={pending} className={BORDERED_BUTTON}>
          {pending ? 'Adding…' : 'Add court'}
        </button>
      </div>

      <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <legend className={LABEL}>Environment</legend>
        {COURT_ENVIRONMENTS.map((environment, index) => (
          <label
            key={environment}
            className={CHECK_LABEL}
            htmlFor={`add-court-${environment}-${branchId}`}
          >
            <input
              id={`add-court-${environment}-${branchId}`}
              type="radio"
              name="environment"
              value={environment}
              defaultChecked={index === 0}
              className={RADIO}
            />
            {environment === 'indoor' ? 'Indoor' : 'Outdoor'}
          </label>
        ))}
      </fieldset>

      <p className="text-[12px] text-[var(--ink-soft)]">
        New courts start as pending. Add opening hours and rates on the court&rsquo;s own page, then
        our team reviews it.
      </p>
      <FormMessage state={state} />
    </form>
  )
}
```

- [ ] **Step 2: Create the branch detail page**

Create `src/app/dashboard/listings/[branchId]/page.tsx`:

```tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { getListingBranch } from '@/lib/listings/queries'
import { COURT_STATUS_LABELS } from '@/lib/listings/status'
import { AmenityChip } from '@/components/ui/amenity-chip'
import { AddCourtForm, EditBranchForm } from './branch-detail-forms'

const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One branch: its editable details, and every court inside it.
 *
 * notFound(), not a redirect, for a branch this session may not manage — and
 * the same answer for a malformed id, a branch that does not exist, and one
 * belonging to someone else. "That branch exists but is not yours" would
 * confirm the id to whoever typed it.
 *
 * Staff holding manage_courts reach this page and see the branch read-only
 * plus the court list; editing branch fields and adding courts are owner-only
 * (the spec's permission table), which is why both forms are behind
 * access.isOwner and both actions re-assert requireOwnerOf.
 */
export default async function BranchDetailPage({
  params,
}: {
  params: Promise<{ branchId: string }>
}) {
  const { branchId } = await params
  const access = await requireDashboardPage('/dashboard/listings')

  // Shape-checked before any SQL: the id reaches a `::uuid` cast inside
  // getListingBranch, and a malformed value would raise 22P02 instead of
  // rendering a 404.
  if (!UUID_RE.test(branchId)) notFound()
  if (!branchIdsWith(access, 'manage_courts').includes(branchId)) notFound()

  const branch = await getListingBranch(branchId)
  if (!branch) notFound()

  return (
    <>
      <header className="mb-8">
        <Link
          href="/dashboard/listings"
          className={`font-mono mb-2 inline-block text-[11px] tracking-[.12em] text-[var(--court)] uppercase ${FOCUS_RING}`}
        >
          &larr; Branches &amp; courts
        </Link>
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          {branch.name}
        </h1>
        <p className="font-mono mt-1 text-[11px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
          {branch.city} &middot; /venues/{branch.slug}
        </p>
      </header>

      <section aria-label="Branch details" className={`${CARD} mb-6`}>
        <h2 className="font-display mb-4 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
          Branch details
        </h2>
        {access.isOwner ? (
          <EditBranchForm
            branchId={branch.id}
            defaults={{
              name: branch.name,
              description: branch.description,
              address: branch.address,
              city: branch.city,
              contactPhone: branch.contactPhone,
              contactEmail: branch.contactEmail,
              amenities: branch.amenities,
              lat: branch.lat,
              lng: branch.lng,
            }}
          />
        ) : (
          <div className="flex flex-col gap-2 text-[13.5px] text-[var(--ink)]">
            <p>{branch.address}</p>
            {branch.description && <p className="text-[var(--ink-soft)]">{branch.description}</p>}
            {branch.amenities.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {branch.amenities.map((amenity) => (
                  <AmenityChip key={amenity} amenity={amenity} />
                ))}
              </div>
            )}
            <p className="mt-2 text-[12.5px] text-[var(--ink-soft)]">
              Only the venue owner can change these details.
            </p>
          </div>
        )}
      </section>

      <section aria-label="Courts" className={`${CARD} mb-6`}>
        <h2 className="font-display mb-4 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
          Courts
        </h2>
        {branch.courts.length === 0 ? (
          <p className="text-[13px] text-[var(--ink-soft)]">
            No courts here yet
            {access.isOwner ? ' — add the first one below.' : '.'}
          </p>
        ) : (
          <ul className="flex flex-col">
            {branch.courts.map((court, index) => (
              <li
                key={court.id}
                className={`py-4 ${index > 0 ? 'border-t border-[var(--hairline)]' : 'pt-0'}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/dashboard/listings/${branch.id}/courts/${court.id}`}
                      className={`text-[14px] font-semibold text-[var(--ink)] hover:text-[var(--court)] ${FOCUS_RING}`}
                    >
                      {court.name}
                    </Link>
                    <div className="font-mono mt-1 text-[10.5px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                      {court.environment}
                      {court.surface ? ` · ${court.surface}` : ''}
                    </div>
                  </div>
                  <span className="font-mono shrink-0 rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[10.5px] tracking-[.05em] text-[var(--court-deep)] uppercase">
                    {COURT_STATUS_LABELS[court.status]}
                  </span>
                </div>
                {/* The rejection reason belongs on the list, not only on the
                    court page: it is the one thing an owner scanning their
                    branch has to act on. */}
                {court.status === 'rejected' && court.rejectionReason && (
                  <p className="mt-2 text-[12.5px] text-[var(--ink)]">
                    <span className="font-semibold">Changes needed:</span> {court.rejectionReason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {access.isOwner && (
        <section aria-label="Add a court" className={CARD}>
          <h2 className="font-display mb-4 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
            Add a court
          </h2>
          <AddCourtForm branchId={branch.id} />
        </section>
      )}
    </>
  )
}
```

- [ ] **Step 3: Typecheck, lint, build**

```bash
npx tsc --noEmit && npm run lint && npm run build
```

Expected: no type errors; lint reports only the pre-existing warnings; the build lists `/dashboard/listings/[branchId]` among the routes.

- [ ] **Step 4: Commit**

```bash
git add "src/app/dashboard/listings/[branchId]/branch-detail-forms.tsx" "src/app/dashboard/listings/[branchId]/page.tsx"
git commit -m "Add the branch detail page with branch editing and the court list"
```

---

### Task 7: `/dashboard/listings/[branchId]/courts/[courtId]` — status banner, court fields, hours, and rates

**Files:**
- Create: `src/app/dashboard/listings/[branchId]/courts/[courtId]/court-forms.tsx`
- Create: `src/app/dashboard/listings/[branchId]/courts/[courtId]/page.tsx`

**Interfaces:**
- Produces, from `.../court-forms.tsx` (`'use client'`):

```ts
export function CourtFieldsForm(props: {
  courtId: string
  defaults: { name: string; environment: CourtEnvironment; surface: string | null }
}): React.ReactElement
export function OperatingHoursForm(props: { courtId: string; days: OperatingHoursDay[] }): React.ReactElement
export function RateBandsForm(props: { courtId: string; bands: RateBand[] }): React.ReactElement
```
- Produces: the route `/dashboard/listings/[branchId]/courts/[courtId]`.
- Consumes: `getListingCourt` (Task 3), `updateCourtAction` / `updateOperatingHoursAction` / `updateRateBandsAction` (Task 4), `COURT_STATUS_BANNERS` (Task 3), `form-ui` (Task 5), `formatHour` from `@/lib/format`.

**Access:** identical three layers to Task 6, plus one more check: the court must actually belong to the `[branchId]` in the URL, otherwise `notFound()`. Without that, a manage-courts session could reach another branch's court by pairing its own `branchId` with a foreign `courtId` in the path — the guard would pass on the branch in the URL while the page rendered a court from somewhere else. The **actions** are already immune (they resolve the branch from the court row), but the *page* is a read and needs its own check.

**Status banner:** rendered for every status from `COURT_STATUS_BANNERS`, with the stored `rejectionReason` appended for `rejected`. A separate warning renders whenever `scheduleWarning` is non-null — the state an hours-only edit can leave behind, where the rate bands no longer cover the opening hours.

- [ ] **Step 1: Create the court forms**

Create `src/app/dashboard/listings/[branchId]/courts/[courtId]/court-forms.tsx`:

```tsx
'use client'

import { useActionState, useState } from 'react'
import {
  updateCourtAction,
  updateOperatingHoursAction,
  updateRateBandsAction,
  type ListingFormState,
} from '../../../actions'
import {
  BORDERED_BUTTON,
  CHECKBOX,
  CHECK_LABEL,
  DARK_BUTTON,
  FIELD,
  FOCUS_RING,
  FormMessage,
  LABEL,
  LIME_BUTTON,
} from '../../../form-ui'
import {
  COURT_ENVIRONMENTS,
  MAX_COURT_NAME,
  MAX_SURFACE,
  type CourtEnvironment,
} from '@/lib/listings/fields'
import {
  PESOS_TO_CENTAVOS,
  WEEKDAY_LABELS,
  type OperatingHoursDay,
  type RateBand,
} from '@/lib/listings/schedule'
import { formatHour } from '@/lib/format'

const RADIO = `h-4 w-4 shrink-0 accent-[var(--court)] ${FOCUS_RING}`
// Written out rather than composed from FIELD: FIELD carries `w-full`, and
// appending `w-[104px]` after it would leave two conflicting width utilities
// in one class list, where which one wins depends on Tailwind's generated
// stylesheet order rather than on the order written here.
const SELECT = `font-mono h-[var(--btn-h-sm)] w-[104px] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2 text-[13px] text-[var(--ink)] ${FOCUS_RING}`

/**
 * The three court forms.
 *
 * Each posts only a hidden `courtId` — never a branchId. The action resolves
 * the branch from the court row and guards
 * requireBranchAccess(branchId, 'manage_courts') against THAT, which is what
 * makes a forged id useless rather than a confused deputy. Do not add a
 * branchId field here "for convenience".
 *
 * Hours are chosen from selects rather than typed into number inputs: the
 * legal values are the 25 integers 0..24 (24 being local midnight, which
 * court_operating_hours.closes_hour permits), and formatHour renders each one
 * the way the rest of the app does.
 */
function HourSelect({
  name,
  id,
  value,
  onChange,
  min,
  max,
}: {
  name: string
  id: string
  value: number
  onChange: (value: number) => void
  min: number
  max: number
}) {
  const hours: number[] = []
  for (let hour = min; hour <= max; hour++) hours.push(hour)

  return (
    <select
      id={id}
      name={name}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className={SELECT}
    >
      {hours.map((hour) => (
        <option key={hour} value={hour}>
          {formatHour(hour)}
        </option>
      ))}
    </select>
  )
}

export function CourtFieldsForm({
  courtId,
  defaults,
}: {
  courtId: string
  defaults: { name: string; environment: CourtEnvironment; surface: string | null }
}) {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    updateCourtAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="courtId" value={courtId} />

      <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
        <div>
          <label className={LABEL} htmlFor={`court-name-${courtId}`}>
            Court name
          </label>
          <input
            id={`court-name-${courtId}`}
            name="name"
            required
            maxLength={MAX_COURT_NAME}
            defaultValue={defaults.name}
            className={FIELD}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor={`court-surface-${courtId}`}>
            Surface (optional)
          </label>
          <input
            id={`court-surface-${courtId}`}
            name="surface"
            maxLength={MAX_SURFACE}
            defaultValue={defaults.surface ?? ''}
            placeholder="Acrylic"
            className={FIELD}
          />
        </div>
      </div>

      <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <legend className={LABEL}>Environment</legend>
        {COURT_ENVIRONMENTS.map((environment) => (
          <label
            key={environment}
            className={CHECK_LABEL}
            htmlFor={`court-${environment}-${courtId}`}
          >
            <input
              id={`court-${environment}-${courtId}`}
              type="radio"
              name="environment"
              value={environment}
              defaultChecked={defaults.environment === environment}
              className={RADIO}
            />
            {environment === 'indoor' ? 'Indoor' : 'Outdoor'}
          </label>
        ))}
        {/* Named as a key field so the re-queue is never a surprise. Name and
            surface are on the same form and do NOT re-queue — the action
            re-queues only when the environment actually changed. */}
        <p className="w-full basis-full text-[11.5px] text-[var(--ink-soft)]">
          Changing the environment sends this court back for approval. Renaming it does not.
        </p>
      </fieldset>

      <div>
        <button type="submit" disabled={pending} className={DARK_BUTTON}>
          {pending ? 'Saving…' : 'Save court'}
        </button>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

type DayRow = { open: boolean; opensHour: number; closesHour: number }

export function OperatingHoursForm({
  courtId,
  days,
}: {
  courtId: string
  days: OperatingHoursDay[]
}) {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    updateOperatingHoursAction,
    null,
  )

  // All seven rows always exist in state, open or not, because the submitted
  // set IS the new week: a day whose checkbox is unchecked submits nothing
  // and is therefore closed. Defaults for a day that has never been open are
  // a plausible 7 AM - 10 PM rather than 0-0, so checking the box is enough.
  const [rows, setRows] = useState<DayRow[]>(() =>
    WEEKDAY_LABELS.map((_, dayOfWeek) => {
      const stored = days.find((day) => day.dayOfWeek === dayOfWeek)
      return {
        open: stored !== undefined,
        opensHour: stored?.opensHour ?? 7,
        closesHour: stored?.closesHour ?? 22,
      }
    }),
  )

  function updateRow(index: number, patch: Partial<DayRow>) {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="courtId" value={courtId} />

      <ul className="flex flex-col">
        {rows.map((row, dayOfWeek) => (
          <li
            key={WEEKDAY_LABELS[dayOfWeek]}
            className={`flex flex-wrap items-center gap-3 py-2.5 ${
              dayOfWeek > 0 ? 'border-t border-[var(--hairline)]' : ''
            }`}
          >
            <label className={`${CHECK_LABEL} w-[128px]`} htmlFor={`open-${dayOfWeek}-${courtId}`}>
              <input
                id={`open-${dayOfWeek}-${courtId}`}
                type="checkbox"
                name={`open-${dayOfWeek}`}
                checked={row.open}
                onChange={(event) => updateRow(dayOfWeek, { open: event.target.checked })}
                className={CHECKBOX}
              />
              {WEEKDAY_LABELS[dayOfWeek]}
            </label>

            {row.open ? (
              <div className="flex flex-wrap items-center gap-2">
                <HourSelect
                  id={`opens-${dayOfWeek}-${courtId}`}
                  name={`opens-${dayOfWeek}`}
                  value={row.opensHour}
                  onChange={(opensHour) => updateRow(dayOfWeek, { opensHour })}
                  min={0}
                  max={23}
                />
                <span aria-hidden className="text-[13px] text-[var(--ink-soft)]">
                  &ndash;
                </span>
                <HourSelect
                  id={`closes-${dayOfWeek}-${courtId}`}
                  name={`closes-${dayOfWeek}`}
                  value={row.closesHour}
                  onChange={(closesHour) => updateRow(dayOfWeek, { closesHour })}
                  min={1}
                  max={24}
                />
              </div>
            ) : (
              <span className="text-[12.5px] text-[var(--ink-soft)]">Closed</span>
            )}
          </li>
        ))}
      </ul>

      <div>
        <button type="submit" disabled={pending} className={DARK_BUTTON}>
          {pending ? 'Saving…' : 'Save hours'}
        </button>
        <FormMessage state={state} />
      </div>
      <p className="text-[11.5px] text-[var(--ink-soft)]">
        Saving new hours sends this court back for approval. If your rate bands no longer cover the
        new hours, update them next.
      </p>
    </form>
  )
}

type BandRow = { key: string; startHour: number; endHour: number; pesos: string }

export function RateBandsForm({ courtId, bands }: { courtId: string; bands: RateBand[] }) {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    updateRateBandsAction,
    null,
  )

  // Pesos, not centavos, because that is what an owner types; the action
  // multiplies by 100. A stored price with odd centavos would show as a
  // decimal here and be rejected on save, which is correct: this product
  // prices courts in whole pesos.
  const [rows, setRows] = useState<BandRow[]>(() =>
    bands.length > 0
      ? bands.map((band) => ({
          key: `${band.startHour}-${band.endHour}`,
          startHour: band.startHour,
          endHour: band.endHour,
          pesos: String(band.priceCentavos / PESOS_TO_CENTAVOS),
        }))
      : [{ key: 'first', startHour: 7, endHour: 22, pesos: '' }],
  )

  function updateRow(index: number, patch: Partial<BandRow>) {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    )
  }

  function addRow() {
    setRows((current) => {
      const last = current[current.length - 1]
      // A new band starts where the last one ended, which is the only place
      // it can legally start — the bands must tile with no gap.
      const startHour = last ? last.endHour : 7
      return [
        ...current,
        {
          key: `row-${Date.now()}`,
          startHour: Math.min(startHour, 23),
          endHour: 24,
          pesos: '',
        },
      ]
    })
  }

  function removeRow(index: number) {
    setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="courtId" value={courtId} />

      <ul className="flex flex-col">
        {rows.map((row, index) => (
          <li
            key={row.key}
            className={`flex flex-wrap items-end gap-3 py-2.5 ${
              index > 0 ? 'border-t border-[var(--hairline)]' : ''
            }`}
          >
            <div>
              <label className={LABEL} htmlFor={`band-start-${index}-${courtId}`}>
                From
              </label>
              <HourSelect
                id={`band-start-${index}-${courtId}`}
                name="bandStart"
                value={row.startHour}
                onChange={(startHour) => updateRow(index, { startHour })}
                min={0}
                max={23}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor={`band-end-${index}-${courtId}`}>
                Until
              </label>
              <HourSelect
                id={`band-end-${index}-${courtId}`}
                name="bandEnd"
                value={row.endHour}
                onChange={(endHour) => updateRow(index, { endHour })}
                min={1}
                max={24}
              />
            </div>
            <div className="w-[132px]">
              <label className={LABEL} htmlFor={`band-price-${index}-${courtId}`}>
                Price per hour
              </label>
              <input
                id={`band-price-${index}-${courtId}`}
                name="bandPrice"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                required
                value={row.pesos}
                onChange={(event) => updateRow(index, { pesos: event.target.value })}
                placeholder="265"
                className={`font-mono ${FIELD}`}
              />
            </div>
            <button
              type="button"
              onClick={() => removeRow(index)}
              disabled={rows.length === 1}
              aria-label={`Remove the band starting at ${formatHour(row.startHour)}`}
              className={BORDERED_BUTTON}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={addRow} className={BORDERED_BUTTON}>
          Add band
        </button>
        {/* The one lime button on this page: pricing is the action that
            actually gets a court approved. */}
        <button type="submit" disabled={pending} className={LIME_BUTTON}>
          {pending ? 'Saving…' : 'Save rates'}
        </button>
      </div>
      <FormMessage state={state} />
      <p className="text-[11.5px] text-[var(--ink-soft)]">
        Bands must cover every open hour exactly once, with no gaps or overlaps. Prices are whole
        pesos per hour. Saving new rates sends this court back for approval.
      </p>
    </form>
  )
}
```

- [ ] **Step 2: Create the court detail page**

Create `src/app/dashboard/listings/[branchId]/courts/[courtId]/page.tsx`:

```tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { getListingCourt } from '@/lib/listings/queries'
import { COURT_STATUS_BANNERS } from '@/lib/listings/status'
import { BANDS_FAILURE_MESSAGES, HOURS_FAILURE_MESSAGES } from '@/lib/listings/schedule'
import { formatHour, formatHourRange, formatPeso } from '@/lib/format'
import { CourtFieldsForm, OperatingHoursForm, RateBandsForm } from './court-forms'

const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One court: its status, its fields, its week, and its prices.
 *
 * FOUR access checks, not three. The usual dashboard guard and the
 * manage_courts scope cover the branch in the URL; the fourth —
 * `court.branchId === branchId` — is what stops a session from pairing its
 * OWN branch id with a foreign court id in the path and reading a court it
 * has no claim on. The write actions are immune to this by construction (they
 * resolve the branch from the court row), but this page is a read and needs
 * its own check.
 */
export default async function CourtDetailPage({
  params,
}: {
  params: Promise<{ branchId: string; courtId: string }>
}) {
  const { branchId, courtId } = await params
  const access = await requireDashboardPage('/dashboard/listings')

  if (!UUID_RE.test(branchId) || !UUID_RE.test(courtId)) notFound()
  if (!branchIdsWith(access, 'manage_courts').includes(branchId)) notFound()

  const court = await getListingCourt(courtId)
  if (!court || court.branchId !== branchId) notFound()

  const banner = COURT_STATUS_BANNERS[court.status]
  const warning =
    court.scheduleWarning === null
      ? null
      : court.scheduleWarning === 'no_open_day' || court.scheduleWarning === 'invalid_window'
        ? HOURS_FAILURE_MESSAGES[court.scheduleWarning]
        : BANDS_FAILURE_MESSAGES[court.scheduleWarning]

  return (
    <>
      <header className="mb-6">
        <Link
          href={`/dashboard/listings/${branchId}`}
          className={`font-mono mb-2 inline-block text-[11px] tracking-[.12em] text-[var(--court)] uppercase ${FOCUS_RING}`}
        >
          &larr; {court.branchName}
        </Link>
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          {court.name}
        </h1>
      </header>

      {/* Informational banner, flat --band-off per branding.md. Rendered for
          every status, including approved: "this is live, and these edits
          will take it off the market" is information an owner needs before
          they touch the forms, not after. */}
      <section
        aria-label="Approval status"
        className="mb-6 rounded-[20px] bg-[var(--band-off)] px-5 py-4"
      >
        <h2 className="font-mono text-[11px] tracking-[.14em] text-[var(--court-deep)] uppercase">
          {banner.title}
        </h2>
        <p className="mt-1.5 text-[13.5px] text-[var(--ink)]">{banner.body}</p>
        {court.status === 'rejected' && court.rejectionReason && (
          <p className="mt-2 text-[13.5px] text-[var(--ink)]">
            <span className="font-semibold">Reason:</span> {court.rejectionReason}
          </p>
        )}
        {warning && (
          <p role="status" className="mt-2 text-[13.5px] font-medium text-[var(--ink)]">
            {warning}
          </p>
        )}
      </section>

      <section aria-label="Court details" className={`${CARD} mb-6`}>
        <h2 className="font-display mb-4 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
          Court details
        </h2>
        <CourtFieldsForm
          courtId={court.id}
          defaults={{ name: court.name, environment: court.environment, surface: court.surface }}
        />
      </section>

      <section aria-label="Opening hours" className={`${CARD} mb-6`}>
        <h2 className="font-display mb-1 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
          Opening hours
        </h2>
        <p className="mb-4 text-[12.5px] text-[var(--ink-soft)]">
          One window per day. Closing at {formatHour(24)} means midnight.
        </p>
        <OperatingHoursForm courtId={court.id} days={court.days} />
      </section>

      <section aria-label="Rates" className={CARD}>
        <h2 className="font-display mb-1 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
          Rates
        </h2>
        {court.bands.length > 0 && (
          <p className="font-mono mb-4 text-[11.5px] text-[var(--ink-soft)]">
            {court.bands
              .map(
                (band) =>
                  `${formatHourRange(band.startHour, band.endHour)} ${formatPeso(band.priceCentavos)}`,
              )
              .join('  ·  ')}
          </p>
        )}
        <RateBandsForm courtId={court.id} bands={court.bands} />
      </section>
    </>
  )
}
```

- [ ] **Step 3: Typecheck, lint, build**

```bash
npx tsc --noEmit && npm run lint && npm run build
```

Expected: no type errors; lint reports only the pre-existing warnings; the build lists `/dashboard/listings/[branchId]/courts/[courtId]`.

- [ ] **Step 4: Re-run the listings tests**

Nothing in this task changes a library, but the court page is the first consumer of `scheduleWarning`, so confirm the queries still behave:

```bash
npx vitest run tests/listings/
```

Expected: PASS — all five listings test files.

- [ ] **Step 5: Commit**

```bash
git add "src/app/dashboard/listings/[branchId]/courts"
git commit -m "Add the court detail page with status banner, hours, and rate bands"
```

---

### Task 8: Photos — upload, reorder, delete, for branches and courts

**Files:**
- Create: `src/lib/listings/storage.ts`
- Create: `src/lib/listings/photos.ts`
- Create: `src/app/dashboard/listings/photo-forms.tsx`
- Create: `tests/listings/photos.test.ts`
- Modify: `src/lib/photos.ts` (add the upload rules — see below)
- Modify: `src/app/dashboard/listings/actions.ts` (six more guarded actions)
- Modify: `src/app/dashboard/listings/[branchId]/page.tsx` (branch photos section)
- Modify: `src/app/dashboard/listings/[branchId]/courts/[courtId]/page.tsx` (court photos section)

**Interfaces:**
- Produces, from `src/lib/photos.ts` (an existing **pure** module — `photoUrl` already lives there and it has no `server-only`, which is exactly why the upload rules go here: the file input's `accept` attribute and the size hint are rendered by a client component, and importing them from the server-only write module would throw at runtime):

```ts
export const MAX_PHOTO_BYTES: 5242880
export const ALLOWED_PHOTO_TYPES: readonly ['image/jpeg', 'image/png', 'image/webp']
export const PHOTO_EXTENSIONS: Record<string, string>
```
- Produces, from `src/lib/listings/storage.ts`:

```ts
export type StorageClient = {
  upload(bucket: PhotoBucket, path: string, bytes: Uint8Array, contentType: string): Promise<{ error: string | null }>
  remove(bucket: PhotoBucket, paths: string[]): Promise<{ error: string | null }>
}
export function serviceRoleStorage(): StorageClient
```
- Produces, from `src/lib/listings/photos.ts`:

```ts
export type PhotoTarget = { kind: 'branch'; branchId: string } | { kind: 'court'; courtId: string }

export type AddPhotoResult =
  | { ok: true; photoId: string; storagePath: string }
  | { ok: false; reason: 'no_file' | 'bad_type' | 'too_large' | 'upload_failed' | 'target_missing' }
export type DeletePhotoResult = { ok: true } | { ok: false; reason: 'not_found' | 'delete_failed' }
export type MovePhotoResult = { ok: true } | { ok: false; reason: 'not_found' | 'at_edge' }

export function bucketFor(target: PhotoTarget): PhotoBucket
export async function addPhoto(input: { target: PhotoTarget; file: File; storage: StorageClient }): Promise<AddPhotoResult>
export async function deletePhoto(input: { target: PhotoTarget; photoId: string; storage: StorageClient }): Promise<DeletePhotoResult>
export async function movePhoto(input: { target: PhotoTarget; photoId: string; direction: 'up' | 'down' }): Promise<MovePhotoResult>
```
- Produces, from `src/app/dashboard/listings/actions.ts` (six additional async exports):

```ts
export async function addBranchPhotoAction(prev: ListingFormState, formData: FormData): Promise<ListingFormState>
export async function deleteBranchPhotoAction(prev: ListingFormState, formData: FormData): Promise<ListingFormState>
export async function moveBranchPhotoAction(prev: ListingFormState, formData: FormData): Promise<ListingFormState>
export async function addCourtPhotoAction(prev: ListingFormState, formData: FormData): Promise<ListingFormState>
export async function deleteCourtPhotoAction(prev: ListingFormState, formData: FormData): Promise<ListingFormState>
export async function moveCourtPhotoAction(prev: ListingFormState, formData: FormData): Promise<ListingFormState>
```
- Produces, from `src/app/dashboard/listings/photo-forms.tsx` (`'use client'`):

```ts
export function PhotoManager(props: {
  kind: 'branch' | 'court'
  targetId: string
  photos: { id: string; storagePath: string }[]
  canManage: boolean
}): React.ReactElement
```

**Why `storage` is a parameter and not an import:** it is the one boundary this slice is allowed to fake. The bucket is shared with the seeded demo photos and an upload has no rollback, so a test that really uploaded would leave objects behind in a shared project forever. Passing the client in means the DB rows stay real — the part worth testing — while the network call is observed. The actions pass `serviceRoleStorage()`; the tests pass a recorder.

**Ordering, and which mismatch is tolerated:** upload the object, **then** insert the row. Delete the object, **then** delete the row. Both orders leave the same failure mode when the second step fails — a storage object with no row, or a row with no object — and the choice is deliberate:
- On **add**, a failed row insert is followed by a best-effort `remove` of the object just uploaded, so the normal outcome is neither.
- On **delete**, the surviving artifact is a **row whose object is gone**: it renders as a broken image the owner can see and delete again (the delete is idempotent — the second `remove` of a missing object is a no-op). The reverse order would leave an **object with no row**: invisible in every UI, and therefore never reclaimable.

**Photo edits never re-queue a court** (spec). None of these functions touches `courts.status`.

- [ ] **Step 0: Add the upload rules to the pure photo module**

Append to `src/lib/photos.ts`:

```ts
/**
 * Upload rules, kept HERE rather than in src/lib/listings/photos.ts because
 * this module is pure and that one is `server-only`: the file input's
 * `accept` attribute and the "up to 5 MB" hint are rendered by a client
 * component, which cannot import a server-only module without throwing at
 * runtime. The server-side check is still the real one — an `accept`
 * attribute is a browser hint a hand-crafted POST ignores entirely.
 */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024

export const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

/** MIME type -> the extension the stored object gets. Keys match ALLOWED_PHOTO_TYPES. */
export const PHOTO_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}
```

- [ ] **Step 1: Write the storage client**

Create `src/lib/listings/storage.ts`:

```ts
import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { PhotoBucket } from '@/lib/photos'

/**
 * The narrow slice of Supabase Storage this slice uses, behind an interface.
 *
 * Two functions, both taking a bucket. That is the whole surface — which is
 * what makes it cheap to hand a recorder to the photo tests instead of really
 * uploading. The bucket is shared with the seeded demo photos and an upload
 * has no rollback, so a test that really wrote to it would leave objects in a
 * shared project forever; the DATABASE rows in those tests stay real.
 *
 * Errors come back as a string, not a thrown exception and not Supabase's own
 * error object: callers only ever need "did it work, and what do I log".
 */
export type StorageClient = {
  upload(
    bucket: PhotoBucket,
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ error: string | null }>
  remove(bucket: PhotoBucket, paths: string[]): Promise<{ error: string | null }>
}

/**
 * Built once and reused. `SUPABASE_SECRET_KEY` is the service-role key — it
 * bypasses RLS, which is exactly why uploads happen here on the server behind
 * a guard and never from the browser (see the comment in
 * supabase/migrations/20260801110350_storage_and_cron.sql: storage.objects
 * has zero policies, so the anon key can write nothing).
 *
 * `persistSession: false` because there is no session to persist: this client
 * authenticates as the service role, not as the signed-in user, and the
 * ownership check has already happened in the action's guard.
 */
let cached: SupabaseClient | null = null

function client(): SupabaseClient {
  if (cached) return cached
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required for uploads')
  }
  cached = createClient(url, key, { auth: { persistSession: false } })
  return cached
}

export function serviceRoleStorage(): StorageClient {
  return {
    async upload(bucket, path, bytes, contentType) {
      // upsert stays FALSE: every path this app writes carries a fresh UUID,
      // so an upsert could only ever mask a collision that should not exist.
      const { error } = await client()
        .storage.from(bucket)
        .upload(path, bytes, { contentType, upsert: false })
      return { error: error ? error.message : null }
    },
    async remove(bucket, paths) {
      const { error } = await client().storage.from(bucket).remove(paths)
      return { error: error ? error.message : null }
    },
  }
}
```

- [ ] **Step 2: Write the failing photo tests**

Create `tests/listings/photos.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBranchWithCourts, teardownFixtures } from '../helpers/fixtures'
import { addPhoto, deletePhoto, movePhoto, type PhotoTarget } from '@/lib/listings/photos'
import { MAX_PHOTO_BYTES } from '@/lib/photos'
import type { StorageClient } from '@/lib/listings/storage'

afterAll(teardownFixtures)

const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555'

/**
 * The ONE permitted test double in the write path, and only because the
 * bucket is shared and an upload cannot be rolled back — a test that really
 * uploaded would leave objects in a shared Supabase project forever. Every
 * database row below is real.
 *
 * `rowsAtCall` is what makes the ordering assertions meaningful rather than
 * decorative: the fake counts the target's photo rows AT THE MOMENT storage
 * is called, so "object first, then row" is observed instead of assumed.
 */
type StorageCall = { op: 'upload' | 'remove'; bucket: string; paths: string[]; rowsAtCall: number }

function recorder(
  target: PhotoTarget,
  options: { uploadError?: string; removeError?: string } = {},
) {
  const calls: StorageCall[] = []

  async function countRows(): Promise<number> {
    const result =
      target.kind === 'branch'
        ? await db.execute(
            sql`select count(*)::int as n from branch_photos where branch_id = ${target.branchId}::uuid`,
          )
        : await db.execute(
            sql`select count(*)::int as n from court_photos where court_id = ${target.courtId}::uuid`,
          )
    return Number(result.rows[0].n)
  }

  const client: StorageClient = {
    async upload(bucket, path) {
      calls.push({ op: 'upload', bucket, paths: [path], rowsAtCall: await countRows() })
      return { error: options.uploadError ?? null }
    },
    async remove(bucket, paths) {
      calls.push({ op: 'remove', bucket, paths, rowsAtCall: await countRows() })
      return { error: options.removeError ?? null }
    },
  }

  return { client, calls }
}

function imageFile(type = 'image/jpeg', bytes = 64): File {
  return new File([new Uint8Array(bytes)], 'photo', { type })
}

async function photoRows(target: PhotoTarget) {
  const result =
    target.kind === 'branch'
      ? await db.execute(sql`
          select id, storage_path, sort_order from branch_photos
          where branch_id = ${target.branchId}::uuid order by sort_order, id
        `)
      : await db.execute(sql`
          select id, storage_path, sort_order from court_photos
          where court_id = ${target.courtId}::uuid order by sort_order, id
        `)
  return result.rows.map((row) => ({
    id: row.id as string,
    storagePath: row.storage_path as string,
    sortOrder: Number(row.sort_order),
  }))
}

test('addPhoto uploads the object before inserting the row', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)

  const result = await addPhoto({ target, file: imageFile(), storage: storage.client })
  expect(result).toMatchObject({ ok: true })
  if (!result.ok) throw new Error('unreachable')

  expect(storage.calls).toHaveLength(1)
  expect(storage.calls[0].op).toBe('upload')
  expect(storage.calls[0].bucket).toBe('branch-photos')
  // Zero rows existed when the object was written: object first, then row.
  expect(storage.calls[0].rowsAtCall).toBe(0)
  expect(result.storagePath.startsWith(`branches/${branchId}/`)).toBe(true)
  expect(result.storagePath.endsWith('.jpg')).toBe(true)

  const rows = await photoRows(target)
  expect(rows).toHaveLength(1)
  expect(rows[0].storagePath).toBe(result.storagePath)
  expect(rows[0].sortOrder).toBe(0)
})

test('addPhoto assigns the next sort_order', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)

  await addPhoto({ target, file: imageFile(), storage: storage.client })
  await addPhoto({ target, file: imageFile('image/png'), storage: storage.client })
  await addPhoto({ target, file: imageFile('image/webp'), storage: storage.client })

  const rows = await photoRows(target)
  expect(rows.map((row) => row.sortOrder)).toEqual([0, 1, 2])
  expect(rows.map((row) => row.storagePath.split('.').pop())).toEqual(['jpg', 'png', 'webp'])
})

test('addPhoto stores court photos under their own prefix and bucket', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  const target: PhotoTarget = { kind: 'court', courtId: courtIds[0] }
  const storage = recorder(target)

  const result = await addPhoto({ target, file: imageFile(), storage: storage.client })
  if (!result.ok) throw new Error('addPhoto failed')

  expect(storage.calls[0].bucket).toBe('court-photos')
  expect(result.storagePath.startsWith(`courts/${courtIds[0]}/`)).toBe(true)
})

test('addPhoto rejects a file type that is not jpeg, png or webp', async () => {
  // Server-side, not merely an `accept` attribute: the attribute is a hint
  // the browser applies and a hand-crafted POST ignores.
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)

  for (const type of ['application/pdf', 'image/gif', 'text/html', '']) {
    expect(await addPhoto({ target, file: imageFile(type), storage: storage.client })).toEqual({
      ok: false,
      reason: 'bad_type',
    })
  }
  expect(storage.calls).toHaveLength(0)
  expect(await photoRows(target)).toEqual([])
})

test('addPhoto rejects a file over 5 MB', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)

  const result = await addPhoto({
    target,
    file: imageFile('image/jpeg', MAX_PHOTO_BYTES + 1),
    storage: storage.client,
  })
  expect(result).toEqual({ ok: false, reason: 'too_large' })
  expect(storage.calls).toHaveLength(0)
})

test('addPhoto rejects an empty file', async () => {
  // An <input type="file"> with nothing chosen still submits an entry with a
  // zero-byte body and an empty name.
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)

  expect(
    await addPhoto({ target, file: imageFile('image/jpeg', 0), storage: storage.client }),
  ).toEqual({ ok: false, reason: 'no_file' })
  expect(storage.calls).toHaveLength(0)
})

test('addPhoto writes no row when the upload fails', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target, { uploadError: 'network unreachable' })

  expect(await addPhoto({ target, file: imageFile(), storage: storage.client })).toEqual({
    ok: false,
    reason: 'upload_failed',
  })
  expect(await photoRows(target)).toEqual([])
})

test('addPhoto removes the uploaded object when the row insert fails', async () => {
  // The branch was deleted between the guard and the write: 23503. Without
  // the compensating remove, the object would be orphaned in the bucket with
  // nothing pointing at it and no way to find it again.
  const target: PhotoTarget = { kind: 'branch', branchId: UNKNOWN_ID }
  const storage = recorder(target)

  expect(await addPhoto({ target, file: imageFile(), storage: storage.client })).toEqual({
    ok: false,
    reason: 'target_missing',
  })
  expect(storage.calls.map((call) => call.op)).toEqual(['upload', 'remove'])
})

test('deletePhoto removes the object first, then the row', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)
  const added = await addPhoto({ target, file: imageFile(), storage: storage.client })
  if (!added.ok) throw new Error('addPhoto failed')

  expect(await deletePhoto({ target, photoId: added.photoId, storage: storage.client })).toEqual({
    ok: true,
  })

  const remove = storage.calls.find((call) => call.op === 'remove')!
  expect(remove.paths).toEqual([added.storagePath])
  // The row was still there when the object went: object first, then row.
  expect(remove.rowsAtCall).toBe(1)
  expect(await photoRows(target)).toEqual([])
})

test('deletePhoto keeps the row when the storage removal fails', async () => {
  // Retryable rather than lost: the owner presses delete again and the second
  // remove of a missing object is a no-op anyway.
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const ok = recorder(target)
  const added = await addPhoto({ target, file: imageFile(), storage: ok.client })
  if (!added.ok) throw new Error('addPhoto failed')

  const failing = recorder(target, { removeError: 'bucket unavailable' })
  expect(await deletePhoto({ target, photoId: added.photoId, storage: failing.client })).toEqual({
    ok: false,
    reason: 'delete_failed',
  })
  expect(await photoRows(target)).toHaveLength(1)
})

test('deletePhoto refuses a photo belonging to another target', async () => {
  // Target-scoped in the WHERE clause, not checked after a read: an owner who
  // passes their own branch id with someone else's photo id must delete
  // nothing.
  const first = await seedBranchWithCourts(0)
  const second = await seedBranchWithCourts(0)
  const firstTarget: PhotoTarget = { kind: 'branch', branchId: first.branchId }
  const storage = recorder(firstTarget)
  const added = await addPhoto({ target: firstTarget, file: imageFile(), storage: storage.client })
  if (!added.ok) throw new Error('addPhoto failed')

  const result = await deletePhoto({
    target: { kind: 'branch', branchId: second.branchId },
    photoId: added.photoId,
    storage: storage.client,
  })
  expect(result).toEqual({ ok: false, reason: 'not_found' })
  expect(await photoRows(firstTarget)).toHaveLength(1)
})

test('movePhoto swaps a photo with the one before it', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)
  const a = await addPhoto({ target, file: imageFile(), storage: storage.client })
  const b = await addPhoto({ target, file: imageFile(), storage: storage.client })
  if (!a.ok || !b.ok) throw new Error('addPhoto failed')

  expect(await movePhoto({ target, photoId: b.photoId, direction: 'up' })).toEqual({ ok: true })
  expect((await photoRows(target)).map((row) => row.id)).toEqual([b.photoId, a.photoId])

  expect(await movePhoto({ target, photoId: b.photoId, direction: 'down' })).toEqual({ ok: true })
  expect((await photoRows(target)).map((row) => row.id)).toEqual([a.photoId, b.photoId])
})

test('movePhoto reports at_edge at either end', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)
  const a = await addPhoto({ target, file: imageFile(), storage: storage.client })
  const b = await addPhoto({ target, file: imageFile(), storage: storage.client })
  if (!a.ok || !b.ok) throw new Error('addPhoto failed')

  expect(await movePhoto({ target, photoId: a.photoId, direction: 'up' })).toEqual({
    ok: false,
    reason: 'at_edge',
  })
  expect(await movePhoto({ target, photoId: b.photoId, direction: 'down' })).toEqual({
    ok: false,
    reason: 'at_edge',
  })
})

test('movePhoto resequences duplicate sort_order values', async () => {
  // branch_photos has no unique constraint on (branch_id, sort_order), and
  // scripts/seed-photos.ts writes 0,1,2 per branch with no coordination — so
  // duplicates are representable. A pure two-row swap would be a no-op on
  // two rows sharing a value; resequencing the whole list is self-healing.
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)
  const a = await addPhoto({ target, file: imageFile(), storage: storage.client })
  const b = await addPhoto({ target, file: imageFile(), storage: storage.client })
  if (!a.ok || !b.ok) throw new Error('addPhoto failed')
  await db.execute(sql`update branch_photos set sort_order = 0 where branch_id = ${branchId}::uuid`)

  expect(await movePhoto({ target, photoId: b.photoId, direction: 'up' })).toEqual({ ok: true })
  const rows = await photoRows(target)
  expect(rows.map((row) => row.sortOrder)).toEqual([0, 1])
  expect(rows[0].id).toBe(b.photoId)
})

test('movePhoto reports not_found for an unknown photo', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  expect(
    await movePhoto({
      target: { kind: 'branch', branchId },
      photoId: UNKNOWN_ID,
      direction: 'up',
    }),
  ).toEqual({ ok: false, reason: 'not_found' })
})
```

- [ ] **Step 3: Write the photo library**

Create `src/lib/listings/photos.ts`:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { PG_FOREIGN_KEY_VIOLATION, sqlStateOf } from '@/lib/db/sql-state'
import {
  ALLOWED_PHOTO_TYPES,
  MAX_PHOTO_BYTES,
  PHOTO_EXTENSIONS,
  type PhotoBucket,
} from '@/lib/photos'
import type { StorageClient } from '@/lib/listings/storage'

/**
 * Branch and court photos: upload, reorder, delete. No cropping, no editing
 * (see the spec's Out of scope).
 *
 * A photo edit NEVER re-queues a court — nothing here touches courts.status.
 *
 * `storage` is a parameter rather than an import so the one boundary that
 * cannot be rolled back is the one boundary the tests fake. The rows stay
 * real; the network call is observed.
 *
 * Branch and court photos live in two tables with two buckets and two path
 * prefixes, and each SQL statement below is written out for both kinds rather
 * than assembled from a variable table name. Building identifiers with
 * `sql.raw` for a two-case switch would trade a real safety property for four
 * saved lines.
 */
export type PhotoTarget = { kind: 'branch'; branchId: string } | { kind: 'court'; courtId: string }

export function bucketFor(target: PhotoTarget): PhotoBucket {
  return target.kind === 'branch' ? 'branch-photos' : 'court-photos'
}

/** The path prefix the seeded photos already use: `branches/<id>/`, `courts/<id>/`. */
function prefixFor(target: PhotoTarget): string {
  return target.kind === 'branch' ? `branches/${target.branchId}/` : `courts/${target.courtId}/`
}

export type AddPhotoResult =
  | { ok: true; photoId: string; storagePath: string }
  | { ok: false; reason: 'no_file' | 'bad_type' | 'too_large' | 'upload_failed' | 'target_missing' }

export async function addPhoto(input: {
  target: PhotoTarget
  file: File
  storage: StorageClient
}): Promise<AddPhotoResult> {
  const { file, target, storage } = input

  // An <input type="file"> with nothing chosen still submits a zero-byte
  // entry, so "empty" is the normal shape of "no photo attached".
  if (file.size === 0) return { ok: false, reason: 'no_file' }
  if (!(ALLOWED_PHOTO_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, reason: 'bad_type' }
  }
  if (file.size > MAX_PHOTO_BYTES) return { ok: false, reason: 'too_large' }

  // A fresh UUID per object, never the uploaded filename: two photos called
  // IMG_0001.jpg would otherwise collide, and a user-supplied name in a
  // public URL is a path-traversal question nobody needs to answer.
  const storagePath = `${prefixFor(target)}${crypto.randomUUID()}.${PHOTO_EXTENSIONS[file.type]}`
  const bytes = new Uint8Array(await file.arrayBuffer())

  // OBJECT FIRST. A row pointing at an object that does not exist renders a
  // broken image on the owner's own page; an object with no row is invisible
  // and unreclaimable. Of the two, only the first is fixable.
  const uploaded = await storage.upload(bucketFor(target), storagePath, bytes, file.type)
  if (uploaded.error !== null) return { ok: false, reason: 'upload_failed' }

  try {
    // sort_order = one past the current maximum, computed in SQL so two
    // concurrent uploads cannot both read the same maximum in TypeScript.
    // coalesce covers the first photo (max over zero rows is null).
    const result =
      target.kind === 'branch'
        ? await db.execute(sql`
            insert into branch_photos (branch_id, storage_path, sort_order)
            select ${target.branchId}::uuid, ${storagePath},
              coalesce(max(sort_order) + 1, 0)
            from branch_photos where branch_id = ${target.branchId}::uuid
            returning id
          `)
        : await db.execute(sql`
            insert into court_photos (court_id, storage_path, sort_order)
            select ${target.courtId}::uuid, ${storagePath},
              coalesce(max(sort_order) + 1, 0)
            from court_photos where court_id = ${target.courtId}::uuid
            returning id
          `)
    return { ok: true, photoId: result.rows[0].id as string, storagePath }
  } catch (error) {
    if (sqlStateOf(error) !== PG_FOREIGN_KEY_VIOLATION) throw error
    // The branch or court vanished between the guard and the write. Best
    // effort: take the object back out, so a failed add leaves nothing.
    await storage.remove(bucketFor(target), [storagePath])
    return { ok: false, reason: 'target_missing' }
  }
}

export type DeletePhotoResult = { ok: true } | { ok: false; reason: 'not_found' | 'delete_failed' }

export async function deletePhoto(input: {
  target: PhotoTarget
  photoId: string
  storage: StorageClient
}): Promise<DeletePhotoResult> {
  const { target, photoId, storage } = input

  // Target-scoped in the WHERE clause, not compared after a read: an owner
  // who passes their own branch id with someone else's photo id must find
  // nothing rather than be told whose it is.
  const found =
    target.kind === 'branch'
      ? await db.execute(sql`
          select storage_path from branch_photos
          where id = ${photoId}::uuid and branch_id = ${target.branchId}::uuid
        `)
      : await db.execute(sql`
          select storage_path from court_photos
          where id = ${photoId}::uuid and court_id = ${target.courtId}::uuid
        `)
  if (found.rows.length === 0) return { ok: false, reason: 'not_found' }
  const storagePath = found.rows[0].storage_path as string

  // OBJECT FIRST, for the reason addPhoto documents. If this succeeds and the
  // row delete below then fails, the owner sees a broken thumbnail and can
  // press delete again — a second remove of a missing object is a no-op.
  const removed = await storage.remove(bucketFor(target), [storagePath])
  if (removed.error !== null) return { ok: false, reason: 'delete_failed' }

  if (target.kind === 'branch') {
    await db.execute(sql`
      delete from branch_photos
      where id = ${photoId}::uuid and branch_id = ${target.branchId}::uuid
    `)
  } else {
    await db.execute(sql`
      delete from court_photos
      where id = ${photoId}::uuid and court_id = ${target.courtId}::uuid
    `)
  }
  return { ok: true }
}

export type MovePhotoResult = { ok: true } | { ok: false; reason: 'not_found' | 'at_edge' }

/**
 * Moves one photo one place up or down.
 *
 * Implemented as "reorder the list, then write every position back" rather
 * than as a two-row swap of sort_order values. Neither branch_photos nor
 * court_photos has a unique constraint on (target, sort_order) — and
 * scripts/seed-photos.ts writes 0,1,2 with no coordination — so duplicates
 * are representable, and a swap between two rows sharing a value would be a
 * silent no-op. Rewriting the whole sequence is self-healing and still
 * "swaps sort_order values" for the case the spec describes.
 *
 * One transaction, so a partial resequence can never leave two photos
 * claiming the same position.
 */
export async function movePhoto(input: {
  target: PhotoTarget
  photoId: string
  direction: 'up' | 'down'
}): Promise<MovePhotoResult> {
  const { target, photoId, direction } = input

  return db.transaction(
    async (tx) => {
      const listed =
        target.kind === 'branch'
          ? await tx.execute(sql`
              select id from branch_photos where branch_id = ${target.branchId}::uuid
              order by sort_order, id
              for update
            `)
          : await tx.execute(sql`
              select id from court_photos where court_id = ${target.courtId}::uuid
              order by sort_order, id
              for update
            `)

      const ids = listed.rows.map((row) => row.id as string)
      const index = ids.indexOf(photoId)
      if (index === -1) return { ok: false as const, reason: 'not_found' as const }

      const target_index = direction === 'up' ? index - 1 : index + 1
      if (target_index < 0 || target_index >= ids.length) {
        return { ok: false as const, reason: 'at_edge' as const }
      }

      const reordered = [...ids]
      reordered[index] = ids[target_index]
      reordered[target_index] = ids[index]

      for (const [position, id] of reordered.entries()) {
        if (target.kind === 'branch') {
          await tx.execute(sql`
            update branch_photos set sort_order = ${position}
            where id = ${id}::uuid and branch_id = ${target.branchId}::uuid
          `)
        } else {
          await tx.execute(sql`
            update court_photos set sort_order = ${position}
            where id = ${id}::uuid and court_id = ${target.courtId}::uuid
          `)
        }
      }

      return { ok: true as const }
    },
    { isolationLevel: 'read committed' },
  )
}
```

- [ ] **Step 4: Run the photo tests twice**

```bash
npx vitest run tests/listings/photos.test.ts && npx vitest run tests/listings/photos.test.ts
```

Expected: PASS both times, 15 tests each run. No object is ever written to the real bucket — the recorder is the only storage client these tests construct.

- [ ] **Step 5: Add the six photo actions**

Append to `src/app/dashboard/listings/actions.ts` (and extend its imports). The new imports:

```ts
import { addPhoto, deletePhoto, movePhoto, type PhotoTarget } from '@/lib/listings/photos'
import { serviceRoleStorage } from '@/lib/listings/storage'
```

And the actions, appended at the end of the file:

```ts
/**
 * Photos. Six actions rather than two with a `kind` field: the guard differs
 * by kind, and a kind read from the form would decide which guard runs —
 * exactly the confused-deputy shape the rest of this file avoids. Branch
 * photos are OWNER-ONLY (requireOwnerOf); court photos are shared with staff
 * holding manage_courts, with the branch resolved from the court row.
 *
 * None of these touches courts.status: photo edits never re-queue a court.
 */
const PHOTO_MESSAGES: Record<
  'no_file' | 'bad_type' | 'too_large' | 'upload_failed' | 'target_missing' | 'not_found' | 'delete_failed' | 'at_edge',
  string
> = {
  no_file: 'Choose a photo first.',
  bad_type: 'Photos must be JPEG, PNG or WebP.',
  too_large: 'That photo is over 5 MB — use a smaller one.',
  upload_failed: "That upload didn't go through. Try again.",
  target_missing: 'That listing no longer exists.',
  not_found: 'That photo is already gone.',
  delete_failed: "That photo couldn't be removed. Try again.",
  at_edge: 'That photo is already at the end.',
}

function photoFrom(formData: FormData): File | null {
  const file = formData.get('photo')
  return file instanceof File ? file : null
}

function directionFrom(formData: FormData): 'up' | 'down' | null {
  const direction = String(formData.get('direction') ?? '')
  return direction === 'up' || direction === 'down' ? direction : null
}

/** Guards a branch photo write and returns the target, or the message to show. */
async function branchPhotoTarget(
  formData: FormData,
): Promise<{ target: PhotoTarget; branchId: string } | { error: string }> {
  const branchId = idFrom(formData, 'branchId')
  if (!branchId) return { error: NOT_YOUR_BRANCH }
  try {
    await requireOwnerOf(branchId)
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_YOUR_BRANCH }
    throw error
  }
  return { target: { kind: 'branch', branchId }, branchId }
}

/** Same, for a court photo: manage_courts, with the branch read from the court row. */
async function courtPhotoTarget(
  formData: FormData,
): Promise<{ target: PhotoTarget; branchId: string } | { error: string }> {
  const context = await courtContext(formData)
  if ('error' in context) return context
  return { target: { kind: 'court', courtId: context.courtId }, branchId: context.branchId }
}

export async function addBranchPhotoAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const scope = await branchPhotoTarget(formData)
  if ('error' in scope) return scope

  const file = photoFrom(formData)
  if (!file) return { error: PHOTO_MESSAGES.no_file }

  const result = await addPhoto({ target: scope.target, file, storage: serviceRoleStorage() })
  if (!result.ok) return { error: PHOTO_MESSAGES[result.reason] }

  revalidateListing(scope.branchId)
  return { ok: true, message: 'Photo added.' }
}

export async function deleteBranchPhotoAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const scope = await branchPhotoTarget(formData)
  if ('error' in scope) return scope

  const photoId = idFrom(formData, 'photoId')
  if (!photoId) return { error: PHOTO_MESSAGES.not_found }

  const result = await deletePhoto({
    target: scope.target,
    photoId,
    storage: serviceRoleStorage(),
  })
  if (!result.ok) return { error: PHOTO_MESSAGES[result.reason] }

  revalidateListing(scope.branchId)
  return { ok: true, message: 'Photo removed.' }
}

export async function moveBranchPhotoAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const scope = await branchPhotoTarget(formData)
  if ('error' in scope) return scope

  const photoId = idFrom(formData, 'photoId')
  const direction = directionFrom(formData)
  if (!photoId || !direction) return { error: BAD_TARGET }

  const result = await movePhoto({ target: scope.target, photoId, direction })
  if (!result.ok) return { error: PHOTO_MESSAGES[result.reason] }

  revalidateListing(scope.branchId)
  return { ok: true, message: 'Order saved.' }
}

export async function addCourtPhotoAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const scope = await courtPhotoTarget(formData)
  if ('error' in scope) return scope

  const file = photoFrom(formData)
  if (!file) return { error: PHOTO_MESSAGES.no_file }

  const result = await addPhoto({ target: scope.target, file, storage: serviceRoleStorage() })
  if (!result.ok) return { error: PHOTO_MESSAGES[result.reason] }

  revalidateListing(scope.branchId)
  return { ok: true, message: 'Photo added.' }
}

export async function deleteCourtPhotoAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const scope = await courtPhotoTarget(formData)
  if ('error' in scope) return scope

  const photoId = idFrom(formData, 'photoId')
  if (!photoId) return { error: PHOTO_MESSAGES.not_found }

  const result = await deletePhoto({
    target: scope.target,
    photoId,
    storage: serviceRoleStorage(),
  })
  if (!result.ok) return { error: PHOTO_MESSAGES[result.reason] }

  revalidateListing(scope.branchId)
  return { ok: true, message: 'Photo removed.' }
}

export async function moveCourtPhotoAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const scope = await courtPhotoTarget(formData)
  if ('error' in scope) return scope

  const photoId = idFrom(formData, 'photoId')
  const direction = directionFrom(formData)
  if (!photoId || !direction) return { error: BAD_TARGET }

  const result = await movePhoto({ target: scope.target, photoId, direction })
  if (!result.ok) return { error: PHOTO_MESSAGES[result.reason] }

  revalidateListing(scope.branchId)
  return { ok: true, message: 'Order saved.' }
}
```

**Note:** `branchPhotoTarget` and `courtPhotoTarget` are module-private (not exported) — a non-async or non-action export would break the `'use server'` contract.

- [ ] **Step 6: Build the photo manager UI**

Create `src/app/dashboard/listings/photo-forms.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import {
  addBranchPhotoAction,
  addCourtPhotoAction,
  deleteBranchPhotoAction,
  deleteCourtPhotoAction,
  moveBranchPhotoAction,
  moveCourtPhotoAction,
  type ListingFormState,
} from './actions'
import { BORDERED_BUTTON, DARK_BUTTON, FIELD, FormMessage, LABEL } from './form-ui'
// ALLOWED_PHOTO_TYPES comes from the PURE photo module, never from
// src/lib/listings/photos.ts — that one is `server-only` and importing it
// here would throw the moment this component reached the client bundle.
import { ALLOWED_PHOTO_TYPES, photoUrl } from '@/lib/photos'

/**
 * Upload, reorder and delete, for branch photos and court photos alike.
 *
 * `kind` picks which pair of actions to bind — it never travels to the
 * server as a form field, because the guard differs by kind and a
 * client-chosen guard is not a guard. The hidden field each form does submit
 * is the branch id or the court id, whichever the bound action expects.
 *
 * Each photo row is its own component so it can own its own useActionState
 * hooks; hooks cannot be called inside a map.
 *
 * `canManage` is false for a staff member looking at branch photos: they see
 * the gallery, without the controls. The actions re-assert it regardless.
 */
const ACTIONS = {
  branch: {
    add: addBranchPhotoAction,
    remove: deleteBranchPhotoAction,
    move: moveBranchPhotoAction,
    idField: 'branchId',
    bucket: 'branch-photos',
  },
  court: {
    add: addCourtPhotoAction,
    remove: deleteCourtPhotoAction,
    move: moveCourtPhotoAction,
    idField: 'courtId',
    bucket: 'court-photos',
  },
} as const

function PhotoRow({
  kind,
  targetId,
  photo,
  isFirst,
  isLast,
}: {
  kind: 'branch' | 'court'
  targetId: string
  photo: { id: string; storagePath: string }
  isFirst: boolean
  isLast: boolean
}) {
  const config = ACTIONS[kind]
  const [moveState, moveAction, movePending] = useActionState<ListingFormState, FormData>(
    config.move,
    null,
  )
  const [removeState, removeAction, removePending] = useActionState<ListingFormState, FormData>(
    config.remove,
    null,
  )

  return (
    <li className="flex flex-col gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element -- the bucket is
          public and these are already-sized uploads; next/image would add a
          loader round trip for a dashboard thumbnail. */}
      <img
        src={photoUrl(config.bucket, photo.storagePath) ?? ''}
        alt=""
        className="h-[96px] w-[144px] rounded-[10px] object-cover"
      />
      <div className="flex flex-wrap gap-1.5">
        <form action={moveAction}>
          <input type="hidden" name={config.idField} value={targetId} />
          <input type="hidden" name="photoId" value={photo.id} />
          <input type="hidden" name="direction" value="up" />
          <button
            type="submit"
            disabled={isFirst || movePending}
            aria-label="Move photo earlier"
            className={BORDERED_BUTTON}
          >
            &uarr;
          </button>
        </form>
        <form action={moveAction}>
          <input type="hidden" name={config.idField} value={targetId} />
          <input type="hidden" name="photoId" value={photo.id} />
          <input type="hidden" name="direction" value="down" />
          <button
            type="submit"
            disabled={isLast || movePending}
            aria-label="Move photo later"
            className={BORDERED_BUTTON}
          >
            &darr;
          </button>
        </form>
        <form action={removeAction}>
          <input type="hidden" name={config.idField} value={targetId} />
          <input type="hidden" name="photoId" value={photo.id} />
          <button
            type="submit"
            disabled={removePending}
            aria-label="Delete photo"
            className={BORDERED_BUTTON}
          >
            {removePending ? 'Removing…' : 'Delete'}
          </button>
        </form>
      </div>
      <FormMessage state={moveState} />
      <FormMessage state={removeState} />
    </li>
  )
}

export function PhotoManager({
  kind,
  targetId,
  photos,
  canManage,
}: {
  kind: 'branch' | 'court'
  targetId: string
  photos: { id: string; storagePath: string }[]
  canManage: boolean
}) {
  const config = ACTIONS[kind]
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(config.add, null)

  return (
    <div className="flex flex-col gap-4">
      {photos.length === 0 ? (
        <p className="text-[13px] text-[var(--ink-soft)]">No photos yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-4">
          {photos.map((photo, index) =>
            canManage ? (
              <PhotoRow
                key={photo.id}
                kind={kind}
                targetId={targetId}
                photo={photo}
                isFirst={index === 0}
                isLast={index === photos.length - 1}
              />
            ) : (
              <li key={photo.id}>
                {/* eslint-disable-next-line @next/next/no-img-element -- see PhotoRow. */}
                <img
                  src={photoUrl(config.bucket, photo.storagePath) ?? ''}
                  alt=""
                  className="h-[96px] w-[144px] rounded-[10px] object-cover"
                />
              </li>
            ),
          )}
        </ul>
      )}

      {canManage && (
        <form action={formAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name={config.idField} value={targetId} />
          <div className="min-w-[240px] flex-1">
            <label className={LABEL} htmlFor={`photo-${kind}-${targetId}`}>
              Add a photo
            </label>
            <input
              id={`photo-${kind}-${targetId}`}
              name="photo"
              type="file"
              accept={ALLOWED_PHOTO_TYPES.join(',')}
              className={`${FIELD} py-1.5`}
            />
          </div>
          <button type="submit" disabled={pending} className={DARK_BUTTON}>
            {pending ? 'Uploading…' : 'Upload'}
          </button>
          <div className="w-full">
            <FormMessage state={state} />
            <p className="mt-1 text-[11.5px] text-[var(--ink-soft)]">
              JPEG, PNG or WebP, up to 5 MB. The first photo is the one players see first.
            </p>
          </div>
        </form>
      )}
    </div>
  )
}
```

- [ ] **Step 7: Add the photo sections to both pages**

In `src/app/dashboard/listings/[branchId]/page.tsx`, add the import:

```tsx
import { PhotoManager } from '../photo-forms'
```

and insert this section immediately after the "Branch details" `</section>`:

```tsx
      <section aria-label="Branch photos" className={`${CARD} mb-6`}>
        <h2 className="font-display mb-4 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
          Branch photos
        </h2>
        {/* Branch photos are owner-only, exactly like the branch fields
            above; staff with manage_courts see the gallery read-only. */}
        <PhotoManager
          kind="branch"
          targetId={branch.id}
          photos={branch.photos}
          canManage={access.isOwner}
        />
      </section>
```

In `src/app/dashboard/listings/[branchId]/courts/[courtId]/page.tsx`, add the import:

```tsx
import { PhotoManager } from '../../../photo-forms'
```

and insert this section immediately after the "Court details" `</section>`:

```tsx
      <section aria-label="Court photos" className={`${CARD} mb-6`}>
        <h2 className="font-display mb-1 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
          Court photos
        </h2>
        <p className="mb-4 text-[12.5px] text-[var(--ink-soft)]">
          Photo changes do not send this court back for approval.
        </p>
        {/* canManage is unconditionally true here: reaching this page already
            required manage_courts on this branch. */}
        <PhotoManager kind="court" targetId={court.id} photos={court.photos} canManage />
      </section>
```

- [ ] **Step 8: Typecheck, lint, build, and re-run the action-coverage test**

```bash
npx tsc --noEmit && npm run lint && npm run build && npx vitest run tests/auth/action-coverage.test.ts
```

Expected: no type errors; lint reports only the pre-existing warnings plus nothing new (the two `<img>` uses carry their own inline disable comments); the build succeeds; action-coverage PASSES — the photo actions live in the same already-guarded file.

- [ ] **Step 9: Commit**

```bash
git add src/lib/photos.ts src/lib/listings/storage.ts src/lib/listings/photos.ts src/app/dashboard/listings/photo-forms.tsx src/app/dashboard/listings/actions.ts "src/app/dashboard/listings/[branchId]/page.tsx" "src/app/dashboard/listings/[branchId]/courts/[courtId]/page.tsx" tests/listings/photos.test.ts
git commit -m "Add branch and court photo upload, reorder, and delete"
```

---

### Task 9: Geocoding and the draggable map pin

**Files:**
- Create: `src/lib/geo/geocode.ts`
- Create: `src/components/listings/pin-map.tsx`
- Create: `src/components/listings/pin-map-dynamic.tsx`
- Create: `src/app/dashboard/listings/location-picker.tsx`
- Create: `tests/listings/geocode.test.ts`
- Modify: `src/lib/geo/cities.ts` (add `cityCenterByName`)
- Modify: `src/app/dashboard/listings/actions.ts` (add `geocodeAddressAction`)
- Modify: `src/app/dashboard/listings/branch-fieldset.tsx` (swap the temporary lat/lng block for the picker)

**Interfaces:**
- Produces, from `src/lib/geo/geocode.ts`:

```ts
export type GeocodeResult = { lat: number; lng: number }
export type Geocoder = (query: string) => Promise<GeocodeResult | null>
export const NOMINATIM_ENDPOINT: 'https://nominatim.openstreetmap.org/search'
export const GEOCODER_USER_AGENT: string
export function createNominatimGeocoder(fetchImpl?: typeof fetch): Geocoder
export function createCachedGeocoder(geocoder: Geocoder): Geocoder
export const geocodeAddress: Geocoder
```
- Produces, from `src/lib/geo/cities.ts`:

```ts
export function cityCenterByName(name: string | null | undefined): City
```
- Produces, from `src/app/dashboard/listings/actions.ts`:

```ts
export async function geocodeAddressAction(query: string): Promise<GeocodeResult | null>
```
- Produces, from `src/components/listings/pin-map.tsx` / `pin-map-dynamic.tsx` (`'use client'`):

```ts
export function PinMap(props: { lat: number; lng: number; hasPin: boolean; onMove: (lat: number, lng: number) => void }): React.ReactElement
```
- Produces, from `src/app/dashboard/listings/location-picker.tsx` (`'use client'`):

```ts
export function LocationPicker(props: {
  idPrefix: string; address: string; city: string; lat: number | null; lng: number | null
}): React.ReactElement
```

**Geocoding is non-blocking, by construction.** Every failure path — no result, a non-2xx response, a thrown fetch, a result outside the Philippines — returns `null`, and the picker's answer to `null` is "drag the pin instead". The pin can always be placed by hand, and `parseBranchFields` accepts a branch with no pin at all.

- [ ] **Step 1: Write the failing geocoder tests**

Create `tests/listings/geocode.test.ts`:

```ts
import { expect, test, vi } from 'vitest'
import {
  createCachedGeocoder,
  createNominatimGeocoder,
  GEOCODER_USER_AGENT,
  NOMINATIM_ENDPOINT,
  type Geocoder,
} from '@/lib/geo/geocode'
import { cityCenterByName } from '@/lib/geo/cities'

/**
 * `fetch` is the second and last permitted test double in this slice, for the
 * obvious reason: Nominatim is somebody else's server with a usage policy,
 * and a test suite is not allowed to be traffic. The Nominatim call itself is
 * deliberately NOT integration-tested (the spec says so); what is tested is
 * that the request we would send is the polite, correct one and that every
 * failure shape degrades to null.
 */
function fakeFetch(response: {
  ok?: boolean
  status?: number
  body?: unknown
  throws?: boolean
}) {
  return vi.fn(async () => {
    if (response.throws) throw new Error('network down')
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body,
    } as unknown as Response
  })
}

test('the Nominatim geocoder sends a polite, one-result, PH-restricted request', async () => {
  const fetchImpl = fakeFetch({ body: [{ lat: '14.6507', lon: '121.1029' }] })
  const geocode = createNominatimGeocoder(fetchImpl as unknown as typeof fetch)

  await geocode('12 Shoe Ave, Marikina, Philippines')

  expect(fetchImpl).toHaveBeenCalledTimes(1)
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit]
  expect(String(url).startsWith(NOMINATIM_ENDPOINT)).toBe(true)
  const params = new URL(String(url)).searchParams
  expect(params.get('q')).toBe('12 Shoe Ave, Marikina, Philippines')
  expect(params.get('format')).toBe('jsonv2')
  // limit=1: one request per submit, no bulk. countrycodes=ph narrows the
  // answer to the only country this product operates in.
  expect(params.get('limit')).toBe('1')
  expect(params.get('countrycodes')).toBe('ph')
  // Nominatim's usage policy REQUIRES an identifying User-Agent. Requests
  // without one are blocked, and a generic one gets the whole app banned.
  expect((init.headers as Record<string, string>)['User-Agent']).toBe(GEOCODER_USER_AGENT)
})

test('the Nominatim geocoder returns the first result coordinates as numbers', async () => {
  // Nominatim returns lat/lon as STRINGS. Handing those to st_makepoint
  // unconverted would be a type error at best and a silent 0 at worst.
  const geocode = createNominatimGeocoder(
    fakeFetch({ body: [{ lat: '14.6507', lon: '121.1029' }] }) as unknown as typeof fetch,
  )
  expect(await geocode('Marikina')).toEqual({ lat: 14.6507, lng: 121.1029 })
})

test('the Nominatim geocoder returns null for an empty result list', async () => {
  const geocode = createNominatimGeocoder(fakeFetch({ body: [] }) as unknown as typeof fetch)
  expect(await geocode('nowhere at all')).toBeNull()
})

test('the Nominatim geocoder returns null for a non-2xx response', async () => {
  // 429 is the realistic one: Nominatim rate-limits, and being rate-limited
  // must not stop an owner from saving their branch.
  const geocode = createNominatimGeocoder(
    fakeFetch({ ok: false, status: 429, body: {} }) as unknown as typeof fetch,
  )
  expect(await geocode('Marikina')).toBeNull()
})

test('the Nominatim geocoder returns null when the network throws', async () => {
  const geocode = createNominatimGeocoder(fakeFetch({ throws: true }) as unknown as typeof fetch)
  expect(await geocode('Marikina')).toBeNull()
})

test('the Nominatim geocoder rejects a result outside the Philippines', async () => {
  // countrycodes=ph is a request, not a guarantee. The same bounding box the
  // form uses is applied to the geocoder's answer, so a bad result cannot
  // pre-fill a pin the form would then reject.
  const geocode = createNominatimGeocoder(
    fakeFetch({ body: [{ lat: '1.3521', lon: '103.8198' }] }) as unknown as typeof fetch,
  )
  expect(await geocode('Singapore')).toBeNull()
})

test('the Nominatim geocoder returns null for a blank query without calling the network', async () => {
  const fetchImpl = fakeFetch({ body: [] })
  const geocode = createNominatimGeocoder(fetchImpl as unknown as typeof fetch)
  expect(await geocode('   ')).toBeNull()
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('the cached geocoder asks the provider once per address', async () => {
  // Nominatim's usage policy is the reason this cache exists at all: an owner
  // pressing "Find on map" repeatedly must not become repeated traffic.
  let calls = 0
  const inner: Geocoder = async () => {
    calls += 1
    return { lat: 14.6507, lng: 121.1029 }
  }
  const geocode = createCachedGeocoder(inner)

  expect(await geocode('12 Shoe Ave, Marikina')).toEqual({ lat: 14.6507, lng: 121.1029 })
  expect(await geocode('12 Shoe Ave, Marikina')).toEqual({ lat: 14.6507, lng: 121.1029 })
  expect(calls).toBe(1)
})

test('the cached geocoder normalizes case and whitespace, and caches misses too', async () => {
  // Caching the miss matters more than caching the hit: a typo'd address is
  // exactly what someone retries five times in a row.
  let calls = 0
  const inner: Geocoder = async () => {
    calls += 1
    return null
  }
  const geocode = createCachedGeocoder(inner)

  expect(await geocode('12 Shoe Ave,  Marikina')).toBeNull()
  expect(await geocode('  12 SHOE AVE, MARIKINA  ')).toBeNull()
  expect(calls).toBe(1)
})

test('cityCenterByName finds a known city and falls back to Metro Manila', async () => {
  // The pin editor has to start somewhere when a branch has no pin yet.
  expect(cityCenterByName('Marikina')).toMatchObject({ slug: 'marikina' })
  expect(cityCenterByName('  marikina ')).toMatchObject({ slug: 'marikina' })
  expect(cityCenterByName('Cebu City')).toMatchObject({ slug: 'metro-manila' })
  expect(cityCenterByName(null)).toMatchObject({ slug: 'metro-manila' })
})
```

- [ ] **Step 2: Add `cityCenterByName`**

Append to `src/lib/geo/cities.ts`:

```ts
/**
 * A city centroid looked up by its display NAME rather than its slug —
 * `branches.city` is free text typed by an owner, not a slug.
 *
 * Used only to decide where the map pin editor opens when a branch has no
 * pin yet. An unknown city (Cebu, Davao, anywhere outside the seeded list)
 * falls back to the region-wide default, which is a starting view, not a
 * claim about where the branch is — the owner drags the pin from there.
 */
export function cityCenterByName(name: string | null | undefined): City {
  const normalized = (name ?? '').trim().toLowerCase()
  return (
    CITIES.find((city) => city.slug !== DEFAULT_CITY_SLUG && city.name.toLowerCase() === normalized) ??
    cityBySlug(DEFAULT_CITY_SLUG)
  )
}
```

- [ ] **Step 3: Write the geocoder**

Create `src/lib/geo/geocode.ts`:

```ts
import 'server-only'
import { isInPhilippines } from '@/lib/listings/fields'

/**
 * Address -> coordinates, behind a provider-swappable function type.
 *
 * Nominatim (OpenStreetMap) today: no API key, and this product's volume is
 * one request per branch form submit. `Geocoder` is a plain function type so
 * swapping in Google later is a one-line change at the bottom of this file
 * and nothing else moves.
 *
 * NON-BLOCKING BY CONSTRUCTION. Every failure — no result, a rate-limit, a
 * dead network, a result in the wrong country — returns null, and null means
 * "the owner places the pin by hand". Geocoding is a convenience; the drag is
 * the precision tool and the only one that is guaranteed to work.
 */
export type GeocodeResult = { lat: number; lng: number }
export type Geocoder = (query: string) => Promise<GeocodeResult | null>

export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search'

/**
 * Nominatim's usage policy REQUIRES an identifying User-Agent with a way to
 * reach the operator. Requests without one are blocked outright, and sharing
 * a generic one is how an application gets banned for someone else's traffic.
 * Update the URL if the deployed domain changes.
 */
export const GEOCODER_USER_AGENT = 'OnCourt/1.0 (+https://oncourt.ph; listings geocoder)'

export function createNominatimGeocoder(fetchImpl: typeof fetch = fetch): Geocoder {
  return async (query: string) => {
    const trimmed = query.trim()
    if (trimmed.length === 0) return null

    const url = new URL(NOMINATIM_ENDPOINT)
    url.searchParams.set('q', trimmed)
    url.searchParams.set('format', 'jsonv2')
    // ONE result, ONE request per submit — no bulk geocoding, per the usage
    // policy and per the spec's "low volume; the pin drag is the precision
    // tool".
    url.searchParams.set('limit', '1')
    url.searchParams.set('countrycodes', 'ph')

    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': GEOCODER_USER_AGENT, 'Accept-Language': 'en' },
      })
      if (!response.ok) return null

      const body = (await response.json()) as unknown
      if (!Array.isArray(body) || body.length === 0) return null

      // Nominatim returns lat/lon as strings, and calls longitude "lon".
      const first = body[0] as { lat?: string; lon?: string }
      const lat = Number(first.lat)
      const lng = Number(first.lon)

      // countrycodes=ph is a request, not a guarantee — and the form applies
      // the same box, so letting a foreign result through would only pre-fill
      // a pin that then fails validation.
      if (!isInPhilippines(lat, lng)) return null
      return { lat, lng }
    } catch {
      // A dead network must not stop someone saving their branch.
      return null
    }
  }
}

/** Entries kept before the oldest is evicted. Small on purpose: this is a courtesy cache. */
const CACHE_LIMIT = 200

/**
 * Memoizes per address string, misses included.
 *
 * Caching the misses is the more valuable half: a typo'd address is exactly
 * what somebody retries five times in a row, and each retry would otherwise
 * be a request to somebody else's server.
 *
 * In-memory and per-process, so it does not survive a deploy or span
 * instances. That is fine — it exists to be polite, not to be a datastore.
 */
export function createCachedGeocoder(geocoder: Geocoder): Geocoder {
  const cache = new Map<string, GeocodeResult | null>()

  return async (query: string) => {
    const key = query.trim().toLowerCase().replace(/\s+/g, ' ')
    if (cache.has(key)) return cache.get(key) ?? null

    const result = await geocoder(query)
    // Map iterates in insertion order, so the first key is the oldest.
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
    cache.set(key, result)
    return result
  }
}

/** The one the app uses. Swap the inner factory to change providers. */
export const geocodeAddress: Geocoder = createCachedGeocoder(createNominatimGeocoder())
```

- [ ] **Step 4: Run the geocoder tests twice**

```bash
npx vitest run tests/listings/geocode.test.ts && npx vitest run tests/listings/geocode.test.ts
```

Expected: PASS both times, 11 tests each run. No real HTTP request is made — every geocoder in the file is constructed with a fake.

- [ ] **Step 5: Add the geocode action**

Append to `src/app/dashboard/listings/actions.ts` (imports first):

```ts
import { geocodeAddress, type GeocodeResult } from '@/lib/geo/geocode'
```

```ts
/**
 * Address -> coordinates for the branch form's map pin.
 *
 * requireOwner, per the spec: only a court owner can reach the branch form,
 * and this action calls an external service on the app's shared quota — an
 * unguarded endpoint would be a free geocoding proxy for anyone with the
 * action id.
 *
 * Returns null for every failure, including "not signed in as an owner". The
 * caller's answer to null is always the same — "place the pin by hand" — so
 * distinguishing the reasons would only leak which one it was.
 *
 * Takes a plain string rather than FormData: it is invoked imperatively from
 * the picker, not submitted by a form, because the branch form cannot nest a
 * second form inside itself.
 */
export async function geocodeAddressAction(query: string): Promise<GeocodeResult | null> {
  try {
    await requireOwner()
  } catch (error) {
    if (error instanceof AuthError) return null
    throw error
  }
  return geocodeAddress(query)
}
```

- [ ] **Step 6: Build the pin map**

Create `src/components/listings/pin-map.tsx`:

```tsx
'use client'

import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  addDuotoneTileLayer,
  DuotoneFilterDefs,
  MAP_DUOTONE_STYLE,
  MAP_SCOPE_CLASS,
} from '@/components/map/map-base'

/**
 * A single DRAGGABLE pin, for the branch form.
 *
 * Deliberately not a reuse of BranchMap (src/components/branch/branch-map.tsx):
 * that one is read-only, has no drag handler, and never moves after mount.
 * This one has to follow a geocode result AND report the owner's drag back
 * up. What the two do share — the CARTO duotone tile layer and its filter —
 * comes from map-base, as it does for SearchMap, rather than being copied a
 * third time.
 *
 * `hasPin` only changes how the marker looks: an unset pin renders hollow so
 * "the map is showing my city" cannot be mistaken for "my venue is here".
 * Dragging it is what sets it, which is why the marker exists either way.
 */
const ZOOM = 16

export function PinMap({
  lat,
  lng,
  hasPin,
  onMove,
}: {
  lat: number
  lng: number
  hasPin: boolean
  onMove: (lat: number, lng: number) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)
  // The drag handler is registered once, at mount, but must always call the
  // CURRENT onMove — a stale closure would report the drag to a dead setter.
  const onMoveRef = useRef(onMove)
  onMoveRef.current = onMove

  useEffect(() => {
    if (!containerRef.current) return
    const map = L.map(containerRef.current, { zoomControl: true, scrollWheelZoom: false })
    addDuotoneTileLayer(map, L)
    // The container can still be mid-layout when next/dynamic swaps this in,
    // leaving Leaflet's cached size wrong — same reasoning as branch-map.tsx.
    map.invalidateSize()
    map.setView([lat, lng], ZOOM)

    const marker = L.marker([lat, lng], {
      draggable: true,
      icon: L.divIcon({ className: 'pin-editor-icon', html: '<span class="pin-editor"></span>' }),
    }).addTo(map)
    marker.on('dragend', () => {
      const position = marker.getLatLng()
      onMoveRef.current(position.lat, position.lng)
    })

    mapRef.current = map
    markerRef.current = marker

    // React 19 StrictMode double-invokes effects in dev, so this cleanup is
    // load-bearing: without it the second mount throws "Map container is
    // already initialized."
    return () => {
      map.remove()
      mapRef.current = null
      markerRef.current = null
    }
    // Created once; the effect below follows later lat/lng changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follows a geocode result (or a re-render after a drag) without tearing
  // the map down and rebuilding it.
  useEffect(() => {
    if (!mapRef.current || !markerRef.current) return
    markerRef.current.setLatLng([lat, lng])
    mapRef.current.setView([lat, lng], mapRef.current.getZoom())
  }, [lat, lng])

  return (
    <>
      <DuotoneFilterDefs />
      <style>{`
        ${MAP_DUOTONE_STYLE}
        .oncourt-pin-map .pin-editor-icon { background: transparent; border: none; }
        .oncourt-pin-map .pin-editor {
          display: block;
          width: 18px; height: 18px;
          border-radius: 50% 50% 50% 0;
          transform: rotate(-45deg);
          background: ${hasPin ? 'var(--court-deep)' : 'transparent'};
          border: 2px solid ${hasPin ? 'white' : 'var(--court-deep)'};
          box-shadow: 0 2px 6px rgba(14, 42, 31, .35);
          cursor: grab;
        }
      `}</style>
      <div
        ref={containerRef}
        role="region"
        aria-label="Drag the marker to your venue's location"
        className={`${MAP_SCOPE_CLASS} oncourt-pin-map h-[240px] w-full overflow-hidden rounded-[10px]`}
      />
    </>
  )
}
```

Create `src/components/listings/pin-map-dynamic.tsx`:

```tsx
'use client'

import dynamic from 'next/dynamic'

/**
 * `PinMap` touches `window` at module scope (via `leaflet`), so it cannot be
 * imported directly by anything that renders on the server. Same mechanism,
 * same shape as src/components/branch/branch-map-dynamic.tsx: dynamic-import
 * with `ssr: false` from a small client module and render that instead.
 *
 * The loading fallback is the same height as the map so nothing jumps when
 * the client bundle arrives.
 */
export const PinMap = dynamic(() => import('./pin-map').then((m) => m.PinMap), {
  ssr: false,
  loading: () => <div className="h-[240px] w-full rounded-[10px] bg-[var(--band-off)]" />,
})
```

- [ ] **Step 7: Build the location picker**

Create `src/app/dashboard/listings/location-picker.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { geocodeAddressAction } from './actions'
import { BORDERED_BUTTON, LABEL } from './form-ui'
import { PinMap } from '@/components/listings/pin-map-dynamic'
import { cityCenterByName } from '@/lib/geo/cities'

/**
 * Address + draggable pin, exactly as the spec rules it: geocode what was
 * typed, then let the owner fine-tune by dragging.
 *
 * The pin's value reaches the server through two HIDDEN inputs named `lat`
 * and `lng` — the same field names the plain number inputs used before this
 * component existed, which is why parseBranchFields needed no change.
 *
 * geocodeAddressAction is called IMPERATIVELY inside a transition rather than
 * through a nested form: this component lives inside the branch form, and
 * HTML forbids a form inside a form. A `formAction` button would submit the
 * branch instead.
 *
 * Failure is never blocking. A null result sets a message and leaves the map
 * exactly where it was, because dragging always works.
 */
export function LocationPicker({
  idPrefix,
  address,
  city,
  lat,
  lng,
}: {
  idPrefix: string
  address: string
  city: string
  lat: number | null
  lng: number | null
}) {
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(
    lat !== null && lng !== null ? { lat, lng } : null,
  )
  const [message, setMessage] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // With no pin, the map opens on the typed city — a starting view, not a
  // claim. An unrecognized city falls back to Metro Manila.
  const fallback = cityCenterByName(city)
  const center = pin ?? { lat: fallback.lat, lng: fallback.lng }

  function findOnMap() {
    const query = [address, city, 'Philippines'].filter((part) => part.trim().length > 0).join(', ')
    startTransition(async () => {
      const result = await geocodeAddressAction(query)
      if (!result) {
        setMessage("We couldn't find that address. Drag the pin to place it yourself.")
        return
      }
      setPin(result)
      setMessage('Found it — drag the pin if it is not exactly right.')
    })
  }

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className={LABEL}>Map location</legend>

      <input type="hidden" name="lat" value={pin === null ? '' : String(pin.lat)} />
      <input type="hidden" name="lng" value={pin === null ? '' : String(pin.lng)} />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={findOnMap}
          disabled={pending || address.trim().length === 0}
          className={BORDERED_BUTTON}
          id={`${idPrefix}-geocode`}
        >
          {pending ? 'Searching…' : 'Find on map'}
        </button>
        {pin !== null && (
          <>
            <span className="font-mono text-[11.5px] text-[var(--ink-soft)]">
              {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
            </span>
            <button
              type="button"
              onClick={() => {
                setPin(null)
                setMessage(null)
              }}
              className={BORDERED_BUTTON}
            >
              Clear pin
            </button>
          </>
        )}
      </div>

      <PinMap
        lat={center.lat}
        lng={center.lng}
        hasPin={pin !== null}
        onMove={(nextLat, nextLng) => {
          setPin({ lat: nextLat, lng: nextLng })
          setMessage(null)
        }}
      />

      <p role="status" className="text-[11.5px] text-[var(--ink-soft)]">
        {message ??
          (pin === null
            ? 'No pin set yet — drag the marker onto your venue, or use Find on map. A branch with no pin will not appear in map or distance searches.'
            : 'Drag the marker to fine-tune the exact spot.')}
      </p>
    </fieldset>
  )
}
```

- [ ] **Step 8: Swap the temporary lat/lng block for the picker**

In `src/app/dashboard/listings/branch-fieldset.tsx`:

1. Change the imports at the top to add React state and the picker, and drop the now-unused length constants only if they become unused (they do not — the text fields still use them):

```tsx
import { useState } from 'react'
import { LocationPicker } from './location-picker'
```

2. Make `address` and `city` controlled, so the picker always geocodes what is currently typed rather than reading sibling DOM nodes. Inside `BranchFieldset`, above the `return`:

```tsx
  // Controlled ONLY for these two: LocationPicker needs their live values to
  // build its query, and reading them back out of the DOM by id would be a
  // second source of truth for the same field.
  const [address, setAddress] = useState(defaults?.address ?? '')
  const [city, setCity] = useState(defaults?.city ?? '')
```

3. Replace the city input's `defaultValue={defaults?.city ?? ''}` with:

```tsx
            value={city}
            onChange={(event) => setCity(event.target.value)}
```

4. Replace the address input's `defaultValue={defaults?.address ?? ''}` with:

```tsx
          value={address}
          onChange={(event) => setAddress(event.target.value)}
```

5. Replace the **entire** `TEMPORARY CHROME` comment and the `<fieldset>` that follows it (through its closing `</fieldset>`) with:

```tsx
      <LocationPicker
        idPrefix={idPrefix}
        address={address}
        city={city}
        lat={defaults?.lat ?? null}
        lng={defaults?.lng ?? null}
      />
```

- [ ] **Step 9: Typecheck, lint, build**

```bash
npx tsc --noEmit && npm run lint && npm run build
```

Expected: no type errors; lint reports only the pre-existing warnings plus the one inline-disabled `react-hooks/exhaustive-deps` in `pin-map.tsx` (which carries its own disable comment, matching `branch-map.tsx`); the build succeeds. A build error mentioning `window is not defined` means `pin-map.tsx` was imported directly instead of through `pin-map-dynamic.tsx`.

- [ ] **Step 10: Run the full listings suite twice**

```bash
npx vitest run tests/listings/ && npx vitest run tests/listings/
```

Expected: PASS both times — seven files: `schedule.test.ts`, `fields.test.ts`, `write.test.ts`, `queries.test.ts`, `permissions.test.ts`, `photos.test.ts`, `geocode.test.ts`.

- [ ] **Step 11: Commit**

```bash
git add src/lib/geo/geocode.ts src/lib/geo/cities.ts src/components/listings/pin-map.tsx src/components/listings/pin-map-dynamic.tsx src/app/dashboard/listings/location-picker.tsx src/app/dashboard/listings/branch-fieldset.tsx src/app/dashboard/listings/actions.ts tests/listings/geocode.test.ts
git commit -m "Add Nominatim geocoding behind a provider interface and a draggable map pin"
```

---

### Task 10: Make the feature reachable — the sidebar item and the staff form's promise

**Files:**
- Modify: `src/app/dashboard/layout.tsx`
- Modify: `src/app/dashboard/staff/staff-forms.tsx`

**Interfaces:**
- Produces: no new exports. `DashboardLayout` gains one nav item; `PermissionCheckboxes` loses one paragraph.
- Consumes: `branchIdsWith` from `@/lib/staff/access` (already imported in `src/app/dashboard/page.tsx`; new to the layout).

**Why these two edits are one task:** the staff form currently promises "Court management arrives with the listings update — the permission is saved now and applies then." That sentence stops being true the moment `manage_courts` grants real access, and the sidebar item is what makes the access reachable. Shipping either without the other leaves the app lying to an owner in one direction or the other.

**Deliberately NOT in this slice:** the public "List your court" CTAs still point at `/login`. Owner accounts are admin-vetted (the roles slice removed self-serve promotion), so the screen those CTAs should lead to is Slice C's promote-to-owner page. Rewiring them here would only move the dead end.

- [ ] **Step 1: Add the sidebar item**

In `src/app/dashboard/layout.tsx`, add the import:

```ts
import { branchIdsWith } from '@/lib/staff/access'
```

and replace the `items` array with:

```ts
  const items = [
    { href: '/dashboard', label: 'Overview', show: true },
    { href: '/dashboard/bookings', label: 'Bookings', show: access.can.view_bookings },
    {
      href: '/dashboard/listings',
      label: 'Branches & courts',
      // Owners always — an owner with no branches yet needs this item most of
      // all, since it is where they add their first one. Staff only where a
      // manage_courts grant actually exists: access.can.manage_courts would
      // be the union across every branch they can see AT ALL, which is the
      // right test for "should this item render" only because
      // branchIdsWith is what the page then scopes its query by. Using
      // branchIdsWith here too keeps the item and the page's contents
      // answering the same question.
      show: access.isOwner || branchIdsWith(access, 'manage_courts').length > 0,
    },
    { href: '/dashboard/earnings', label: 'Earnings', show: access.can.view_earnings },
    { href: '/dashboard/staff', label: 'Staff', show: access.isOwner },
  ].filter((item) => item.show)
```

Also update the comment block directly above `items`, which currently claims the mockup's "Branches & courts" item belongs to a later slice. Replace that paragraph:

```ts
  // Only sections this session can actually use. A staff member without
  // view_earnings must not see an Earnings item that then bounces them; a
  // staff member must not see Staff at all, since staff management is
  // owner-only (requireOwnerPage guards that page, and its actions use
  // requireOwnerOf).
  //
  // Overview is unconditional: everyone admitted here has at least one
  // permission on at least one branch (branch_staff_some_permission
  // guarantees it), and the overview degrades to the empty state otherwise.
  //
  // The mockup also lists Reviews and Settings; those are later slices, and a
  // nav item pointing at a 404 is worse than no item.
```

And remove the now-stale sentence in the file's top docstring that reads "The mockup also lists Branches & courts, Reviews, and Settings; those are later slices" — replace `Branches & courts, Reviews, and Settings` with `Reviews and Settings`.

- [ ] **Step 2: Delete the staff form's placeholder promise**

In `src/app/dashboard/staff/staff-forms.tsx`, delete this comment and the paragraph it introduces, in full — from the `{/* manage_courts has no effect yet` comment through the closing `</p>`:

```tsx
      {/* manage_courts has no effect yet — the courts slice that consults it
          hasn't shipped. Kept as a real, saveable checkbox rather than removed
          or disabled: the spec mandates all four permissions, and this line is
          what keeps checking it from being silently misleading in the
          meantime. */}
      <p className="w-full basis-full text-[11.5px] text-[var(--ink-soft)]">
        Court management arrives with the listings update — the permission is saved now and
        applies then.
      </p>
```

Nothing replaces it: all four permissions now do exactly what their labels say, so an explanatory line under the checkboxes would be noise.

- [ ] **Step 3: Confirm the sentence is gone and nothing else referenced it**

```bash
grep -rn "arrives with the listings" src tests || echo "gone"
```

Expected: `gone`.

- [ ] **Step 4: Typecheck, lint, build, full suite**

```bash
npx tsc --noEmit && npm run lint && npm run build && npm test
```

Expected: no type errors; lint reports only the pre-existing warnings; the build succeeds; every test passes. If one of the known flaky DB files times out, re-run that file alone before investigating.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/layout.tsx src/app/dashboard/staff/staff-forms.tsx
git commit -m "Add the Branches & courts sidebar item and retire the staff form placeholder"
```

---

### Task 11: Manual verification

**Files:** none. This task changes nothing; it is the browser pass every earlier task deliberately excluded, collected in one place so implementation tasks stay verifiable by tests alone.

**Interfaces:** none.

Everything below needs a running dev server and a real signed-in account, so none of it can be asserted by the suite. Work through it in order; each line is a claim the automated tests cannot make.

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

Expected: `Local: http://localhost:3000`. Leave it running for the rest of this task.

- [ ] **Step 2: Owner path — create a branch end to end**

Signed in as an account whose `profiles.role` is `owner`:

- [ ] `/dashboard` shows a **Branches & courts** item in the sidebar.
- [ ] `/dashboard/listings` renders; with no branches it shows the empty state and the **Add a branch** card.
- [ ] Fill in name, city, address. Press **Find on map** — the pin moves to the geocoded spot and the coordinates appear in mono beside the button. (If Nominatim rate-limits, the message reads "We couldn't find that address. Drag the pin to place it yourself." and the form still works — that is the non-blocking path, not a failure.)
- [ ] Drag the marker; the coordinates update and the pin turns solid.
- [ ] Submit. The browser lands on `/dashboard/listings/<branchId>` and the branch's details are pre-filled.
- [ ] Tab through the whole form: **every** control shows the green focus ring — text inputs, textarea, amenity checkboxes, both map buttons, the submit button, and the back link.

- [ ] **Step 3: Photos**

- [ ] Upload a JPEG under 5 MB to **Branch photos**. The thumbnail appears.
- [ ] Upload a second one, then press ↓ on the first: the order swaps and survives a page reload.
- [ ] Press **Delete** on one: it disappears, and reloading confirms it is gone. Open its public URL (`.../storage/v1/object/public/branch-photos/branches/<id>/<file>`) — it 404s, proving the object went with the row.
- [ ] Try uploading a PDF: the message reads "Photos must be JPEG, PNG or WebP." and nothing is added.

- [ ] **Step 4: Court lifecycle**

- [ ] Add a court. It appears in the court list marked **Pending**, and the court page's banner says "Awaiting approval".
- [ ] Set opening hours and save: the banner still says pending, and the message under the button says "Saved."
- [ ] Set rate bands that leave a gap (e.g. 11–15 and 16–24 for an 11–24 court). The form refuses with the tiling message and the old bands are still listed above.
- [ ] Set tiling bands and save: "Saved." and the summary line above the form updates.
- [ ] Flip the court to `approved` by hand (`update courts set status='approved' where id='<courtId>'` through the pooler), reload: the banner reads "Approved" and the court now appears on `/venues/<slug>` and in `/search`.
- [ ] Rename the court and save: the message is **"Saved."**, the banner still reads Approved, and it is still on the public page.
- [ ] Change the environment and save: the message is **"Saved. This court is back in the approval queue."**, the banner reads "Awaiting approval", and the court has disappeared from `/venues/<slug>` and `/search`.
- [ ] Flip it to `rejected` with a reason by hand, reload: the banner shows the reason, and the branch page shows "Changes needed: …" under the court. Save any rate-band change: it returns to pending and the reason is gone.
- [ ] Flip it to `suspended` by hand: the banner says contact support, and saving an hours change leaves it suspended.

- [ ] **Step 5: Staff path**

With a second, `player`-role account granted `manage_courts` on that branch only (add them through `/dashboard/staff` as the owner):

- [ ] The staff account's sidebar shows **Branches & courts**.
- [ ] `/dashboard/listings` lists only the granted branch.
- [ ] Its branch page shows the details **read-only** ("Only the venue owner can change these details"), no branch-photo upload control, and **no Add a court** card.
- [ ] The court page is fully editable: fields, hours, rates, and court photos all save.
- [ ] Typing another branch's `/dashboard/listings/<otherBranchId>` URL renders a 404, not a redirect and not the page.
- [ ] Typing the granted branch id paired with another branch's court id renders a 404.

- [ ] **Step 6: Staff form copy**

- [ ] As the owner, open `/dashboard/staff`: the "Court management arrives with the listings update…" sentence is gone from under the permission checkboxes.

- [ ] **Step 7: Responsive and reduced motion**

- [ ] At 560px wide: the branch form stacks to one column, the hours rows wrap, and the page never scrolls sideways.
- [ ] At 980px: the dashboard sidebar becomes the horizontal strip and the listings pages still fit.
- [ ] With "Reduce motion" enabled in the OS, the branch cards do not lift on hover.

- [ ] **Step 8: Stop the dev server**

Press `Ctrl-C` in the terminal running `npm run dev`.

- [ ] **Step 9: Final full verification**

```bash
npx tsc --noEmit && npm run lint && npm run build && npm test && npm test
```

Expected: no type errors; lint reports only the pre-existing `<img>` and unused-`table` warnings; the build succeeds; the whole suite passes **twice in a row** — the second run is what proves the new DB tests are repeat-safe against this shared, persistent database.
