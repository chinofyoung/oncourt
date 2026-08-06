# Owner Reviews View & Settings (Slice D) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last two gaps the dashboard mockup has been advertising since Slice A. `/dashboard/reviews` gives owners and `view_bookings` staff the reviews players left on their courts, branch-scoped and branch-filterable, without visiting each public branch page. `/dashboard/settings` gives an owner the two pieces of brand identity they currently cannot touch at all — their business name and their logo — with their public slug shown read-only. This is the smallest of the four slices and the last one.

**Architecture:** Two new `import 'server-only'` modules under `src/lib/owner/`: `reviews.ts` (one scoped read plus its row type and cap constant) and `settings.ts` (the owner's own profile read, and the three writes: name, logo, remove-logo). Two new pages under the existing `/dashboard` shell, each re-asserting `requireDashboardPage` like its siblings. One new `'use server'` file, `src/app/dashboard/settings/actions.ts`, exporting nothing but three thin `requireOwner`-guarded actions and the state type its forms bind to. One new `'use client'` form file. Two new sidebar items in `src/app/dashboard/layout.tsx`. **No migrations:** `reviews`, `profiles.business_name`, `profiles.slug`, `profiles.business_logo_path` and both storage buckets already exist.

**Tech Stack:** Next.js 16 App Router (TypeScript), Tailwind v4 with brand tokens in `src/app/globals.css`, Drizzle `sql` template over Postgres (never the query builder), Supabase Auth (Google), Supabase Storage behind the existing `StorageClient` interface, Vitest against the hosted Supabase project.

**Spec:** `docs/superpowers/specs/2026-08-06-owner-reviews-and-settings-design.md`. Every clause of it maps to a task below.

**Previous slices, consumed and never duplicated:**

- `docs/superpowers/plans/2026-08-06-roles-and-staff.md` era: `loadDashboardAccess` / `branchIdsWith` (`src/lib/staff/access.ts`), `requireDashboardPage` (`src/lib/auth/page-guards.ts`), the `?branch=<uuid>` URL-state filter and the entry-redirect pattern (`src/app/dashboard/bookings/page.tsx`), `MAX_BUSINESS_NAME_LENGTH` (`src/lib/staff/write.ts`).
- `docs/superpowers/plans/2026-08-06-listings-management.md`: the photo machinery this slice reuses wholesale for the logo — `ALLOWED_PHOTO_TYPES` / `MAX_PHOTO_BYTES` / `PHOTO_EXTENSIONS` / `photoUrl` (the **pure** `src/lib/photos.ts`), the `StorageClient` interface and `serviceRoleStorage()` (`src/lib/listings/storage.ts`), the object-first ordering and best-effort-cleanup asymmetry (`src/lib/listings/photos.ts`), and the shared control classes + `FormMessage` (`src/app/dashboard/listings/form-ui.tsx`).
- `docs/superpowers/plans/2026-08-06-admin-surface.md`: the `seedAdmin` fixture (`tests/helpers/fixtures.ts`) and the `GUARDS` list in `tests/auth/action-coverage.test.ts`, which **already contains `requireOwner`** — this slice needs no edit to it (Task 5 proves that by running the test rather than assuming it).

---

## Verified facts this plan rests on (checked against the tree, not assumed)

Three of the spec's clauses delegate a verification to this plan. All three were done before writing it; the evidence is recorded here so no task has to re-derive it.

1. **Storage bucket layout — the logo goes in `branch-photos` under a `logos/` prefix.**
   `supabase/migrations/20260801110350_storage_and_cron.sql` creates exactly two buckets, both `public = true`: `branch-photos` and `court-photos`. There is no third bucket, and `PhotoBucket` in `src/lib/photos.ts` is exactly `'branch-photos' | 'court-photos'`. The prefixes in use are `branches/<branchId>/` and `courts/<courtId>/` — written by `prefixFor()` in `src/lib/listings/photos.ts` and by `scripts/seed-photos.ts` (`branches/${branchId}/${n + 1}.jpg`). So `logos/<ownerId>/<uuid>.<ext>` in **`branch-photos`** collides with nothing, needs no migration, and is public-read like every other object this app serves. `court-photos` would be the wrong half of the pair (a logo is not a court photo); a new bucket would be a migration, which this slice does not have.

2. **`testTimeout` is already 20000 in `vitest.config.ts`.** Confirmed at `test: { environment: 'node', setupFiles: [...], testTimeout: 20000, fileParallelism: false }`. **Do not pass `--testTimeout` on any run in this plan.** The only reason to pass it is the diagnostic in Global Constraints, where a *larger* number tells a slow pooler apart from a hung query.

3. **`requireOwner` is already in `GUARDS`.** `tests/auth/action-coverage.test.ts` lists `['requireUser', 'requireAdmin', 'requireOwnerOf', 'requireOwner', 'requirePlayer', 'requireBranchAccess']`. The settings actions use `requireOwner`, so that file is untouched by this slice.

---

## Two spec corrections, decided here

**(A) The brand page does NOT already render the logo — this slice makes that true, in one component.**

The spec says "The brand page (`/owners/[slug]`) already renders `business_logo_path`; no public-surface changes needed." That is false against the tree. `src/app/owners/[slug]/page.tsx` carries this comment today:

> `Logo:` `profile.logoPath` can never resolve to a URL — no Storage bucket was ever provisioned for owner logos (`PhotoBucket` in src/lib/photos.ts only allows 'branch-photos' | 'court-photos'), a gap logged as a follow-up needing a migration.

It renders an initial-letter badge instead. `getOwnerProfile` in `src/lib/branches/queries.ts` does return `logoPath` (line ~451), so the data is there; only the bucket decision was missing, and fact 1 above supplies it **without** the migration that comment assumed was needed. Shipping the upload without this one change would mean an owner uploads a logo that renders on exactly zero surfaces, which is not a feature. So **Task 4 includes a small step on `src/app/owners/[slug]/page.tsx`**: render the logo when `logoPath` is set, keep the existing badge as the fallback, and replace the now-false comment. Nothing else on that page changes, and no query changes.

**(B) The venue page's owner strip carries the same stale comment, and this slice deliberately leaves it alone.**

`src/app/venues/[slug]/page.tsx` (~line 215) says the same thing about `detail.owner.logoPath`. It is **not** touched here: it is already modified in the working tree by other in-flight work (see Global Constraints), and the spec scopes the public surface to the brand page. Flag it to the controller as a one-line follow-up; do not edit it as part of this slice.

**No file under `src/components/search/`, `src/app/search/`, `src/lib/search/`, `src/components/branch/`, or `src/components/ui/amenity-chip.tsx` is touched by any task in this plan.** In particular the dashboard reviews list does **not** import `src/components/branch/review-list.tsx`; it renders its own markup, modelled on the review card already in `src/app/bookings/page.tsx` (a precedent read, not an import).

---

## Global Constraints

- **NO MIGRATIONS IN THIS SLICE.** `reviews` (`id`, `booking_id` unique, `branch_id`, `player_id`, `rating`, `body`, `created_at`) exists in `supabase/migrations/20260801161137_reviews.sql`; `profiles.business_name`, `profiles.slug` and `profiles.business_logo_path` exist in `20260801052945_profiles.sql`; both storage buckets exist in `20260801110350_storage_and_cron.sql`. If you believe a column or bucket is missing, re-read those three files. Do not run `npx supabase db push`, do not run `npx drizzle-kit pull`, do not add a file under `supabase/migrations/`.
  - In particular: **`reviews` has no `court_id`.** The court name comes through `reviews.booking_id → bookings.court_id → courts.name`. Do not add a column; do not join `courts` to `branches` and guess.
- **Data access is server-only.** Every read/write goes through a Server Component, Server Action or Route Handler guarded by `requireUser` / `requirePlayer` / `requireOwner` / `requireOwnerOf` / `requireBranchAccess` / `requireAdmin` (or, for pages, their redirect flavors in `src/lib/auth/page-guards.ts`). The browser never queries Postgres. TypeScript is the security boundary.
- **Never use the Drizzle query builder.** Only `db.execute(sql\`...\`)`. Do not import `src/db/schema.ts` — it is excluded from `tsconfig.json` and importing it resurfaces a `TS2304`.
- **Scope every read by the caller's branch ids, never by `access.can`.** `access.can` is a UNION across every branch a session can see at all and exists only to decide whether a nav item renders. The reviews query takes a `branchIds: string[]` and filters `b.id = any (${sql.param(branchIds)}::uuid[])` **in SQL** — never in TypeScript after the fetch. An empty array serializes to `{}` and matches nothing, which is the correct answer for an owner with no branches.
- **`'use server'` rule.** Every export of a `'use server'` file must be an async function AND becomes a client-invokable endpoint. Therefore: all logic lives in `import 'server-only'` (or pure) modules and the `'use server'` file exports **only** thin guarded actions plus the state `type` its forms bind to. `tests/auth/action-coverage.test.ts` globs `src/**/*.{ts,tsx}` for `'use server'` and requires one of the `GUARDS` substrings; `requireOwner` is already listed (verified fact 3), so **no edit to that file is part of this slice.**
- **Do not test `'use server'` actions directly.** They call `revalidatePath`, which throws outside a request context. The project's convention (`tests/bookings/review-action.test.ts`, `tests/listings/permissions.test.ts`) is to test the server-only libs and the guards; `tests/auth/action-coverage.test.ts` plus the final manual-verification task cover the actions.
- **Money is integer centavos, percentages integer basis points.** Never floats, never `numeric`. This slice renders no money at all — if you find yourself formatting pesos on either new page, you have drifted.
- **Manila time.** Dates come out of SQL as `to_char(... at time zone 'Asia/Manila', 'YYYY-MM-DD')` and render through `formatDateLabel` from `src/lib/format.ts`. Never `new Date(...).toLocaleDateString()`.
- **All user-facing copy is English only.** No Taglish (see the Language entry in `design/branding.md`).
- **Read `design/branding.md` before any UI work.** Solid colors only — no gradients, no glows. Cards: white, `border-radius: 20px`, no border, shadow `--shadow-sm`. Buttons: `--btn-h` 48px / `--btn-h-sm` 38px, `--btn-radius` 12px, display font weight 700. Mono (`font-mono`) for dates, counts and uppercase kickers. Non-interactive chips/badges stay pill-shaped (`999px`). Content column 1120px max. Breakpoints 980px and 560px.
  - **Rating mark:** branding.md's Rating entry is "lime dot (7px, ink outline) + bold number". The reviews list renders that inline (a 7px `rounded-full bg-[var(--ball)]` span with a 1.5px `--ink` outline, then the number in `font-semibold`), exactly as `src/app/bookings/page.tsx` already does for a player's own reviews. It does **not** import `src/components/ui/rating.tsx`: that component is for an *aggregate* (average + count in parens) and returns `null` when `count === 0`, which is the wrong component for a single review's own score.
  - **Never two lime (`--ball`) buttons in one view.** The settings page has three submit buttons (save name, upload logo, remove logo). Exactly one — **Save** on the business-name form, the page's primary action — uses `LIME_BUTTON`; the logo controls use `DARK_BUTTON` and `BORDERED_BUTTON`, which is branding.md's alternative primary. The reviews page has no button other than the filter's, which is bordered.
- **Branded focus ring on EVERY interactive element.** Declare, in every file that renders one, exactly:
  ```ts
  const FOCUS_RING =
    'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'
  ```
  and append it to the `className` of every `<Link>`, `<button>`, `<select>`, `<input>` and `<textarea>`. Reviews rejected its omission four times in an earlier slice. **The settings `'use client'` form imports `FOCUS_RING` and the control classes from `src/app/dashboard/listings/form-ui.tsx`** instead of redeclaring them — that module is a route-agnostic set of class strings plus one message renderer despite living under `/dashboard/listings`, and Slice C already established importing it from another route group. **Server Components declare their own `FOCUS_RING` locally**: they cannot import from a `'use client'` module without pulling it into the client bundle.
- **Tests run against the hosted Supabase project** via `DATABASE_URL` in `.env.local` — the Supavisor session pooler on port **5432**, never 6543. The database is **shared and persistent**: tests must pass on repeated runs, must create their own rows under their own ids, must clean up through `teardownFixtures()`'s id tracking, and must **never mutate seeded singleton rows** (`smash-zone-marikina` and the nine demo branches). **Run every DB-touching test file twice.**
  - Both of this slice's queries are **scoped**, not global — `getOwnerReviews` by an explicit branch-id list and every settings write by a single owner id — so unlike Slice C's admin queries these tests can assert exact contents. Still seed your own branch and assert against it; never assert a global count.
  - The suite has known pool-contention flakes under `npm test` (`tests/booking/hold.test.ts`, `tests/branches/detail.test.ts`, `tests/owner/queries.test.ts`, `tests/schema/bookings.test.ts`, `tests/bookings/queries.test.ts`): if one of those times out during a full run, **re-run that file on its own** before treating it as a regression. If the pooler is degraded and new files time out too, re-run with `npx vitest run <file> --testTimeout=45000` to tell a slow connection apart from a hung query. The config's own 20000 is the normal value and no run in this plan passes a flag.
- **Exactly two test doubles are permitted in this slice**, both already established in this repo:
  1. The **session** — `vi.mock('@/lib/supabase/server')` exactly as `tests/auth/guards.test.ts` and `tests/listings/permissions.test.ts` do it. Used only in Task 3's owner-only matrix.
  2. The **`StorageClient`** — a recorder passed as a parameter, exactly as `tests/listings/photos.test.ts` does it. The bucket is shared with the seeded demo photos and an upload has no rollback, so a test that really uploaded would leave objects in a shared project forever.
  Database rows are always real. No other double, anywhere. In particular `next/navigation`'s `redirect` is **not** mocked in this slice: no new page guard is added, so nothing here needs it.
- **No browser or dev-server steps inside implementation tasks.** Verification is tests + `npx tsc --noEmit` + `npm run lint` + `npm run build`. Everything that genuinely needs a browser is collected into the single final task, which the user runs themselves.
- **The working tree is not clean, and that is expected.** At planning time `git status` showed thirteen modified files and two untracked paths from earlier slices' in-flight work. **Never run `git add -A` or `git add .`** — every commit step below lists its exact paths, and only those paths go in. **Commit after every task**; do not squash tasks into one commit. Run no other state-changing git command.

---

### Task 1: The scoped reviews read

**Files:**
- Create: `src/lib/owner/reviews.ts`
- Create: `tests/owner/reviews.test.ts`

**Interfaces:**
- Produces, from `src/lib/owner/reviews.ts` (`import 'server-only'`):

```ts
export const OWNER_REVIEWS_LIMIT = 100

export type OwnerReviewRow = {
  id: string
  rating: number
  /** Null for a review left with no words, AND for one whose body is only whitespace. */
  body: string | null
  /** Resolved through booking_id -> bookings.court_id -> courts.name. */
  courtName: string
  branchId: string
  branchName: string
  /** coalesce(full_name, split_part(email, '@', 1)) — never null, never an email. */
  playerName: string
  /** `YYYY-MM-DD` in Manila, ready for formatDateLabel(). */
  createdOn: string
}

export type OwnerReviewsPage = {
  reviews: OwnerReviewRow[]
  /** True when more than OWNER_REVIEWS_LIMIT reviews matched; the page shows a muted line. */
  capped: boolean
}

export async function getOwnerReviews(
  branchIds: string[],
  filters?: { branchId?: string },
): Promise<OwnerReviewsPage>
```
- Consumes: `db` from `@/db`; `sql` from `drizzle-orm`. Nothing else.

**Why a new module rather than `src/lib/owner/queries.ts`:** that file is 487 lines organised entirely around the booking and money surfaces, and its four shared SQL fragments (`REAL_BOOKING`, `SCHEDULE_ROW`, `SCHEDULE_LABEL`, `MANILA_END_HOUR`) are all about booking status and booking hours — a reviews read uses none of them. Appending a sixty-line unrelated query there would also grow `tests/owner/queries.test.ts`, which is on the documented pooler-flake list; a sibling module keeps this slice's new tests off that file entirely. The one convention that *is* shared — `coalesce(full_name, split_part(email, '@', 1))` for a player's display name — is three tokens and is written out here for the same reason `queries.ts` writes `REAL_BOOKING` out rather than importing it from the player module.

**Why it comes first:** the page in Task 2 is a rendering of exactly this row shape, and nothing else in the slice depends on it. It is the smallest fully-testable unit here.

- [ ] **Step 1: Write the failing query tests**

Create `tests/owner/reviews.test.ts`:

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
import { getOwnerReviews, OWNER_REVIEWS_LIMIT } from '@/lib/owner/reviews'

afterAll(teardownFixtures)

/**
 * getOwnerReviews is SCOPED — it only ever sees the branch ids handed to it —
 * so unlike Slice C's admin queries these assertions can be exact rather than
 * filtered deltas. Every test seeds its own branch and asserts against that
 * branch's list.
 *
 * No test double anywhere in this file. The rows are real, the joins are real,
 * and the coalesce being asserted is the one that actually runs in production.
 */
async function seedReview(opts: {
  courtId: string
  branchId: string
  playerId: string
  hour: number
  rating?: number
  body?: string | null
}): Promise<string> {
  const bookingId = await seedBooking({
    courtId: opts.courtId,
    branchId: opts.branchId,
    playerId: opts.playerId,
    startsAt: manilaHour('2026-03-01', opts.hour),
    status: 'completed',
  })
  const result = await db.execute(sql`
    insert into reviews (booking_id, branch_id, player_id, rating, body)
    values (${bookingId}::uuid, ${opts.branchId}::uuid, ${opts.playerId}::uuid,
            ${opts.rating ?? 5}, ${opts.body ?? null})
    returning id
  `)
  return result.rows[0].id as string
}

test('getOwnerReviews returns every fact the dashboard list renders', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const reviewId = await seedReview({
    courtId: courtIds[0],
    branchId,
    playerId,
    hour: 12,
    rating: 4,
    body: 'Nets were in great shape.',
  })

  const page = await getOwnerReviews([branchId])
  expect(page.capped).toBe(false)
  expect(page.reviews).toHaveLength(1)
  expect(page.reviews[0]).toMatchObject({
    id: reviewId,
    rating: 4,
    body: 'Nets were in great shape.',
    // THE join the reviews table cannot do directly: reviews carries no
    // court_id, so this resolves booking_id -> bookings.court_id -> courts.name.
    courtName: 'Court 1',
    branchId,
    branchName: 'Fixture Branch',
  })
  // seedPlayer() leaves full_name null, so this is the split_part fallback --
  // the local part of the address, never the address itself.
  expect(page.reviews[0].playerName).toMatch(/^player-[0-9a-f-]+$/)
  expect(page.reviews[0].playerName).not.toContain('@')
  expect(page.reviews[0].createdOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  // rating comes out of a smallint column; a string here would render as
  // "4" today and break the moment anything does arithmetic on it.
  expect(typeof page.reviews[0].rating).toBe('number')
})

test('getOwnerReviews never returns another owner’s reviews', async () => {
  // THE cross-owner exclusion. Two owners, two branches, one review each: the
  // scope list is the only thing standing between them, and it is applied in
  // SQL rather than filtered afterwards.
  const mine = await seedBranchWithCourts(1)
  const theirs = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await seedReview({ courtId: mine.courtIds[0], branchId: mine.branchId, playerId, hour: 12 })
  await seedReview({ courtId: theirs.courtIds[0], branchId: theirs.branchId, playerId, hour: 14 })

  const page = await getOwnerReviews([mine.branchId])
  expect(page.reviews).toHaveLength(1)
  expect(page.reviews[0].branchId).toBe(mine.branchId)

  // And the other direction, so this cannot pass by the scope being ignored.
  const otherPage = await getOwnerReviews([theirs.branchId])
  expect(otherPage.reviews.map((row) => row.branchId)).toEqual([theirs.branchId])
})

test('getOwnerReviews returns nothing for an empty scope', async () => {
  // An owner with no branches yet. `= any('{}'::uuid[])` matches nothing,
  // which is the correct answer and not an error.
  await expect(getOwnerReviews([])).resolves.toEqual({ reviews: [], capped: false })
})

test('getOwnerReviews narrows to one branch when the filter is set', async () => {
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedReview({ courtId: first.courtIds[0], branchId: first.branchId, playerId, hour: 12 })
  await seedReview({ courtId: second.courtIds[0], branchId: second.branchId, playerId, hour: 14 })

  const scope = [first.branchId, second.branchId]
  expect((await getOwnerReviews(scope)).reviews).toHaveLength(2)

  const filtered = await getOwnerReviews(scope, { branchId: second.branchId })
  expect(filtered.reviews.map((row) => row.branchId)).toEqual([second.branchId])

  // A filter naming a branch OUTSIDE the scope narrows to nothing rather than
  // widening: the `any(branchIds)` clause is still there underneath it.
  const outside = await getOwnerReviews([first.branchId], { branchId: second.branchId })
  expect(outside.reviews).toEqual([])
})

test('getOwnerReviews reports an absent body as null, including a whitespace-only one', async () => {
  // The page renders nothing at all for a null body -- not an empty quote --
  // so a body of "   " has to arrive as null, not as three spaces that render
  // an empty paragraph with a margin.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedReview({ courtId: courtIds[0], branchId, playerId, hour: 12, body: null })
  await seedReview({ courtId: courtIds[0], branchId, playerId, hour: 13, body: '   \n\t ' })

  const page = await getOwnerReviews([branchId])
  expect(page.reviews).toHaveLength(2)
  expect(page.reviews.every((row) => row.body === null)).toBe(true)
})

test('getOwnerReviews uses the player’s full name when they have one', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await db.execute(sql`update profiles set full_name = 'Anna Reyes' where id = ${playerId}::uuid`)
  await seedReview({ courtId: courtIds[0], branchId, playerId, hour: 12 })

  const page = await getOwnerReviews([branchId])
  expect(page.reviews[0].playerName).toBe('Anna Reyes')
})

test('getOwnerReviews returns newest first, breaking ties by id', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const older = await seedReview({ courtId: courtIds[0], branchId, playerId, hour: 12 })
  const tieA = await seedReview({ courtId: courtIds[0], branchId, playerId, hour: 13 })
  const tieB = await seedReview({ courtId: courtIds[0], branchId, playerId, hour: 14 })

  // Backdated explicitly rather than trusting three inserts to land on three
  // different clock ticks. The two tied rows share a created_at to the
  // microsecond, so the ONLY thing that can order them is the id tiebreak --
  // without it this test would flake, which is the point of having it.
  await db.execute(sql`
    update reviews set created_at = timestamptz '2026-03-01 09:00:00+08'
    where id = ${older}::uuid
  `)
  await db.execute(sql`
    update reviews set created_at = timestamptz '2026-03-02 09:00:00+08'
    where id = any (array[${tieA}::uuid, ${tieB}::uuid])
  `)

  const page = await getOwnerReviews([branchId])
  const tied = [tieA, tieB].sort().reverse() // id desc
  expect(page.reviews.map((row) => row.id)).toEqual([...tied, older])
})

test('getOwnerReviews caps the list and says so', async () => {
  // OWNER_REVIEWS_LIMIT + 1 rows, inserted in two statements rather than 202
  // round trips: the pooler would not enjoy the latter and neither would the
  // 20s timeout. Consecutive whole hours on ONE court, so bookings_no_overlap
  // (a '[)' range) is satisfied by construction.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
      fee_config_snapshot
    )
    select ${courtIds[0]}::uuid, ${branchId}::uuid, ${playerId}::uuid,
      timestamptz '2026-04-01 00:00:00+08' + (n * interval '1 hour'),
      timestamptz '2026-04-01 01:00:00+08' + (n * interval '1 hour'),
      'completed', 30000, 0, 30000, 3000, 0, 27000, '{"test": true}'::jsonb
    from generate_series(0, ${OWNER_REVIEWS_LIMIT}) as n
  `)
  await db.execute(sql`
    insert into reviews (booking_id, branch_id, player_id, rating, body)
    select bk.id, bk.branch_id, bk.player_id, 5, null
    from bookings bk where bk.branch_id = ${branchId}::uuid
  `)

  const page = await getOwnerReviews([branchId])
  expect(page.reviews).toHaveLength(OWNER_REVIEWS_LIMIT)
  expect(page.capped).toBe(true)

  // Exactly at the limit is NOT capped -- an off-by-one here would show the
  // "showing the most recent 100" line to someone whose 100 reviews are all
  // on the page.
  await db.execute(sql`
    delete from reviews where id in (
      select id from reviews where branch_id = ${branchId}::uuid
      order by created_at, id limit 1
    )
  `)
  const exact = await getOwnerReviews([branchId])
  expect(exact.reviews).toHaveLength(OWNER_REVIEWS_LIMIT)
  expect(exact.capped).toBe(false)
})
```

- [ ] **Step 2: Watch it fail for the right reason**

```bash
npx vitest run tests/owner/reviews.test.ts
```

Expected: a module-resolution failure on `@/lib/owner/reviews` — not assertion failures. If you see assertions failing instead, the module already exists and you are editing the wrong thing.

- [ ] **Step 3: Write the query**

Create `src/lib/owner/reviews.ts`:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

/**
 * The reviews players left on a scoped set of branches — /dashboard/reviews.
 *
 * A separate module from src/lib/owner/queries.ts on purpose: that one is
 * organised around bookings and money and shares four SQL fragments about
 * booking status and booking hours, none of which a reviews read uses.
 *
 * Read-only. Replies, moderation and deletion are out of scope for this slice
 * (they need a migration); there is deliberately no write in this file.
 */

/**
 * No pagination this slice. One hundred is comfortably more than a busy branch
 * accumulates in a season, the page says so out loud when it is hit, and a
 * cap is what keeps a five-branch owner's page from becoming an unbounded
 * render. Exported so the test asserts the real number rather than a copy.
 */
export const OWNER_REVIEWS_LIMIT = 100

export type OwnerReviewRow = {
  id: string
  rating: number
  body: string | null
  courtName: string
  branchId: string
  branchName: string
  playerName: string
  /** `YYYY-MM-DD` in Manila — feed straight to formatDateLabel(). */
  createdOn: string
}

export type OwnerReviewsPage = { reviews: OwnerReviewRow[]; capped: boolean }

export async function getOwnerReviews(
  branchIds: string[],
  filters: { branchId?: string } = {},
): Promise<OwnerReviewsPage> {
  // Belt-and-braces on top of the scope list: the `any` clause already makes
  // an unscoped branch id return nothing, so a forged ?branch= can only ever
  // narrow, never widen.
  const branchFilter = filters.branchId ? sql`and b.id = ${filters.branchId}::uuid` : sql``

  // LIMIT + 1 is how `capped` is answered without a second count(*) round
  // trip: if the extra row came back, there is more than the page shows.
  const result = await db.execute(sql`
    select rv.id, rv.rating::int as rating,
      nullif(btrim(rv.body), '') as body,
      c.name as court_name,
      b.id as branch_id, b.name as branch_name,
      coalesce(pr.full_name, split_part(pr.email, '@', 1)) as player_name,
      to_char(rv.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as created_on
    from reviews rv
    join branches b  on b.id = rv.branch_id
    -- reviews carries no court_id, so the court comes through the booking.
    -- Both joins are INNER and safe to be: booking_id and player_id are NOT
    -- NULL with FKs, and bookings.court_id is NOT NULL too.
    join bookings bk on bk.id = rv.booking_id
    join courts c    on c.id = bk.court_id
    join profiles pr on pr.id = rv.player_id
    where b.id = any (${sql.param(branchIds)}::uuid[])
      ${branchFilter}
    -- Newest first, with the id as a deterministic tiebreak: two reviews can
    -- share a created_at, and an unstable order would reshuffle the page on
    -- every render.
    order by rv.created_at desc, rv.id desc
    limit ${OWNER_REVIEWS_LIMIT + 1}
  `)

  const capped = result.rows.length > OWNER_REVIEWS_LIMIT
  const reviews = result.rows.slice(0, OWNER_REVIEWS_LIMIT).map((row) => ({
    id: row.id as string,
    // Coerced out of the driver, like every numeric column in this codebase.
    rating: Number(row.rating),
    // Already nullif'd in SQL, so a whitespace-only body is null here too and
    // the page renders no paragraph at all rather than an empty one.
    body: (row.body as string | null) ?? null,
    courtName: row.court_name as string,
    branchId: row.branch_id as string,
    branchName: row.branch_name as string,
    playerName: row.player_name as string,
    createdOn: row.created_on as string,
  }))

  return { reviews, capped }
}
```

- [ ] **Step 4: Watch it pass, twice**

```bash
npx vitest run tests/owner/reviews.test.ts
npx vitest run tests/owner/reviews.test.ts
```

Expected: green both times. The second run is what proves the 101 seeded bookings and reviews are torn down and the file is repeat-safe against this shared, persistent database. If the second run fails on a leftover row, `teardownFixtures()` is not reaching them — fix the teardown, never the assertion.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors; lint reports only the pre-existing warnings.

```bash
git add src/lib/owner/reviews.ts tests/owner/reviews.test.ts
git commit -m "Add the branch-scoped owner reviews query"
```

---

### Task 2: `/dashboard/reviews` and its sidebar item

**Files:**
- Create: `src/app/dashboard/reviews/page.tsx`
- Modify: `src/app/dashboard/layout.tsx`

**Interfaces:**
- Produces: the default-exported `ReviewsPage` Server Component at route `/dashboard/reviews`, taking `{ searchParams: Promise<{ branch?: string }> }`.
- Consumes: `requireDashboardPage` from `@/lib/auth/page-guards`; `branchIdsWith` from `@/lib/staff/access`; `getOwnerReviews` / `OWNER_REVIEWS_LIMIT` from `@/lib/owner/reviews`; `formatDateLabel` from `@/lib/format`; `redirect` from `next/navigation`.
- No new exports from `layout.tsx` — one item added to its existing `items` array.

**Why the nav item ships in the same commit as the page:** their own rule from the previous slice, written into `layout.tsx`'s comment — "a nav item pointing at a 404 is worse than no item". The Settings item is therefore **not** added here; it lands in Task 4 with its page.

**Access, exactly as specified — and where it differs from Bookings.** The sidebar gate is `access.isOwner || branchIdsWith(access, 'view_bookings').length > 0`, the same shape the Branches & courts item already uses. The page's entry redirect is `if (!access.isOwner && scope.length === 0) redirect('/dashboard')` — note the `!access.isOwner`, which `/dashboard/bookings` does not have. That is deliberate and is what the spec asks for: an owner with no branches yet sees the empty state (the item is shown to them unconditionally, so bouncing them would be the nav lying), while a staff member whose `view_bookings` grants were all revoked between the nav render and the click has nothing to look at and goes back to the overview.

- [ ] **Step 1: The page**

Create `src/app/dashboard/reviews/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { getOwnerReviews, OWNER_REVIEWS_LIMIT } from '@/lib/owner/reviews'
import { formatDateLabel } from '@/lib/format'

// Declared locally, not imported from src/app/dashboard/listings/form-ui.tsx:
// that module is 'use client', and importing it into a Server Component would
// pull it into the client bundle for a string.
const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What players said, for the people who run the courts.
 *
 * Read-only by design: replies, moderation and deletion are out of scope (they
 * need a migration). Nothing on this page is a form except the branch filter,
 * and that is a plain GET.
 *
 * Access is `view_bookings`, scoped per branch — the same permission that
 * governs /dashboard/bookings, because a review is operational feedback about
 * a specific branch's courts and belongs to whoever already sees that branch's
 * schedule. It is NOT gated on `access.can`: that is a union across every
 * branch a session can see at all, and scoping the query by it would show a
 * staff member reviews from a branch they were never granted.
 */
export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string }>
}) {
  const access = await requireDashboardPage('/dashboard/reviews')
  const { branch: rawBranch } = await searchParams

  const scopeBranchIds = branchIdsWith(access, 'view_bookings')
  // `!access.isOwner &&` deliberately, and unlike /dashboard/bookings: the
  // sidebar shows this item to every owner, including one with no branches
  // yet, so bouncing them would make the nav a liar. A staff member whose
  // grants were revoked since the nav rendered has genuinely nothing here.
  if (!access.isOwner && scopeBranchIds.length === 0) redirect('/dashboard')

  // The dropdown and the filter validation are narrowed to the view_bookings
  // branches specifically, never to every branch this session can see at all.
  const branches = access.branches.filter((branch) => scopeBranchIds.includes(branch.id))
  const branchId =
    rawBranch && UUID_RE.test(rawBranch) && branches.some((branch) => branch.id === rawBranch)
      ? rawBranch
      : undefined

  // No round trip at all for an owner with no branches: `any('{}')` would
  // return nothing anyway, and skipping it keeps the empty state free.
  const { reviews, capped } =
    scopeBranchIds.length > 0
      ? await getOwnerReviews(scopeBranchIds, { branchId })
      : { reviews: [], capped: false }

  const filteredBranchName = branchId
    ? branches.find((branch) => branch.id === branchId)?.name
    : undefined

  return (
    <>
      <header className="mb-8">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Reviews
        </h1>
        <p className="mt-2 max-w-[560px] text-[15px] text-[var(--ink-soft)]">
          What players said after playing on your courts. Newest first.
        </p>
      </header>

      {branches.length > 1 && (
        <form
          method="get"
          action="/dashboard/reviews"
          aria-label="Filter reviews by branch"
          className="mb-6 flex items-center gap-2"
        >
          <select
            name="branch"
            aria-label="Branch"
            defaultValue={branchId ?? ''}
            className={`h-[var(--btn-h-sm)] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-3 text-[13px] text-[var(--ink)] ${FOCUS_RING}`}
          >
            <option value="">All branches</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className={`inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3.5 text-[13px] font-semibold text-[var(--ink)] hover:border-[var(--court)] ${FOCUS_RING}`}
          >
            Filter
          </button>
        </form>
      )}

      {reviews.length === 0 ? (
        <p className={EMPTY_PANEL}>
          {filteredBranchName
            ? `No reviews for ${filteredBranchName} yet.`
            : 'No reviews yet — players can review a court after they’ve played on it.'}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-4">
            {reviews.map((review) => (
              <article
                key={review.id}
                className="rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)]"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-display text-[16px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                      {review.courtName}
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-[var(--ink-soft)]">
                      {review.branchName} · {review.playerName}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[11.5px] text-[var(--ink-soft)]">
                      {formatDateLabel(review.createdOn)}
                    </div>
                    {/* branding.md's Rating mark: lime dot (7px, ink outline)
                        + bold number. Inline rather than <Rating>, which is
                        the AGGREGATE component (average + count in parens) and
                        renders nothing at all when count is 0. */}
                    <div className="mt-1.5 flex items-center justify-end gap-1.5 text-[14px] font-semibold text-[var(--ink)]">
                      <span
                        aria-hidden
                        className="h-[7px] w-[7px] rounded-full bg-[var(--ball)] outline outline-[1.5px] outline-[var(--ink)]"
                      />
                      {review.rating.toFixed(1)}
                    </div>
                  </div>
                </div>
                {/* Null body renders NOTHING — not an empty blockquote, not a
                    dash. The query already collapses a whitespace-only body to
                    null, so this one check covers both. */}
                {review.body && (
                  <p className="mt-3.5 text-[14.5px] text-[var(--ink)]">{review.body}</p>
                )}
              </article>
            ))}
          </div>

          {capped && (
            <p className="mt-5 text-[12.5px] text-[var(--ink-soft)]">
              Showing the most recent {OWNER_REVIEWS_LIMIT}.
            </p>
          )}
        </>
      )}
    </>
  )
}
```

- [ ] **Step 2: The sidebar item**

In `src/app/dashboard/layout.tsx`, replace this comment paragraph:

```tsx
  // The mockup also lists Reviews and Settings; those are later slices, and a
  // nav item pointing at a 404 is worse than no item.
```

with:

```tsx
  // Settings is added alongside its own page in the next task of this slice —
  // a nav item pointing at a 404 is worse than no item.
```

then, in the `items` array, replace these two consecutive lines:

```tsx
    { href: '/dashboard/earnings', label: 'Earnings', show: access.can.view_earnings },
    { href: '/dashboard/staff', label: 'Staff', show: access.isOwner },
```

with these three (the mockup's order is Overview, Bookings, Branches & courts, Earnings, Reviews, Settings; Staff has no mockup entry and keeps its current position):

```tsx
    { href: '/dashboard/earnings', label: 'Earnings', show: access.can.view_earnings },
    {
      href: '/dashboard/reviews',
      label: 'Reviews',
      // Gated exactly like Branches & courts, on the same permission the
      // Bookings item uses: owners always (an owner with no branches sees the
      // empty state, which is the honest answer), staff only where a
      // view_bookings grant actually exists. branchIdsWith, not
      // access.can.view_bookings, so the item and the page's contents answer
      // the same question.
      show: access.isOwner || branchIdsWith(access, 'view_bookings').length > 0,
    },
    { href: '/dashboard/staff', label: 'Staff', show: access.isOwner },
```

`branchIdsWith` is already imported in that file — do not add a second import.

- [ ] **Step 3: Typecheck, lint, build**

```bash
npx tsc --noEmit && npm run lint && npm run build
```

Expected: no type errors; lint reports only the pre-existing warnings; the build succeeds and its route list now includes `/dashboard/reviews`.

- [ ] **Step 4: Confirm nothing regressed, twice**

```bash
npx vitest run tests/owner tests/staff
npx vitest run tests/owner tests/staff
```

Expected: green both times. Nothing here changes a query, so this is a regression check on the layout edit rather than new coverage.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/reviews/page.tsx src/app/dashboard/layout.tsx
git commit -m "Add the owner reviews page and its sidebar item"
```

---

### Task 3: The settings reads and writes

**Files:**
- Modify: `src/lib/staff/write.ts`
- Create: `src/lib/owner/settings.ts`
- Create: `tests/owner/settings.test.ts`

**Interfaces:**
- Produces, from `src/lib/staff/write.ts` — one word added, `export`:

```ts
export const MAX_BUSINESS_NAME_LENGTH = 120
```
- Produces, from `src/lib/owner/settings.ts` (`import 'server-only'`):

```ts
export const LOGO_BUCKET: PhotoBucket // 'branch-photos'

export type OwnerSettings = {
  businessName: string | null
  slug: string | null
  logoPath: string | null
}

export type SettingsFailure =
  | 'not_an_owner'
  | 'empty_name'
  | 'name_too_long'
  | 'no_file'
  | 'bad_type'
  | 'too_large'
  | 'upload_failed'

export type SettingsResult = { ok: true } | { ok: false; reason: SettingsFailure }

/** Null when the id has no `role = 'owner'` profile — e.g. an admin, who passes requireOwner. */
export async function getOwnerSettings(ownerId: string): Promise<OwnerSettings | null>

export async function updateBusinessName(input: {
  ownerId: string
  businessName: string
}): Promise<SettingsResult>

export async function updateBusinessLogo(input: {
  ownerId: string
  file: File
  storage: StorageClient
}): Promise<SettingsResult>

export async function removeBusinessLogo(input: {
  ownerId: string
  storage: StorageClient
}): Promise<SettingsResult>
```
- Consumes: `db` from `@/db`; `sql` from `drizzle-orm`; `ALLOWED_PHOTO_TYPES`, `MAX_PHOTO_BYTES`, `PHOTO_EXTENSIONS`, `type PhotoBucket` from `@/lib/photos`; `type StorageClient` from `@/lib/listings/storage`; `MAX_BUSINESS_NAME_LENGTH` from `@/lib/staff/write`.

**Four decisions this module makes, and why:**

1. **`MAX_BUSINESS_NAME_LENGTH` is imported, never restated.** `promoteToOwner` already enforces 120 on the same column; two constants would eventually disagree and an owner would find a name the admin screen accepted and this one refused. The constant is currently module-private in `src/lib/staff/write.ts`; Step 1 exports it and changes nothing else. It is **not** moved to a pure module: the only client-side consumer is the name field's `maxLength`, and Task 4's Server Component passes it down as a prop, which costs one prop and avoids inventing a module for one number.

2. **`StorageClient` is reused verbatim, not re-declared.** It is a two-method interface keyed by `PhotoBucket`, and `PhotoBucket` already admits `'branch-photos'`. A parallel `LogoStorageClient` of identical shape would need its own fake in the tests and its own real implementation beside `serviceRoleStorage()`, for no property gained. `LOGO_BUCKET` is exported so the path convention has exactly one authority — the settings page, the brand page and the tests all read it from here.

3. **Zero rows is `not_an_owner`, NOT `stale`.** Slice C's rule ("zero rows is stale, never an error") applies to a court that moved under someone's cursor, where "reload" is genuinely the next step. Here the row is the caller's *own* profile, and the realistic cause of zero rows is that `requireOwner` admits admins (`role === 'owner' || role === 'admin'`) while these writes are scoped `role = 'owner'`. Telling an admin to reload would be advice that never comes true. One reason, one honest sentence, and it also covers the unreachable "profile vanished" case.

4. **The path swap is a transaction with `for update`, and the object work brackets it.** Upload happens **before** the row is touched (a row pointing at a missing object is a broken logo on the owner's own public page; an object with no row is invisible), and the replaced object is removed **after** the update commits, best-effort, with its error swallowed — a dangling old object beats a live row pointing at nothing, the same asymmetry `src/lib/listings/photos.ts` documents. The `for update` read of the previous path is in the same transaction as the write, matching `approveCourt` and `replaceRateBands`, so two concurrent uploads cannot both read the same previous path and both try to delete it.

- [ ] **Step 1: Export the business-name cap**

In `src/lib/staff/write.ts`, change:

```ts
const MAX_BUSINESS_NAME_LENGTH = 120
```

to:

```ts
/**
 * The one authority on how long a business name may be. Exported since the
 * owner-settings slice: /dashboard/settings edits the same column, and a second
 * constant would eventually disagree with this one — an owner would find a name
 * the promote screen accepted and the settings page refused.
 */
export const MAX_BUSINESS_NAME_LENGTH = 120
```

Nothing else in that file changes.

- [ ] **Step 2: Write the failing settings tests**

Create `tests/owner/settings.test.ts`:

```ts
import { afterAll, beforeEach, expect, test, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  seedAdmin,
  seedBranchWithCourts,
  seedOwner,
  seedPlayer,
  seedStaffGrant,
  teardownFixtures,
} from '../helpers/fixtures'
import { MAX_PHOTO_BYTES } from '@/lib/photos'
import { MAX_BUSINESS_NAME_LENGTH } from '@/lib/staff/write'
import type { StorageClient } from '@/lib/listings/storage'
import {
  getOwnerSettings,
  LOGO_BUCKET,
  removeBusinessLogo,
  updateBusinessLogo,
  updateBusinessName,
} from '@/lib/owner/settings'

afterAll(teardownFixtures)

const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555'

/**
 * Two boundaries are replaced in this file and nothing else is.
 *
 *   1. The SESSION, for the guard matrix at the bottom — the same vi.mock
 *      tests/auth/guards.test.ts and tests/listings/permissions.test.ts use.
 *      Everything under it (the profiles lookup, the role read) is real.
 *   2. The STORAGE CLIENT, passed as a parameter exactly as
 *      tests/listings/photos.test.ts does. The bucket is shared with the
 *      seeded demo photos and an upload has no rollback, so a test that really
 *      uploaded would leave objects in a shared Supabase project forever.
 *
 * Every profiles row below is real.
 */
const claims = vi.hoisted(() => ({ value: null as null | { sub: string } }))

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getClaims: async () => ({ data: claims.value ? { claims: claims.value } : null }) },
  }),
}))

const { AuthError, requireOwner } = await import('@/lib/auth/guards')

function signInAs(userId: string) {
  claims.value = { sub: userId }
}

beforeEach(() => {
  claims.value = null
})

/**
 * `pathAtCall` is what makes the ordering assertions real rather than
 * decorative: the fake reads profiles.business_logo_path AT THE MOMENT storage
 * is called, so "object first, then row" and "old object removed AFTER the row
 * update" are observed instead of assumed.
 */
type StorageCall = { op: 'upload' | 'remove'; bucket: string; paths: string[]; pathAtCall: string | null }

function recorder(ownerId: string, options: { uploadError?: string; removeError?: string } = {}) {
  const calls: StorageCall[] = []

  async function currentPath(): Promise<string | null> {
    const result = await db.execute(sql`
      select business_logo_path from profiles where id = ${ownerId}::uuid
    `)
    return (result.rows[0]?.business_logo_path as string | null) ?? null
  }

  const client: StorageClient = {
    async upload(bucket, path) {
      calls.push({ op: 'upload', bucket, paths: [path], pathAtCall: await currentPath() })
      return { error: options.uploadError ?? null }
    },
    async remove(bucket, paths) {
      calls.push({ op: 'remove', bucket, paths, pathAtCall: await currentPath() })
      return { error: options.removeError ?? null }
    },
  }

  return { client, calls }
}

function imageFile(type = 'image/jpeg', bytes = 64): File {
  return new File([new Uint8Array(bytes)], 'logo', { type })
}

async function logoPathOf(ownerId: string): Promise<string | null> {
  const result = await db.execute(sql`
    select business_logo_path from profiles where id = ${ownerId}::uuid
  `)
  return (result.rows[0].business_logo_path as string | null) ?? null
}

// -------------------------------------------------------------- getOwnerSettings

test('getOwnerSettings returns the three fields the page renders', async () => {
  const ownerId = await seedOwner()
  const slug = `settings-${crypto.randomUUID()}`
  await db.execute(sql`
    update profiles set business_name = 'Smash Zone', slug = ${slug}
    where id = ${ownerId}::uuid
  `)

  await expect(getOwnerSettings(ownerId)).resolves.toEqual({
    businessName: 'Smash Zone',
    slug,
    logoPath: null,
  })
})

test('getOwnerSettings returns nulls, not an error, for an owner promoted without a name', async () => {
  // seedOwner() flips the role and nothing else, which is a real state: the
  // page renders the em-dash brand-link line for exactly this row.
  const ownerId = await seedOwner()
  await expect(getOwnerSettings(ownerId)).resolves.toEqual({
    businessName: null,
    slug: null,
    logoPath: null,
  })
})

test('getOwnerSettings returns null for anyone who is not an owner', async () => {
  // An ADMIN is the case that matters: requireOwner admits them, so they can
  // reach the page, and this null is what tells the page to say so.
  await expect(getOwnerSettings(await seedAdmin())).resolves.toBeNull()
  await expect(getOwnerSettings(await seedPlayer())).resolves.toBeNull()
  await expect(getOwnerSettings(UNKNOWN_ID)).resolves.toBeNull()
})

// ------------------------------------------------------------ updateBusinessName

test('updateBusinessName trims and stores the name', async () => {
  const ownerId = await seedOwner()

  await expect(
    updateBusinessName({ ownerId, businessName: '  Smash Zone Marikina  ' }),
  ).resolves.toEqual({ ok: true })
  await expect(getOwnerSettings(ownerId)).resolves.toMatchObject({
    businessName: 'Smash Zone Marikina',
  })
})

test('updateBusinessName refuses an empty or whitespace-only name and writes nothing', async () => {
  const ownerId = await seedOwner()
  await updateBusinessName({ ownerId, businessName: 'Smash Zone' })

  for (const businessName of ['', '   ', '\n\t ']) {
    await expect(updateBusinessName({ ownerId, businessName })).resolves.toEqual({
      ok: false,
      reason: 'empty_name',
    })
  }
  await expect(getOwnerSettings(ownerId)).resolves.toMatchObject({ businessName: 'Smash Zone' })
})

test('updateBusinessName refuses a name past the shared cap, and allows the cap itself', async () => {
  // The cap is imported from src/lib/staff/write.ts, the same authority
  // promoteToOwner uses — never a second copy of the number.
  const ownerId = await seedOwner()

  await expect(
    updateBusinessName({ ownerId, businessName: 'x'.repeat(MAX_BUSINESS_NAME_LENGTH + 1) }),
  ).resolves.toEqual({ ok: false, reason: 'name_too_long' })
  await expect(getOwnerSettings(ownerId)).resolves.toMatchObject({ businessName: null })

  await expect(
    updateBusinessName({ ownerId, businessName: 'x'.repeat(MAX_BUSINESS_NAME_LENGTH) }),
  ).resolves.toEqual({ ok: true })
})

test('updateBusinessName measures the cap AFTER trimming', async () => {
  // Otherwise a name that fits would be refused for its trailing spaces.
  const ownerId = await seedOwner()
  const name = 'x'.repeat(MAX_BUSINESS_NAME_LENGTH)
  await expect(updateBusinessName({ ownerId, businessName: `  ${name}  ` })).resolves.toEqual({
    ok: true,
  })
  await expect(getOwnerSettings(ownerId)).resolves.toMatchObject({ businessName: name })
})

test('updateBusinessName refuses anyone whose profile is not role = owner', async () => {
  // An admin passes requireOwner but is not an owner, so the write's own
  // `role = 'owner'` scoping is the second layer that stops it. The reason is
  // not_an_owner rather than stale: telling an admin to reload would be advice
  // that never comes true.
  for (const id of [await seedAdmin(), await seedPlayer(), UNKNOWN_ID]) {
    await expect(updateBusinessName({ ownerId: id, businessName: 'Smash Zone' })).resolves.toEqual({
      ok: false,
      reason: 'not_an_owner',
    })
  }
})

// ------------------------------------------------------------ updateBusinessLogo

test('updateBusinessLogo uploads to logos/<ownerId>/ in the branch-photos bucket, object first', async () => {
  const ownerId = await seedOwner()
  const { client, calls } = recorder(ownerId)

  await expect(updateBusinessLogo({ ownerId, file: imageFile(), storage: client })).resolves.toEqual(
    { ok: true },
  )

  expect(calls).toHaveLength(1)
  expect(calls[0].op).toBe('upload')
  expect(calls[0].bucket).toBe(LOGO_BUCKET)
  expect(LOGO_BUCKET).toBe('branch-photos')
  // A fresh UUID per object, never the uploaded filename: two logos called
  // logo.png would collide, and a user-supplied name in a public URL is a
  // path-traversal question nobody needs to answer.
  expect(calls[0].paths[0]).toMatch(
    new RegExp(`^logos/${ownerId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$`),
  )
  // OBJECT FIRST: the row still had no path when storage was called.
  expect(calls[0].pathAtCall).toBeNull()
  expect(await logoPathOf(ownerId)).toBe(calls[0].paths[0])
})

test('updateBusinessLogo picks the extension from the content type', async () => {
  for (const [type, extension] of [
    ['image/png', 'png'],
    ['image/webp', 'webp'],
  ] as const) {
    const ownerId = await seedOwner()
    const { client } = recorder(ownerId)
    await updateBusinessLogo({ ownerId, file: imageFile(type), storage: client })
    expect(await logoPathOf(ownerId)).toMatch(new RegExp(`\\.${extension}$`))
  }
})

test('updateBusinessLogo removes the replaced object AFTER the new path is stored', async () => {
  const ownerId = await seedOwner()
  await updateBusinessLogo({ ownerId, file: imageFile(), storage: recorder(ownerId).client })
  const firstPath = await logoPathOf(ownerId)

  const { client, calls } = recorder(ownerId)
  await expect(
    updateBusinessLogo({ ownerId, file: imageFile('image/png'), storage: client }),
  ).resolves.toEqual({ ok: true })

  const secondPath = await logoPathOf(ownerId)
  expect(secondPath).not.toBe(firstPath)

  expect(calls.map((call) => call.op)).toEqual(['upload', 'remove'])
  // Object first: the row still pointed at the OLD path during the upload.
  expect(calls[0].pathAtCall).toBe(firstPath)
  // Cleanup after: the row already pointed at the NEW path when the old object
  // was removed, so a crash between the two leaves a dangling object rather
  // than a row pointing at nothing.
  expect(calls[1].paths).toEqual([firstPath])
  expect(calls[1].pathAtCall).toBe(secondPath)
})

test('updateBusinessLogo still succeeds when removing the replaced object fails', async () => {
  // BEST EFFORT, deliberately. A dangling old object costs storage; a failed
  // save costs the owner their logo for no reason they can act on.
  const ownerId = await seedOwner()
  await updateBusinessLogo({ ownerId, file: imageFile(), storage: recorder(ownerId).client })
  const firstPath = await logoPathOf(ownerId)

  const { client } = recorder(ownerId, { removeError: 'storage exploded' })
  await expect(
    updateBusinessLogo({ ownerId, file: imageFile(), storage: client }),
  ).resolves.toEqual({ ok: true })

  const secondPath = await logoPathOf(ownerId)
  expect(secondPath).not.toBeNull()
  expect(secondPath).not.toBe(firstPath)
})

test('updateBusinessLogo writes no row when the upload fails', async () => {
  const ownerId = await seedOwner()
  const { client, calls } = recorder(ownerId, { uploadError: 'network down' })

  await expect(updateBusinessLogo({ ownerId, file: imageFile(), storage: client })).resolves.toEqual(
    { ok: false, reason: 'upload_failed' },
  )
  expect(calls.map((call) => call.op)).toEqual(['upload'])
  expect(await logoPathOf(ownerId)).toBeNull()
})

test('updateBusinessLogo refuses an empty, wrong-typed or oversized file before touching storage', async () => {
  const ownerId = await seedOwner()

  const cases: [File, string][] = [
    // An <input type="file"> with nothing chosen still submits a zero-byte
    // entry, so "empty" is the normal shape of "no logo attached".
    [imageFile('image/jpeg', 0), 'no_file'],
    [imageFile('image/gif'), 'bad_type'],
    [imageFile('application/pdf'), 'bad_type'],
    [imageFile('image/jpeg', MAX_PHOTO_BYTES + 1), 'too_large'],
  ]

  for (const [file, reason] of cases) {
    const { client, calls } = recorder(ownerId)
    await expect(updateBusinessLogo({ ownerId, file, storage: client })).resolves.toEqual({
      ok: false,
      reason,
    })
    expect(calls).toEqual([])
  }
  expect(await logoPathOf(ownerId)).toBeNull()
})

test('updateBusinessLogo takes the uploaded object back out when the profile is not an owner', async () => {
  // The object went up before the row was checked, so a refusal has to
  // reclaim it — the same cleanup addPhoto does for a vanished target.
  const adminId = await seedAdmin()
  const { client, calls } = recorder(adminId)

  await expect(updateBusinessLogo({ ownerId: adminId, file: imageFile(), storage: client })).resolves.toEqual(
    { ok: false, reason: 'not_an_owner' },
  )
  expect(calls.map((call) => call.op)).toEqual(['upload', 'remove'])
  expect(calls[1].paths).toEqual(calls[0].paths)
  expect(await logoPathOf(adminId)).toBeNull()
})

// ------------------------------------------------------------ removeBusinessLogo

test('removeBusinessLogo nulls the path, then removes the object', async () => {
  const ownerId = await seedOwner()
  await updateBusinessLogo({ ownerId, file: imageFile(), storage: recorder(ownerId).client })
  const path = await logoPathOf(ownerId)

  const { client, calls } = recorder(ownerId)
  await expect(removeBusinessLogo({ ownerId, storage: client })).resolves.toEqual({ ok: true })

  expect(await logoPathOf(ownerId)).toBeNull()
  expect(calls.map((call) => call.op)).toEqual(['remove'])
  expect(calls[0].bucket).toBe(LOGO_BUCKET)
  expect(calls[0].paths).toEqual([path])
  // ROW FIRST here, the opposite order from the upload and for the same
  // reason: the failure this ordering avoids is a row pointing at an object
  // that is already gone.
  expect(calls[0].pathAtCall).toBeNull()
})

test('removeBusinessLogo still succeeds when the object removal fails', async () => {
  const ownerId = await seedOwner()
  await updateBusinessLogo({ ownerId, file: imageFile(), storage: recorder(ownerId).client })

  const { client } = recorder(ownerId, { removeError: 'storage exploded' })
  await expect(removeBusinessLogo({ ownerId, storage: client })).resolves.toEqual({ ok: true })
  expect(await logoPathOf(ownerId)).toBeNull()
})

test('removeBusinessLogo is a no-op, not an error, when there is no logo', async () => {
  // A double-submit must not be a failure the owner has to interpret.
  const ownerId = await seedOwner()
  const { client, calls } = recorder(ownerId)

  await expect(removeBusinessLogo({ ownerId, storage: client })).resolves.toEqual({ ok: true })
  expect(calls).toEqual([])
})

test('removeBusinessLogo refuses anyone whose profile is not role = owner', async () => {
  for (const id of [await seedAdmin(), await seedPlayer(), UNKNOWN_ID]) {
    const { client, calls } = recorder(id)
    await expect(removeBusinessLogo({ ownerId: id, storage: client })).resolves.toEqual({
      ok: false,
      reason: 'not_an_owner',
    })
    expect(calls).toEqual([])
  }
})

// ------------------------------------------------------------------ the guard

test('requireOwner admits an owner and an admin, and refuses everyone else', async () => {
  // The FIRST of the two layers. The second is the `role = 'owner'` scoping in
  // every write above — which is exactly why an admin passing here is safe.
  const ownerId = await seedOwner()
  signInAs(ownerId)
  await expect(requireOwner()).resolves.toMatchObject({ id: ownerId, role: 'owner' })

  const adminId = await seedAdmin()
  signInAs(adminId)
  await expect(requireOwner()).resolves.toMatchObject({ id: adminId, role: 'admin' })
})

test('requireOwner refuses a plain player and a staff member with a grant', async () => {
  // Settings is brand identity: staff never see it, no matter what they were
  // granted. There is no branch-scoped flag that opens this page.
  const playerId = await seedPlayer()
  signInAs(playerId)
  await expect(requireOwner()).rejects.toBeInstanceOf(AuthError)

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
  await requireOwner().catch((error) => expect((error as InstanceType<typeof AuthError>).status).toBe(403))
  await expect(requireOwner()).rejects.toBeInstanceOf(AuthError)
})

test('requireOwner reports 401, not 403, for a signed-out visitor', async () => {
  // beforeEach leaves claims null.
  await expect(requireOwner()).rejects.toBeInstanceOf(AuthError)
  await requireOwner().catch((error) => expect((error as InstanceType<typeof AuthError>).status).toBe(401))
})
```

- [ ] **Step 3: Watch it fail for the right reason**

```bash
npx vitest run tests/owner/settings.test.ts
```

Expected: a module-resolution failure on `@/lib/owner/settings` — not assertion failures. (If instead it fails importing `MAX_BUSINESS_NAME_LENGTH`, Step 1 was skipped.)

- [ ] **Step 4: Write the settings module**

Create `src/lib/owner/settings.ts`:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  ALLOWED_PHOTO_TYPES,
  MAX_PHOTO_BYTES,
  PHOTO_EXTENSIONS,
  type PhotoBucket,
} from '@/lib/photos'
import type { StorageClient } from '@/lib/listings/storage'
import { MAX_BUSINESS_NAME_LENGTH } from '@/lib/staff/write'

/**
 * An owner's own brand identity: business name, logo, and the slug they can
 * see but not change. Backs /dashboard/settings.
 *
 * Every function here is scoped to ONE owner id, which the action takes from
 * the guarded session and never from the form. There is no branch scoping in
 * this module because none of it is branch-shaped: a business name belongs to
 * the account, not to a location.
 *
 * `role = 'owner'` is in the WHERE clause of every write, not checked after a
 * read. requireOwner (the actions' guard) admits ADMINS as well as owners —
 * see its doc comment — so that clause is the second layer that stops an admin
 * from acquiring a business identity by visiting a dashboard page.
 *
 * `storage` is a parameter rather than an import for the same reason
 * src/lib/listings/photos.ts takes one: the one boundary that cannot be rolled
 * back is the one boundary the tests fake. The rows stay real.
 */

/**
 * Logos live in the EXISTING `branch-photos` bucket under a `logos/` prefix.
 *
 * Only two buckets exist (supabase/migrations/20260801110350_storage_and_cron.sql
 * creates `branch-photos` and `court-photos`, both public), this slice has no
 * migration, and the prefixes already in use are `branches/<id>/` and
 * `courts/<id>/` — so `logos/<ownerId>/` collides with nothing. `court-photos`
 * would be the wrong half of the pair: a brand logo is not a court photo.
 *
 * Exported so the settings page, the public brand page and the tests all read
 * the bucket from one place rather than repeating the string.
 */
export const LOGO_BUCKET: PhotoBucket = 'branch-photos'

export type OwnerSettings = {
  businessName: string | null
  slug: string | null
  logoPath: string | null
}

export type SettingsFailure =
  | 'not_an_owner'
  | 'empty_name'
  | 'name_too_long'
  | 'no_file'
  | 'bad_type'
  | 'too_large'
  | 'upload_failed'

export type SettingsResult = { ok: true } | { ok: false; reason: SettingsFailure }

/**
 * The three fields the settings page renders, or null when this id has no
 * owner profile.
 *
 * Null is a REACHABLE state, not a defensive branch: requireOwner admits
 * admins, and an admin has no business_name or slug by construction (see
 * seedAdmin's note and promoteToOwner's `role = 'player'` scoping). The page
 * renders a short explanation for it rather than an empty form that would
 * refuse every submission.
 */
export async function getOwnerSettings(ownerId: string): Promise<OwnerSettings | null> {
  const result = await db.execute(sql`
    select business_name, slug, business_logo_path
    from profiles
    where id = ${ownerId}::uuid and role = 'owner'
  `)
  const row = result.rows[0]
  if (!row) return null
  return {
    businessName: (row.business_name as string | null) ?? null,
    slug: (row.slug as string | null) ?? null,
    logoPath: (row.business_logo_path as string | null) ?? null,
  }
}

export async function updateBusinessName(input: {
  ownerId: string
  businessName: string
}): Promise<SettingsResult> {
  // Trimmed BEFORE measuring, so a name that fits is not refused for its
  // trailing spaces, and checked before any SQL: the column is plain `text`
  // with no constraint, so nothing below this line would refuse an empty name
  // — and an owner with a blank business name disappears from their own brand
  // page, which falls back to the slug.
  const businessName = input.businessName.trim()
  if (businessName.length === 0) return { ok: false, reason: 'empty_name' }
  if (businessName.length > MAX_BUSINESS_NAME_LENGTH) return { ok: false, reason: 'name_too_long' }

  const result = await db.execute(sql`
    update profiles set business_name = ${businessName}
    where id = ${input.ownerId}::uuid and role = 'owner'
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'not_an_owner' }
}

/**
 * Swaps `business_logo_path` and reports what was there before, in one
 * transaction.
 *
 * `for update` on the read is what makes the previous path trustworthy rather
 * than merely likely: two uploads racing would otherwise both read the same
 * previous path and both try to delete it, and the loser would delete the
 * object the winner's row now points at. Same lock discipline as
 * approveCourt/replaceRateBands.
 */
async function swapLogoPath(
  ownerId: string,
  nextPath: string | null,
): Promise<{ ok: true; previousPath: string | null } | { ok: false; reason: 'not_an_owner' }> {
  return db.transaction(
    async (tx) => {
      const current = await tx.execute(sql`
        select business_logo_path from profiles
        where id = ${ownerId}::uuid and role = 'owner'
        for update
      `)
      if (current.rows.length === 0) return { ok: false as const, reason: 'not_an_owner' as const }
      const previousPath = (current.rows[0].business_logo_path as string | null) ?? null

      await tx.execute(sql`
        update profiles set business_logo_path = ${nextPath}
        where id = ${ownerId}::uuid and role = 'owner'
      `)
      return { ok: true as const, previousPath }
    },
    { isolationLevel: 'read committed' },
  )
}

export async function updateBusinessLogo(input: {
  ownerId: string
  file: File
  storage: StorageClient
}): Promise<SettingsResult> {
  const { ownerId, file, storage } = input

  // The same three server-side rules that govern every other upload in this
  // app, imported from the pure module rather than restated. The file input's
  // `accept` attribute is a browser hint a hand-crafted POST ignores; this is
  // the real check.
  if (file.size === 0) return { ok: false, reason: 'no_file' }
  if (!(ALLOWED_PHOTO_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, reason: 'bad_type' }
  }
  if (file.size > MAX_PHOTO_BYTES) return { ok: false, reason: 'too_large' }

  const storagePath = `logos/${ownerId}/${crypto.randomUUID()}.${PHOTO_EXTENSIONS[file.type]}`
  const bytes = new Uint8Array(await file.arrayBuffer())

  // OBJECT FIRST. A row pointing at an object that does not exist is a broken
  // logo on the owner's own public brand page; an object with no row is
  // invisible. Of the two, only the first is visible to a player.
  const uploaded = await storage.upload(LOGO_BUCKET, storagePath, bytes, file.type)
  if (uploaded.error !== null) return { ok: false, reason: 'upload_failed' }

  const swapped = await swapLogoPath(ownerId, storagePath)
  if (!swapped.ok) {
    // The object went up before the row was checked, so a refusal reclaims it
    // — the same cleanup addPhoto does when its target has vanished.
    await storage.remove(LOGO_BUCKET, [storagePath])
    return { ok: false, reason: swapped.reason }
  }

  // BEST EFFORT, and deliberately AFTER the path update has committed: a
  // dangling old object costs storage, while removing it first and then
  // failing to write the row would leave the owner's brand page pointing at
  // nothing. The error is swallowed for the same reason — the save succeeded,
  // and there is nothing the owner could do about a storage hiccup.
  if (swapped.previousPath !== null && swapped.previousPath !== storagePath) {
    await storage.remove(LOGO_BUCKET, [swapped.previousPath])
  }
  return { ok: true }
}

export async function removeBusinessLogo(input: {
  ownerId: string
  storage: StorageClient
}): Promise<SettingsResult> {
  const { ownerId, storage } = input

  // ROW FIRST here — the opposite order from the upload, and for the same
  // reason: the state worth avoiding is a row pointing at an object that is
  // already gone, so the row stops pointing at it first.
  const swapped = await swapLogoPath(ownerId, null)
  if (!swapped.ok) return { ok: false, reason: swapped.reason }

  // Nothing to reclaim when there was no logo — a double-submit is a no-op,
  // not a failure the owner has to interpret.
  if (swapped.previousPath !== null) {
    await storage.remove(LOGO_BUCKET, [swapped.previousPath])
  }
  return { ok: true }
}
```

- [ ] **Step 5: Watch it pass, twice**

```bash
npx vitest run tests/owner/settings.test.ts
npx vitest run tests/owner/settings.test.ts
```

Expected: green both times. If a run times out on the pooler rather than failing an assertion, re-run that file alone before investigating.

- [ ] **Step 6: Prove nothing else moved**

```bash
npx vitest run tests/staff tests/owner
```

Expected: green. `tests/staff/write.test.ts` is the file that would notice if exporting the constant had changed its value.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors; lint reports only the pre-existing warnings.

```bash
git add src/lib/owner/settings.ts src/lib/staff/write.ts tests/owner/settings.test.ts
git commit -m "Add the owner settings reads and writes, reusing the photo machinery for the logo"
```

---

### Task 4: `/dashboard/settings`, its actions, its sidebar item, and the brand page that finally shows the logo

**Files:**
- Create: `src/app/dashboard/settings/actions.ts`
- Create: `src/app/dashboard/settings/settings-forms.tsx`
- Create: `src/app/dashboard/settings/page.tsx`
- Modify: `src/app/dashboard/layout.tsx`
- Modify: `src/app/owners/[slug]/page.tsx`

**Interfaces:**
- Produces, from `src/app/dashboard/settings/actions.ts` (`'use server'` — these five exports and nothing else):

```ts
export type SettingsFormState = { ok: true; message: string } | { error: string } | null

export async function updateBusinessNameAction(
  _prevState: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState>

export async function updateBusinessLogoAction(
  _prevState: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState>

export async function removeBusinessLogoAction(
  _prevState: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState>
```
- Produces, from `src/app/dashboard/settings/settings-forms.tsx` (`'use client'`):

```ts
// Both are React function components; neither annotates a return type, matching
// every other component file in this project.
export function BusinessNameForm(props: { businessName: string | null; maxLength: number })
export function LogoForm(props: { logoUrl: string | null })
```
- Consumes: `requireDashboardPage`; `redirect`; `requireOwner` / `AuthError` from `@/lib/auth/guards`; `serviceRoleStorage` from `@/lib/listings/storage`; `getOwnerSettings` / `LOGO_BUCKET` / `updateBusinessName` / `updateBusinessLogo` / `removeBusinessLogo` / `type SettingsFailure` from `@/lib/owner/settings`; `MAX_BUSINESS_NAME_LENGTH` from `@/lib/staff/write`; `photoUrl` / `ALLOWED_PHOTO_TYPES` from `@/lib/photos`; the control classes and `FormMessage` from `@/app/dashboard/listings/form-ui`.

**Five things to get right here:**

1. **The gate is inline, not `requireOwnerPage`.** The page resolves `requireDashboardPage('/dashboard/settings')` like its siblings and then `if (!access.isOwner) redirect('/dashboard')`. `requireOwnerPage` would send a staff member to `/bookings` — bouncing them out of the dashboard entirely for opening a page they merely cannot use. `/dashboard` is where they belong.

2. **The owner id comes from the guard's return value, never from the form.** Every action does `const user = await requireOwner()` and passes `user.id`. There is no `ownerId` form field anywhere in this task; if you find yourself adding one, stop.

3. **`SettingsFormState` is structurally identical to `ListingFormState`,** so `FormMessage` from `src/app/dashboard/listings/form-ui.tsx` renders it as-is. That is deliberate reuse of one `role="alert"` / `role="status"` renderer, not a coincidence to be tidied away by writing a second one.

4. **Exactly one lime button on the page.** Save (business name) is `LIME_BUTTON`; Upload is `DARK_BUTTON`; Remove logo is `BORDERED_BUTTON`. branding.md: never two lime buttons in one view.

5. **`getOwnerSettings` returning null is a real state, not a defensive branch.** `requireOwner` admits admins; an admin has no owner profile. The page says so in one sentence instead of rendering a form whose every submission would come back `not_an_owner`.

- [ ] **Step 1: The actions**

Create `src/app/dashboard/settings/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { AuthError, requireOwner } from '@/lib/auth/guards'
import { serviceRoleStorage } from '@/lib/listings/storage'
import {
  removeBusinessLogo,
  updateBusinessLogo,
  updateBusinessName,
  type SettingsFailure,
} from '@/lib/owner/settings'

/**
 * /dashboard/settings.
 *
 * This file exports nothing but three async guarded actions and the
 * `SettingsFormState` type its forms bind to — every OTHER export of a
 * 'use server' file becomes a client-invokable endpoint. All validation and
 * all SQL live in src/lib/owner/settings.ts, where they are unit-tested.
 *
 * ONE guard shape: requireOwner, with the owner id taken from ITS RETURN
 * VALUE. No action here reads an id from the form, so there is nothing for a
 * forged submission to point at. requireOwner also admits admins (see its doc
 * comment); the library's `role = 'owner'` scoping is what turns that into a
 * friendly refusal rather than an admin quietly acquiring a business identity.
 *
 * Every action takes useActionState's (prevState, formData) shape. The
 * previous state is unused — each submission is judged on its own input — but
 * the parameter must exist for React to bind the action to the form's state.
 */
export type SettingsFormState = { ok: true; message: string } | { error: string } | null

const NOT_AN_OWNER_ACTION = 'Only court owners can change these settings.'

const SETTINGS_MESSAGES: Record<SettingsFailure, string> = {
  not_an_owner: "Your account isn't a court-owner account, so there's nothing to save here.",
  empty_name: 'Your business name can’t be blank.',
  name_too_long: 'That business name is too long — shorten it and try again.',
  no_file: 'Choose an image first.',
  bad_type: 'Logos must be JPEG, PNG or WebP.',
  too_large: 'That image is over 5 MB — use a smaller one.',
  upload_failed: "That upload didn't go through. Try again.",
}

/**
 * A name or logo change is brand identity: it shows on the owner's public
 * brand page and in the "Hosted by" strip on every one of their branch pages,
 * as well as in the dashboard's own sidebar chip. All four go.
 *
 * 'layout' on the two public route groups, matching how the listings actions
 * already revalidate /venues — both are dynamic segments with no static index
 * to name individually.
 */
function revalidateBrand(): void {
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard')
  revalidatePath('/owners', 'layout')
  revalidatePath('/venues', 'layout')
}

export async function updateBusinessNameAction(
  _prevState: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  let user
  try {
    user = await requireOwner()
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_AN_OWNER_ACTION }
    throw error
  }

  const result = await updateBusinessName({
    ownerId: user.id,
    businessName: String(formData.get('businessName') ?? ''),
  })
  if (!result.ok) return { error: SETTINGS_MESSAGES[result.reason] }

  revalidateBrand()
  return { ok: true, message: 'Business name saved.' }
}

export async function updateBusinessLogoAction(
  _prevState: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  let user
  try {
    user = await requireOwner()
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_AN_OWNER_ACTION }
    throw error
  }

  // An <input type="file"> with nothing chosen still submits a zero-byte
  // entry, so this only has to catch a submission with no field at all.
  const file = formData.get('logo')
  if (!(file instanceof File)) return { error: SETTINGS_MESSAGES.no_file }

  const result = await updateBusinessLogo({
    ownerId: user.id,
    file,
    storage: serviceRoleStorage(),
  })
  if (!result.ok) return { error: SETTINGS_MESSAGES[result.reason] }

  revalidateBrand()
  return { ok: true, message: 'Logo saved.' }
}

export async function removeBusinessLogoAction(
  _prevState: SettingsFormState,
  _formData: FormData,
): Promise<SettingsFormState> {
  let user
  try {
    user = await requireOwner()
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_AN_OWNER_ACTION }
    throw error
  }

  const result = await removeBusinessLogo({ ownerId: user.id, storage: serviceRoleStorage() })
  if (!result.ok) return { error: SETTINGS_MESSAGES[result.reason] }

  revalidateBrand()
  return { ok: true, message: 'Logo removed.' }
}
```

- [ ] **Step 2: The forms**

Create `src/app/dashboard/settings/settings-forms.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import {
  removeBusinessLogoAction,
  updateBusinessLogoAction,
  updateBusinessNameAction,
  type SettingsFormState,
} from './actions'
import {
  BORDERED_BUTTON,
  DARK_BUTTON,
  FIELD,
  FormMessage,
  LABEL,
  LIME_BUTTON,
} from '@/app/dashboard/listings/form-ui'
// The PURE photo module, never src/lib/owner/settings.ts or
// src/lib/listings/photos.ts — those are `server-only` and importing either
// here would throw the moment this component reached the client bundle.
import { ALLOWED_PHOTO_TYPES } from '@/lib/photos'

/**
 * The two settings forms.
 *
 * FormMessage is imported from the listings form-ui module rather than
 * re-implemented: SettingsFormState is structurally identical to
 * ListingFormState, and that module is a route-agnostic set of class strings
 * plus one renderer despite where it lives.
 *
 * branding.md, "never two lime buttons in one view": Save is the page's single
 * lime primary; the logo controls use the dark alternative primary and the
 * bordered secondary. FOCUS_RING is baked into every one of those class
 * constants, which is why none of them is concatenated with it here.
 */
export function BusinessNameForm({
  businessName,
  maxLength,
}: {
  businessName: string | null
  maxLength: number
}) {
  const [state, action, pending] = useActionState<SettingsFormState, FormData>(
    updateBusinessNameAction,
    null,
  )

  return (
    <form action={action} className="flex flex-col gap-3">
      <div>
        <label className={LABEL} htmlFor="businessName">
          Business name
        </label>
        <input
          id="businessName"
          name="businessName"
          type="text"
          required
          maxLength={maxLength}
          defaultValue={businessName ?? ''}
          placeholder="Smash Zone Marikina"
          className={FIELD}
        />
      </div>
      <div>
        <button type="submit" disabled={pending} className={LIME_BUTTON}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <FormMessage state={state} />
    </form>
  )
}

export function LogoForm({ logoUrl }: { logoUrl: string | null }) {
  const [uploadState, uploadAction, uploadPending] = useActionState<SettingsFormState, FormData>(
    updateBusinessLogoAction,
    null,
  )
  const [removeState, removeAction, removePending] = useActionState<SettingsFormState, FormData>(
    removeBusinessLogoAction,
    null,
  )

  return (
    <div className="flex flex-col gap-4">
      {logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- the bucket is
        // public and this is an already-sized upload; next/image would add a
        // loader round trip for a dashboard thumbnail.
        <img
          src={logoUrl}
          alt="Your current logo"
          className="h-[72px] w-[72px] rounded-full border border-[var(--hairline)] object-cover"
        />
      )}

      <form action={uploadAction} className="flex flex-col gap-3">
        <div>
          <label className={LABEL} htmlFor="logo">
            {logoUrl ? 'Replace logo' : 'Upload logo'}
          </label>
          <input
            id="logo"
            name="logo"
            type="file"
            // A browser hint only — the server checks the type and the size
            // again, because a hand-crafted POST ignores this attribute.
            accept={ALLOWED_PHOTO_TYPES.join(',')}
            // `py-1.5` on top of FIELD, exactly as photo-forms.tsx does it:
            // FIELD's fixed --btn-h-sm height crops a file input's own
            // "Choose file" button in Chrome without it.
            className={`${FIELD} py-1.5`}
          />
          <p className="mt-1 text-[12px] text-[var(--ink-soft)]">JPEG, PNG or WebP, up to 5 MB.</p>
        </div>
        <div>
          <button type="submit" disabled={uploadPending} className={DARK_BUTTON}>
            {uploadPending ? 'Uploading…' : 'Upload'}
          </button>
        </div>
        <FormMessage state={uploadState} />
      </form>

      {logoUrl && (
        <form action={removeAction}>
          <button type="submit" disabled={removePending} className={BORDERED_BUTTON}>
            {removePending ? 'Removing…' : 'Remove logo'}
          </button>
          <FormMessage state={removeState} />
        </form>
      )}
    </div>
  )
}
```

- [ ] **Step 3: The page**

Create `src/app/dashboard/settings/page.tsx`:

```tsx
import { redirect } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { getOwnerSettings, LOGO_BUCKET } from '@/lib/owner/settings'
import { MAX_BUSINESS_NAME_LENGTH } from '@/lib/staff/write'
import { photoUrl } from '@/lib/photos'
import { BusinessNameForm, LogoForm } from './settings-forms'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)]'

const NOTICE =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

/**
 * Brand identity: business name, logo, and the slug the team controls.
 *
 * OWNER-ONLY, gated inline rather than by requireOwnerPage. The sibling pages
 * all resolve requireDashboardPage and then narrow; requireOwnerPage's 403
 * target is /bookings, and bouncing a staff member out of the dashboard
 * entirely for opening a page they merely cannot use is the wrong answer.
 * /dashboard is where they belong. The sidebar hides the item for them
 * (`show: access.isOwner`), and every action re-asserts requireOwner.
 *
 * Staff never see this page at all: there is no branch-scoped permission that
 * opens it, because a business name is not branch-shaped.
 */
export default async function SettingsPage() {
  const access = await requireDashboardPage('/dashboard/settings')
  if (!access.isOwner) redirect('/dashboard')

  // Null for an ADMIN, who passes access.isOwner (it is the same
  // `role === 'owner' || role === 'admin'` predicate requireOwner uses) but
  // has no business identity. Saying so beats rendering a form whose every
  // submission would come back not_an_owner.
  const settings = await getOwnerSettings(access.user.id)

  return (
    <>
      <header className="mb-8">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Settings
        </h1>
        <p className="mt-2 max-w-[560px] text-[15px] text-[var(--ink-soft)]">
          How your business appears to players across OnCourt.
        </p>
      </header>

      {settings === null ? (
        <p className={NOTICE}>
          Your account isn&rsquo;t a court-owner account, so there&rsquo;s nothing to set up here.
        </p>
      ) : (
        <div className="flex max-w-[560px] flex-col gap-5">
          <section aria-labelledby="business-name-heading" className={CARD}>
            <h2
              id="business-name-heading"
              className="font-display mb-1 text-[15px] font-bold tracking-[-0.01em] text-[var(--ink)]"
            >
              Business name
            </h2>
            <p className="mb-4 text-[13px] text-[var(--ink-soft)]">
              Shown on your brand page and on every branch you list.
            </p>
            <BusinessNameForm
              businessName={settings.businessName}
              maxLength={MAX_BUSINESS_NAME_LENGTH}
            />
          </section>

          <section aria-labelledby="logo-heading" className={CARD}>
            <h2
              id="logo-heading"
              className="font-display mb-1 text-[15px] font-bold tracking-[-0.01em] text-[var(--ink)]"
            >
              Logo
            </h2>
            <p className="mb-4 text-[13px] text-[var(--ink-soft)]">
              A square image works best. Without one, players see the first letter of your business
              name.
            </p>
            <LogoForm logoUrl={photoUrl(LOGO_BUCKET, settings.logoPath)} />
          </section>

          <section aria-labelledby="brand-link-heading" className={CARD}>
            <h2
              id="brand-link-heading"
              className="font-display mb-1 text-[15px] font-bold tracking-[-0.01em] text-[var(--ink)]"
            >
              Brand link
            </h2>
            {/* READ-ONLY, deliberately. The slug is in every public URL that
                points at this owner; changing it would break links players
                already have, so it stays an admin decision. Rendered as text,
                not a disabled input — a disabled field invites a fight with it. */}
            <p className="font-mono text-[13px] break-all text-[var(--ink)]">
              {settings.slug ? `/owners/${settings.slug}` : '—'}
            </p>
            <p className="mt-2 text-[13px] text-[var(--ink-soft)]">
              Your brand link is set by our team — contact us to change it.
            </p>
          </section>
        </div>
      )}
    </>
  )
}
```

Note the em dash on the null-slug line is a literal `—`, and the sentence under it is the spec's wording verbatim in both cases — a null slug changes only what sits above it.

- [ ] **Step 4: The sidebar item**

In `src/app/dashboard/layout.tsx`, replace the comment Task 2 left:

```tsx
  // Settings is added alongside its own page in the next task of this slice —
  // a nav item pointing at a 404 is worse than no item.
```

with:

```tsx
  // Settings is owner-only: brand identity is not branch-shaped, so there is
  // no staff permission that opens it. The page re-asserts this inline and
  // every settings action re-asserts requireOwner.
```

then replace these two lines at the end of the array:

```tsx
    { href: '/dashboard/staff', label: 'Staff', show: access.isOwner },
  ].filter((item) => item.show)
```

with these three, putting Settings LAST as the mockup does:

```tsx
    { href: '/dashboard/staff', label: 'Staff', show: access.isOwner },
    { href: '/dashboard/settings', label: 'Settings', show: access.isOwner },
  ].filter((item) => item.show)
```

- [ ] **Step 5: Make the brand page show the logo**

This is spec correction (A) from the top of this plan: the spec says `/owners/[slug]` already renders `business_logo_path`, and it does not — it renders an initial-letter badge behind a comment claiming no bucket exists for logos. One now does (`LOGO_BUCKET`), so this makes the claim true. `getOwnerProfile` already returns `logoPath`; **no query changes.**

In `src/app/owners/[slug]/page.tsx`, add to the imports:

```tsx
import { photoUrl } from '@/lib/photos'
import { LOGO_BUCKET } from '@/lib/owner/settings'
```

Replace this comment block:

```tsx
// Logo: `profile.logoPath` can never resolve to a URL — no Storage bucket
// was ever provisioned for owner logos (`PhotoBucket` in src/lib/photos.ts
// only allows 'branch-photos' | 'court-photos'), a gap logged as a
// follow-up needing a migration. Rather than invent a bucket name (which
// would 404) or call photoUrl() with a wrong bucket, this renders the same
// initial-letter fallback badge as the branch page's owner strip
// (src/app/venues/[slug]/page.tsx), so the two pages agree.
```

with:

```tsx
// Logo: owners can now upload one at /dashboard/settings, which stores it in
// the EXISTING `branch-photos` bucket under `logos/<ownerId>/` — see
// LOGO_BUCKET in src/lib/owner/settings.ts for why that bucket and why no
// migration was needed. An earlier version of this comment said no bucket
// existed for owner logos and that a migration was required; that was the
// state of the tree, not a constraint. The initial-letter badge stays as the
// fallback for the many owners who have not uploaded one.
```

Then, inside the component, after `const branchCountLabel = ...`, add:

```tsx
  const logoUrl = photoUrl(LOGO_BUCKET, profile.logoPath)
```

and replace the badge span:

```tsx
            <span
              aria-hidden
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-[var(--hairline)] bg-[var(--court)] text-2xl font-semibold text-white"
            >
              {displayName.charAt(0).toUpperCase()}
            </span>
```

with:

```tsx
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- the
              // bucket is public and this is an already-sized upload; the same
              // call this page's dashboard counterpart makes.
              <img
                src={logoUrl}
                alt={`${displayName} logo`}
                className="h-16 w-16 shrink-0 rounded-full border border-[var(--hairline)] object-cover"
              />
            ) : (
              <span
                aria-hidden
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-[var(--hairline)] bg-[var(--court)] text-2xl font-semibold text-white"
              >
                {displayName.charAt(0).toUpperCase()}
              </span>
            )}
```

**Do not touch `src/app/venues/[slug]/page.tsx`.** Its owner strip carries the same now-stale comment, but it is already modified by other in-flight work in this tree and the spec scopes the public change to the brand page. It is flagged in this plan's header as a follow-up for the controller.

- [ ] **Step 6: Prove the action file is genuinely guarded**

```bash
npx vitest run tests/auth/action-coverage.test.ts
```

Expected: green, with **no edit to that file**. `GUARDS` already contains `requireOwner` (verified fact 3 at the top of this plan), and the new `'use server'` file uses it three times. If this fails, the actions file lost its guard — fix the actions, never the `GUARDS` list.

- [ ] **Step 7: Typecheck, lint, build**

```bash
npx tsc --noEmit && npm run lint && npm run build
```

Expected: no type errors; lint reports only the pre-existing warnings (the two new `<img>` elements each carry their own inline disable, so neither adds one); the build succeeds and its route list now includes `/dashboard/settings`.

- [ ] **Step 8: Confirm the suite is still green, twice**

```bash
npm test
npm test
```

Expected: green both times. If one of the documented pooler-flake files times out, re-run that file alone before treating it as a regression.

- [ ] **Step 9: Commit**

```bash
git add src/app/dashboard/settings/actions.ts src/app/dashboard/settings/settings-forms.tsx src/app/dashboard/settings/page.tsx src/app/dashboard/layout.tsx "src/app/owners/[slug]/page.tsx"
git commit -m "Add the owner settings page, its actions, and the brand page logo it feeds"
```

---

### Task 5: Manual verification

**Files:** none. This task changes nothing; it is the browser pass every earlier task deliberately excluded, collected in one place so implementation tasks stay verifiable by tests alone.

**Interfaces:** none.

Everything below needs a running dev server and real signed-in accounts, so none of it can be asserted by the suite. Work through it in order; each line is a claim the automated tests cannot make.

- [ ] **Step 1: Have the three accounts you need**

An **owner** with at least one branch and one approved court, a **staff member** with `view_bookings` on that branch (grant it at `/dashboard/staff` as the owner), and a **player**. If you do not have an owner handy, promote a test account at `/admin/owners`.

- [ ] **Step 2: Get at least two reviews onto the owner's courts**

The honest path: as the player, book and pay for a slot, let it complete (`complete_past_bookings` runs every five minutes on past bookings), then leave a review from `/bookings`. The fast path, against a **test** account only — never a seeded singleton:

```bash
psql "$DATABASE_URL" -c "insert into reviews (booking_id, branch_id, player_id, rating, body) select id, branch_id, player_id, 5, 'Great courts, easy parking.' from bookings where id = '<a completed booking id on that branch>'"
```

Expected: `INSERT 0 1`. Add a second one with `body` left null, so the null-body rendering can be checked.

- [ ] **Step 3: Start the dev server**

```bash
npm run dev
```

Expected: `Local: http://localhost:3000`. Leave it running for the rest of this task.

- [ ] **Step 4: The reviews page**

- [ ] Signed in as the **owner**, the dashboard sidebar shows **Reviews** between Earnings and Staff, and **Settings** last. Open Reviews.
- [ ] Each card shows the court name, then "&lt;branch&gt; · &lt;player&gt;", the date on the right as `Fri, Aug 1`, and the lime-dot rating with a bold number like `5.0`.
- [ ] The review you left with a **null body** renders no paragraph at all — no empty quote, no dash, no extra gap under the header row.
- [ ] The player's name is their full name if their Google profile has one, otherwise the part of their email before the `@` — **never a full email address**.
- [ ] Newest first.
- [ ] With **two or more** branches in scope, the branch filter appears; pick one and the list narrows, the URL becomes `/dashboard/reviews?branch=<uuid>`, and reloading that URL keeps the filter. With only one branch, no filter renders at all.
- [ ] Hand-edit the URL to `?branch=` a **nonsense value** and to another owner's real branch uuid: in both cases the filter is ignored and the unfiltered list comes back — never an error, never someone else's reviews.
- [ ] Filter to a branch with no reviews: the empty state names that branch. Remove the filter on an owner with no reviews anywhere: the empty state is the general one.
- [ ] Tab through the page: the select and the Filter button both show the green focus ring.

- [ ] **Step 5: Reviews access**

- [ ] Signed in as the **staff member with `view_bookings`**: Reviews is in their sidebar, and it shows only that branch's reviews. **Settings is absent.**
- [ ] As the owner, revoke that staff member's `view_bookings` (leave them another permission so the grant survives), then as the staff member open `/dashboard/reviews` directly: the browser lands on `/dashboard`.
- [ ] Signed in as a **player**, open `/dashboard/reviews` directly: the browser lands on `/bookings` (`requireDashboardPage` turns them away before the page runs). Signed out, it lands on `/login?next=%2Fdashboard%2Freviews`, and signing in as the owner returns to the page.

- [ ] **Step 6: Settings access**

- [ ] Signed in as the **staff member**, open `/dashboard/settings` directly: the browser lands on `/dashboard`, **not** `/bookings`.
- [ ] Signed in as an **admin** who is not an owner: Settings is in the sidebar (they pass `isOwner`), and the page renders only "Your account isn't a court-owner account, so there's nothing to set up here." — no forms.
- [ ] Signed out, `/dashboard/settings` lands on `/login?next=%2Fdashboard%2Fsettings`.

- [ ] **Step 7: Business name**

- [ ] As the owner, change the name and Save: the message reads "Business name saved.", the sidebar chip at the bottom of the dashboard updates, and `/owners/<slug>` and the "Hosted by" strip on `/venues/<branch-slug>` both show the new name without a hard refresh being needed.
- [ ] Submit it blank (remove the `required` attribute in devtools, or type only spaces): "Your business name can’t be blank." and nothing changed.
- [ ] Paste something longer than 120 characters (remove `maxLength` in devtools first): "That business name is too long — shorten it and try again."
- [ ] Exactly one lime button is visible anywhere on this page.

- [ ] **Step 8: Logo**

- [ ] Upload a square JPEG: the message reads "Logo saved.", the round preview appears above the field, the field's label becomes **Replace logo**, and a **Remove logo** button appears.
- [ ] Open `/owners/<slug>`: the logo replaces the initial-letter badge in the header. Check an owner who has **not** uploaded one — the badge is still there.
- [ ] Upload a **replacement**: the preview and the brand page both change. Then open the Supabase Storage browser at bucket `branch-photos`, prefix `logos/<ownerId>/`: only the current object is there — the replaced one was cleaned up.
- [ ] Try a `.gif` and a `.pdf` (clear the `accept` filter in the file dialog): "Logos must be JPEG, PNG or WebP." Try an image over 5 MB: "That image is over 5 MB — use a smaller one." Press Upload with **no file chosen**: "Choose an image first."
- [ ] Press **Remove logo**: "Logo removed.", the preview and the Remove button disappear, the brand page falls back to the initial-letter badge, and the object is gone from `logos/<ownerId>/`.
- [ ] Tab through the page: the text field, both file/submit controls and Remove logo all show the green focus ring.

- [ ] **Step 9: Brand link**

- [ ] The Brand link card shows `/owners/<slug>` in mono and the line "Your brand link is set by our team — contact us to change it." There is no input, no button, and nothing editable.
- [ ] Null-slug case — against a **test** owner only:

```bash
psql "$DATABASE_URL" -c "update profiles set slug = null where id = '<test owner id>'"
```

  Reload Settings: the mono line is a single em dash `—`, the sentence under it is unchanged, and the page does not error. Put the slug back afterwards.

- [ ] **Step 10: Responsive and reduced motion**

- [ ] At 980px: the dashboard sidebar becomes the horizontal strip and both new items are reachable in it without the page scrolling sideways.
- [ ] At 560px: the review cards' header row stacks rather than crushing the date, the settings cards stay within the column, and neither page scrolls sideways.
- [ ] With "Reduce motion" enabled in the OS, nothing on either page animates.

- [ ] **Step 11: Stop the dev server**

Press `Ctrl-C` in the terminal running `npm run dev`.

- [ ] **Step 12: Final full verification**

```bash
npx tsc --noEmit && npm run lint && npm run build && npm test && npm test
```

Expected: no type errors; lint reports only the pre-existing warnings; the build succeeds; the whole suite passes **twice in a row** — the second run is what proves this slice's new DB tests are repeat-safe against the shared, persistent database, and in particular that the 101 bookings and reviews the cap test seeds are fully torn down.

