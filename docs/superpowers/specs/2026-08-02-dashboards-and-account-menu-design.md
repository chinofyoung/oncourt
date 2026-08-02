# Dashboards & Account Menu — Design

**Date:** 2026-08-02
**Status:** approved, ready for implementation planning
**Parent spec:** `docs/superpowers/specs/2026-07-31-pickleball-court-booking-platform-design.md`

## Problem

A signed-in user has nowhere to go. The nav's avatar is a bare `<span>`/`<img>` badge
(`src/components/site/nav.tsx`) — not a link, no menu — and there is no sign-out control
anywhere in the app. `/auth/callback` defaults `next` to `/`, and nothing passes a `next`,
so every sign-in lands on the marketing home page. None of the parent spec's authenticated
pages exist: `/bookings` (player), `/dashboard/*` (owner), `/admin/*`.

This slice builds the account menu and both dashboards, read-only over tables that already
exist, plus the one write path the schema explicitly assigns here (leaving a review).

## Scope

### In

1. **Account menu** — `AccountMenu` client dropdown replacing the dead avatar badge.
   Items: My bookings (all roles), Owner dashboard (`owner` | `admin`), Sign out.
2. **Sign-out** — Server Action, so cookie clearing happens server-side.
3. **`?next=` threading** — `/login?next=…` → `/auth/callback?next=…` → intended page.
4. **`/bookings`** — player dashboard. Stats row, tabs (upcoming / past / reviews),
   upcoming cards, past table, reviews list, profile rail.
5. **`/bookings/[id]`** — receipt detail.
6. **Leave a review** — Server Action from the past-bookings tab.
7. **`/dashboard`** — owner overview: stats, today's grid, pending-approval list,
   recent activity.
8. **`/dashboard/bookings`** — day navigator + branch filter.
9. **`/dashboard/earnings`** — gross / platform fee / net, per branch and rolled up, by month.
10. **Demo data** — idempotent upcoming bookings in `supabase/seed.sql`, plus
    `scripts/grant-demo-data.ts` to attach demo data to a real signed-in account.
11. **Doc correction** — `docs/foundation-review-notes.md` open item 2 and row 5 both state
    Google OAuth is unconfigured. It is configured (verified 2026-08-02, see Verification).

### Out, and why

- **Branch & court CRUD** — forms, validation, photo upload, approval re-submission. The
  single largest piece of the owner dashboard and its own slice. The sidebar renders only
  implemented sections, so there are no dead links.
- **Owner settings, owner reviews page** — no reader value not already covered by Overview.
- **`/admin/*`** — the whole admin panel is a separate slice. **The Admin menu item is
  omitted too**: an item pointing at a 404 is worse than no item.
- **Editing a review** — the mockup has an "Edit review" link. Creating is the valuable
  path; editing needs an update action plus an edit window policy nobody has decided.
- **Payouts** — the owner mockup's Payouts panel (next payout + history) has **no backing
  table**. The `payout_status` enum exists; no `payouts` table does. Displaying payouts is
  meaningless before payout *generation* exists, which is a separate concern.

## Data model — reads only, no migration

Every table this slice needs already exists. No migration.

| Need | Source |
|---|---|
| Player bookings, amounts, fees | `bookings` (`court_fee_centavos`, `transaction_fee_centavos`, `total_charged_centavos`, `platform_fee_centavos`, `owner_net_centavos`, `status`, `starts_at`, `ends_at`) |
| Court / branch labels | `courts` (`name`, `environment`), `branches` (`name`, `address`, `city`, `slug`) |
| Owner scoping | `branches.owner_id` |
| Pending approval queue | `courts.status = 'pending'` |
| Reviews | `reviews` (`booking_id` unique, `rating`, `body`, `created_at`) |
| Profile rail | `profiles` (`full_name`, `email`, `avatar_url`, `phone`, `business_name`) |
| Occupancy denominator | `court_operating_hours` (`opens_hour`, `closes_hour`, `day_of_week`) |

`bookings.status` values in play: `confirmed` and `completed` count as real bookings;
`pending_payment` is an unpaid hold and must not appear as a booking on either dashboard;
`expired` and `refunded_manual` are excluded from earnings.

## Architecture

### Authorization

- Add role-level **`requireOwner()`** to `src/lib/auth/guards.ts` — passes for `owner` and
  `admin`, throws `AuthError(403)` otherwise. The existing `requireOwnerOf(branchId)` is
  per-branch and stays; this is the page-level gate for "is this person an owner at all".
- Pages need **redirect** semantics, not the thrown `AuthError` that suits Server Actions.
  Add `requireUserPage(next)` / `requireOwnerPage(next)`, which redirect to
  `/login?next=<path>` instead of throwing.
- Owner queries filter on `owner_id` **in SQL**, never in TypeScript after the fact. An
  admin viewing `/dashboard` sees only branches they own — admin oversight belongs to
  `/admin/*`, not to a widened owner query.

### Sign-out and the action-coverage test

`tests/auth/action-coverage.test.ts` asserts every `'use server'` file mentions
`requireUser` / `requireAdmin` / `requireOwnerOf`. The sign-out action calls
`requireUser()` and catches `AuthError` by redirecting home anyway, so a user whose session
already expired can still clear a stale cookie rather than being stuck signed-in-but-not.
That is honest compliance, not a workaround.

If a later slice adds Server Actions guarded only by the new `requireOwner()`, that test's
`GUARDS` array must gain `requireOwner` or it will report a false positive. This slice adds
no such action: the owner pages are reads, and its two new actions — sign-out and review
creation — are both guarded by `requireUser`.

### Login page split

`src/app/login/page.tsx` is currently `'use client'` end to end. Reading `searchParams.next`
there would need `useSearchParams()` plus a Suspense boundary. Split instead:

- `login/page.tsx` — Server Component. Reads `searchParams.next`, renders the split layout.
- `login/sign-in-button.tsx` — Client Component. Takes `next` as a prop, owns the
  `pending`/`error` state and the `signInWithOAuth` call.

This also shrinks the client bundle: the photo panel, headings, and copy stop shipping as
client JS.

`next` must stay a same-origin path. `/auth/callback` already enforces a leading `/`
(`route.ts:18`); the login page applies the same check before forwarding, so a crafted
`?next=https://evil.com` is dropped at both ends.

### Components

- **`AccountMenu`** (client) — receives a serializable `user` prop from the server `Nav`.
  Owns open/close, Escape to close, click-outside, focus return to trigger, `aria-expanded`
  / `aria-controls`. Roving focus with arrow keys is out; a short menu of links does not
  need it, and Tab already works.
- **`OwnerDayGrid`** (server) — **new**, deliberately not a reuse of
  `src/components/availability-grid.tsx`. The two look alike and mean different things: the
  availability grid shows prices and is clickable to book; this shows player names and is
  not interactive. Overloading one component with both would tangle the booking path with a
  reporting view. Per branding.md, it scrolls horizontally inside its own container with a
  sticky first column; the page never scrolls sideways.
- **Tabs on `/bookings`** — server-rendered via `?tab=upcoming|past|reviews`, not client JS.
  Each tab is a fresh server render, so the data can't go stale behind a hidden panel, and
  tab state survives a reload and is linkable.
- Stat cards, booking cards, past rows, review cards follow the mockups
  (`design/mockups/player-dashboard.html`, `owner-dashboard.html`) and branding.md tokens:
  cards white with `border-radius: 20px` and `--shadow-sm`, mono for times/prices/kickers,
  one lime primary per view, no gradients.

### Query modules

Two new server-only modules, following `src/lib/branches/queries.ts` — `db.execute(sql\`…\`)`,
never the Drizzle query builder, per the project's data-access rule.

**`src/lib/bookings/queries.ts`**
- `getPlayerDashboard(playerId)` → stats (upcoming count, hours played this month, distinct
  courts visited, total spent), upcoming bookings, past bookings with a `has_review` flag,
  the player's reviews.
- `getBookingReceipt(bookingId, playerId)` → one booking with fee breakdown, scoped to the
  player in the `where` clause so another user's id returns no row rather than a 403 after
  the fact.

**`src/lib/owner/queries.ts`**
- `getOwnerOverview(ownerId, day)` → stats, today's grid rows, pending courts, recent activity.
- `getOwnerBookings(ownerId, { day, branchId })` → filtered list.
- `getOwnerEarnings(ownerId, month)` → per-branch and total gross / platform fee / net.

### Time and money

All day boundaries go through `src/lib/date-manila.ts`; "today" means today in Manila, not
in the server's zone. All amounts stay integer centavos end to end and are formatted only
at render, through `src/lib/format.ts`. Occupancy is computed as booked hours over
operating hours from `court_operating_hours` for that weekday — not over a hardcoded
24 or 17 hours.

## Error handling & edge cases

- **Signed out** → redirect to `/login?next=<path>`, so sign-in returns them where they were.
- **Player role hitting `/dashboard`** → `requireOwner` throws 403. Rather than an error
  page, redirect to `/bookings`, which is where that user's dashboard actually is.
- **Owner with zero branches** → Overview renders its empty state (no branches yet) rather
  than zeros that read as "no bookings today".
- **Empty lists** — every list has a designed empty state. With the current seed, the
  populated and empty paths are both reachable, so both get verified.
- **Review already exists** → the unique constraint on `reviews.booking_id` is the
  authority. The action catches `23505` and reports "already reviewed" instead of crashing.
- **Review on an ineligible booking** → eligibility (`status = 'completed'` and
  `player_id = caller`) is enforced in the action's SQL `where`, so a forged `booking_id`
  inserts nothing.
- **Deleted/absent booking on `/bookings/[id]`** → `notFound()`, the same response another
  player's booking id gets. Not-yours and not-real are indistinguishable to the caller by
  design; a distinct 403 would confirm the row exists.

## Testing

Integration tests against the **hosted** Supabase project via `DATABASE_URL` — the DB
constraints are the logic. The database is shared and persistent, so tests must pass on
repeated runs and must not mutate seeded singleton rows: each test creates its own rows
under its own ids and cleans up.

- `getPlayerDashboard` returns only the caller's bookings — a second player's booking is
  absent.
- `pending_payment` holds are excluded from both dashboards.
- `getBookingReceipt` returns no row for a booking belonging to someone else.
- Earnings per-branch figures sum to the rolled-up total, and match the raw
  `owner_net_centavos` / `platform_fee_centavos` sums for the same rows.
- Owner queries return only the caller's branches — a second owner's branch is absent.
- `requireOwner` accepts `owner` and `admin`, rejects `player`.
- Review creation: succeeds once for an eligible completed booking; a second attempt hits
  `23505` and is reported, not thrown; a non-completed or other-player booking inserts nothing.
- `tests/auth/action-coverage.test.ts` keeps passing with the new actions.

## Verification

Google OAuth **is** configured — verified 2026-08-02:

```
curl -s -o /dev/null -D - "https://<ref>.supabase.co/auth/v1/authorize?provider=google&redirect_to=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback"
→ HTTP/1.1 302 Found
   Location: https://accounts.google.com/o/oauth2/v2/auth?client_id=682199069314-…
```

A disabled provider returns `400 Unsupported provider`. `docs/foundation-review-notes.md`
states the opposite and gets corrected in this slice.

Not provable by that probe: whether `http://localhost:3000/auth/callback` is in the
project's redirect allowlist. Supabase validates that at callback time, so a missing entry
surfaces as a failed redirect after account selection — a one-line fix in Supabase's URL
Configuration.

**Sign-in is completed by the user, not by the assistant.** Verification sequence:

1. Signed-out checks, no session needed: `/bookings` and `/dashboard` redirect to
   `/login?next=…`; typecheck; lint; the integration suite.
2. User completes Google sign-in once in the browser pane.
3. `scripts/grant-demo-data.ts --email <user>` — sets the role, reassigns one seeded
   brand's branches to that profile, and creates upcoming bookings for them. Idempotent,
   and keeps the email out of the repo.
4. Signed-in checks: account menu opens, keyboard-closes, and navigates; both dashboards
   render populated and empty states; a receipt renders; a review submits; sign-out clears
   the session and returns the signed-out nav.

Until step 2 happens, the signed-in render is unverified and will be reported as such.

## Files

**New:** `src/components/site/account-menu.tsx`, `src/app/login/sign-in-button.tsx`,
`src/app/bookings/page.tsx`, `src/app/bookings/[id]/page.tsx`,
`src/app/bookings/actions.ts`, `src/app/dashboard/layout.tsx`,
`src/app/dashboard/page.tsx`, `src/app/dashboard/bookings/page.tsx`,
`src/app/dashboard/earnings/page.tsx`, `src/components/dashboard/owner-day-grid.tsx`,
`src/components/dashboard/stat-card.tsx`, `src/lib/bookings/queries.ts`,
`src/lib/owner/queries.ts`, `src/app/auth/sign-out/actions.ts`,
`scripts/grant-demo-data.ts`, tests under `tests/bookings/` and `tests/owner/`.

**Changed:** `src/components/site/nav.tsx` (avatar → `AccountMenu`),
`src/app/login/page.tsx` (server wrapper), `src/lib/auth/guards.ts` (`requireOwner`,
page helpers), `supabase/seed.sql` (upcoming bookings),
`docs/foundation-review-notes.md` (OAuth correction).
