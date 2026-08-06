# Admin Surface (Slice C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins the surface the listing lifecycle has been dead-ending into. A guarded `/admin` route group with an approval queue over every owner's `pending` courts (approve / reject-with-reason), a second tab that suspends and unsuspends live courts, and a promote-to-owner screen that wraps the already-tested `promoteToOwner`. Plus the two loose ends Slice B deliberately left: the account menu gains an **Admin** item, and the public "List your court" CTAs stop pointing at a dead `/login`.

**Architecture:** One new guard, `requireAdminPage`, added to the existing `src/lib/auth/page-guards.ts` (redirect flavor of `requireAdmin`: 401 → login with `next`, any signed-in non-admin → `/`). Three new modules under `src/lib/admin/`: `moderation.ts` (**pure** — the result union, the length limit, the message maps), `write.ts` (the four status transitions, all status-scoped so a stale click is a friendly message rather than a race) and `queries.ts` (the queue rows, the sidebar's pending count, and the promote screen's email lookup). One `'use server'` file, `src/app/admin/actions.ts`, exporting nothing but six thin `requireAdmin`-guarded actions and the two state types its forms bind to. Two pages (`/admin`, `/admin/owners`) under one guarded layout, each re-asserting the guard. **No migrations:** every table, column and enum this slice needs already exists.

**Tech Stack:** Next.js 16 App Router (TypeScript), Tailwind v4 with brand tokens in `src/app/globals.css`, Drizzle `sql` template over Postgres (never the query builder), Supabase Auth (Google), Vitest against the hosted Supabase project.

**Spec:** `docs/superpowers/specs/2026-08-06-listings-and-admin-design.md` — **Slice C only** ("Slice C — Admin surface", plus the shared Enforcement summary and Testing sections). Slice B shipped; do not re-plan or re-open it.

**Previous slice:** `docs/superpowers/plans/2026-08-06-listings-management.md` — this plan consumes what it built and must not duplicate any of it: `requeueCourtSql`'s single-statement status-scoped shape (`src/lib/listings/write.ts`), `getListingCourt`'s `scheduleWarning` (`src/lib/listings/queries.ts`), the pure schedule rules (`src/lib/listings/schedule.ts`), the status labels and banners (`src/lib/listings/status.ts`), the shared control classes and `FormMessage` (`src/app/dashboard/listings/form-ui.tsx`), and `sqlStateOf` (`src/lib/db/sql-state.ts`).

**Two carried notes from Slice B's final review, both discharged here:**

1. **The approve action must REFUSE while `scheduleWarning !== null`.** `replaceOperatingHours` deliberately allows an owner to save hours their rate bands no longer tile — refusing there would deadlock them, since the bands form validates against the *stored* hours. The court is re-queued to `pending` and the warning tells them to fix the bands next. Nothing else stops that court from being approved, and an approved court whose bands leave an uncovered hour is **live but unpriceable**: `priceSlots` in `src/lib/booking/pricing.ts` throws `No rate band covers hour N`, and the player who finds it is mid-checkout. So the queue is the last gate, and `approveCourt` enforces it in the write itself (not in the page, not in the action) — using the **same** rule the owner sees, which is why Task 2 first extracts that rule into one shared pure function.
2. **The admin/action guard asymmetry is resolved by this slice existing.** `requireOwnerOf` and `requireBranchAccess` both short-circuit `role === 'admin'`, so an admin passes every owner action — but `/dashboard/*` pages scope their reads by `branchIdsWith(access, …)`, which for an admin lists only branches they personally own, so those pages 404 on someone else's branch. That mismatch was noted as "an admin can write where they cannot read". It stops being a defect now: cross-owner moderation has its own surface at `/admin/*`, and `/dashboard` remains, correctly, the place where an admin sees only their own branches. **Do not "fix" it by widening `branchIdsWith` for admins.**

## Global Constraints

- **NO MIGRATIONS IN THIS SLICE.** `courts` (with `status`, `rejection_reason`, `created_at`), `branches`, `profiles` (with `role`, `business_name`, `slug`), `court_operating_hours`, `court_rate_bands`, `court_photos`, and the `court_status` / `court_environment` / `user_role` enums all already exist (`supabase/migrations/20260801063910_listings.sql`, `20260801052945_profiles.sql`, `20260801042931_settings_and_enums.sql`). If you believe a column is missing, you have misread the schema — re-read those files. **In particular there is no `submitted_at` column and you must not add one:** `courts.created_at` is the only date this slice can show, so the queue labels it **"Added"**, never "Submitted" (a re-queued court's `created_at` is its original creation, and calling that a submission date would be a lie the UI tells). Do not run `npx supabase db push`, do not run `npx drizzle-kit pull`, do not add a file under `supabase/migrations/`.
- **Data access is server-only.** Every read/write goes through a Server Component, Server Action, or Route Handler guarded by `requireUser` / `requirePlayer` / `requireOwner` / `requireOwnerOf` / `requireBranchAccess` / `requireAdmin` (or, for pages, their redirect flavors in `src/lib/auth/page-guards.ts`). The browser never queries Postgres. TypeScript is the security boundary.
- **Never use the Drizzle query builder.** Only `db.execute(sql\`...\`)`. Do not import `src/db/schema.ts` — it is excluded from `tsconfig.json` and importing it resurfaces a `TS2304`.
- **`'use server'` rule.** Every export of a `'use server'` file must be an async function AND becomes a client-invokable endpoint. Therefore: testable logic lives in `import 'server-only'` (or pure) modules and the `'use server'` file exports **only** thin guarded actions plus the state `type`s its forms bind to. `tests/auth/action-coverage.test.ts` globs every `'use server'` file and requires one of its `GUARDS` substrings. **Verified against the file as it stands today: `GUARDS` is `['requireUser', 'requireAdmin', 'requireOwnerOf', 'requireOwner', 'requirePlayer', 'requireBranchAccess']` — `requireAdmin` is ALREADY in the list, so this slice needs no edit to it.** `requireAdminPage` is a *page* guard and never appears in a `'use server'` file, so it needs no entry either (and would be matched by the `requireAdmin` substring anyway). Task 4 proves this by running the test rather than assuming it.
- **The blocks/listings write pattern is the template for every transition** (`src/lib/listings/write.ts` + `src/app/dashboard/listings/actions.ts`; read both before Task 2):
  1. The guard runs **first**, before any DB lookup derived from submitted input, so a signed-out caller cannot use the response as a row-existence oracle.
  2. Friendly typed reasons (`{ ok: false; reason: '…' }`), never thrown strings; the action maps reason → sentence.
  3. Status transitions are **single-statement status-scoped UPDATEs** — `set status='approved' where id=$ and status='pending'` — so zero rows means "it already moved", with no read-then-write race. The only transition with a pre-read is `approveCourt`, and its pre-read is `for update` inside the same transaction as the UPDATE, exactly like `replaceRateBands`.
  4. `sqlStateOf(error)` from `src/lib/db/sql-state.ts` translates SQLSTATEs into reasons; anything else re-throws.
- **Zero rows is `stale`, never an error and never "not found".** A court that changed status under the admin's cursor and a court that was deleted are the same answer to the same question: reload the queue. Do not add a `not_found` reason to distinguish them — it would be an existence oracle for no user benefit.
- **Suspension never touches bookings.** No transition in this slice writes to, cancels, refunds, or reads-for-mutation the `bookings` table. A suspended court disappears from public search and the venue page (public reads filter to `approved`) and from the owner day grid; its existing bookings stay exactly where they are. Task 2 pins this with a test.
- **Money is integer centavos, percentages integer basis points.** Never floats, never `numeric`. Coerce every numeric column out of the driver with `Number()`. This slice renders prices but never computes them.
- **Manila time.** Dates render through `to_char(... at time zone 'Asia/Manila', 'YYYY-MM-DD')` and `formatDateLabel` from `src/lib/format.ts`; hours through `formatHour`/`formatHourRange`. `closes_hour` may be `24` and `formatHour(24)` already renders it as `12 AM`.
- **All user-facing copy is English only.** No Taglish (see the Language entry in `design/branding.md`).
- **Read `design/branding.md` before any UI work.** Solid colors only — no gradients, no glows. Cards: white, `border-radius: 20px`, no border, shadow `--shadow-sm`. Buttons: `--btn-h` 48px / `--btn-h-sm` 38px, `--btn-radius` 12px, display font weight 700. Mono (`font-mono`) for times, prices, dates, counts and uppercase kickers. **Never two lime (`--ball`) buttons in one view** — the approval queue repeats its controls per court, so it uses branding.md's alternative primary (`--ink` bg, `--ball` text) for Approve and the bordered secondary for Reject, and renders **no** lime button at all. Non-interactive chips/badges stay pill-shaped (`999px`). Content column 1120px max. Breakpoints 980px and 560px.
- **Branded focus ring on EVERY interactive element.** Declare, in every file that renders one, exactly:
  ```ts
  const FOCUS_RING =
    'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'
  ```
  and append it to the `className` of every `<Link>`, `<button>`, `<select>`, `<input>`, and `<textarea>`. Reviews rejected its omission four times in an earlier slice. **The `/admin` client components import `FOCUS_RING` and the shared control classes from `src/app/dashboard/listings/form-ui.tsx` instead of redeclaring them** — that module is a route-agnostic set of class strings and one message renderer despite living under `/dashboard/listings`, and moving it would churn six Slice-B files for no behavioral gain. Server Components under `/admin` still declare their own `FOCUS_RING` locally: they cannot import from a `'use client'` module without pulling it into the client bundle.
- **Tests run against the hosted Supabase project** via `DATABASE_URL` in `.env.local` — the Supavisor session pooler on port **5432**, never 6543. The database is **shared and persistent**: tests must pass on repeated runs, must create their own rows under their own ids, must clean up through `teardownFixtures()`'s id tracking, and must **never mutate seeded singleton rows** (`smash-zone-marikina` and the nine demo branches). **Run every DB-touching test file twice.**
  - **The admin queries are GLOBAL — this is the one new testing hazard in this slice.** `getAdminCourts(['pending'])` and `getPendingCourtCount()` deliberately span every owner, so on this shared database they will return rows other test files (and the seed) created. Every assertion about queue *contents* must filter to ids this test seeded (`rows.filter((row) => row.branchId === branchId)`), and every assertion about the *count* must be a delta (read it before seeding, assert `after === before + n`). A test that asserts `toHaveLength(2)` against a global query will pass alone and fail in a full run.
  - The suite has known pool-contention flakes under `npm test` (`tests/booking/hold.test.ts`, `tests/branches/detail.test.ts`, `tests/owner/queries.test.ts`, `tests/schema/bookings.test.ts`, `tests/bookings/queries.test.ts`): if one of those times out during a full run, **re-run that file on its own** before treating it as a regression. If the pooler is degraded and new files time out too, re-run with `npx vitest run <file> --testTimeout=15000` to tell a slow connection apart from a hung query.
- **Only two test doubles are permitted in this slice**, both at a framework boundary the tests cannot otherwise reach, and both already established in this repo or trivially derived from it:
  1. The **session** — `vi.mock('@/lib/supabase/server')` exactly as `tests/auth/guards.test.ts` and `tests/listings/permissions.test.ts` already do it.
  2. **`next/navigation`'s `redirect`** — new in this slice, and only in `tests/auth/admin-page-guard.test.ts`. A page guard's whole answer *is* which path it redirects to; `redirect()` throws a framework control-flow signal that only means something inside a request context, so replacing it with an error carrying the destination is what turns that answer into an assertion.
  Database rows are always real. No other double, anywhere.
- **Do not test `'use server'` actions directly.** They call `revalidatePath`/`redirect`, which throw outside a request context. The project's convention (see `tests/bookings/review-action.test.ts` and `tests/listings/permissions.test.ts`) is to test the server-only libs and the guards; the actions are thin enough that `tests/auth/action-coverage.test.ts`, Task 4's structural assertions, and the final manual-verification task cover them.
- **No browser or dev-server steps inside implementation tasks.** Verification is tests + `npx tsc --noEmit` + `npm run lint` + `npm run build`. Everything that genuinely needs a browser is collected into the single final task.
- **Commit after every task**, with the exact `git add` paths given in that task's final step. Do not squash tasks into one commit.

---

### Task 1: `requireAdminPage`, the admin fixture, and the redirect tests that pin them

**Files:**
- Modify: `src/lib/auth/page-guards.ts`
- Modify: `tests/helpers/fixtures.ts`
- Modify: `tests/staff/write.test.ts`
- Create: `tests/auth/admin-page-guard.test.ts`

**Interfaces:**
- Produces, from `src/lib/auth/page-guards.ts`:

```ts
export async function requireAdminPage(next: string): Promise<SessionUser>
```
- Produces, from `tests/helpers/fixtures.ts`:

```ts
export async function seedAdmin(): Promise<string>
```
- Consumes: `requireAdmin`, `AuthError`, `SessionUser` from `@/lib/auth/guards`; `safeNextPath` from `./next-path`; `redirect` from `next/navigation`. All four are already imported or exported by the files being modified.

**Why first:** every later task's page and action assumes a signed-in admin exists and that `/admin` is closed to everyone else. The fixture is what lets a test *have* an admin, and the guard is the only thing standing between `/admin` and a curious player. Both are small, both are pure prerequisites, and neither can be written after the pages without the pages being unverifiable in the meantime.

**Design note — a non-admin goes to `/`, not `/dashboard` and not `/bookings`.** The other page guards send a wrong-role visitor to *their* home (`requireOwnerPage` → `/bookings`, `requirePlayerPage` → `/dashboard`) because in each case a correct destination exists for that role. Here it does not: `/admin` has no player-flavored or owner-flavored equivalent. Sending everyone to `/` also keeps the redirect from being an oracle — an owner and a player get the identical answer, so neither learns anything about what `/admin` is.

- [ ] **Step 1: Add the `seedAdmin` fixture**

In `tests/helpers/fixtures.ts`, add directly after `seedOwner()`:

```ts
/**
 * A player promoted to admin, by the same one-line role flip seedOwner() uses.
 *
 * Extracted for the same reason seedOwner() was: tests/auth/guards.test.ts has
 * its own private copy (it seeds auth.users directly and cannot use this
 * module), and tests/staff/write.test.ts had this exact two-step inline. The
 * admin surface needs an admin session in three more files.
 *
 * Sets ONLY the role. business_name/slug stay null — an admin is not an owner
 * and has no business identity, and filling those in would hide a query that
 * depends on them.
 */
export async function seedAdmin(): Promise<string> {
  const id = await seedPlayer()
  await db.execute(sql`update profiles set role = 'admin' where id = ${id}::uuid`)
  return id
}
```

- [ ] **Step 2: Use the fixture where the inline copy already existed**

In `tests/staff/write.test.ts`, add `seedAdmin` to the fixtures import (keeping alphabetical order):

```ts
import {
  seedAdmin,
  seedBranchWithCourts,
  seedOwner,
  seedPlayer,
  seedStaffGrant,
  teardownFixtures,
} from '../helpers/fixtures'
```

and inside `test('addBranchStaff refuses an owner and an admin as a target', …)` replace:

```ts
  const adminTarget = await seedPlayer()
  await db.execute(sql`update profiles set role = 'admin' where id = ${adminTarget}::uuid`)
```

with:

```ts
  const adminTarget = await seedAdmin()
```

`db`, `sql` and `seedPlayer` all remain in use elsewhere in that file — do not remove their imports.

- [ ] **Step 3: Write the failing guard tests**

Create `tests/auth/admin-page-guard.test.ts`:

```ts
import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { seedAdmin, seedOwner, seedPlayer, teardownFixtures } from '../helpers/fixtures'

afterAll(teardownFixtures)

/**
 * requireAdminPage's entire contract is "which path does this session end up
 * on", so both boundaries it answers through are replaced here and nothing
 * else is:
 *
 *   1. The SESSION — the same vi.mock tests/auth/guards.test.ts uses.
 *      Everything below it (the profiles lookup, the role read) hits the real
 *      database, which is the point: this file would fail if `role = 'admin'`
 *      ever stopped meaning admin.
 *   2. next/navigation's REDIRECT — the second and last permitted double in
 *      this slice. redirect() throws a framework control-flow signal that only
 *      carries meaning inside a request context; swapping it for an error that
 *      carries the destination is what makes the answer assertable at all.
 *
 * Declared through vi.hoisted() because vi.mock factories are hoisted above
 * every other statement in the file — a plain `class RedirectSignal` below
 * would be in its temporal dead zone when the factory closure is created.
 */
const { RedirectSignal } = vi.hoisted(() => {
  class RedirectSignal extends Error {
    readonly to: string
    constructor(to: string) {
      super(`redirect:${to}`)
      this.name = 'RedirectSignal'
      this.to = to
    }
  }
  return { RedirectSignal }
})

const claims = vi.hoisted(() => ({ value: null as null | { sub: string } }))

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getClaims: async () => ({ data: claims.value ? { claims: claims.value } : null }) },
  }),
}))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to)
  },
}))

const { requireAdminPage } = await import('@/lib/auth/page-guards')

function signInAs(userId: string) {
  claims.value = { sub: userId }
}

beforeEach(() => {
  claims.value = null
})

async function expectRedirect(promise: Promise<unknown>, to: string) {
  await expect(promise).rejects.toBeInstanceOf(RedirectSignal)
  await promise.catch((error) => expect((error as InstanceType<typeof RedirectSignal>).to).toBe(to))
}

test('requireAdminPage sends a signed-out visitor to login carrying the path back', async () => {
  await expectRedirect(requireAdminPage('/admin'), '/login?next=%2Fadmin')
})

test('requireAdminPage normalizes the next path through safeNextPath', async () => {
  // Not user input today — every caller passes a literal — but there is one
  // definition of an acceptable `next` in this app and this guard uses it,
  // exactly like requireUserPage. "//evil.com/admin" is protocol-relative and
  // resolves cross-origin in a browser, so it collapses to "/".
  await expectRedirect(requireAdminPage('//evil.com/admin'), '/login?next=%2F')
})

test('requireAdminPage sends a signed-in player to the home page', async () => {
  const playerId = await seedPlayer()
  signInAs(playerId)
  await expectRedirect(requireAdminPage('/admin'), '/')
})

test('requireAdminPage sends a signed-in owner to the home page too', async () => {
  // Deliberately the SAME destination as the player above. A redirect that
  // differed by role would tell an owner that /admin is a real place with a
  // different answer for them; it is not, and they learn nothing.
  const ownerId = await seedOwner()
  signInAs(ownerId)
  await expectRedirect(requireAdminPage('/admin'), '/')
})

test('requireAdminPage resolves to the admin session user', async () => {
  const adminId = await seedAdmin()
  signInAs(adminId)
  await expect(requireAdminPage('/admin')).resolves.toMatchObject({
    id: adminId,
    role: 'admin',
  })
})
```

- [ ] **Step 4: Watch it fail for the right reason**

```bash
npx vitest run tests/auth/admin-page-guard.test.ts
```

Expected: every test fails with `SyntaxError: The requested module '@/lib/auth/page-guards' does not provide an export named 'requireAdminPage'` (or Vitest's equivalent import error) — not with an assertion failure. If a test fails on an assertion instead, the export already exists and you are editing the wrong thing.

- [ ] **Step 5: Add the guard**

In `src/lib/auth/page-guards.ts`, extend the import from `@/lib/auth/guards` to include `requireAdmin` (keeping alphabetical order):

```ts
import {
  AuthError,
  requireAdmin,
  requireOwner,
  requirePlayer,
  requireUser,
  type SessionUser,
} from '@/lib/auth/guards'
```

and append, at the end of the file:

```ts
/**
 * The /admin/* gate.
 *
 * A signed-out visitor goes to login carrying the path back; ANY signed-in
 * non-admin goes to `/`. Not /dashboard and not /bookings: unlike the owner
 * and player guards, there is no role-appropriate equivalent of this page to
 * send someone to, and answering every wrong role identically keeps the
 * redirect from telling an owner something a player is not told.
 *
 * The layout calls this once so every /admin/* page is gated by construction,
 * and every page calls it again — the same two-layer pattern /dashboard uses.
 * App Router cannot pass a value from a layout to a page, so the second call
 * is what makes each page's own data fetching gated rather than gated-by-
 * assumption. The cost is a claims read and one indexed profile lookup.
 */
export async function requireAdminPage(next: string): Promise<SessionUser> {
  try {
    return await requireAdmin()
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.status === 401) redirect(`/login?next=${encodeURIComponent(safeNextPath(next))}`)
      redirect('/')
    }
    throw error
  }
}
```

- [ ] **Step 6: Watch it pass, twice**

```bash
npx vitest run tests/auth/admin-page-guard.test.ts tests/staff/write.test.ts
npx vitest run tests/auth/admin-page-guard.test.ts tests/staff/write.test.ts
```

Expected: both runs green. The second run is what proves the new fixture rows are torn down and the tests are repeat-safe against this shared, persistent database.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors; lint reports only the pre-existing warnings.

```bash
git add src/lib/auth/page-guards.ts tests/helpers/fixtures.ts tests/staff/write.test.ts tests/auth/admin-page-guard.test.ts
git commit -m "Add requireAdminPage, the seedAdmin fixture, and the page-guard redirect tests"
```

---

### Task 2: The moderation rules and the four status transitions

**Files:**
- Modify: `src/lib/listings/schedule.ts`
- Modify: `src/lib/listings/queries.ts`
- Modify: `tests/listings/schedule.test.ts`
- Create: `src/lib/admin/moderation.ts`
- Create: `src/lib/admin/write.ts`
- Create: `tests/admin/write.test.ts`

**Interfaces:**
- Produces, from `src/lib/listings/schedule.ts` (still a **pure** module):

```ts
export function courtScheduleWarning(
  days: OperatingHoursDay[],
  bands: RateBand[],
): HoursFailure | BandsFailure | null
```
- Produces, from `src/lib/admin/moderation.ts` (a **pure** module — deliberately NOT `server-only`, because the queue page and the actions both render its message maps, and a client component may end up doing so too):

```ts
export const MAX_REJECTION_REASON: 500

export type CourtModerationFailure = 'stale' | 'empty_reason' | 'reason_too_long'

export type CourtModerationResult =
  | { ok: true }
  | { ok: false; reason: CourtModerationFailure }
  | { ok: false; reason: 'schedule_incomplete'; warning: HoursFailure | BandsFailure }

export const MODERATION_FAILURE_MESSAGES: Record<CourtModerationFailure, string>
export const SCHEDULE_BLOCK_MESSAGES: Record<HoursFailure | BandsFailure, string>
```
- Produces, from `src/lib/admin/write.ts` (`import 'server-only'` — all SQL):

```ts
export async function approveCourt(input: { courtId: string }): Promise<CourtModerationResult>
export async function rejectCourt(input: { courtId: string; reason: string }): Promise<CourtModerationResult>
export async function suspendCourt(input: { courtId: string }): Promise<CourtModerationResult>
export async function unsuspendCourt(input: { courtId: string }): Promise<CourtModerationResult>
```
- Consumes: `db` from `@/db`; `sql` from `drizzle-orm`; `courtScheduleWarning`, `HoursFailure`, `BandsFailure`, `OperatingHoursDay`, `RateBand` from `@/lib/listings/schedule`.

**Why the shared rule comes first:** the spec's carried recommendation is that approval refuse while `scheduleWarning !== null`. If the queue re-derived that judgement, the two could drift and the queue would approve a court the owner's page is still telling them to fix. So Step 1 lifts the rule out of `getListingCourt` into one exported pure function, and both callers use it. This is the only Slice-B behavior this plan changes, and it changes nothing observable: the extracted function is the inlined expression, verbatim.

- [ ] **Step 1: Extract the shared schedule rule**

Append to `src/lib/listings/schedule.ts`:

```ts
/**
 * "Do these bands price every open hour, exactly once?" — one rule, two
 * callers, deliberately.
 *
 * Lifted out of getListingCourt (src/lib/listings/queries.ts), which had this
 * expression inline, when the admin approval queue needed the identical
 * judgement. approveCourt REFUSES while this is non-null and the owner's court
 * page WARNS while this is non-null; two copies would eventually let the queue
 * approve a court the owner's own page is still telling them to fix — a court
 * that is live, bookable, and throws "No rate band covers hour N" out of
 * priceSlots() in the middle of a player's checkout.
 *
 * 'no_open_day' covers the brand-new court that has no hours yet as well as
 * one whose hours were deleted: either way the bands have nothing to tile, and
 * the next instruction is the same.
 */
export function courtScheduleWarning(
  days: OperatingHoursDay[],
  bands: RateBand[],
): HoursFailure | BandsFailure | null {
  const span = operatingSpan(days)
  if (span === null) return 'no_open_day'
  return validateRateBands(bands, span)
}
```

Append these tests to `tests/listings/schedule.test.ts`, and add `courtScheduleWarning` to that file's import list from `@/lib/listings/schedule`:

```ts
test('courtScheduleWarning is null when the bands tile the week exactly', () => {
  expect(
    courtScheduleWarning(OPEN_ALL_WEEK, [
      { startHour: 11, endHour: 15, priceCentavos: 26500 },
      { startHour: 15, endHour: 17, priceCentavos: 31500 },
      { startHour: 17, endHour: 24, priceCentavos: 36500 },
    ]),
  ).toBeNull()
})

test('courtScheduleWarning reports the gap, the missing hours, and the missing bands', () => {
  // A gap: 15-17 is unpriced, which is exactly what priceSlots() throws on.
  expect(
    courtScheduleWarning(OPEN_ALL_WEEK, [
      { startHour: 11, endHour: 15, priceCentavos: 26500 },
      { startHour: 17, endHour: 24, priceCentavos: 36500 },
    ]),
  ).toBe('bands_do_not_tile')

  // No hours at all -> the bands have nothing to tile, and this is the answer
  // even though the bands themselves are well formed.
  expect(courtScheduleWarning([], [{ startHour: 11, endHour: 24, priceCentavos: 26500 }])).toBe(
    'no_open_day',
  )

  // Hours but no bands.
  expect(courtScheduleWarning(OPEN_ALL_WEEK, [])).toBe('no_bands')
})
```

- [ ] **Step 2: Point `getListingCourt` at the shared rule**

In `src/lib/listings/queries.ts`, replace the import from `@/lib/listings/schedule`:

```ts
import {
  courtScheduleWarning,
  type BandsFailure,
  type HoursFailure,
  type OperatingHoursDay,
  type RateBand,
} from '@/lib/listings/schedule'
```

and replace these four lines in `getListingCourt`:

```ts
  const span = operatingSpan(days)
  // 'no_open_day' covers the brand-new court that has no hours yet as well as
  // one whose hours were deleted: either way the bands have nothing to tile
  // and the page's next instruction is the same.
  const scheduleWarning = span === null ? 'no_open_day' : validateRateBands(bands, span)
```

with:

```ts
  // The exact rule the approval queue refuses on — see courtScheduleWarning.
  const scheduleWarning = courtScheduleWarning(days, bands)
```

Then confirm nothing broke and nothing is now unused:

```bash
npx vitest run tests/listings/schedule.test.ts tests/listings/queries.test.ts && npm run lint
```

Expected: both files green (the queries file's existing `scheduleWarning` assertions are the proof that the extraction changed no behavior); lint reports only the pre-existing warnings — in particular **no** `operatingSpan is defined but never used` in `queries.ts`, which would mean the import was not narrowed.

- [ ] **Step 3: Write the pure moderation module**

Create `src/lib/admin/moderation.ts`:

```ts
import type { BandsFailure, HoursFailure } from '@/lib/listings/schedule'

/**
 * The vocabulary of a court moderation decision: what can go wrong, and what
 * we say about it.
 *
 * PURE — no database, no session — for the same reason src/lib/listings/
 * status.ts is: the queue page renders these strings, and a Server Component
 * and a Server Action must be able to import them from the same place. The SQL
 * lives next door in ./write.ts.
 */

/**
 * Long enough for a real explanation with a couple of specifics, short enough
 * that the column (plain `text`, no constraint) never holds a pasted document.
 * Enforced here rather than by the database, which has no opinion.
 */
export const MAX_REJECTION_REASON = 500

export type CourtModerationFailure = 'stale' | 'empty_reason' | 'reason_too_long'

/**
 * `schedule_incomplete` carries its warning so the admin is told WHICH way the
 * court is not ready, using the same HoursFailure/BandsFailure vocabulary the
 * owner's own court page uses. It is a separate arm of the union rather than a
 * fifth CourtModerationFailure because only that one failure has a payload,
 * and an optional field would let a caller forget to render it.
 */
export type CourtModerationResult =
  | { ok: true }
  | { ok: false; reason: CourtModerationFailure }
  | { ok: false; reason: 'schedule_incomplete'; warning: HoursFailure | BandsFailure }

export const MODERATION_FAILURE_MESSAGES: Record<CourtModerationFailure, string> = {
  // Deliberately the same sentence whether the court changed status under the
  // admin's cursor or was deleted outright. Both mean "reload"; distinguishing
  // them would be a row-existence oracle that helps nobody.
  stale: 'That court has already moved on — reload the queue to see where it is now.',
  empty_reason: 'Say why you are rejecting it. The owner sees this and has to act on it.',
  reason_too_long: `Keep the reason under ${MAX_REJECTION_REASON} characters.`,
}

/**
 * Why a court cannot be approved yet, in the admin's voice.
 *
 * NOT a reuse of HOURS_FAILURE_MESSAGES/BANDS_FAILURE_MESSAGES: those are
 * written to the owner who is filling in the form ("Open the court on at least
 * one day of the week"), and an admin reading that in a queue would think it
 * was an instruction to them. Same five reasons, same rule, different reader.
 */
export const SCHEDULE_BLOCK_MESSAGES: Record<HoursFailure | BandsFailure, string> = {
  no_open_day: "This court has no opening hours yet, so it can't go live.",
  invalid_window: "This court's opening hours don't form a usable week, so it can't go live.",
  no_bands: "This court has no rates yet, so it can't go live.",
  invalid_band: "This court's rates aren't usable, so it can't go live.",
  bands_do_not_tile:
    "This court's rates don't cover its opening hours exactly, so it can't go live.",
}
```

- [ ] **Step 4: Write the failing transition tests**

Create `tests/admin/write.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'
import { MAX_REJECTION_REASON } from '@/lib/admin/moderation'
import { approveCourt, rejectCourt, suspendCourt, unsuspendCourt } from '@/lib/admin/write'

afterAll(teardownFixtures)

const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555'

/**
 * Every transition here is a status-scoped UPDATE, so "what is the status now"
 * is the whole assertion surface — plus, for reject, the reason it wrote.
 *
 * The fixture court is open 11-24 every day with bands 11-15 / 15-17 / 17-24:
 * an exact tiling, which is what makes it approvable. Tests that need an
 * un-approvable court break that tiling explicitly, so the reason a court is
 * refused is visible in the test rather than inherited from the fixture.
 */
async function setStatus(courtId: string, status: string, rejectionReason: string | null = null) {
  await db.execute(sql`
    update courts set status = ${status}::court_status, rejection_reason = ${rejectionReason}
    where id = ${courtId}::uuid
  `)
}

async function courtRow(courtId: string): Promise<{ status: string; rejectionReason: string | null }> {
  const result = await db.execute(sql`
    select status::text as status, rejection_reason from courts where id = ${courtId}::uuid
  `)
  return {
    status: result.rows[0].status as string,
    rejectionReason: (result.rows[0].rejection_reason as string | null) ?? null,
  }
}

// ------------------------------------------------------------------ approve

test('approveCourt approves a pending court whose bands tile its hours', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')

  await expect(approveCourt({ courtId: courtIds[0] })).resolves.toEqual({ ok: true })
  expect((await courtRow(courtIds[0])).status).toBe('approved')
})

test('approveCourt refuses a court whose bands leave a gap, and leaves it pending', async () => {
  // THE carried recommendation from Slice B's final review. Deleting the
  // middle band leaves 15-17 unpriced; approving it would put a court on the
  // market that throws "No rate band covers hour 15" out of priceSlots() in
  // the middle of a player's checkout.
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')
  await db.execute(sql`
    delete from court_rate_bands where court_id = ${courtIds[0]}::uuid and start_hour = 15
  `)

  await expect(approveCourt({ courtId: courtIds[0] })).resolves.toEqual({
    ok: false,
    reason: 'schedule_incomplete',
    warning: 'bands_do_not_tile',
  })
  expect((await courtRow(courtIds[0])).status).toBe('pending')
})

test('approveCourt refuses a court with no operating hours at all', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')
  await db.execute(sql`delete from court_operating_hours where court_id = ${courtIds[0]}::uuid`)

  await expect(approveCourt({ courtId: courtIds[0] })).resolves.toEqual({
    ok: false,
    reason: 'schedule_incomplete',
    warning: 'no_open_day',
  })
  expect((await courtRow(courtIds[0])).status).toBe('pending')
})

test('approveCourt refuses a court with hours but no rates', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')
  await db.execute(sql`delete from court_rate_bands where court_id = ${courtIds[0]}::uuid`)

  await expect(approveCourt({ courtId: courtIds[0] })).resolves.toEqual({
    ok: false,
    reason: 'schedule_incomplete',
    warning: 'no_bands',
  })
  expect((await courtRow(courtIds[0])).status).toBe('pending')
})

test('approveCourt reports stale for a court that is no longer pending', async () => {
  // Two admins with the queue open, one clicks after the other. The second
  // gets a sentence, not a second write and not an error page.
  const { courtIds } = await seedBranchWithCourts(2)
  await setStatus(courtIds[0], 'approved')
  await setStatus(courtIds[1], 'suspended')

  for (const courtId of courtIds) {
    await expect(approveCourt({ courtId })).resolves.toEqual({ ok: false, reason: 'stale' })
  }
  expect((await courtRow(courtIds[0])).status).toBe('approved')
  expect((await courtRow(courtIds[1])).status).toBe('suspended')
})

test('approveCourt reports stale for a court id that does not exist', async () => {
  await expect(approveCourt({ courtId: UNKNOWN_ID })).resolves.toEqual({
    ok: false,
    reason: 'stale',
  })
})

// ------------------------------------------------------------------- reject

test('rejectCourt requires a reason and writes nothing without one', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')

  for (const reason of ['', '   ', '\n\t ']) {
    await expect(rejectCourt({ courtId: courtIds[0], reason })).resolves.toEqual({
      ok: false,
      reason: 'empty_reason',
    })
  }
  expect(await courtRow(courtIds[0])).toEqual({ status: 'pending', rejectionReason: null })
})

test('rejectCourt refuses a reason past the length limit', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')

  await expect(
    rejectCourt({ courtId: courtIds[0], reason: 'x'.repeat(MAX_REJECTION_REASON + 1) }),
  ).resolves.toEqual({ ok: false, reason: 'reason_too_long' })
  expect((await courtRow(courtIds[0])).status).toBe('pending')

  // The boundary itself is allowed.
  await expect(
    rejectCourt({ courtId: courtIds[0], reason: 'x'.repeat(MAX_REJECTION_REASON) }),
  ).resolves.toEqual({ ok: true })
})

test('rejectCourt stores the trimmed reason and moves the court to rejected', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')

  await expect(
    rejectCourt({ courtId: courtIds[0], reason: '  Add a photo showing the whole court.  ' }),
  ).resolves.toEqual({ ok: true })
  expect(await courtRow(courtIds[0])).toEqual({
    status: 'rejected',
    rejectionReason: 'Add a photo showing the whole court.',
  })
})

test('rejectCourt reports stale for a court that is not pending', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'approved')

  await expect(
    rejectCourt({ courtId: courtIds[0], reason: 'Too late.' }),
  ).resolves.toEqual({ ok: false, reason: 'stale' })
  expect(await courtRow(courtIds[0])).toEqual({ status: 'approved', rejectionReason: null })
})

// ------------------------------------------------------- suspend / unsuspend

test('suspendCourt takes an approved court off the market', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'approved')

  await expect(suspendCourt({ courtId: courtIds[0] })).resolves.toEqual({ ok: true })
  expect((await courtRow(courtIds[0])).status).toBe('suspended')
})

test('suspendCourt reports stale for anything that is not approved', async () => {
  const { courtIds } = await seedBranchWithCourts(3)
  await setStatus(courtIds[0], 'pending')
  await setStatus(courtIds[1], 'rejected', 'Blurry photos.')
  await setStatus(courtIds[2], 'suspended')

  for (const courtId of courtIds) {
    await expect(suspendCourt({ courtId })).resolves.toEqual({ ok: false, reason: 'stale' })
  }
})

test('suspendCourt never touches the court’s bookings', async () => {
  // Spec: "Suspending never touches bookings." A suspended court disappears
  // from every public surface because those reads filter to approved — the
  // bookings already taken on it are financial records and stay exactly as
  // they are.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await setStatus(courtIds[0], 'approved')
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2026-09-14', 12),
    status: 'confirmed',
  })

  await expect(suspendCourt({ courtId: courtIds[0] })).resolves.toEqual({ ok: true })

  const booking = await db.execute(sql`
    select status::text as status, total_charged_centavos
    from bookings where id = ${bookingId}::uuid
  `)
  expect(booking.rows).toHaveLength(1)
  expect(booking.rows[0].status).toBe('confirmed')
  expect(Number(booking.rows[0].total_charged_centavos)).toBe(30000)
})

test('unsuspendCourt puts a suspended court straight back on the market', async () => {
  // Back to `approved`, NOT back to `pending`: an unsuspension reverses an
  // admin's own decision about a court that was already approved once. Sending
  // it through the queue again would make the admin re-approve their own undo.
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'suspended')

  await expect(unsuspendCourt({ courtId: courtIds[0] })).resolves.toEqual({ ok: true })
  expect((await courtRow(courtIds[0])).status).toBe('approved')
})

test('unsuspendCourt reports stale for anything that is not suspended', async () => {
  const { courtIds } = await seedBranchWithCourts(3)
  await setStatus(courtIds[0], 'pending')
  await setStatus(courtIds[1], 'approved')
  await setStatus(courtIds[2], 'rejected', 'Blurry photos.')

  for (const courtId of courtIds) {
    await expect(unsuspendCourt({ courtId })).resolves.toEqual({ ok: false, reason: 'stale' })
  }
})
```

- [ ] **Step 5: Watch it fail for the right reason**

```bash
npx vitest run tests/admin/write.test.ts
```

Expected: a module-resolution failure on `@/lib/admin/write` — not assertion failures.

- [ ] **Step 6: Write the transitions**

Create `src/lib/admin/write.ts`:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { MAX_REJECTION_REASON, type CourtModerationResult } from '@/lib/admin/moderation'
import {
  courtScheduleWarning,
  type OperatingHoursDay,
  type RateBand,
} from '@/lib/listings/schedule'

/**
 * The four admin status transitions. Exported for src/app/admin/actions.ts,
 * which is the only production caller.
 *
 * All four are STATUS-SCOPED single-statement UPDATEs — the shape
 * requeueCourtSql() established in src/lib/listings/write.ts — so the source
 * status is part of the WHERE clause and zero rows updated is a meaningful
 * answer ("it already moved") rather than an error or a race. There is no
 * read-then-write anywhere here, and no transition can move a court from a
 * status it was not in when the admin looked at it:
 *
 *   approve:   pending   -> approved
 *   reject:    pending   -> rejected (+ rejection_reason)
 *   suspend:   approved  -> suspended
 *   unsuspend: suspended -> approved
 *
 * None of them touches `bookings`. Suspension takes a court off every public
 * surface (those reads filter to `approved`) and leaves its financial records
 * alone; cancelling or refunding is a different feature that this slice does
 * not have and must not grow by accident.
 *
 * Nor do they clear `rejection_reason` on the way in. They do not need to: the
 * only paths into `pending` are the column default on insert (null) and
 * requeueCourtSql, which nulls it — so a pending court's reason is already
 * null by construction, and a suspended court's is whatever the last rejection
 * left, which is the honest record of what happened.
 */

export async function approveCourt(input: { courtId: string }): Promise<CourtModerationResult> {
  // The ONE transition with a pre-read, because approving is the one decision
  // that depends on more than the court's own status: a court whose rate bands
  // do not exactly tile its opening hours is live-but-unpriceable, and
  // priceSlots() throws "No rate band covers hour N" at whichever player finds
  // the hole. replaceOperatingHours deliberately allows an owner to reach that
  // state (refusing there would deadlock them — see its doc comment), so this
  // is the last gate before the market sees it.
  //
  // Inside ONE transaction, behind `for update` on the court row, exactly like
  // replaceRateBands. That lock is what makes the check trustworthy: the
  // owner's hours and bands writes take the same lock, so they cannot slip a
  // different schedule between this read and the UPDATE below.
  return db.transaction(
    async (tx) => {
      const court = await tx.execute(sql`
        select id from courts
        where id = ${input.courtId}::uuid and status = 'pending'
        for update
      `)
      if (court.rows.length === 0) return { ok: false as const, reason: 'stale' as const }

      const hourRows = await tx.execute(sql`
        select day_of_week, opens_hour, closes_hour from court_operating_hours
        where court_id = ${input.courtId}::uuid
      `)
      const bandRows = await tx.execute(sql`
        select start_hour, end_hour, price_centavos from court_rate_bands
        where court_id = ${input.courtId}::uuid
      `)

      const days: OperatingHoursDay[] = hourRows.rows.map((row) => ({
        dayOfWeek: Number(row.day_of_week),
        opensHour: Number(row.opens_hour),
        closesHour: Number(row.closes_hour),
      }))
      const bands: RateBand[] = bandRows.rows.map((row) => ({
        startHour: Number(row.start_hour),
        endHour: Number(row.end_hour),
        priceCentavos: Number(row.price_centavos),
      }))

      // The identical function getListingCourt uses for the owner's warning.
      const warning = courtScheduleWarning(days, bands)
      if (warning !== null) {
        return { ok: false as const, reason: 'schedule_incomplete' as const, warning }
      }

      const updated = await tx.execute(sql`
        update courts set status = 'approved'
        where id = ${input.courtId}::uuid and status = 'pending'
        returning id
      `)
      return updated.rows.length > 0
        ? { ok: true as const }
        : { ok: false as const, reason: 'stale' as const }
    },
    { isolationLevel: 'read committed' },
  )
}

export async function rejectCourt(input: {
  courtId: string
  reason: string
}): Promise<CourtModerationResult> {
  // Checked before any SQL. The column is plain `text` with no constraint, so
  // nothing below this line would refuse an empty reason — and a rejection the
  // owner cannot act on is worse than no rejection, because their court is off
  // the market with no way back that they can see.
  const reason = input.reason.trim()
  if (reason.length === 0) return { ok: false, reason: 'empty_reason' }
  if (reason.length > MAX_REJECTION_REASON) return { ok: false, reason: 'reason_too_long' }

  const result = await db.execute(sql`
    update courts set status = 'rejected', rejection_reason = ${reason}
    where id = ${input.courtId}::uuid and status = 'pending'
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'stale' }
}

export async function suspendCourt(input: { courtId: string }): Promise<CourtModerationResult> {
  const result = await db.execute(sql`
    update courts set status = 'suspended'
    where id = ${input.courtId}::uuid and status = 'approved'
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'stale' }
}

export async function unsuspendCourt(input: { courtId: string }): Promise<CourtModerationResult> {
  // Straight back to `approved`, not to `pending`: this reverses an admin's
  // own decision about a court that was already approved once, and routing it
  // through the queue would only ask the admin to re-approve their own undo.
  const result = await db.execute(sql`
    update courts set status = 'approved'
    where id = ${input.courtId}::uuid and status = 'suspended'
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'stale' }
}
```

- [ ] **Step 7: Watch it pass, twice**

```bash
npx vitest run tests/admin/write.test.ts
npx vitest run tests/admin/write.test.ts
```

Expected: green both times. If a run times out on the pooler rather than failing an assertion, re-run with `--testTimeout=15000` before investigating.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors; lint reports only the pre-existing warnings.

```bash
git add src/lib/admin/moderation.ts src/lib/admin/write.ts src/lib/listings/schedule.ts src/lib/listings/queries.ts tests/admin/write.test.ts tests/listings/schedule.test.ts
git commit -m "Add the admin court status transitions and share the schedule-warning rule"
```

---

### Task 3: The admin reads — queue rows, the pending count, and the profile lookup

**Files:**
- Create: `src/lib/admin/queries.ts`
- Create: `tests/admin/queries.test.ts`

**Interfaces:**
- Produces, from `src/lib/admin/queries.ts` (`import 'server-only'`):

```ts
export type AdminCourtRow = {
  id: string
  name: string
  environment: CourtEnvironment
  surface: string | null
  status: CourtStatus
  rejectionReason: string | null
  /** `YYYY-MM-DD` in Manila, from courts.created_at. Labelled "Added", never "Submitted". */
  addedOn: string
  branchId: string
  branchName: string
  branchCity: string
  branchSlug: string
  ownerBusinessName: string | null
  ownerEmail: string
  photoCount: number
  bandCount: number
  /** e.g. `11 – 12 AM daily`, `6 days · 11 – 12 AM`, or `No hours set`. */
  hoursSummary: string
  /** Non-null means approveCourt will refuse. Same rule, same vocabulary. */
  scheduleWarning: HoursFailure | BandsFailure | null
}

export type AdminProfileLookup = {
  id: string
  email: string
  fullName: string | null
  role: Role
}

export async function getAdminCourts(statuses: CourtStatus[]): Promise<AdminCourtRow[]>
export async function getPendingCourtCount(): Promise<number>
export async function findProfileByEmail(email: string): Promise<AdminProfileLookup | null>
```
- Consumes: `db`, `sql`; `CourtEnvironment` from `@/lib/listings/fields`; `CourtStatus` from `@/lib/listings/status`; `courtScheduleWarning` and the schedule types from `@/lib/listings/schedule`; `formatHourRange` from `@/lib/format`; `Role` from `@/lib/auth/guards`.

**Why these three live together:** they are the entire read surface of `/admin`. The queue and the suspend tab are the same query with a different status list — one function, called twice — and the sidebar's badge is the same predicate as a `count(*)`. The profile lookup joins them because it is the other thing an admin types into this app.

**The one thing that makes these different from every other query in this codebase: they are GLOBAL.** Every other read is scoped by `owner_id` or by a branch-id list resolved from a session. These deliberately span every owner, because moderating one owner's court at a time is not moderation. That is exactly why `requireAdmin` is not optional above them, and why the tests below filter their assertions to rows they seeded (see Global Constraints).

- [ ] **Step 1: Write the failing query tests**

Create `tests/admin/queries.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBranchWithCourts, seedOwner, seedPlayer, teardownFixtures } from '../helpers/fixtures'
import { findProfileByEmail, getAdminCourts, getPendingCourtCount } from '@/lib/admin/queries'

afterAll(teardownFixtures)

/**
 * These queries span EVERY owner — that is their purpose — so on this shared,
 * persistent database they also return the seed's rows and whatever other test
 * files have in flight. Every assertion about contents therefore filters to
 * ids this test seeded, and the one assertion about a global count is a delta.
 * A `toHaveLength(2)` against getAdminCourts() would pass alone and fail in a
 * full run.
 */
async function setStatus(courtId: string, status: string, rejectionReason: string | null = null) {
  await db.execute(sql`
    update courts set status = ${status}::court_status, rejection_reason = ${rejectionReason}
    where id = ${courtId}::uuid
  `)
}

async function emailOf(userId: string): Promise<string> {
  const result = await db.execute(sql`select email from profiles where id = ${userId}::uuid`)
  return result.rows[0].email as string
}

async function forBranch(statuses: ('pending' | 'approved' | 'rejected' | 'suspended')[], branchId: string) {
  return (await getAdminCourts(statuses)).filter((row) => row.branchId === branchId)
}

test('getAdminCourts returns the facts an admin needs to moderate without leaving the page', async () => {
  const { ownerId, branchId, slug, courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')
  await db.execute(sql`
    insert into court_photos (court_id, storage_path, sort_order)
    values (${courtIds[0]}::uuid, ${`courts/${courtIds[0]}/a.jpg`}, 0)
  `)

  const rows = await forBranch(['pending'], branchId)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    id: courtIds[0],
    name: 'Court 1',
    environment: 'indoor',
    status: 'pending',
    rejectionReason: null,
    branchId,
    branchName: 'Fixture Branch',
    branchCity: 'Marikina',
    branchSlug: slug,
    // seedOwner() sets the role and nothing else, so an owner with no business
    // name is a real state the queue has to render — the page falls back to
    // the email rather than printing "null".
    ownerBusinessName: null,
    ownerEmail: await emailOf(ownerId),
    photoCount: 1,
    bandCount: 3,
    // The fixture court is open 11-24 all week. formatHourRange(11, 24) is
    // "11 – 12 AM" (both ends land in AM, so the period prints once) — this
    // asserts the app's real formatter, not a prettier hypothetical one.
    hoursSummary: '11 – 12 AM daily',
    scheduleWarning: null,
  })
  expect(rows[0].addedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

test('getAdminCourts carries the same schedule warning that blocks approval', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')
  await db.execute(sql`
    delete from court_rate_bands where court_id = ${courtIds[0]}::uuid and start_hour = 15
  `)

  const rows = await forBranch(['pending'], branchId)
  expect(rows[0].scheduleWarning).toBe('bands_do_not_tile')
  expect(rows[0].bandCount).toBe(2)
})

test('getAdminCourts summarizes a partial week and an empty one', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  await setStatus(courtIds[0], 'pending')
  await setStatus(courtIds[1], 'pending')
  await db.execute(sql`
    delete from court_operating_hours where court_id = ${courtIds[0]}::uuid and day_of_week = 0
  `)
  await db.execute(sql`delete from court_operating_hours where court_id = ${courtIds[1]}::uuid`)

  const rows = await forBranch(['pending'], branchId)
  const byId = new Map(rows.map((row) => [row.id, row]))
  expect(byId.get(courtIds[0])!.hoursSummary).toBe('6 days · 11 – 12 AM')
  expect(byId.get(courtIds[1])!.hoursSummary).toBe('No hours set')
  expect(byId.get(courtIds[1])!.scheduleWarning).toBe('no_open_day')
})

test('getAdminCourts takes several statuses at once, for the suspend tab', async () => {
  // The live tab is this same function with ['approved', 'suspended'] — one
  // query shape, two pages, so a column added for the queue is a column the
  // suspend tab gets too.
  const { branchId, courtIds } = await seedBranchWithCourts(3)
  await setStatus(courtIds[0], 'approved')
  await setStatus(courtIds[1], 'suspended')
  await setStatus(courtIds[2], 'pending')

  const live = await forBranch(['approved', 'suspended'], branchId)
  expect(live.map((row) => row.id).sort()).toEqual([courtIds[0], courtIds[1]].sort())
  expect(new Set(live.map((row) => row.status))).toEqual(new Set(['approved', 'suspended']))
})

test('getAdminCourts returns oldest first, so the queue is a queue', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  await setStatus(courtIds[0], 'pending')
  await setStatus(courtIds[1], 'pending')
  // Backdated explicitly rather than relying on two inserts landing on
  // different clock ticks: a tie would fall through to the id tiebreak, which
  // is a random uuid, and the test would flake.
  await db.execute(sql`
    update courts set created_at = now() - interval '3 days' where id = ${courtIds[1]}::uuid
  `)

  const rows = await forBranch(['pending'], branchId)
  expect(rows.map((row) => row.id)).toEqual([courtIds[1], courtIds[0]])
})

test('getAdminCourts returns nothing for an empty status list', async () => {
  expect(await getAdminCourts([])).toEqual([])
})

test('getPendingCourtCount counts pending courts across every owner', async () => {
  // A delta, not an absolute: this count is global by design and other rows
  // exist in this shared database.
  const before = await getPendingCourtCount()
  const { courtIds } = await seedBranchWithCourts(2)
  await setStatus(courtIds[0], 'pending')
  await setStatus(courtIds[1], 'pending')

  expect(await getPendingCourtCount()).toBe(before + 2)

  await setStatus(courtIds[0], 'approved')
  expect(await getPendingCourtCount()).toBe(before + 1)
})

test('findProfileByEmail matches the whole address, case-insensitively', async () => {
  const playerId = await seedPlayer()
  const email = await emailOf(playerId)

  await expect(findProfileByEmail(email)).resolves.toMatchObject({ id: playerId, role: 'player' })
  await expect(findProfileByEmail(email.toUpperCase())).resolves.toMatchObject({ id: playerId })
  await expect(findProfileByEmail(`  ${email}  `)).resolves.toMatchObject({ id: playerId })
})

test('findProfileByEmail never matches a prefix or a substring', async () => {
  // Exact-whole-address, so nobody can enumerate the user table by typing
  // letters — slice A's deterministic rule, and the same one addBranchStaff
  // follows.
  const playerId = await seedPlayer()
  const email = await emailOf(playerId)

  await expect(findProfileByEmail(email.slice(0, 8))).resolves.toBeNull()
  await expect(findProfileByEmail(email.split('@')[0])).resolves.toBeNull()
  await expect(findProfileByEmail('@example.test')).resolves.toBeNull()
})

test('findProfileByEmail returns the role, so the screen can say why it refuses', async () => {
  const ownerId = await seedOwner()
  await expect(findProfileByEmail(await emailOf(ownerId))).resolves.toMatchObject({
    id: ownerId,
    role: 'owner',
  })
})

test('findProfileByEmail returns null for an address nobody uses', async () => {
  await expect(findProfileByEmail(`nobody-${crypto.randomUUID()}@example.test`)).resolves.toBeNull()
})
```

- [ ] **Step 2: Watch it fail for the right reason**

```bash
npx vitest run tests/admin/queries.test.ts
```

Expected: a module-resolution failure on `@/lib/admin/queries`.

- [ ] **Step 3: Write the queries**

Create `src/lib/admin/queries.ts`:

```ts
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
```

- [ ] **Step 4: Watch it pass, twice**

```bash
npx vitest run tests/admin/queries.test.ts
npx vitest run tests/admin/queries.test.ts
```

Expected: green both times.

- [ ] **Step 5: Prove the whole suite is still green**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: no type errors; lint reports only the pre-existing warnings; every test passes. If one of the known flaky DB files times out, re-run that file alone before investigating.

- [ ] **Step 6: Commit**

```bash
git add src/lib/admin/queries.ts tests/admin/queries.test.ts
git commit -m "Add the admin queue, pending count and profile lookup queries"
```

---

### Task 4: The guarded admin actions, and the permission matrix that pins them

**Files:**
- Create: `src/app/admin/actions.ts`
- Create: `tests/admin/permissions.test.ts`

**Interfaces:**
- Produces, from `src/app/admin/actions.ts` (a `'use server'` file — **every export below is async, and the only non-function exports are the two state `type`s**):

```ts
export type AdminFormState = { ok: true; message: string } | { error: string } | null
export type OwnerLookupState = { player: AdminProfileLookup } | { error: string } | null

export async function approveCourtAction(prev: AdminFormState, formData: FormData): Promise<AdminFormState>
export async function rejectCourtAction(prev: AdminFormState, formData: FormData): Promise<AdminFormState>
export async function suspendCourtAction(prev: AdminFormState, formData: FormData): Promise<AdminFormState>
export async function unsuspendCourtAction(prev: AdminFormState, formData: FormData): Promise<AdminFormState>
export async function lookupPlayerAction(prev: OwnerLookupState, formData: FormData): Promise<OwnerLookupState>
export async function promoteOwnerAction(prev: AdminFormState, formData: FormData): Promise<AdminFormState>
```
- Consumes: `requireAdmin` / `AuthError` from `@/lib/auth/guards`; Tasks 2 and 3's libraries; `promoteToOwner` and `parseStaffEmail` from `@/lib/staff/write`.

**The permission table for this whole slice — one row, on purpose:**

| Action | Guard | Target id from |
|---|---|---|
| all six | `requireAdmin` | the form, shape-checked (`courtId` / `userId`) |

There is no per-branch dimension here and there must not be one: an admin's authority is global, which is exactly what `requireAdmin` says, and adding a branch check would imply an admin who moderates only some venues — a concept this product does not have. Guarding on a submitted id is safe for the same structural reason `src/app/dashboard/staff/actions.ts` gives: every write underneath is **status-scoped** (`where … and status='pending'`) or **role-scoped** (`promoteToOwner`'s `where … and role='player'`), so a forged id either matches no row or matches a row the admin was entitled to act on anyway.

**Ambiguity resolved — `promoteToOwner`'s real failure reasons.** The spec's Slice C section lists `no_such_user`, `not_a_player`, `already_owner`, `slug_taken`. The shipped function (`src/lib/staff/write.ts`, tested in `tests/staff/write.test.ts`) returns **`no_such_user | already_owner | slug_taken | invalid_input`** — there is no `not_a_player`, because its role-scoped `where … and role='player'` cannot tell a promoted owner from an admin, and `already_owner` is the reason it reports for both; and there is a fourth reason the spec omits, `invalid_input`, for a blank/over-long business name or a malformed slug. **Render the four reasons the code actually returns.** Do not add a `not_a_player` arm to the function to match the prose — the union is tested and the screen is the thing that adapts.

- [ ] **Step 1: Write the failing permission tests**

Create `tests/admin/permissions.test.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import {
  seedAdmin,
  seedBranchWithCourts,
  seedOwner,
  seedPlayer,
  seedStaffGrant,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

/**
 * The spec's admin rule — "admin actions behind requireAdmin" — asserted
 * against the real guard, with only the SESSION stubbed (the same vi.mock
 * tests/auth/guards.test.ts uses). Everything below it, including the role
 * read, hits the real database.
 *
 * The actions themselves are not called here: they invoke revalidatePath(),
 * which throws outside a request context. The project's convention is to test
 * the guards and the server-only libs — so this file also makes the structural
 * assertions that pin the actions to those libs, which is how "the promote
 * screen wraps the already-tested promoteToOwner" becomes something a test can
 * actually check rather than something a reviewer has to remember.
 */
const claims = vi.hoisted(() => ({ value: null as null | { sub: string } }))

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getClaims: async () => ({ data: claims.value ? { claims: claims.value } : null }) },
  }),
}))

const { AuthError, requireAdmin } = await import('@/lib/auth/guards')

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

test('an admin may run the moderation actions', async () => {
  const adminId = await seedAdmin()
  signInAs(adminId)
  await expect(requireAdmin()).resolves.toMatchObject({ id: adminId, role: 'admin' })
})

test('an owner may not — owning venues is not moderating them', async () => {
  // The distinction this whole slice rests on. requireOwnerOf and
  // requireBranchAccess both let an admin through; nothing lets an owner into
  // requireAdmin, so an owner cannot approve their own court.
  const ownerId = await seedOwner()
  signInAs(ownerId)
  await expectForbidden(requireAdmin())
})

test('a plain player and a fully-granted staff member may not', async () => {
  const playerId = await seedPlayer()
  signInAs(playerId)
  await expectForbidden(requireAdmin())

  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({
    branchId,
    userId: staffId,
    viewBookings: true,
    blockSlots: true,
    manageCourts: true,
    viewEarnings: true,
  })
  signInAs(staffId)
  // Every permission on that branch, and still not an admin: manage_courts is
  // "edit this branch's courts", never "approve anyone's".
  await expectForbidden(requireAdmin())
})

test('a signed-out caller gets 401, not 403', async () => {
  await expect(requireAdmin()).rejects.toMatchObject({ status: 401 })
})

test('every admin action is guarded, and delegates to the already-tested libraries', async () => {
  const source = await readFile('src/app/admin/actions.ts', 'utf8')

  expect(source).toMatch(/^\s*['"]use server['"]/m)
  // Six exported functions and no seventh: every export of a 'use server' file
  // is a client-invokable endpoint, so an accidentally exported helper is an
  // accidentally published endpoint.
  expect(source.match(/export async function/g) ?? []).toHaveLength(6)
  expect(source).toContain('requireAdmin')

  // The promote screen WRAPS slice A's tested function rather than
  // re-implementing the role flip — which is what keeps the grant-revocation
  // side effect (a user is never simultaneously an owner and someone's staff)
  // attached to promotion.
  expect(source).toContain("from '@/lib/staff/write'")
  expect(source).toContain('promoteToOwner')
  expect(source).toContain("from '@/lib/admin/write'")
  expect(source).toContain("from '@/lib/admin/queries'")

  // No SQL in a 'use server' file: every read and write goes through a
  // server-only module that has its own tests.
  expect(source).not.toContain('db.execute')
  expect(source).not.toContain('update profiles')
  expect(source).not.toContain('update courts')
})
```

- [ ] **Step 2: Watch it fail for the right reason**

```bash
npx vitest run tests/admin/permissions.test.ts
```

Expected: the four guard tests pass immediately (they exercise code that already exists), and the structural test fails with `ENOENT: no such file or directory, open 'src/app/admin/actions.ts'`.

- [ ] **Step 3: Write the actions**

Create `src/app/admin/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { AuthError, requireAdmin } from '@/lib/auth/guards'
import {
  MODERATION_FAILURE_MESSAGES,
  SCHEDULE_BLOCK_MESSAGES,
  type CourtModerationResult,
} from '@/lib/admin/moderation'
import { findProfileByEmail, type AdminProfileLookup } from '@/lib/admin/queries'
import { approveCourt, rejectCourt, suspendCourt, unsuspendCourt } from '@/lib/admin/write'
import { parseStaffEmail, promoteToOwner } from '@/lib/staff/write'

/**
 * The admin surface's writes.
 *
 * This file exports only six async guarded actions and the two state types its
 * forms bind to — every OTHER export of a 'use server' file becomes a
 * client-invokable endpoint. All logic and all SQL live in the modules under
 * src/lib/admin/ and src/lib/staff/, where they are unit-tested.
 *
 * ONE GUARD SHAPE: requireAdmin, on all six. There is no per-branch dimension
 * to an admin's authority, and inventing one here would contradict every guard
 * in src/lib/auth/guards.ts, each of which already lets an admin through
 * unconditionally.
 *
 * A submitted id is safe to guard on because every write underneath is scoped
 * by something the caller cannot forge: the moderation writes are status-
 * scoped (`and status = 'pending'`), and promoteToOwner is role-scoped
 * (`and role = 'player'`). A wrong id matches no row and returns a friendly
 * reason.
 *
 * Every action takes useActionState's (prevState, formData) shape. The
 * previous state is unused — each submission is judged on its own input — but
 * the parameter must exist for React to bind the action to the form's state.
 */
export type AdminFormState = { ok: true; message: string } | { error: string } | null
export type OwnerLookupState = { player: AdminProfileLookup } | { error: string } | null

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOT_ADMIN = 'That action is for admins only.'
const BAD_TARGET = "That doesn't look right — reload the page and try again."

/** Shape-checked before it reaches a `::uuid` cast, which would raise 22P02. */
function idFrom(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '')
  return UUID_RE.test(value) ? value : null
}

/**
 * The guard, once. Returns the message to show, or null to proceed — every
 * action's first two lines.
 */
async function refuseUnlessAdmin(): Promise<string | null> {
  try {
    await requireAdmin()
    return null
  } catch (error) {
    if (error instanceof AuthError) return NOT_ADMIN
    throw error
  }
}

/** One sentence per failure, from the two maps in src/lib/admin/moderation.ts. */
function moderationError(result: Extract<CourtModerationResult, { ok: false }>): string {
  return result.reason === 'schedule_incomplete'
    ? SCHEDULE_BLOCK_MESSAGES[result.warning]
    : MODERATION_FAILURE_MESSAGES[result.reason]
}

/**
 * A court's status decides whether it appears on every public surface, so a
 * transition invalidates all of them — plus the owner's own listings pages,
 * where the status banner is now stale, and /admin itself.
 */
function revalidateModeration(): void {
  revalidatePath('/admin')
  revalidatePath('/dashboard/listings', 'layout')
  revalidatePath('/dashboard')
  revalidatePath('/venues', 'layout')
  revalidatePath('/search')
  revalidatePath('/')
}

export async function approveCourtAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const courtId = idFrom(formData, 'courtId')
  if (!courtId) return { error: BAD_TARGET }

  const result = await approveCourt({ courtId })
  if (!result.ok) return { error: moderationError(result) }

  revalidateModeration()
  return { ok: true, message: 'Approved. Players can book it now.' }
}

export async function rejectCourtAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const courtId = idFrom(formData, 'courtId')
  if (!courtId) return { error: BAD_TARGET }

  // Passed through untrimmed: rejectCourt() trims and is the single authority
  // on what counts as empty, so the form and the write cannot disagree.
  const result = await rejectCourt({ courtId, reason: String(formData.get('reason') ?? '') })
  if (!result.ok) return { error: moderationError(result) }

  revalidateModeration()
  return { ok: true, message: 'Rejected. The owner sees your reason on the court page.' }
}

export async function suspendCourtAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const courtId = idFrom(formData, 'courtId')
  if (!courtId) return { error: BAD_TARGET }

  const result = await suspendCourt({ courtId })
  if (!result.ok) return { error: moderationError(result) }

  revalidateModeration()
  return { ok: true, message: 'Suspended. Existing bookings are untouched.' }
}

export async function unsuspendCourtAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const courtId = idFrom(formData, 'courtId')
  if (!courtId) return { error: BAD_TARGET }

  const result = await unsuspendCourt({ courtId })
  if (!result.ok) return { error: moderationError(result) }

  revalidateModeration()
  return { ok: true, message: 'Back on the market.' }
}

/**
 * Step one of promotion: find the account.
 *
 * Returns the profile whatever its role, including owner and admin — the
 * screen shows what it found and then refuses, which is more useful than
 * "no match" for an admin who typed the right address for the wrong person.
 *
 * parseStaffEmail is reused rather than re-derived: it is the tested rule for
 * "is this even an address", and the two screens that take one must not
 * disagree.
 */
export async function lookupPlayerAction(
  _prevState: OwnerLookupState,
  formData: FormData,
): Promise<OwnerLookupState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const email = parseStaffEmail(formData)
  if (!email) return { error: 'Enter the full email address of an existing OnCourt account.' }

  const player = await findProfileByEmail(email)
  if (!player) {
    return { error: `No OnCourt account uses ${email}. Ask them to sign in once, then try again.` }
  }
  return { player }
}

/**
 * Step two: promote.
 *
 * A thin wrapper over slice A's promoteToOwner, which owns the whole rule —
 * the role flip, the business fields, and the deletion of every branch_staff
 * grant the person held, all in one transaction. Re-implementing any part of
 * that here would be the one way to end up with an owner who is still someone
 * else's staff.
 *
 * Guarding on a submitted userId is safe because promoteToOwner's WHERE clause
 * is `and role = 'player'`: a forged id belonging to an owner or an admin
 * matches nothing and comes back as `already_owner`.
 */
export async function promoteOwnerAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const userId = idFrom(formData, 'userId')
  if (!userId) return { error: BAD_TARGET }

  const result = await promoteToOwner({
    userId,
    businessName: String(formData.get('businessName') ?? ''),
    slug: String(formData.get('slug') ?? '').trim().toLowerCase(),
  })

  if (!result.ok) {
    // All four reasons the function actually returns. The spec's prose lists a
    // `not_a_player` that does not exist in the code: its role-scoped UPDATE
    // cannot tell an owner from an admin, and reports `already_owner` for
    // both. `invalid_input` is the reason the prose omits.
    return {
      error:
        result.reason === 'no_such_user'
          ? 'That account no longer exists. Search for the address again.'
          : result.reason === 'already_owner'
            ? 'That account is no longer a player — it is already an owner or an admin.'
            : result.reason === 'slug_taken'
              ? 'That web address is already taken. Try a different one.'
              : 'Enter a business name, and a web address of lowercase letters, numbers and hyphens.',
    }
  }

  revalidatePath('/admin/owners')
  revalidatePath('/dashboard')
  return {
    ok: true,
    message:
      result.revokedGrants > 0
        ? `Promoted. ${result.revokedGrants} staff ${result.revokedGrants === 1 ? 'grant was' : 'grants were'} revoked.`
        : 'Promoted. They can add branches and courts now.',
  }
}
```

- [ ] **Step 4: Watch it pass, and prove the GUARDS list needs no edit**

```bash
npx vitest run tests/admin/permissions.test.ts tests/auth/action-coverage.test.ts
```

Expected: green. `tests/auth/action-coverage.test.ts` passing **without any edit** is the proof of the Global Constraints claim: its `GUARDS` array already contains `requireAdmin`, and `src/app/admin/actions.ts` calls it. Confirm the list yourself rather than trusting the pass:

```bash
grep -n "requireAdmin" tests/auth/action-coverage.test.ts
```

Expected: one hit, inside the `GUARDS` array. **If it is absent, add `'requireAdmin'` to that array in this task and say so in the commit message** — but the plan's verification says it is there.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors; lint reports only the pre-existing warnings.

```bash
git add src/app/admin/actions.ts tests/admin/permissions.test.ts
git commit -m "Add the guarded admin actions and the permission matrix that pins them"
```

---

### Task 5: The `/admin` shell and the approval queue

**Files:**
- Modify: `src/lib/listings/fields.ts`
- Modify: `src/app/dashboard/listings/[branchId]/branch-detail-forms.tsx`
- Modify: `src/app/dashboard/listings/[branchId]/courts/[courtId]/court-forms.tsx`
- Modify: `src/components/search/filter-chips.tsx`
- Create: `src/app/admin/layout.tsx`
- Create: `src/app/admin/page.tsx`
- Create: `src/app/admin/moderation-forms.tsx`

**Interfaces:**
- Produces, from `src/lib/listings/fields.ts` (still **pure**):

```ts
export const COURT_ENVIRONMENT_LABELS: Record<CourtEnvironment, string>
```
- Produces, from `src/app/admin/moderation-forms.tsx` (`'use client'`):

```ts
export function ApprovalForms({ courtId, blockedReason }: { courtId: string; blockedReason: string | null }): JSX.Element
export function StatusToggleForm({ courtId, kind }: { courtId: string; kind: 'suspend' | 'unsuspend' }): JSX.Element
```
- Consumes: `requireAdminPage`; `getAdminCourts` / `getPendingCourtCount`; `SCHEDULE_BLOCK_MESSAGES`; `COURT_STATUS_LABELS` from `@/lib/listings/status`; the actions from `./actions`; `DARK_BUTTON` / `BORDERED_BUTTON` / `TEXTAREA` / `FormMessage` from `@/app/dashboard/listings/form-ui` (client file only — the two Server Components declare their own `FOCUS_RING` locally); `signOutAction`; `Wordmark`; `formatDateLabel` from `@/lib/format`.

**Source:** `design/mockups/admin-approvals.html` — sidebar shell with an `admin` tag beside the wordmark, a count badge on the queue item, and per-court cards carrying a facts list, an Approve/Reject pair, and a "View branch →" link. **Deviations, deliberate:** the mockup's sidebar lists six sections (Branches & courts, Users, Bookings, Payouts, Fee settings) — the spec's Slice C scope is two, and a nav item pointing at a 404 is worse than no item. The mockup's right rail (today's counts, fee settings, overrides) belongs to the admin-panel slices that are explicitly out of scope. The mockup's "Owner gets this by email" note under the rejection box is **not** reproduced: notification emails are out of scope for this slice and the sentence would be false. The mockup also carries the stale `--band-peak` token; use `--band-off` per `design/branding.md`, which is authoritative over the mockups.

- [ ] **Step 1: One label map instead of a fourth copy of the ternary**

`{environment === 'indoor' ? 'Indoor' : 'Outdoor'}` already exists verbatim in three files. Append to `src/lib/listings/fields.ts`, directly under `COURT_ENVIRONMENTS`:

```ts
/**
 * Sentence-case labels for the `court_environment` enum, in one place. Three
 * files carried the same `environment === 'indoor' ? 'Indoor' : 'Outdoor'`
 * ternary before the admin queue would have made it four; all three iterate a
 * `CourtEnvironment`, so this indexes safely everywhere.
 */
export const COURT_ENVIRONMENT_LABELS: Record<CourtEnvironment, string> = {
  indoor: 'Indoor',
  outdoor: 'Outdoor',
}
```

Then replace each ternary with a lookup, adding `COURT_ENVIRONMENT_LABELS` to the existing `@/lib/listings/fields` import in the first two files and a new import in the third:

- `src/app/dashboard/listings/[branchId]/branch-detail-forms.tsx` → `{COURT_ENVIRONMENT_LABELS[environment]}`
- `src/app/dashboard/listings/[branchId]/courts/[courtId]/court-forms.tsx` → `{COURT_ENVIRONMENT_LABELS[environment]}`
- `src/components/search/filter-chips.tsx` → `{COURT_ENVIRONMENT_LABELS[env]}`

Verify no copy survives:

```bash
grep -rn "'Indoor' : 'Outdoor'" src || echo "gone"
npx tsc --noEmit
```

Expected: `gone`, and no type errors.

- [ ] **Step 2: The shell**

Create `src/app/admin/layout.tsx`:

```tsx
import Link from 'next/link'
import { Wordmark } from '@/components/site/wordmark'
import { signOutAction } from '@/app/auth/sign-out/actions'
import { requireAdminPage } from '@/lib/auth/page-guards'
import { getPendingCourtCount } from '@/lib/admin/queries'

// Global Constraints mandate a branded focus-visible ring on every
// interactive element. Declared locally, not imported from the listings
// form-ui module: that module is 'use client', and importing it into a Server
// Component would pull this shell into the client bundle for no benefit.
const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

/**
 * Moderation shell. The guard lives in the layout so every /admin/* page is
 * gated by construction rather than by each page remembering — and every page
 * calls requireAdminPage again anyway, because App Router cannot hand a
 * layout's result to a page and a page's own data fetching must be gated by
 * the page. The same two-layer pattern /dashboard uses.
 *
 * Renders its own chrome rather than <Nav>, exactly like the dashboard shell,
 * so this sign-out form is the only one reachable from inside /admin/*.
 *
 * Two nav items, not the mockup's six: Payouts, Fee settings, Users and
 * Bookings are later slices (the spec's Out of scope), and an item pointing at
 * a 404 is worse than no item.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAdminPage('/admin')
  const pending = await getPendingCourtCount()

  const items = [
    { href: '/admin', label: 'Approvals', badge: pending },
    { href: '/admin/owners', label: 'Owners', badge: 0 },
  ]

  return (
    <div className="flex min-h-dvh max-[980px]:flex-col">
      <aside className="flex w-[248px] shrink-0 flex-col gap-8 border-r border-[var(--hairline)] bg-[var(--panel)] p-6 max-[980px]:w-full max-[980px]:border-r-0 max-[980px]:border-b">
        <div className="flex items-center gap-2">
          <Link href="/" className={`text-[20px] text-[var(--ink)] ${FOCUS_RING}`}>
            <Wordmark />
          </Link>
          {/* Non-interactive chip, so pill-shaped per branding.md. It is the
              only thing telling an admin which of the app's two shells they
              are standing in. */}
          <span className="font-mono rounded-full border border-[var(--hairline)] bg-[var(--surface)] px-2 py-0.5 text-[10px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
            admin
          </span>
        </div>

        <nav className="flex flex-col gap-1 max-[980px]:flex-row max-[980px]:overflow-x-auto">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 rounded-[10px] px-3 py-2.5 text-[13.5px] font-medium whitespace-nowrap text-[var(--ink)] hover:bg-[var(--surface)] ${FOCUS_RING}`}
            >
              {item.label}
              {item.badge > 0 && (
                <span className="font-mono ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--ink)] px-1.5 text-[11px] font-semibold text-[var(--ball)]">
                  {item.badge}
                </span>
              )}
            </Link>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-3 max-[980px]:mt-0">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-[var(--ink)]">
              {user.fullName ?? user.email}
            </div>
            <div className="font-mono text-[10px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
              {user.role}
            </div>
          </div>
          <Link
            href="/"
            className={`rounded-[10px] px-3 py-2 text-[13px] font-medium text-[var(--court)] hover:bg-[var(--surface)] ${FOCUS_RING}`}
          >
            Back to the site
          </Link>
          {/* A form POST, not a link, per signOutAction's own contract. */}
          <form action={signOutAction}>
            <button
              type="submit"
              className={`w-full rounded-[10px] border border-[var(--hairline)] px-3 py-2 text-[13px] font-medium text-[var(--ink)] hover:border-[var(--court)] ${FOCUS_RING}`}
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="min-w-0 flex-1 p-8 max-[560px]:p-5">{children}</div>
    </div>
  )
}
```

- [ ] **Step 3: The forms**

Create `src/app/admin/moderation-forms.tsx`:

```tsx
'use client'

import { useActionState, useState } from 'react'
import {
  BORDERED_BUTTON,
  DARK_BUTTON,
  FormMessage,
  TEXTAREA,
} from '@/app/dashboard/listings/form-ui'
import {
  approveCourtAction,
  rejectCourtAction,
  suspendCourtAction,
  unsuspendCourtAction,
  type AdminFormState,
} from './actions'

/**
 * The queue's controls. Client components for the same reason the listings and
 * staff forms are: a Server Component cannot render what a Server Action
 * returned, so "that court has already moved on" would look like nothing
 * happening.
 *
 * The control classes come from the listings form-ui module rather than being
 * redeclared. Despite its path it is a route-agnostic set of class strings and
 * one message renderer, and FOCUS_RING in particular is the string reviews
 * caught missing four times in an earlier slice — one definition is the point.
 * AdminFormState and ListingFormState are the same shape, so FormMessage
 * accepts either.
 *
 * NO LIME BUTTON anywhere on this page: the queue repeats its controls once
 * per court, and branding.md forbids two lime buttons in one view. Approve is
 * branding.md's alternative primary (--ink bg, --ball text), which is what the
 * mockup's .btn-approve already is; Reject is the bordered secondary.
 *
 * There is no DOM test environment in this project (vitest.config.ts sets
 * environment: 'node'), so these are verified in the final manual pass. The
 * guarded actions and the SQL underneath them are unit-tested.
 */
export function ApprovalForms({
  courtId,
  blockedReason,
}: {
  courtId: string
  /** Non-null when the court's schedule would make approveCourt() refuse. */
  blockedReason: string | null
}) {
  const [approveState, approve, approving] = useActionState<AdminFormState, FormData>(
    approveCourtAction,
    null,
  )
  const [rejectState, reject, rejecting] = useActionState<AdminFormState, FormData>(
    rejectCourtAction,
    null,
  )
  const [rejectOpen, setRejectOpen] = useState(false)

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <form action={approve}>
          <input type="hidden" name="courtId" value={courtId} />
          {/* Disabled, not hidden: the admin should see that approving is the
              normal next step AND why it is unavailable. The server refuses
              independently — approveCourt() is the enforcement, this is the
              explanation. */}
          <button
            type="submit"
            disabled={approving || blockedReason !== null}
            className={DARK_BUTTON}
            title={blockedReason ?? undefined}
          >
            {approving ? 'Approving…' : 'Approve'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => setRejectOpen((open) => !open)}
          aria-expanded={rejectOpen}
          className={BORDERED_BUTTON}
        >
          {rejectOpen ? 'Cancel' : 'Reject…'}
        </button>
      </div>

      <FormMessage state={approveState} />

      {rejectOpen && (
        <form action={reject} className="border-t border-[var(--hairline)] pt-4">
          <input type="hidden" name="courtId" value={courtId} />
          <label className="sr-only" htmlFor={`reject-reason-${courtId}`}>
            Reason for rejecting this court
          </label>
          {/* `required` is a convenience, never the rule: rejectCourt() trims
              and refuses an empty reason server-side, which is what a form
              posted without JavaScript hits. */}
          <textarea
            id={`reject-reason-${courtId}`}
            name="reason"
            required
            rows={3}
            placeholder="What does the owner need to change?"
            className={TEXTAREA}
          />
          <p className="mt-2 text-[12.5px] text-[var(--ink-soft)]">
            The owner sees this on the court page. Any edit to its hours, rates or environment puts
            it back in this queue.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button type="submit" disabled={rejecting} className={BORDERED_BUTTON}>
              {rejecting ? 'Rejecting…' : 'Confirm rejection'}
            </button>
          </div>
          <FormMessage state={rejectState} />
        </form>
      )}

      {blockedReason && (
        <p role="status" className="text-[12.5px] font-medium text-[var(--ink)]">
          {blockedReason}
        </p>
      )}
    </div>
  )
}

/**
 * Suspend and unsuspend, one component. The two differ only in which action
 * they post to and what the button says — the hook is still called exactly
 * once per render, with the action chosen before the call, so hook order never
 * varies.
 */
export function StatusToggleForm({
  courtId,
  kind,
}: {
  courtId: string
  kind: 'suspend' | 'unsuspend'
}) {
  const [state, submit, pending] = useActionState<AdminFormState, FormData>(
    kind === 'suspend' ? suspendCourtAction : unsuspendCourtAction,
    null,
  )
  const label = kind === 'suspend' ? 'Suspend' : 'Put back on the market'

  return (
    <form action={submit} className="mt-3">
      <input type="hidden" name="courtId" value={courtId} />
      <button type="submit" disabled={pending} className={BORDERED_BUTTON}>
        {pending ? 'Saving…' : label}
      </button>
      <FormMessage state={state} />
    </form>
  )
}
```

Note the import list above deliberately omits `FOCUS_RING`: every interactive element in this file is a `<button>` or a `<textarea>` styled by `DARK_BUTTON` / `BORDERED_BUTTON` / `TEXTAREA`, and all three of those strings already carry the ring. If you add a bare control here, import `FOCUS_RING` and append it — the constraint is that every interactive element *has* the ring, not that every file declares it.

- [ ] **Step 4: The queue page**

Create `src/app/admin/page.tsx`:

```tsx
import Link from 'next/link'
import { requireAdminPage } from '@/lib/auth/page-guards'
import { getAdminCourts, type AdminCourtRow } from '@/lib/admin/queries'
import { SCHEDULE_BLOCK_MESSAGES } from '@/lib/admin/moderation'
import { COURT_ENVIRONMENT_LABELS } from '@/lib/listings/fields'
import { COURT_STATUS_LABELS } from '@/lib/listings/status'
import { formatDateLabel } from '@/lib/format'
import { ApprovalForms, StatusToggleForm } from './moderation-forms'

const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)] max-[560px]:p-5'
const KICKER = 'font-mono text-[10.5px] tracking-[.12em] text-[var(--ink-soft)] uppercase'
const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

/**
 * The approval queue, and the live-courts tab beside it.
 *
 * Two tabs over ONE query: getAdminCourts(['pending']) and
 * getAdminCourts(['approved', 'suspended']). A tab, not two routes, because
 * they are the same page doing the same job — moderating courts — and a fact
 * added to the card is a fact both tabs get.
 *
 * requireAdminPage again, even though the layout already ran it: App Router
 * cannot pass a layout's result to a page, and this page's own reads are
 * GLOBAL (see src/lib/admin/queries.ts). Gated by construction beats gated by
 * assumption.
 */
export default async function AdminApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  await requireAdminPage('/admin')
  const { tab } = await searchParams
  const live = tab === 'live'

  const courts = await getAdminCourts(live ? ['approved', 'suspended'] : ['pending'])

  return (
    <>
      <header className="mb-6">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          {live ? 'Live courts' : 'Approval queue'}
        </h1>
        <p className="mt-2 max-w-[620px] text-[15px] text-[var(--ink-soft)]">
          {live
            ? 'Every approved court, and the suspended ones. Suspending takes a court off search and its venue page immediately; the bookings already on it are untouched.'
            : 'Courts waiting on a decision, across every owner, oldest first. A court comes back here whenever its owner changes its hours, rates or environment.'}
        </p>
      </header>

      <nav aria-label="Queue filter" className="mb-6 flex gap-2">
        {[
          { href: '/admin', label: 'Pending', active: !live },
          { href: '/admin?tab=live', label: 'Approved & suspended', active: live },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={item.active ? 'page' : undefined}
            className={`font-display inline-flex h-[var(--btn-h-sm)] items-center rounded-full border px-4 text-[13.5px] font-semibold ${FOCUS_RING} ${
              item.active
                ? 'border-[var(--ink)] bg-[var(--ink)] text-[var(--ball)]'
                : 'border-[var(--hairline)] bg-[var(--panel)] text-[var(--ink-soft)] hover:border-[var(--court)] hover:text-[var(--ink)]'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {courts.length === 0 ? (
        <p className={EMPTY_PANEL}>
          {live ? 'No approved courts yet.' : 'Nothing is waiting for approval. Good.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {courts.map((court) => (
            <li key={court.id}>
              <CourtCard court={court} live={live} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function CourtCard({ court, live }: { court: AdminCourtRow; live: boolean }) {
  // The identical rule approveCourt() refuses on, phrased for the admin.
  const blockedReason =
    court.scheduleWarning === null ? null : SCHEDULE_BLOCK_MESSAGES[court.scheduleWarning]

  const facts = [
    {
      term: 'Court',
      detail: [COURT_ENVIRONMENT_LABELS[court.environment], court.surface]
        .filter(Boolean)
        .join(' · '),
    },
    { term: 'Hours', detail: court.hoursSummary },
    {
      term: 'Rates',
      detail: `${court.bandCount} ${court.bandCount === 1 ? 'band' : 'bands'}`,
    },
    {
      term: 'Photos',
      detail: `${court.photoCount} ${court.photoCount === 1 ? 'photo' : 'photos'}`,
    },
  ]

  return (
    <article className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-[18px] font-bold tracking-[-0.015em] text-[var(--ink)]">
            {court.name} — {court.branchName}
          </h2>
          <p className="mt-1 text-[13px] text-[var(--ink-soft)]">
            {/* An owner promoted by hand may have no business name yet, so the
                email is the fallback rather than an empty space. */}
            {court.ownerBusinessName ?? court.ownerEmail} · {court.branchCity}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2.5">
          <span className="font-mono text-[12px] whitespace-nowrap text-[var(--ink-soft)]">
            {/* "Added", never "Submitted": courts.created_at is a creation
                date, and a re-queued court still carries its original one. */}
            Added {formatDateLabel(court.addedOn)}
          </span>
          <span className="font-mono rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[10.5px] tracking-[.06em] text-[var(--court-deep)] uppercase">
            {COURT_STATUS_LABELS[court.status]}
          </span>
        </div>
      </div>

      <dl className="font-mono mt-4 grid gap-2 text-[12.5px]">
        {facts.map((fact) => (
          <div key={fact.term} className="grid grid-cols-[84px_1fr] gap-2.5">
            <dt className={KICKER}>{fact.term}</dt>
            <dd className="text-[var(--ink)]">{fact.detail}</dd>
          </div>
        ))}
      </dl>

      {court.status === 'rejected' && court.rejectionReason && (
        <p className="mt-3 text-[13px] text-[var(--ink)]">
          <span className="font-semibold">Last reason:</span> {court.rejectionReason}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-[var(--hairline)] pt-4">
        {live ? (
          <StatusToggleForm
            courtId={court.id}
            kind={court.status === 'approved' ? 'suspend' : 'unsuspend'}
          />
        ) : (
          <ApprovalForms courtId={court.id} blockedReason={blockedReason} />
        )}
        {/* The public branch page, so the whole venue can be judged rather
            than one row of facts. A pending court is not ON that page — public
            reads filter to approved — which is exactly the "here is the venue
            this belongs to" context the queue cannot fit. */}
        <Link
          href={`/venues/${court.branchSlug}`}
          className={`ml-auto text-[13.5px] font-semibold text-[var(--court)] hover:text-[var(--court-deep)] ${FOCUS_RING}`}
        >
          View branch &rarr;
        </Link>
      </div>
    </article>
  )
}
```

- [ ] **Step 5: Typecheck, lint, build**

```bash
npx tsc --noEmit && npm run lint && npm run build
```

Expected: no type errors; lint reports only the pre-existing warnings; the build succeeds and lists `/admin` among the routes. A build failure naming `server-only` means a Server Component imported something it should not — check that `moderation-forms.tsx` is the only file importing `./actions` into the client tree.

- [ ] **Step 6: Confirm the suite is still green, twice**

```bash
npm test && npm test
```

Expected: green both runs. Step 1 touched three Slice-B UI files; `tests/listings/*` and `tests/lib/search/params.test.ts` passing is what says the label swap changed nothing.

- [ ] **Step 7: Commit**

```bash
git add src/app/admin/layout.tsx src/app/admin/page.tsx src/app/admin/moderation-forms.tsx src/lib/listings/fields.ts "src/app/dashboard/listings/[branchId]/branch-detail-forms.tsx" "src/app/dashboard/listings/[branchId]/courts/[courtId]/court-forms.tsx" src/components/search/filter-chips.tsx
git commit -m "Add the /admin shell, the approval queue and the live-courts tab"
```

---

### Task 6: `/admin/owners` — promote a player to a vetted owner

**Files:**
- Create: `src/app/admin/owners/page.tsx`
- Create: `src/app/admin/owners/promote-form.tsx`

**Interfaces:**
- Produces, from `src/app/admin/owners/promote-form.tsx` (`'use client'`):

```ts
export function PromoteOwnerForm(): JSX.Element
```
- Consumes: `requireAdminPage`; `lookupPlayerAction` / `promoteOwnerAction` / `OwnerLookupState` / `AdminFormState` from `@/app/admin/actions`; the shared control classes from `@/app/dashboard/listings/form-ui`.
- **No new server module.** Every rule this screen enforces already exists and is tested: `parseStaffEmail` and `promoteToOwner` in `src/lib/staff/write.ts`, `findProfileByEmail` in `src/lib/admin/queries.ts`. This task adds a screen and nothing else, which is why it has no test file of its own — Task 4's structural assertions are what pin it to those functions.

**Two steps, not one, and no email in the URL.** The spec asks for "email lookup … showing the matched player" before the promotion. That is a lookup form whose result the admin reads, then a second form that acts on it. It is deliberately **not** a `<form method="get">` writing `?email=` into the address bar: that would put a real person's email address into browser history, the referrer of every subsequent request, and any server log in front of this app, for a search an admin runs several times a day.

**What the page must say out loud.** Promotion is not additive — `promoteToOwner` flips the role and, in the same transaction, DELETES every `branch_staff` grant that person held; and because roles are exclusive, an owner account can never hold a paid booking again (`requirePlayer` rejects it). The admin is doing that to someone else's account, so the page states both consequences before the button, not after.

- [ ] **Step 1: The form**

Create `src/app/admin/owners/promote-form.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import {
  BORDERED_BUTTON,
  DARK_BUTTON,
  FIELD,
  FormMessage,
  LABEL,
} from '@/app/dashboard/listings/form-ui'
import {
  lookupPlayerAction,
  promoteOwnerAction,
  type AdminFormState,
  type OwnerLookupState,
} from '@/app/admin/actions'

/**
 * Two forms, one screen: find the account, then promote it.
 *
 * Both states live here because the second form only exists once the first has
 * an answer — a Server Component cannot hold that, and a `?email=` round trip
 * would publish someone's address into the URL bar, browser history and every
 * log in front of this app.
 *
 * The lookup returns the profile WHATEVER its role. Showing "that address
 * belongs to an owner already" is more useful to an admin who mistyped a
 * colleague's address than a flat "no match", and the promote form simply is
 * not rendered for a non-player — with promoteToOwner's role-scoped WHERE
 * clause as the real enforcement underneath.
 */
export function PromoteOwnerForm() {
  const [lookup, findPlayer, finding] = useActionState<OwnerLookupState, FormData>(
    lookupPlayerAction,
    null,
  )
  const [promotion, promote, promoting] = useActionState<AdminFormState, FormData>(
    promoteOwnerAction,
    null,
  )

  const player = lookup && 'player' in lookup ? lookup.player : null

  return (
    <div className="flex flex-col gap-6">
      <form action={findPlayer} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[260px] flex-1">
          <label className={LABEL} htmlFor="promote-email">
            Email address
          </label>
          <input
            id="promote-email"
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="owner@example.com"
            className={FIELD}
          />
        </div>
        <button type="submit" disabled={finding} className={BORDERED_BUTTON}>
          {finding ? 'Searching…' : 'Find account'}
        </button>
        <div className="w-full">
          {/* Only the failure arm renders here — a hit renders the card below,
              which says more than a sentence could. */}
          {lookup && 'error' in lookup && (
            <p role="alert" className="mt-2 text-[12.5px] font-medium text-[var(--ink)]">
              {lookup.error}
            </p>
          )}
        </div>
      </form>

      {player && (
        <div className="rounded-[20px] bg-[var(--surface)] p-5">
          <p className="font-mono text-[10.5px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
            Match
          </p>
          <p className="mt-1.5 text-[15px] font-semibold text-[var(--ink)]">
            {player.fullName ?? player.email}
          </p>
          <p className="text-[13px] text-[var(--ink-soft)]">
            {player.email} · {player.role}
          </p>

          {player.role !== 'player' ? (
            <p className="mt-3 text-[13.5px] text-[var(--ink)]">
              That account is already {player.role === 'owner' ? 'a court owner' : 'an admin'}, so
              there is nothing to promote.
            </p>
          ) : (
            <form action={promote} className="mt-4 flex flex-col gap-3">
              <input type="hidden" name="userId" value={player.id} />

              <div className="flex flex-wrap gap-3">
                <div className="min-w-[240px] flex-1">
                  <label className={LABEL} htmlFor="promote-business-name">
                    Business name
                  </label>
                  <input
                    id="promote-business-name"
                    name="businessName"
                    type="text"
                    required
                    maxLength={120}
                    placeholder="Smash Zone"
                    className={FIELD}
                  />
                </div>
                <div className="min-w-[240px] flex-1">
                  <label className={LABEL} htmlFor="promote-slug">
                    Web address
                  </label>
                  {/* Shape-checked here for a fast answer and again in
                      promoteToOwner, which is the authority; the UNIQUE index
                      on profiles.slug is the authority on collisions. */}
                  <input
                    id="promote-slug"
                    name="slug"
                    type="text"
                    required
                    pattern="[a-z0-9\-]+"
                    placeholder="smash-zone"
                    className={FIELD}
                  />
                  <p className="mt-1 text-[11.5px] text-[var(--ink-soft)]">
                    Lowercase letters, numbers and hyphens. Appears at /owners/&lt;address&gt;.
                  </p>
                </div>
              </div>

              <div>
                <button type="submit" disabled={promoting} className={DARK_BUTTON}>
                  {promoting ? 'Promoting…' : 'Promote to owner'}
                </button>
              </div>
              <FormMessage state={promotion} />
            </form>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: The page**

Create `src/app/admin/owners/page.tsx`:

```tsx
import { requireAdminPage } from '@/lib/auth/page-guards'
import { PromoteOwnerForm } from './promote-form'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)] max-[560px]:p-5'

/**
 * Promote a player into a vetted owner.
 *
 * Self-serve promotion does not exist any more (the roles slice removed it),
 * so this screen is the ONLY way an owner account comes into being outside of
 * hand-run SQL. requireAdminPage again on top of the layout's — the two-layer
 * pattern.
 *
 * The consequences panel is not decoration. promoteToOwner deletes every
 * branch_staff grant the person holds, in the same transaction as the role
 * flip, and an owner account can never hold a paid booking again because roles
 * are exclusive (requirePlayer rejects owners and admins). The admin is doing
 * that to someone else's account, so both facts are stated before the button
 * rather than discovered after it.
 */
export default async function AdminOwnersPage() {
  await requireAdminPage('/admin/owners')

  return (
    <>
      <header className="mb-6">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Owners
        </h1>
        <p className="mt-2 max-w-[620px] text-[15px] text-[var(--ink-soft)]">
          Turn an existing player account into a court owner. They have to have signed in at least
          once — this creates no account, it only changes one.
        </p>
      </header>

      <section
        aria-label="What promotion does"
        className="mb-6 rounded-[20px] bg-[var(--band-off)] px-5 py-4"
      >
        <h2 className="font-mono text-[11px] tracking-[.14em] text-[var(--court-deep)] uppercase">
          Before you promote
        </h2>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] text-[var(--ink)]">
          <li>
            Every staff access they hold at other venues is revoked. An account is never both an
            owner and someone else&rsquo;s staff.
          </li>
          <li>
            They stop being able to book courts — anywhere, including their own. An owner account
            is a business account.
          </li>
          <li>
            Their bookings so far are untouched, and the web address you choose is public at
            /owners/&lt;address&gt;.
          </li>
          <li>This cannot be undone from this screen.</li>
        </ul>
      </section>

      <section aria-label="Promote a player" className={CARD}>
        <PromoteOwnerForm />
      </section>
    </>
  )
}
```

- [ ] **Step 3: Typecheck, lint, build**

```bash
npx tsc --noEmit && npm run lint && npm run build
```

Expected: no type errors; lint reports only the pre-existing warnings; the build succeeds and lists `/admin/owners`.

- [ ] **Step 4: Confirm the action wiring is still pinned**

```bash
npx vitest run tests/admin/permissions.test.ts tests/auth/action-coverage.test.ts
```

Expected: green. This task added a second client entry point into `src/app/admin/actions.ts` and no new exports, so both must still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/owners/page.tsx src/app/admin/owners/promote-form.tsx
git commit -m "Add the /admin/owners promote-to-owner screen"
```

---

### Task 7: Make it reachable — the Admin nav item and the "List your court" CTAs

**Files:**
- Create: `src/lib/site/owner-cta.ts`
- Create: `tests/lib/owner-cta.test.ts`
- Modify: `src/components/site/account-menu.tsx`
- Modify: `src/components/site/nav.tsx`
- Modify: `src/components/site/footer.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/app/login/page.tsx`

**Interfaces:**
- Produces, from `src/lib/site/owner-cta.ts` (a **pure** module — the nav and the home page are Server Components, but a client component may need this too, and it touches nothing):

```ts
export const OWNER_CTA_ANCHOR: '/#for-owners'
export function ownerCtaHref(role: Role | null): string
```
- Consumes: `Role` from `@/lib/auth/guards` (type-only, so the pure module stays pure).

**The deferred item, discharged.** Slice B's Task 10 says: *"the public 'List your court' CTAs still point at `/login`. Owner accounts are admin-vetted, so the screen those CTAs should lead to is Slice C's promote-to-owner page. Rewiring them here would only move the dead end."* That page now exists — but it is an **admin** screen, so a visitor must never be sent to it. The destination therefore depends on who is asking:

| Session | Destination | Why |
|---|---|---|
| owner or admin | `/dashboard/listings` | They can list a court right now; this is the screen that does it. |
| any other signed-in role (player, staff) | `/#for-owners` | Promotion is admin-vetted, so there is no self-serve screen to send them to. The home page's owner section is the honest answer, and it now says how to get an account. |
| signed out | `/login?next=%2Fdashboard%2Flistings` | Sign in first; an owner lands on their listings, and a player is bounced onward by `requireDashboardPage` — which is the same non-answer as the anchor, reached one step later. |

**Two rules, deliberately:** `<Nav>` and the home page's owner CTA are session-aware because they already resolve a session (or trivially can). The **footer** is not: it renders on every public page, several of which resolve no session at all, and adding a claims read plus a profile lookup to every footer render to relabel one link is not a trade worth making. Its link always points at `/#for-owners`, which is a marketing destination that is correct for everyone.

- [ ] **Step 1: Write the failing helper test**

Create `tests/lib/owner-cta.test.ts`:

```ts
import { expect, test } from 'vitest'
import { OWNER_CTA_ANCHOR, ownerCtaHref } from '@/lib/site/owner-cta'

/**
 * Pure module: no database, no session, no fixtures. Each case is a promise
 * the public CTAs make about where they land — the reason they exist at all is
 * that they used to land, for everyone, on /login and stop there.
 */
test('an owner and an admin go straight to the screen that lists a court', () => {
  expect(ownerCtaHref('owner')).toBe('/dashboard/listings')
  expect(ownerCtaHref('admin')).toBe('/dashboard/listings')
})

test('a signed-in player goes to the explainer, not to a screen they cannot use', () => {
  // Owner accounts are admin-vetted since the roles slice: there is no
  // self-serve promotion screen to send them to, and /admin/owners is for
  // admins. The home page's owner section is the honest destination.
  expect(ownerCtaHref('player')).toBe(OWNER_CTA_ANCHOR)
  expect(OWNER_CTA_ANCHOR).toBe('/#for-owners')
})

test('a signed-out visitor is asked to sign in, and comes back to listings', () => {
  expect(ownerCtaHref(null)).toBe('/login?next=%2Fdashboard%2Flistings')
})
```

```bash
npx vitest run tests/lib/owner-cta.test.ts
```

Expected: a module-resolution failure on `@/lib/site/owner-cta`.

- [ ] **Step 2: Write the helper**

Create `src/lib/site/owner-cta.ts`:

```ts
import type { Role } from '@/lib/auth/guards'

/**
 * Where "List your court" goes.
 *
 * These CTAs pointed at /login from the day the home page was built, and
 * /login was a dead end for the one person who clicked them: owner accounts
 * stopped being self-serve in the roles slice, so signing in taught a
 * would-be owner nothing. The admin promote screen (added in this slice) is
 * the screen that grants the account — and it is an ADMIN screen, so a visitor
 * must never be sent to it.
 *
 * PURE, and takes the role rather than the user, so a client component can
 * call it too and so the test needs no database.
 */
export const OWNER_CTA_ANCHOR = '/#for-owners'

export function ownerCtaHref(role: Role | null): string {
  // The same predicate requireOwner and loadDashboardAccess use for "is this
  // an owner at all" — an admin is admitted to /dashboard, where they see the
  // branches they personally own.
  if (role === 'owner' || role === 'admin') return '/dashboard/listings'
  // Signed in, but not an owner: no screen exists that would make them one, so
  // the explainer is the honest destination.
  if (role !== null) return OWNER_CTA_ANCHOR
  return `/login?next=${encodeURIComponent('/dashboard/listings')}`
}
```

Confirm:

```bash
npx vitest run tests/lib/owner-cta.test.ts
```

Expected: green.

- [ ] **Step 3: The Admin item in the account menu**

In `src/components/site/account-menu.tsx`, replace the docstring paragraph:

```ts
 * There is no Admin item. /admin/* does not exist yet in this slice, and an
 * item pointing at a 404 is worse than no item.
```

with:

```ts
 * An admin gets an Admin item ALONGSIDE the owner dashboard link, not instead
 * of it: the two answer different questions ("my own branches" vs "everyone
 * else's courts"), and /dashboard genuinely works for an admin — its queries
 * filter on owner_id, so they see only what they own there.
```

Then add, directly after the `dashboardLabel` line:

```ts
  const isAdmin = user.role === 'admin'
```

and render the item directly after the dashboard `<Link>` block:

```tsx
          {isAdmin && (
            <Link
              href="/admin"
              onClick={() => setOpen(false)}
              className={`block rounded-[10px] px-3 py-2.5 text-[13.5px] font-medium text-[var(--ink)] ${FOCUS_RING} hover:bg-[var(--surface)]`}
            >
              Admin
            </Link>
          )}
```

- [ ] **Step 4: The nav CTA**

In `src/components/site/nav.tsx`, add the import:

```ts
import { ownerCtaHref } from '@/lib/site/owner-cta'
```

and replace the `href="/login"` on the "List your court" pill (the FIRST of the two `/login` links — the second is the "Sign in" link and stays exactly as it is) with:

```tsx
            href={ownerCtaHref(user?.role ?? null)}
```

This costs nothing: `<Nav>` already awaited `getOptionalUser()` for the account menu.

Also update the docstring line that describes the right side, which currently reads `Right side: "List your court" pill + 36px avatar.`, by appending a sentence:

```ts
 * The pill's destination depends on the session — see src/lib/site/owner-cta.ts.
```

- [ ] **Step 5: The footer CTA**

In `src/components/site/footer.tsx`, add the import:

```ts
import { OWNER_CTA_ANCHOR } from '@/lib/site/owner-cta'
```

and change the "List your court" link's `href="/login"` to `href={OWNER_CTA_ANCHOR}`. Add a comment directly above that `<Link>`:

```tsx
        {/* The anchor, not the session-aware destination <Nav> uses: this
            footer renders on public pages that resolve no session at all, and
            a claims read plus a profile lookup on every footer render to
            relabel one link is not a trade worth making. */}
```

- [ ] **Step 6: The home page's owner section**

In `src/app/page.tsx`, add the imports:

```ts
import { getOptionalUser } from '@/lib/auth/guards'
import { ownerCtaHref } from '@/lib/site/owner-cta'
```

Inside `HomePage`, after the existing `getHomeData()` call, add:

```ts
  // A second session read on this page (<Nav> does its own): one claims read
  // and one indexed profiles lookup, so that the page's own owner CTA lands
  // somewhere useful instead of on /login for an owner who is already signed
  // in. App Router gives a Server Component no way to share <Nav>'s result.
  const user = await getOptionalUser()
```

Give the owner section an id so the anchor resolves — replace:

```tsx
        <section
          aria-label="For court owners"
```

with:

```tsx
        <section
          id="for-owners"
          // The destination of every "List your court" link for a visitor who
          // is not an owner. scroll-mt keeps the heading clear of the top edge
          // when the browser jumps here.
          className="scroll-mt-8"
          aria-label="For court owners"
```

— merging that `className` into the existing one on that element rather than adding a second `className` attribute: the final value is `scroll-mt-8 mt-[84px] flex flex-wrap items-center gap-8 rounded-[28px] bg-[var(--court-deep)] p-14 max-[980px]:p-8 max-[560px]:mt-16`.

Change the CTA link's `href="/login"` to:

```tsx
            href={ownerCtaHref(user?.role ?? null)}
```

And replace the section's supporting paragraph, which currently promises a self-serve flow that no longer exists:

```tsx
            <p className="mt-3 max-w-[500px] text-[15px] text-[#DCE9DC]/75">
              List every court and branch you run, set your own rates by time of day, and get
              bookings paid upfront. Free to list — we only earn when you do.
            </p>
```

with:

```tsx
            <p className="mt-3 max-w-[500px] text-[15px] text-[#DCE9DC]/75">
              List every court and branch you run, set your own rates by time of day, and get
              bookings paid upfront. Free to list — we only earn when you do.
            </p>
            <p className="mt-2 max-w-[500px] text-[13.5px] text-[#DCE9DC]/60">
              Owner accounts are set up by our team. Sign in once with Google, then contact us and
              we&rsquo;ll switch yours on.
            </p>
```

- [ ] **Step 7: The login page's owner line**

In `src/app/login/page.tsx`, replace:

```tsx
            Own a court?{' '}
            <span className="text-[var(--ink)]">Sign in with the same Google account</span> to list
            it and manage your branches.
```

with:

```tsx
            Own a court?{' '}
            <span className="text-[var(--ink)]">Sign in with your Google account</span>, then
            contact us and we&rsquo;ll switch your account over to a court owner.
```

The old sentence told a player that signing in would let them list a court. It has not been true since the roles slice removed self-serve promotion, and this slice is where the true answer finally exists.

- [ ] **Step 8: Prove no dead CTA survives**

```bash
grep -rn 'href="/login"' src/components/site src/app/page.tsx || echo "no hardcoded owner CTA left"
```

Expected: exactly ONE hit — `src/components/site/nav.tsx`'s **"Sign in"** link, which is a sign-in link and belongs on `/login`. If the "List your court" pill or the footer link still appears, Step 4 or Step 5 was missed.

- [ ] **Step 9: Typecheck, lint, build, full suite twice**

```bash
npx tsc --noEmit && npm run lint && npm run build && npm test && npm test
```

Expected: no type errors; lint reports only the pre-existing warnings; the build succeeds; the whole suite passes twice in a row.

- [ ] **Step 10: Commit**

```bash
git add src/lib/site/owner-cta.ts tests/lib/owner-cta.test.ts src/components/site/account-menu.tsx src/components/site/nav.tsx src/components/site/footer.tsx src/app/page.tsx src/app/login/page.tsx
git commit -m "Add the Admin nav item and point the List your court CTAs somewhere real"
```

---

### Task 8: Manual verification

**Files:** none. This task changes nothing; it is the browser pass every earlier task deliberately excluded, collected in one place so implementation tasks stay verifiable by tests alone.

**Interfaces:** none.

Everything below needs a running dev server and real signed-in accounts, so none of it can be asserted by the suite. Work through it in order; each line is a claim the automated tests cannot make.

- [ ] **Step 1: Get an admin account**

Either add your address to `ADMIN_EMAILS` in `.env.local` and sign in again (the auth callback promotes it), or flip it directly through the session pooler:

```bash
psql "$DATABASE_URL" -c "update profiles set role='admin' where email='<your-address>'"
```

Expected: `UPDATE 1`. Do this against a test account, not a seeded singleton.

- [ ] **Step 2: Start the dev server**

```bash
npm run dev
```

Expected: `Local: http://localhost:3000`. Leave it running for the rest of this task.

- [ ] **Step 3: The gate**

- [ ] Signed out, open `/admin`: the browser lands on `/login?next=%2Fadmin`, and signing in as the admin returns to `/admin`.
- [ ] Signed in as a **player**, open `/admin`: the browser lands on `/`. Same for `/admin/owners`.
- [ ] Signed in as an **owner** (not admin), open `/admin`: the browser lands on `/` — the identical destination the player got.
- [ ] Signed in as the admin: the account menu in the nav shows **Admin** beside **Owner dashboard**, and Admin opens `/admin`. Sign in as a player and confirm the Admin item is absent.

- [ ] **Step 4: The queue**

As the admin, with at least one `pending` court (create one from an owner account at `/dashboard/listings`, or flip one by hand):

- [ ] `/admin` lists pending courts from **every** owner, oldest first, each showing court name — branch, the owner's business name (or their email when they have none), city, **Added &lt;date&gt;**, a Pending chip, and the four facts: environment/surface, hours summary, band count, photo count.
- [ ] The sidebar's **Approvals** item carries a count badge equal to the number of cards.
- [ ] **View branch →** opens `/venues/<slug>` in the same tab, and the pending court is NOT on that page (public reads filter to approved).
- [ ] Tab through a card: every control shows the green focus ring — Approve, Reject…, the branch link, and (once opened) the textarea and Confirm rejection.
- [ ] No lime button appears anywhere on the page.

- [ ] **Step 5: Approve, and the refusal that guards it**

- [ ] On a court whose bands tile its hours, press **Approve**: the message reads "Approved. Players can book it now.", the card leaves the queue on reload, the badge drops by one, and the court now appears on `/venues/<slug>` and in `/search`.
- [ ] As the owner, delete a rate band so the hours are no longer fully covered (edit the rates on the court page to leave a gap — the form refuses a gap, so instead widen the opening hours past the bands, which is allowed and re-queues the court).
- [ ] Back at `/admin`: that card's **Approve** button is disabled, and the sentence under it reads "This court's rates don't cover its opening hours exactly, so it can't go live."
- [ ] The court stays in the queue. Fix the bands as the owner, reload `/admin`, and Approve is enabled again.

- [ ] **Step 6: Reject**

- [ ] Press **Reject…**: the textarea appears and the button becomes **Cancel**.
- [ ] Submit it empty (remove the `required` attribute in devtools, or press Confirm with only spaces typed): the message reads "Say why you are rejecting it. The owner sees this and has to act on it." and the court is still pending.
- [ ] Type a real reason and confirm: the message reads "Rejected. The owner sees your reason on the court page.", and the card leaves the queue.
- [ ] As the owner, open that court: the banner reads "Changes needed" with your reason under it. Change its rate bands and save: it returns to `pending`, the reason is gone, and it is back at the top of nobody's queue but the bottom of `/admin`'s.

- [ ] **Step 7: Stale state, with two tabs**

- [ ] Open `/admin` in two browser tabs. Approve a court in tab A, then press Approve on the same card in tab B: the message reads "That court has already moved on — reload the queue to see where it is now." Nothing else changes, and no error page appears.

- [ ] **Step 8: Suspend and unsuspend**

- [ ] Open `/admin?tab=live` via the **Approved & suspended** pill. Approved and suspended courts are listed; pending ones are not.
- [ ] Take a booking on an approved court first (as a player), then **Suspend** it: the message reads "Suspended. Existing bookings are untouched.", the court disappears from `/search` and `/venues/<slug>`, and the player's `/bookings` still shows their booking with the same status and amount.
- [ ] The owner's `/dashboard/bookings` still lists that booking; the day grid, which is scoped to approved courts, no longer shows the court.
- [ ] Press **Put back on the market**: the court is approved again and reappears in `/search`.

- [ ] **Step 9: Promote to owner**

- [ ] Open `/admin/owners`. The "Before you promote" panel lists all four consequences.
- [ ] Search an address nobody uses: "No OnCourt account uses … Ask them to sign in once, then try again."
- [ ] Search an existing **owner's** address: the match card appears and says there is nothing to promote — no form.
- [ ] Search a **player's** address who also holds a staff grant somewhere: the match card appears with the promote form. Note their staff access at `/dashboard/staff` as that branch's owner first.
- [ ] Promote them with a business name and a slug: the message names how many grants were revoked, and the owner's `/dashboard/staff` no longer lists them.
- [ ] Sign in as that person: they now have the owner dashboard, `/bookings` bounces them, and `/dashboard/listings` lets them add a branch.
- [ ] Promote a second person with the **same** slug: "That web address is already taken. Try a different one."
- [ ] Submit with an empty business name or a slug containing a space (remove the `pattern`/`required` attributes in devtools): the message asks for a business name and a valid web address, and nothing changed.
- [ ] Confirm no email address ever appears in the URL bar on this page.

- [ ] **Step 10: The CTAs**

- [ ] Signed out, press **List your court** in the nav: it lands on `/login?next=%2Fdashboard%2Flistings`, and signing in as an owner continues to `/dashboard/listings`.
- [ ] Signed in as an **owner**: the same pill goes straight to `/dashboard/listings`.
- [ ] Signed in as a **player**: the pill jumps to the home page's "For court owners" section, which now says owner accounts are set up by the team.
- [ ] The **footer's** "List your court" link goes to that same section from any page.
- [ ] The home page's own CTA button follows the same rule as the nav pill.
- [ ] `/login` no longer claims that signing in is how you list a court.

- [ ] **Step 11: Responsive and reduced motion**

- [ ] At 980px: the `/admin` sidebar becomes the horizontal strip, the count badge stays beside its label, and the queue cards still fit.
- [ ] At 560px: the card head stacks, the facts list stays readable, the buttons wrap, and the page never scrolls sideways.
- [ ] With "Reduce motion" enabled in the OS, nothing on `/admin` animates.

- [ ] **Step 12: Stop the dev server**

Press `Ctrl-C` in the terminal running `npm run dev`.

- [ ] **Step 13: Final full verification**

```bash
npx tsc --noEmit && npm run lint && npm run build && npm test && npm test
```

Expected: no type errors; lint reports only the pre-existing `<img>` and unused-`table` warnings; the build succeeds; the whole suite passes **twice in a row** — the second run is what proves this slice's new DB tests are repeat-safe against the shared, persistent database, and in particular that the global admin queries did not have absolute-count assertions smuggled into them.

