# Public browse pages — design spec

**Date:** 2026-08-01
**Status:** Approved design, pending implementation plan
**Slice:** Home, Search results, Branch page (full), Owner profile
**Depends on:** the Supabase foundation (`docs/superpowers/plans/2026-07-31-supabase-foundation.md`,
`docs/foundation-review-notes.md`)

## Overview

The foundation branch shipped the database, auth guards, and the booking
availability/pricing/hold logic, but only two pages: a placeholder `/` and a
`/venues/[slug]` that renders the availability grid and nothing else. This slice
builds the four **public browse** pages from `design/mockups/` — the pages a
signed-out visitor sees before they ever authenticate.

It is deliberately the subset of the eight mockups that needs no payment
provider, no listing-management UI, and no owner/admin surfaces. The three
mockups it excludes (`checkout.html`, `owner-dashboard.html`,
`player-dashboard.html`) and `admin-approvals.html` each sit on a backend slice
that does not exist yet; folding them in would mean designing payments, payouts,
and moderation by accident.

`design/branding.md` is the design source of truth and outranks the mockup HTML
wherever the two disagree — most notably the availability grid's time spine,
which the mockups still render with the dropped `--band-peak` tint.

## Goals

- Four pages that match the mockups, rendered from real data in the live database.
- A reusable set of page chrome and card primitives, since all four pages share them.
- A search page whose full state lives in the URL, so a search is linkable.
- Enough seeded content that grids, empty states, filters, and the map are
  exercisable and verifiable rather than theoretical.

## Non-goals

- Leaving a review (write-side). Reviews are read-only here; the write path
  belongs to the player dashboard slice.
- Any authenticated-only surface: checkout, dashboards, admin approvals.
- Listing management or photo upload UI. Photos arrive via a seed script.
- Realtime availability. Unchanged from the product spec: deferred.
- Pagination on search. Ten seeded branches fit one page; the query is written so
  a `limit/offset` can be added without restructuring.

## Routes

| Route | Mockup | Nav variant | Status |
|---|---|---|---|
| `/` | `home.html` | overlay | Replaces the current placeholder |
| `/search` | `search-results.html` | solid | New |
| `/venues/[slug]` | `branch-page.html` | solid | Extends the existing page |
| `/owners/[slug]` | `owner-profile.html` | solid | New |

`/search` reads its entire state from the query string:

```
/search?city=marikina&date=2026-08-02&hour=18&env=indoor&max=40000&amenities=parking,showers&sort=distance
```

| Param | Values | Default |
|---|---|---|
| `city` | a slug from `src/lib/geo/cities.ts` | `metro-manila` (region-wide centroid) |
| `lat` / `lng` | decimal degrees, from the geolocation button; overrides `city` | absent |
| `date` | `YYYY-MM-DD`, Manila calendar date | today (Manila) |
| `hour` | integer 0–23 | absent (no time filter) |
| `env` | `indoor` \| `outdoor` | absent (both) |
| `max` | integer centavos | absent |
| `amenities` | comma-separated, from the seeded amenity vocabulary | absent |
| `sort` | `distance` \| `price` \| `rating` | `distance` |

Every param is validated server-side and falls back to its default when invalid,
matching the existing branch page's treatment of `?date=` — a mistyped query
string on a public page is a typo, not a 404. Unknown params are ignored.

## Architecture

### Page chrome

- `src/components/site/wordmark.tsx` — "oncourt" in display 800 plus the 8×8px
  lime square. Prop `onDark`: light backgrounds get the `1.5px solid var(--ink)`
  border, dark/photo backgrounds get none. Per `branding.md`, same rule at footer size.
- `src/components/site/nav.tsx` — Server Component. Two variants:
  - `overlay` — absolute, transparent, white text, glass pill
    (`rgba(255,255,255,.09)` bg, `rgba(255,255,255,.18)` border, `blur(22px)`).
    Used only over the home hero.
  - `solid` — `--surface` background with a hairline bottom border. Every other page.

  Right side is the "List your court" pill plus, when a session exists, a 36px
  avatar; signed out, a "Sign in" link to `/login`. Session is read with
  `supabase.auth.getClaims()` — never `getSession()` — per the product spec.
- `src/components/site/footer.tsx` — static, shared by all four pages.

There is no shared route-group layout, because the nav variant differs per page
and the home hero needs the nav to render *inside* it. Each page composes `Nav`
and `Footer` directly.

### Shared primitives

- `src/lib/format.ts` — `formatPeso(centavos)` (`₱300`, `₱1,022.90`, mono at the
  call site), `formatPriceFrom(centavos)` (`from ₱200/hr`), `formatHour(hour)`
  (`6 AM`, and `12 AM` for 24 — the `formatHour(24)` bug the foundation notes
  record), `formatHourRange(start, end)` (`7 – 9 AM`, spaced en dash),
  `formatDateLabel(date)` (`Fri, Aug 1`).
- `src/lib/date-manila.ts` — consolidates the helpers currently duplicated across
  `src/lib/booking/hold.ts`, `src/lib/booking/availability.ts`, and
  `src/app/venues/[slug]/page.tsx`/`actions.ts`: `manilaToday()`,
  `manilaWeekday(date)`, `isValidCalendarDate(date)`, `shiftDay(date, days)`.
  `isRealCalendarDate` and `isValidCalendarDate` are the same function under two
  names and collapse into one. Call sites are updated; the existing tests for
  those behaviors move with them and must stay green.

  This is scoped debt repayment, not opportunistic refactoring: all four helpers
  are needed by the new pages, and `docs/foundation-review-notes.md` lists the
  duplication as a deferred item nobody owned. Two known correctness traps are
  preserved with their reasoning: `manilaWeekday` must not use `getUTCDay()` on a
  `+08:00`-shifted instant, and `shiftDay` must do pure calendar arithmetic via
  `Date.UTC` with no offset parsing.
- `src/lib/photos.ts` — `photoUrl(bucket, storagePath)` builds the public Storage
  URL from `NEXT_PUBLIC_SUPABASE_URL`. Both buckets are already public. Returns a
  brand-colored placeholder marker when a branch has no photos so cards never
  render a broken image.
- `src/components/ui/rating.tsx` — the lime dot (7px, ink outline) + bold number +
  muted count. Renders nothing when a branch has no reviews.
- `src/components/ui/branch-card.tsx` — the card used by home, search, and owner
  profile: cover photo, name, city, rating, `from ₱X/hr`, amenity chips. Card
  styling per `branding.md` (white, radius 20px, no border, `--shadow-sm`, hover
  lift −4px with image scale 1.045, guarded by `prefers-reduced-motion`).
- `src/components/ui/amenity-chip.tsx` — pill-shaped (999px) so it reads as a
  badge, not a button.

### Data layer

One server-only module, `src/lib/branches/queries.ts`, written as
`db.execute(sql\`...\`)` — never the Drizzle query builder, per `CLAUDE.md`.
Array parameters use `= any(${sql.param(ids)}::uuid[])`; the naïve
`in (${ids})` form generates a row constructor and fails with `42883`.

```ts
searchBranches(filters): Promise<BranchSummary[]>
getBranchDetail(slug): Promise<BranchDetail | null>
getOwnerProfile(slug): Promise<OwnerProfile | null>
getHomeData(): Promise<{ featured: BranchSummary[]; cities: CityCount[]; openNow: number }>
```

`BranchSummary` is what a card needs: `id, slug, name, city, coverPhotoPath,
minPriceCentavos, courtCount, ratingAvg, ratingCount, distanceMeters | null,
amenities`.

**`searchBranches`** — a single query over `branches` joined to approved courts:

- Radius: `st_dwithin(location, st_setsrid(st_makepoint($lng, $lat), 4326)::geography, $radiusMeters)`.
  Default radius 25 km. Uses the existing `branches_location_gix` GIST index.
- Distance: `st_distance(location, …)` for both ordering and the "2.4 km away" label.
- `minPriceCentavos`: `min(court_rate_bands.price_centavos)` across the branch's
  approved courts.
- Environment filter: `exists (select 1 from courts where branch_id = … and status = 'approved' and environment = $env)`.
- Amenities filter: `branches.amenities @> $amenities::text[]`.
- Max price: filters on the computed minimum.
- Availability filter (`date` + `hour`, applied only when `hour` is present): the
  branch has at least one approved court that is open at that hour on that
  Manila weekday (`court_operating_hours`) and has no `bookings` row in
  (`pending_payment`, `confirmed`, `completed`) whose `slot` overlaps the hour.
  This reuses the same definitions as `src/lib/booking/availability.ts` rather
  than restating them.
- Ratings: `avg(rating)` / `count(*)` from `reviews` grouped by `branch_id`, via a
  `left join lateral` so branches with no reviews still appear.
- Sorting: `distance` (default) → `st_distance` asc; `price` → `minPriceCentavos`
  asc; `rating` → `ratingAvg` desc nulls last.

Branches with a `null` `location` (the column is nullable) are excluded from
radius search and sorted last elsewhere.

**`getBranchDetail`** returns the branch, its photos ordered by `sort_order`, its
amenities, the owner (`business_name`, `slug`, `business_logo_path`), its approved
courts with rate bands, the rating aggregate, and the most recent reviews with
their authors' `full_name`/`avatar_url`. The availability grid keeps its existing
`loadBranchDay(slug, date)` path untouched.

**`getOwnerProfile`** returns the owner profile plus a `BranchSummary` per branch.

**`getHomeData`** returns featured branches (highest rated, then most courts,
capped at 6), the seeded city list with branch counts, and `openNow` — the count
of approved courts with no overlapping active booking at the current Manila hour,
for the mockup's live indicator.

### Geography

`src/lib/geo/cities.ts` is a hardcoded list of `{ slug, name, lat, lng }` for the
Metro Manila cities the seed actually places branches in, plus a `metro-manila`
region-wide default centroid. No third-party geocoder: no API key, no rate limit,
no no-match empty state, and every option in the picker is guaranteed to return
results.

The search bar's location control is a `<select>` of those cities plus a "Use my
location" button that calls `navigator.geolocation.getCurrentPosition` and
navigates to the same page with `?lat=&lng=`. Permission denial is a no-op that
leaves the city picker in charge — the page never depends on geolocation.

### Map

`src/components/search/search-map.tsx`, `'use client'`, loaded via
`next/dynamic` with `ssr: false` (Leaflet touches `window` at import time). Adds
`leaflet` as a dependency; its stylesheet is imported by the component.

Implemented exactly as `branding.md` documents, since that entry was written to be
reproducible from the doc alone:

- CARTO Positron `light_all` tiles.
- Duotone via an inline SVG filter applied as
  `filter: url(#duotone) contrast(1.06)` on `.leaflet-tile-pane` — a
  `feColorMatrix` to luminance feeding a `feComponentTransfer` with
  `feFuncR 0.078 0.918`, `feFuncG 0.239 0.949`, `feFuncB 0.173 0.894`.
- Markers are `L.divIcon` price pills in the marker pane (a sibling of the tile
  pane), so the filter does not tint them: white bg, `--ink` text, mono 12px,
  `--shadow-sm`, 999px radius; active/hover inverts to `--ball` with a 1.5px
  `--ink` border.
- **Do not** attempt a container-level blend-mode overlay. `branding.md` records
  that it cannot work — `.leaflet-map-pane` sits at z-index 400, so an overlay is
  either fully below the map or fully above the markers.

List↔map hover sync lives in a thin client wrapper,
`src/components/search/search-results.tsx`, which holds `activeId` and receives
the server-fetched `BranchSummary[]` as props. The cards themselves stay
presentational. The server page does all data fetching; no data is fetched in the
browser.

## New backend: reviews

One migration, `supabase/migrations/<timestamp>_reviews.sql`:

```sql
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

alter table reviews enable row level security;
```

Notes:

- `booking_id` is `unique`, which both gives the FK its index and enforces one
  review per booking.
- `booking_id` is `NO ACTION` (the default), consistent with the existing
  `bookings` FKs: bookings are financial records that must not vanish. `branch_id`
  and `player_id` cascade, matching the tables above them.
- `branch_id` is denormalized off `booking → court → branch` because every read in
  this slice aggregates by branch.
- RLS enabled, zero policies, like every other table — deny by default. No
  `force row level security`.
- No grants are added, so the existing lockdown suite picks the table up
  automatically.
- Rating is aggregated on read. No denormalized `branches.rating` column and no
  triggers: at this scale the aggregate is cheap, and a denormalized column needs
  maintenance machinery this slice would not test.
- The migration must be idempotent (`if not exists`, and `DO $$ … $$` guarded on
  `pg_constraint` for anything `alter table … add constraint`), because
  `supabase db reset` is unavailable on the hosted project and idempotency is
  proven by applying twice.

## Seed data

`supabase/seed.sql` grows to **3 owners → ~10 branches → ~30 courts**, plus past
`completed` bookings and the reviews attached to them. Multi-branch owners (one
with 5, one with 3, one with 2) are what make `/owners/[slug]` meaningful.

Constraints on the seed:

- Every statement idempotent (`on conflict … do nothing` / guarded updates). This
  database is shared and persistent and the file may run more than once.
- Deterministic UUIDs that do **not** collide with the existing
  `smash-zone-marikina` fixture (`aaaa…`/`bbbb…`/`cccc…`) or the `task9-*` rows
  (`1111…`/`2222…`/`3333…`). The existing seed's header documents why that
  collision matters; a third distinct prefix is required.
- Real Metro Manila coordinates, so `ST_DWithin` and distance ordering produce
  believable results rather than a cluster on one point.
- Varied `environment`, rate bands, operating hours, and amenities drawn from a
  fixed vocabulary, so every search filter has both matching and non-matching rows.
- Seeded bookings must satisfy the `bookings_no_overlap` exclusion constraint, the
  `bookings_time_order` check, and `fee_config_snapshot not null`; they are placed
  in the past with `status = 'completed'` so they neither block live booking nor
  need `expires_at`.
- Seeded players need `auth.users` rows, since `profiles` FKs to them via the
  signup trigger.

`scripts/seed-photos.ts` (run with `tsx`) downloads a set of Unsplash court photos
and uploads them to the `branch-photos` and `court-photos` buckets at deterministic
paths (`branches/<branch_id>/<n>.jpg`), then upserts the matching `branch_photos` /
`court_photos` rows. Photo rows are created by the script rather than by
`seed.sql`, so a row never points at an object that does not exist. Re-running
upserts to the same paths and is a no-op. The script uses the secret key and is
server-only; it is a development utility, not application code.

## Testing

Tests run against the hosted Supabase project via `DATABASE_URL` — the Supavisor
**session** pooler on port 5432, never 6543. Because the database is shared and
never reset, every test must pass on repeated runs and must not mutate seeded
singleton rows.

| Area | Coverage |
|---|---|
| `tests/schema/reviews.test.ts` | rating range check, one-review-per-booking uniqueness, FK delete behavior (cascade on branch/player, `NO ACTION` on booking), RLS enabled, no grants |
| `tests/security/data-api-lockdown.test.ts` | already enumerates every table — confirm `reviews` is picked up rather than special-cased |
| `tests/branches/search.test.ts` | radius inclusion/exclusion, distance ordering, environment / max-price / amenities / availability-at-hour filters, branches with `null` location, branches with no reviews |
| `tests/lib/format.test.ts` | peso formatting incl. thousands and centavos, `formatHour(0)` and `formatHour(24)`, hour ranges, date labels |
| existing date-helper tests | move to `tests/lib/date-manila.test.ts` with the consolidated module; must stay green |

Tests create and clean up their own fixtures. The migration is applied twice to
prove idempotency, since `db reset` is unavailable.

## Verification

Each page is verified in the browser pane against a running dev server: console
and network clean, content and structure read from the accessibility tree, and the
result compared to its mockup. Screenshots go to `docs/screenshots/` — never the
project root.

**Explicitly not verifiable in this slice, and not to be claimed:**

- **Signed-in nav state.** Google OAuth is still unconfigured
  (`docs/foundation-review-notes.md`, open item 2). All four pages are verified
  signed-out, which is the real case for public browse. The avatar branch of the
  nav is written but unproven.
- **Anything behind checkout.** Payments do not exist.

The foundation notes' recurring failure mode applies here: verify what code
actually produces — print the generated SQL, read the computed CSS, query the
catalog — rather than trusting a comment or a passing test.

## Risks

- **The map is the one genuinely new client-side surface.** Leaflet + SSR + a
  filter that must land on the right pane. If the duotone or the marker pane
  behaves differently than `branding.md` describes, the doc is what gets corrected
  — in the same turn, per `CLAUDE.md`.
- **Seed size.** ~10 branches × ~3 courts × rate bands × operating hours × bookings
  × reviews is a lot of idempotent SQL in one file. If it becomes unwieldy it
  should be generated by a script rather than hand-written twice.
- **The test database is also the demo database.** Already flagged in the
  foundation notes. This slice adds ~10 branches of demo content to it, which
  makes the case for a separate throwaway test project stronger, not weaker.
- **`branch_photos` has no `is_cover` column.** Cover photo is "lowest
  `sort_order`". That is sufficient here; if owners later need to choose a cover,
  it is a schema change, not a query change.
