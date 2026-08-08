# Player profile completion: checklist, percentage, and a home city

**Date:** 2026-08-08
**Status:** approved, ready for implementation

## Problem

A player signs in with Google and lands on `/bookings` with a profile the
application never asks them to finish. Three things follow from that:

1. **There is no player profile surface at all.** `/dashboard/settings` is
   owner-only (gated inline — see `src/app/dashboard/settings/page.tsx`), and a
   player's only page is `/bookings`. A player cannot view or change a single
   field on their own account.
2. **We don't know where anyone plays.** `profiles` has no city column, so every
   search starts at Tacloban regardless of who is asking. For a player in Cebu
   the first thing the product does is show them courts on another island.
3. **`phone` is collected from nobody.** The column exists and is used for
   owners' business details; no player has ever been asked for one, so a court
   has no way to reach a player about their own booking.

This adds a profile-completion checklist to the top of the player dashboard that
fixes all three: it shows what's missing, lets the player fill it in place, and
uses the city it collects to start their searches somewhere useful.

## Decisions

| Question | Decision |
|---|---|
| Steps counted | Full name, phone, city — **three** |
| Avatar | **Not** a step, and no upload is built |
| Step UI | Checklist panel on `/bookings`, each row expanding inline into its own field |
| Edit surface | The panel itself — no `/account` page |
| City input | A `<select>` over `CITIES`, storing the slug |
| City list | Expanded from 2 entries to 15 (13 new real cities + the existing Tacloban and nationwide entries) |
| What the city does | Defaults the Where field on the home hero and `/search` |
| Phone validation | Light — accept `09XXXXXXXXX` and `+639XXXXXXXXX`, normalize on write |
| Percentage | `Math.round(done / 3 * 100)` → 0 / 33 / 67 / 100 |

### Why avatar is not a step

`avatar_url` is auto-filled from Google's `raw_user_meta_data` by the
`handle_new_user` trigger, and this application has **no avatar upload path** —
there are `branch-photos` and `court-photos` storage buckets and nothing else.
Counting it would give a player whose Google account has no photo a step they
cannot physically complete, pinning their meter below 100% forever. Building
upload (a bucket, an upload action, image validation, a migration) roughly
doubles this feature for a field almost everyone already has. Dropped, not
deferred: if avatar upload is built later it can be added as a fourth step then.

### Why full name stays a step even though it is usually pre-filled

`full_name` also comes from Google, so most players start at 33% having done
nothing. That was considered and kept deliberately: an already-earned tick reads
as momentum rather than a scolding, and a Google account without a name is real
(it happens with some workspace accounts), so the step is genuinely completable
for the people who need it.

### Why the panel cannot disappear at 100%

Because the edit surface **is** the panel, hiding it once complete would leave a
player permanently unable to change the city they just set — they have no other
profile page to go to. So at 100% the panel collapses to a single
"Profile complete" line carrying an **Edit** toggle that reveals the same three
fields. This is a direct consequence of choosing inline-only editing over a
separate `/account` page; if an `/account` page is ever built, this collapse
behaviour becomes redundant and should be revisited.

## Design

### 1. Migration — one nullable column

```sql
alter table profiles add column if not exists city_slug text;
```

Nullable, no default: "we have not asked yet" and "they declined" are both
honestly null, and every existing row must stay valid.

**No foreign key and no check constraint.** `CITIES` is a hardcoded TypeScript
table, not a database table — `src/lib/geo/cities.ts` documents why (no API key,
no rate limit, no network failure mode). There is nothing to reference. The slug
is validated in TypeScript against `CITIES` on write, exactly as
`parseSearchParams` already validates amenity slugs against `AMENITY_SLUGS`.

Per this project's migration rules: apply with
`npx supabase db push --db-url "$DATABASE_URL"`, prove idempotency by applying
twice (hence `if not exists`), then regenerate types with `drizzle-kit pull`.

### 2. Expanding `CITIES` — `src/lib/geo/cities.ts`

The list grows from 2 entries to 15. Suggested set, all with real centroids —
the exact roster is adjustable, but it must cover the cities a Philippine
player would plausibly name:

| slug | name | lat | lng |
|---|---|---|---|
| `quezon-city` | Quezon City | 14.6760 | 121.0437 |
| `manila` | Manila | 14.5995 | 120.9842 |
| `makati` | Makati | 14.5547 | 121.0244 |
| `pasig` | Pasig | 14.5764 | 121.0851 |
| `taguig` | Taguig | 14.5176 | 121.0509 |
| `cebu-city` | Cebu City | 10.3157 | 123.8854 |
| `davao-city` | Davao City | 7.1907 | 125.4553 |
| `iloilo-city` | Iloilo City | 10.7202 | 122.5621 |
| `bacolod` | Bacolod | 10.6407 | 122.9689 |
| `cagayan-de-oro` | Cagayan de Oro | 8.4542 | 124.6319 |
| `baguio` | Baguio | 16.4023 | 120.5960 |
| `zamboanga-city` | Zamboanga City | 6.9214 | 122.0790 |
| `general-santos` | General Santos | 6.1164 | 125.1716 |
| `tacloban` | Tacloban City | 11.2444 | 125.0048 |
| `philippines` | All of the Philippines | 12.8797 | 121.7740 |

`tacloban` and `philippines` are the existing rows, unchanged — including
`philippines`'s `radiusMeters: 1_500_000`. Every new entry omits `radiusMeters`
and inherits the shared 12 km `CITY_SEARCH_RADIUS_METERS`. `DEFAULT_CITY_SLUG`
stays `tacloban`.

**A promise in that file must be rewritten, not quietly broken.** Its doc
comment currently claims the table is "short enough to keep honest by hand" so
there is "no option in the picker that returns nothing", and that "The picker
must never make a real branch unreachable." The second half stays true and stays.
The first half becomes false the moment this list ships: with one live branch,
fourteen of these cities return zero courts. Replace that claim with the honest
version — the list now exists to let a player name where they actually live, and
an empty result for a city with no courts yet is the correct answer, not a bug.

**Two existing consumers, both already safe** — verify, don't assume:
- The home page's browse-by-city chips are built from `getHomeData`, which
  already returns one row per city *counted by radius* and omits cities with
  zero branches. The thirteen new cities therefore add zero new chips today.
- The `/search` and home-hero Where `<select>`s simply grow to 15 options.

### 3. Completion logic — `src/lib/profile/completion.ts`

A new **pure, import-free module**. This matters and is not stylistic: the panel
is a client component, and this codebase has a documented trap where a client
component value-importing from a module that transitively pulls in `server-only`
type-checks and lints clean but 500s the page at runtime. This module must
import nothing but types.

```ts
export type ProfileStepKey = 'full_name' | 'phone' | 'city'

export type ProfileStep = {
  key: ProfileStepKey
  label: string
  done: boolean
}

export type ProfileCompletion = {
  steps: ProfileStep[]
  doneCount: number
  total: number
  percent: number
}

export function profileCompletion(profile: {
  fullName: string | null
  phone: string | null
  citySlug: string | null
}): ProfileCompletion
```

A field counts as done when it is non-null and not blank after trimming — a
profile whose `full_name` is `"   "` is not complete. `percent` is
`Math.round(doneCount / total * 100)`, giving 0 / 33 / 67 / 100.

### 4. Phone normalization — `src/lib/profile/phone.ts`

Also pure and import-free, and separate from `completion.ts` so each module has
one job.

```ts
/** Returns E.164-style `+639XXXXXXXXX`, or null when the input isn't a PH mobile. */
export function normalizePhPhone(raw: string): string | null
```

Accepts, after stripping spaces, dashes and parentheses: `09XXXXXXXXX` (11
digits), `+639XXXXXXXXX`, and `639XXXXXXXXX`. All three store as
`+639XXXXXXXXX`, so one player's number has one representation. Anything else
returns null and the action rejects it with a message. Landlines are deliberately
not supported — the field exists so a court can reach a player about a booking,
and that means a mobile.

### 5. The panel — `src/components/player/profile-completion-panel.tsx`

A client component rendered at the top of `/bookings`, above the stat-card row.

**Incomplete state.** A `--panel` card carrying, in order: the heading
"Complete your profile"; a progress bar with the percentage and "N of 3"; the
explainer paragraph; then three rows. Each row shows a tick (done) or an empty
circle (not done) plus its label. Clicking an incomplete row expands it inline
into its own labelled field and a Save button — the checklist *is* the form.
Rows are independent: any order, and a player may leave any of them.

**Complete state.** Collapses to a single line — "Profile complete" with a tick
— plus an **Edit** toggle revealing the same three fields for later changes. See
the Decisions section for why it must not simply disappear.

Follows `design/branding.md` throughout: card recipe (white, 20px radius, no
border, `--shadow-sm`), `--btn-radius` on controls, `--court` for the progress
fill, mono uppercase for the kicker. **Read that file before styling anything.**
The progress bar needs `role="progressbar"` with `aria-valuenow/min/max`, and
each expanding row must be a real `<button>` with `aria-expanded`.

Note the panel is a **client** component but `/bookings` is a Server Component:
the page reads the profile and passes plain values as props.

### 6. Server action — `src/app/bookings/profile-actions.ts`

`'use server'`, one exported action:

```ts
export async function updatePlayerProfileAction(
  input: { fullName?: string; phone?: string; citySlug?: string },
): Promise<{ ok: true } | { ok: false; error: string }>
```

- Guarded by `requirePlayer()` — and this is load-bearing beyond correctness:
  `tests/auth/action-coverage.test.ts` globs every `'use server'` file and fails
  any exported action without a recognized guard. A new action file **will** be
  picked up by that test.
- Writes only the fields present in `input`, so one row's Save never blanks
  another field.
- Validates `citySlug` against `CITIES`; rejects anything else.
- Runs `phone` through `normalizePhPhone`; rejects null.
- Trims `fullName`; rejects empty.
- Writes via `db.execute(sql\`...\`)` — never the Drizzle query builder, per
  project convention.
- `revalidatePath('/bookings')` on success so the panel re-renders with the new
  percentage.

### 7. Using the city — search defaults

**`parseSearchParams` gains an optional second argument:**

```ts
export function parseSearchParams(
  params: Record<string, string | string[] | undefined>,
  fallbackCitySlug?: string | null,
)
```

When `?city=` is absent or invalid **and** `fallbackCitySlug` is a valid slug,
that becomes the resolved city; otherwise `DEFAULT_CITY_SLUG`, exactly as now.
An explicit `?city=` in the URL always wins — a shared link must show the
recipient the same city it showed the sender. Because the parameter is optional,
every existing call and every existing test keeps working unchanged.

**A trap in `/search/page.tsx`.** It currently reads:

```ts
const parsed = await props.searchParams.then(parseSearchParams)
```

`.then(fn)` calls `fn` with exactly one argument, so adding a second parameter
here silently does nothing — it would type-check and quietly ignore the
fallback. Restructure to:

```ts
const parsed = parseSearchParams(await props.searchParams, playerCitySlug)
```

**The home hero** (`src/app/page.tsx`) already calls `getOptionalUser()`. It
additionally needs that user's `city_slug` to seed the Where `<select>`'s
`defaultValue` (falling back to `DEFAULT_CITY_SLUG`). Add a small server query —
`getPlayerCitySlug(userId)` in `src/lib/profile/queries.ts` — rather than
widening `getOptionalUser`, whose job is auth, not profile data.

Signed-out visitors are unaffected everywhere: no user, no fallback, same
`DEFAULT_CITY_SLUG` behaviour as today.

### 8. Copy

English only, per `design/branding.md`'s Language rule. Plain and factual — it
must not promise anything the product does not do:

- Heading: **Complete your profile**
- Explainer: **Your city sets where your searches start, so you see courts you
  can actually reach. Your phone lets a court reach you about a booking.**
- Step labels: **Your name**, **Mobile number**, **Home city**
- Complete state: **Profile complete**

Deliberately avoided: any claim about who can or cannot see these fields. This
spec adds no visibility rules, so a privacy promise here would be unfounded.

## Testing

Existing suites must keep passing untouched — a diff to an unrelated test is a
signal the change escaped its scope.

New tests:
- `profileCompletion` — 0/1/2/3 done, the whitespace-only case, percentage
  rounding at each step.
- `normalizePhPhone` — all three accepted input shapes normalizing to one
  output; spaces/dashes/parens stripped; rejects too short, too long, non-numeric,
  landline, and empty.
- `parseSearchParams` fallback — no `?city=` plus a valid fallback uses it; an
  explicit `?city=` beats the fallback; an invalid fallback falls through to
  `DEFAULT_CITY_SLUG`; no fallback behaves exactly as before.
- The action's city validation rejects a slug outside `CITIES`.

Tests run against the **hosted** Supabase database in the foreground, never
backgrounded. The database is shared and persistent, so tests must pass on
repeated runs and must not mutate seeded singleton rows.

## Verification

- `npx tsc --noEmit` and `npx eslint` clean (baseline: 9 warnings, 0 errors).
- Migration applies twice in a row without error.
- `/bookings` is behind auth and **cannot be browser-verified by an agent** —
  this project has no dev login. The panel's rendering must be confirmed by the
  user, or by a test that renders the component directly. Do not claim it was
  visually verified.
- `/search` and `/` are public and must be checked signed-out: the Where field
  still defaults to Tacloban and no page 500s from a client/server import
  boundary violation.

## Out of scope

- Avatar upload, and any storage bucket for it.
- An `/account` page or any second profile surface.
- Showing profile fields to anyone but their owner.
- Any use of the city beyond seeding the two Where fields — no "courts near
  you" section, no distance re-ranking, no notifications.
- Owner/admin profile completion. This panel is player-only, matching
  `/bookings`'s own `requirePlayerPage` guard.
