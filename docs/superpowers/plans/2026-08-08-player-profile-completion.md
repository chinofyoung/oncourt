# Player Profile Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give players a profile-completion checklist on `/bookings` that collects their name, mobile number and home city, and use that city to start their searches somewhere useful.

**Architecture:** One nullable column (`profiles.city_slug`); `CITIES` expanded from 2 to 15 real Philippine cities; two pure, import-free modules for completion math and phone normalization; a client checklist panel whose rows expand into inline forms bound to three guarded Server Actions; and an optional fallback parameter threaded into `parseSearchParams` so a signed-in player's city seeds the Where field on `/` and `/search`.

**Tech Stack:** Next.js App Router (Server Components + Server Actions), TypeScript, Tailwind CSS v4, Postgres via Drizzle's `db.execute(sql\`...\`)`, Supabase (hosted), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-08-player-profile-completion-design.md` — read it before Task 1. Every "why" lives there; this plan is the "how".

## Global Constraints

Every task's requirements implicitly include this section.

- **Do NOT run any state-changing git command.** No `commit`, `add`, `branch`, `checkout`, `stash`, `reset`, `push`. Read-only `status`/`diff`/`log` is fine. The user commits their own work. Where the writing-plans template would put a "Commit" step, this plan puts a **Report** step.
- **Data access is server-only.** All reads and writes go through Server Components, Server Actions or Route Handlers, each behind a guard. Use `db.execute(sql\`...\`)` — **never** the Drizzle query builder, and **never** import `src/db/schema.ts` (it is excluded from `tsconfig.json` and importing it resurfaces a `TS2304`).
- **Client/server import boundary.** A client component may only *type*-import from any module that transitively reaches `@/db` or `server-only`. A value-import type-checks and lints clean, then 500s the page at runtime with "You're importing a module that depends on 'server-only'". `src/lib/profile/completion.ts` and `src/lib/profile/phone.ts` must therefore import **nothing but types**.
- **Every `'use server'` file must call a guard.** `tests/auth/action-coverage.test.ts` globs `src/**/*.{ts,tsx}`, keeps files containing `'use server'`, and fails any whose source does not mention one of its `GUARDS` — `requirePlayer` is on that list. A new action file will be picked up automatically.
- **All money is integer centavos; percentages are integer basis points.** Nothing in this feature touches money, but do not introduce floats anywhere.
- **Identifiers are lowercase `snake_case`** in SQL. Drizzle uses `casing: 'snake_case'`.
- **Tests run against a HOSTED Supabase database** via `DATABASE_URL` in `.env.local`, through the Supavisor session pooler on port **5432** (never 6543). The database is **shared and persistent**: tests must pass on repeated runs and must not mutate seeded singleton rows. Run vitest in the **foreground**, never backgrounded.
- **Copy is English only.** No Taglish. See `design/branding.md`'s Language rule.
- **Read `design/branding.md` before any styling**, and update it in the same turn if a design-system value changes.
- **eslint baseline is 9 warnings / 0 errors.** "Clean" means 0 errors and no NEW warnings — not zero output.
- `/bookings` is behind auth and **cannot be browser-verified by an agent** (no dev login exists). Never claim a visual check of it that did not happen.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/20260808000000_profile_city.sql` | Adds `profiles.city_slug` | 1 |
| `src/lib/geo/cities.ts` | The city table — grows to 15 entries; doc comment corrected | 1 |
| `src/lib/profile/completion.ts` | Pure: which steps are done, and the percentage | 2 |
| `src/lib/profile/phone.ts` | Pure: PH mobile normalization | 2 |
| `src/lib/profile/queries.ts` | Server-only reads of a player's profile fields | 3 |
| `src/app/bookings/profile-actions.ts` | Three guarded Server Actions, one per field | 3 |
| `src/components/player/profile-completion-panel.tsx` | The client checklist panel | 4 |
| `src/app/bookings/page.tsx` | Renders the panel above the stat cards | 4 |
| `src/lib/search/params.ts` | `parseSearchParams` gains an optional fallback city | 5 |
| `src/app/search/page.tsx`, `src/app/page.tsx` | Pass the player's city as that fallback | 5 |

Task order matters: Task 1 produces the slugs Task 3 validates against; Task 2 produces the functions Tasks 3 and 4 call.

---

### Task 1: Data foundation — `city_slug` column and a real city list

**Files:**
- Create: `supabase/migrations/20260808000000_profile_city.sql`
- Modify: `src/lib/geo/cities.ts`
- Test: `tests/lib/geo/cities.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: the column `profiles.city_slug text` (nullable); `CITIES` containing 15 entries whose `slug` values Task 3 validates against and Task 4 renders as `<option>`s. `DEFAULT_CITY_SLUG` stays `'tacloban'`; `CITY_SEARCH_RADIUS_METERS` stays `12_000`; the `City` type is unchanged.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260808000000_profile_city.sql`:

```sql
-- A player's home city, as a slug from src/lib/geo/cities.ts.
--
-- Nullable with no default on purpose: "we have not asked yet" and "they
-- declined to say" are both honestly null, and every existing profile must
-- stay valid without a backfill.
--
-- No foreign key and no check constraint. CITIES is a hardcoded TypeScript
-- table, not a database table -- src/lib/geo/cities.ts documents why (no API
-- key, no rate limit, no network failure mode, no option that returns
-- nothing). There is nothing here to reference. The slug is validated in
-- TypeScript on write, the same way parseSearchParams validates amenity slugs
-- against AMENITY_SLUGS.
--
-- `if not exists` so this migration is idempotent: this project cannot run
-- `supabase db reset`, so idempotency is proven by applying twice.
alter table profiles add column if not exists city_slug text;
```

- [ ] **Step 2: Apply the migration twice**

```bash
npx supabase db push --db-url "$DATABASE_URL"
```

Run it a second time. Expected: the second run succeeds with no error — that is the idempotency proof this project requires in place of `db reset`.

- [ ] **Step 3: Verify the column exists**

```bash
psql "$DATABASE_URL" -c "select column_name, data_type, is_nullable from information_schema.columns where table_name='profiles' and column_name='city_slug'"
```

Expected: one row, `text`, `YES`.

- [ ] **Step 4: Regenerate Drizzle types**

```bash
npx drizzle-kit pull
```

Project convention: schema truth is the SQL migration, and `schema.ts` is regenerated after every migration. Note `schema.ts` is excluded from `tsconfig.json` and nothing imports it — do not add an import to "fix" any error it contains.

- [ ] **Step 5: Write the failing test for the expanded city table**

Create `tests/lib/geo/cities.test.ts`:

```ts
import { expect, test } from 'vitest'
import { CITIES, DEFAULT_CITY_SLUG, cityBySlug } from '@/lib/geo/cities'

test('every city has a unique slug', () => {
  const slugs = CITIES.map((city) => city.slug)
  expect(new Set(slugs).size).toBe(slugs.length)
})

test('every city centroid is inside the Philippines bounding box', () => {
  for (const city of CITIES) {
    expect(city.lat, `${city.slug} lat`).toBeGreaterThan(4)
    expect(city.lat, `${city.slug} lat`).toBeLessThan(21)
    expect(city.lng, `${city.slug} lng`).toBeGreaterThan(116)
    expect(city.lng, `${city.slug} lng`).toBeLessThan(127)
  }
})

test('only wide-area entries carry a radius override', () => {
  for (const city of CITIES) {
    if (city.slug === 'philippines') expect(city.radiusMeters).toBe(1_500_000)
    else expect(city.radiusMeters).toBeUndefined()
  }
})

test('the default city is a real city in the table', () => {
  const city = cityBySlug(DEFAULT_CITY_SLUG)
  expect(city.slug).toBe('tacloban')
  expect(city.radiusMeters).toBeUndefined()
})

test('the table covers the major cities players will name', () => {
  const slugs = new Set(CITIES.map((city) => city.slug))
  for (const expected of ['quezon-city', 'manila', 'cebu-city', 'davao-city', 'tacloban', 'philippines']) {
    expect(slugs, `missing ${expected}`).toContain(expected)
  }
})
```

- [ ] **Step 6: Run it and watch it fail**

```bash
npx vitest run tests/lib/geo/cities.test.ts
```

Expected: the last test FAILS — `CITIES` currently holds only `tacloban` and `philippines`, so `quezon-city` is missing. The other four should already pass.

- [ ] **Step 7: Expand `CITIES`**

In `src/lib/geo/cities.ts`, replace the `CITIES` array with the 15-entry table. Keep `tacloban` and `philippines` exactly as they are, including `philippines`'s `radiusMeters`:

```ts
export const CITIES: readonly City[] = [
  { slug: 'quezon-city', name: 'Quezon City', lat: 14.676, lng: 121.0437 },
  { slug: 'manila', name: 'Manila', lat: 14.5995, lng: 120.9842 },
  { slug: 'makati', name: 'Makati', lat: 14.5547, lng: 121.0244 },
  { slug: 'pasig', name: 'Pasig', lat: 14.5764, lng: 121.0851 },
  { slug: 'taguig', name: 'Taguig', lat: 14.5176, lng: 121.0509 },
  { slug: 'baguio', name: 'Baguio', lat: 16.4023, lng: 120.596 },
  { slug: 'iloilo-city', name: 'Iloilo City', lat: 10.7202, lng: 122.5621 },
  { slug: 'bacolod', name: 'Bacolod', lat: 10.6407, lng: 122.9689 },
  { slug: 'cebu-city', name: 'Cebu City', lat: 10.3157, lng: 123.8854 },
  { slug: 'tacloban', name: 'Tacloban City', lat: 11.2444, lng: 125.0048 },
  { slug: 'cagayan-de-oro', name: 'Cagayan de Oro', lat: 8.4542, lng: 124.6319 },
  { slug: 'zamboanga-city', name: 'Zamboanga City', lat: 6.9214, lng: 122.079 },
  { slug: 'davao-city', name: 'Davao City', lat: 7.1907, lng: 125.4553 },
  { slug: 'general-santos', name: 'General Santos', lat: 6.1164, lng: 125.1716 },
  {
    slug: 'philippines',
    name: 'All of the Philippines',
    lat: 12.8797,
    lng: 121.774,
    radiusMeters: 1_500_000,
  },
] as const
```

Ordered roughly north to south so the dropdown reads geographically rather than arbitrarily, with the nationwide fallback last.

- [ ] **Step 8: Correct the file's doc comment**

The comment above `CITIES` currently promises the table is "short enough to keep honest by hand" so there is "no option in the picker that returns nothing". That becomes false with this change: with one live branch, fourteen of these fifteen cities return zero courts today. Replace that paragraph — keep the rest of the comment, including the still-true "The picker must never make a real branch unreachable" and the reasoning for a nationwide rather than regional fallback:

```
 * A hardcoded table rather than a geocoder on purpose: no API key, no rate
 * limit, no usage policy to honor, and no network failure mode.
 *
 * The list is NO LONGER short enough to guarantee every option returns
 * results, and that is deliberate. It grew from two entries to fifteen when
 * players gained a home-city field (profiles.city_slug): a player has to be
 * able to name where they actually live, and "Tacloban or nationwide" could
 * not do that. With one live branch today, most of these cities return zero
 * courts — that is the correct, honest answer for a city with no courts yet,
 * not a bug to hide by shortening the list.
 *
 * What has NOT changed: the picker must never make a real branch unreachable.
```

- [ ] **Step 9: Run the tests**

```bash
npx vitest run tests/lib/geo/cities.test.ts
```

Expected: all 5 PASS.

- [ ] **Step 10: Update the two tests that assert the OLD table's contents**

**Ruling (user-approved, 2026-08-08).** An earlier draft of this plan said to report rather than edit any test that asserts the old two-entry list. Two tests do, and on inspection both assert *stale facts about the table's contents* rather than any logic — so both get updated. This is the one sanctioned test edit in this plan. Every other assertion in both files stays exactly as it is; nothing may be weakened, skipped, or deleted.

**10a — `tests/lib/search/params.test.ts`**, the case named "falls back to tacloban for a slug that is no longer in the table". It uses `makati` as its example of a removed slug, and `makati` is a real slug again as of Step 7. The behaviour under test — an old bookmark carrying a dead slug must land on the default rather than 500 or (0, 0) — is still exactly right and must keep being tested. Only the example changes:

```ts
    it('falls back to tacloban for a slug that is no longer in the table', () => {
      // An old bookmark carrying a slug this table no longer has must land on
      // the default, not 500 or (0, 0). `makati` used to be the example here —
      // it was a dead slug after the Metro Manila table was replaced, and
      // became a real one again when the table grew to 15 cities for the
      // player home-city field. `intramuros` is a district, never a slug in
      // this table, so it cannot come back the same way.
      const result = parseSearchParams({ city: 'intramuros' })
      expect(result.citySlug).toBe('tacloban')
      expect(result.filters.radiusMeters).toBe(CITY_SEARCH_RADIUS_METERS)
    })
```

**10b — `tests/listings/geocode.test.ts`**, the `cityCenterByName` case. One line asserted `cityCenterByName('Cebu City')` falls back to `tacloban`, which was only true because Cebu was absent from the table. With `cebu-city` added it now resolves to Cebu — and that is the behaviour this function was always reaching for: it exists to give the branch pin editor a sensible starting view, and an owner typing a Cebu address should get a Cebu map. Change that single assertion:

```ts
  // Cebu resolves to its own centroid now that the table carries it — the pin
  // editor opening on the city the owner actually typed is the whole point of
  // this function. Before the table grew to 15 cities this fell back to
  // tacloban simply because there was no Cebu entry to find.
  expect(cityCenterByName('Cebu City')).toMatchObject({ slug: 'cebu-city' })
```

Leave every other line of that test alone — in particular the wide-area-entry case (a `radiusMeters`-carrying entry must still be skipped, since its centroid is open water) and the `null`/whitespace/case-insensitivity cases.

- [ ] **Step 10c: Prove no OTHER consumer regressed**

```bash
npx vitest run tests/lib/search/params.test.ts tests/branches/search.test.ts tests/listings/geocode.test.ts
```

Expected: all pass, with **only** the two edits above present. Any *third* test needing a change is a coupling nobody predicted — stop and report it rather than editing it.

- [ ] **Step 11: Verify the home page's city chips did not multiply**

`getHomeData` returns one row per city counted by radius and omits cities with zero branches, so 13 new cities should add **zero** new chips. Start the dev server with the preview tool (`{name: "oncourt-dev"}`), open `http://localhost:3000/`, and run:

```js
JSON.stringify([...document.querySelectorAll('a[href^="/search?city="]')].map((a) => a.textContent.trim()))
```

Expected: the same chips as before this task (Tacloban only, on current data) — not 15.

- [ ] **Step 12: Gate and report**

```bash
npx tsc --noEmit && npx eslint
```

Report: the migration applied twice cleanly, the column verification, the 5 new tests passing, the 3 existing suites passing unchanged, the chip count, and the clean gate. Do not commit.

---

### Task 2: Pure modules — completion math and phone normalization

**Files:**
- Create: `src/lib/profile/completion.ts`, `src/lib/profile/phone.ts`
- Test: `tests/lib/profile/completion.test.ts`, `tests/lib/profile/phone.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, both value-importable from a **client** component:
  - `profileCompletion(profile: { fullName: string | null; phone: string | null; citySlug: string | null }): ProfileCompletion`
  - `type ProfileStepKey = 'full_name' | 'phone' | 'city'`
  - `type ProfileStep = { key: ProfileStepKey; label: string; done: boolean }`
  - `type ProfileCompletion = { steps: ProfileStep[]; doneCount: number; total: number; percent: number }`
  - `normalizePhPhone(raw: string): string | null` — returns `+639XXXXXXXXX` or null

**Both files must import nothing at all** (not even types from a `@/db`-touching module). Task 4's client panel value-imports them; an import that transitively reaches `server-only` type-checks clean and then 500s the page at runtime.

- [ ] **Step 1: Write the failing tests for phone normalization**

Create `tests/lib/profile/phone.test.ts`:

```ts
import { expect, test } from 'vitest'
import { normalizePhPhone } from '@/lib/profile/phone'

test('accepts the three PH mobile shapes and stores one form', () => {
  expect(normalizePhPhone('09171234567')).toBe('+639171234567')
  expect(normalizePhPhone('+639171234567')).toBe('+639171234567')
  expect(normalizePhPhone('639171234567')).toBe('+639171234567')
})

test('ignores spaces, dashes and parentheses', () => {
  expect(normalizePhPhone('0917 123 4567')).toBe('+639171234567')
  expect(normalizePhPhone('0917-123-4567')).toBe('+639171234567')
  expect(normalizePhPhone('(0917) 123-4567')).toBe('+639171234567')
  expect(normalizePhPhone('  09171234567  ')).toBe('+639171234567')
})

test('rejects anything that is not a PH mobile', () => {
  expect(normalizePhPhone('')).toBeNull()
  expect(normalizePhPhone('   ')).toBeNull()
  expect(normalizePhPhone('0917123456')).toBeNull()   // one digit short
  expect(normalizePhPhone('091712345678')).toBeNull() // one digit long
  expect(normalizePhPhone('08171234567')).toBeNull()  // not a 9-series mobile
  expect(normalizePhPhone('+6329123456')).toBeNull()  // landline
  expect(normalizePhPhone('not a phone')).toBeNull()
  expect(normalizePhPhone('+1 415 555 2671')).toBeNull()
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/lib/profile/phone.test.ts
```

Expected: FAIL — cannot resolve `@/lib/profile/phone`.

- [ ] **Step 3: Implement `normalizePhPhone`**

Create `src/lib/profile/phone.ts`:

```ts
/**
 * A Philippine mobile number in one canonical form, or null.
 *
 * IMPORT-FREE ON PURPOSE. src/components/player/profile-completion-panel.tsx
 * is a client component and value-imports this; a module that transitively
 * reaches `server-only` type-checks and lints clean, then 500s the page at
 * runtime.
 *
 * Accepts the three shapes a Filipino player actually types — `09XXXXXXXXX`,
 * `+639XXXXXXXXX`, `639XXXXXXXXX` — and stores all three as `+639XXXXXXXXX`,
 * so one person's number has exactly one representation in the database.
 *
 * Mobile only, deliberately: this field exists so a court can reach a player
 * about their booking, and every PH mobile is `9`-series. A landline would
 * pass a laxer check and fail the only purpose the field has.
 */
export function normalizePhPhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-()]/g, '')
  const national = digits.startsWith('+63')
    ? digits.slice(3)
    : digits.startsWith('63')
      ? digits.slice(2)
      : digits.startsWith('0')
        ? digits.slice(1)
        : null
  if (national === null) return null
  if (!/^9\d{9}$/.test(national)) return null
  return `+63${national}`
}
```

- [ ] **Step 4: Run the phone tests**

```bash
npx vitest run tests/lib/profile/phone.test.ts
```

Expected: all 3 PASS.

- [ ] **Step 5: Write the failing tests for completion**

Create `tests/lib/profile/completion.test.ts`:

```ts
import { expect, test } from 'vitest'
import { profileCompletion } from '@/lib/profile/completion'

const EMPTY = { fullName: null, phone: null, citySlug: null }

test('an untouched profile is 0% with three steps, none done', () => {
  const result = profileCompletion(EMPTY)
  expect(result.total).toBe(3)
  expect(result.doneCount).toBe(0)
  expect(result.percent).toBe(0)
  expect(result.steps.map((step) => step.key)).toEqual(['full_name', 'phone', 'city'])
  expect(result.steps.every((step) => !step.done)).toBe(true)
})

test('percent rounds to 33 / 67 / 100 as steps complete', () => {
  expect(profileCompletion({ ...EMPTY, fullName: 'Ana Cruz' }).percent).toBe(33)
  expect(profileCompletion({ ...EMPTY, fullName: 'Ana Cruz', phone: '+639171234567' }).percent).toBe(67)
  expect(
    profileCompletion({ fullName: 'Ana Cruz', phone: '+639171234567', citySlug: 'cebu-city' }).percent,
  ).toBe(100)
})

test('a whitespace-only value does not count as done', () => {
  const result = profileCompletion({ fullName: '   ', phone: '\t', citySlug: ' ' })
  expect(result.doneCount).toBe(0)
  expect(result.percent).toBe(0)
})

test('each step reports its own done flag independently', () => {
  const result = profileCompletion({ ...EMPTY, citySlug: 'davao-city' })
  const byKey = Object.fromEntries(result.steps.map((step) => [step.key, step.done]))
  expect(byKey).toEqual({ full_name: false, phone: false, city: true })
  expect(result.doneCount).toBe(1)
})

test('every step carries a human label', () => {
  for (const step of profileCompletion(EMPTY).steps) {
    expect(step.label.length).toBeGreaterThan(0)
  }
})
```

- [ ] **Step 6: Run it and watch it fail**

```bash
npx vitest run tests/lib/profile/completion.test.ts
```

Expected: FAIL — cannot resolve `@/lib/profile/completion`.

- [ ] **Step 7: Implement `profileCompletion`**

Create `src/lib/profile/completion.ts`:

```ts
/**
 * Which parts of a player's profile are filled in, and how far along they are.
 *
 * IMPORT-FREE ON PURPOSE — same reason as src/lib/profile/phone.ts: the
 * checklist panel is a client component and value-imports this.
 *
 * THREE STEPS, NOT FOUR. `avatar_url` is deliberately excluded: it is
 * auto-filled from Google at signup and this application has no avatar upload
 * path at all, so a player whose Google account has no photo would see a step
 * they cannot complete and a meter pinned below 100% forever. See the spec's
 * "Why avatar is not a step".
 *
 * `full_name` IS counted even though Google usually pre-fills it, so most
 * players start at 33% having done nothing — an already-earned tick reads as
 * momentum rather than a scolding, and a Google account with no name is real.
 */
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

/** Non-null and not blank once trimmed — `"   "` is not a name. */
function filled(value: string | null): boolean {
  return value !== null && value.trim().length > 0
}

export function profileCompletion(profile: {
  fullName: string | null
  phone: string | null
  citySlug: string | null
}): ProfileCompletion {
  const steps: ProfileStep[] = [
    { key: 'full_name', label: 'Your name', done: filled(profile.fullName) },
    { key: 'phone', label: 'Mobile number', done: filled(profile.phone) },
    { key: 'city', label: 'Home city', done: filled(profile.citySlug) },
  ]
  const doneCount = steps.filter((step) => step.done).length
  return {
    steps,
    doneCount,
    total: steps.length,
    percent: Math.round((doneCount / steps.length) * 100),
  }
}
```

- [ ] **Step 8: Run both suites**

```bash
npx vitest run tests/lib/profile/
```

Expected: all 8 tests PASS.

- [ ] **Step 9: Prove both modules are genuinely import-free**

```bash
grep -n "^import\|require(" src/lib/profile/completion.ts src/lib/profile/phone.ts
```

Expected: **no output at all**. Any import here is the runtime-500 trap described in the Global Constraints — even a type-only one is worth avoiding in these two files, since a later edit can silently turn it into a value import.

- [ ] **Step 10: Gate and report**

```bash
npx tsc --noEmit && npx eslint
```

Report: both test suites passing, the empty grep output, and the clean gate. Do not commit.

---

### Task 3: Profile queries and the three Server Actions

**Files:**
- Create: `src/lib/profile/queries.ts`, `src/app/bookings/profile-actions.ts`
- Test: `tests/profile/actions.test.ts`

**Interfaces:**
- Consumes: `normalizePhPhone` (Task 2), `CITIES` (Task 1).
- Produces:
  - `getPlayerProfileFields(userId: string): Promise<{ fullName: string | null; phone: string | null; citySlug: string | null }>` — used by Task 4's page.
  - `getPlayerCitySlug(userId: string): Promise<string | null>` — used by Task 5.
  - `type ProfileFormState = { ok: true; message: string } | { error: string } | null`
  - Three actions, each `(prevState: ProfileFormState, formData: FormData) => Promise<ProfileFormState>`: `updateFullNameAction`, `updatePhoneAction`, `updateCityAction`.

**Note on the action signature.** The spec sketched a single `updatePlayerProfileAction` taking a plain object. This plan uses three `(prevState, formData)` actions instead, because that is the shape `useActionState` binds to and the shape every existing form in this codebase already uses (`src/app/dashboard/settings/settings-forms.tsx` + `actions.ts`). Same behaviour, matching the established pattern.

- [ ] **Step 1: Write `src/lib/profile/queries.ts`**

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PlayerProfileFields = {
  fullName: string | null
  phone: string | null
  citySlug: string | null
}

/**
 * The three fields the completion checklist tracks. Shape-checked before the
 * `::uuid` cast (22P02 otherwise), the same guard startCheckout uses.
 *
 * A missing row returns all-nulls rather than throwing: the caller is a
 * dashboard panel, and "nothing filled in" is the honest render for a profile
 * row that somehow does not exist yet.
 */
export async function getPlayerProfileFields(userId: string): Promise<PlayerProfileFields> {
  if (!UUID_RE.test(userId)) return { fullName: null, phone: null, citySlug: null }
  const result = await db.execute(sql`
    select full_name, phone, city_slug from profiles where id = ${userId}::uuid
  `)
  const row = result.rows[0]
  return {
    fullName: (row?.full_name as string | null) ?? null,
    phone: (row?.phone as string | null) ?? null,
    citySlug: (row?.city_slug as string | null) ?? null,
  }
}

/**
 * Just the city, for seeding the Where field on `/` and `/search`. A separate
 * one-column query rather than widening getOptionalUser, whose job is auth,
 * not profile data.
 */
export async function getPlayerCitySlug(userId: string): Promise<string | null> {
  if (!UUID_RE.test(userId)) return null
  const result = await db.execute(sql`
    select city_slug from profiles where id = ${userId}::uuid
  `)
  return (result.rows[0]?.city_slug as string | null) ?? null
}
```

- [ ] **Step 2: Write the three actions**

Create `src/app/bookings/profile-actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { AuthError, requirePlayer } from '@/lib/auth/guards'
import { CITIES } from '@/lib/geo/cities'
import { normalizePhPhone } from '@/lib/profile/phone'

/**
 * Matches SettingsFormState's shape (src/app/dashboard/settings/actions.ts) so
 * these forms bind to useActionState exactly like the owner settings forms do.
 */
export type ProfileFormState = { ok: true; message: string } | { error: string } | null

const NAME_MAX = 80

/**
 * requirePlayer, not requireUser: roles are exclusive, /bookings is
 * requirePlayerPage, and an owner or admin has no profile checklist here.
 *
 * tests/auth/action-coverage.test.ts globs every 'use server' file and fails
 * any that mentions no guard from its GUARDS list — `requirePlayer` is on it.
 */
async function playerIdOrError(): Promise<{ id: string } | { error: string }> {
  try {
    const user = await requirePlayer()
    return { id: user.id }
  } catch (error) {
    if (error instanceof AuthError) return { error: 'Sign in as a player to update your profile.' }
    throw error
  }
}

export async function updateFullNameAction(
  _prevState: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const auth = await playerIdOrError()
  if ('error' in auth) return { error: auth.error }

  const fullName = String(formData.get('fullName') ?? '').trim()
  if (fullName.length === 0) return { error: 'Enter your name.' }
  if (fullName.length > NAME_MAX) return { error: `Keep your name under ${NAME_MAX} characters.` }

  await db.execute(sql`update profiles set full_name = ${fullName} where id = ${auth.id}::uuid`)
  revalidatePath('/bookings')
  return { ok: true, message: 'Name saved.' }
}

export async function updatePhoneAction(
  _prevState: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const auth = await playerIdOrError()
  if ('error' in auth) return { error: auth.error }

  // Normalized, never stored as typed: one person's number gets exactly one
  // representation. Null means it is not a PH mobile.
  const phone = normalizePhPhone(String(formData.get('phone') ?? ''))
  if (phone === null) return { error: 'Enter a Philippine mobile number, like 0917 123 4567.' }

  await db.execute(sql`update profiles set phone = ${phone} where id = ${auth.id}::uuid`)
  revalidatePath('/bookings')
  return { ok: true, message: 'Mobile number saved.' }
}

export async function updateCityAction(
  _prevState: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const auth = await playerIdOrError()
  if ('error' in auth) return { error: auth.error }

  // The closed set is the gate: a slug outside CITIES never reaches SQL. There
  // is no FK to lean on here — CITIES is a TypeScript table, by design.
  const citySlug = String(formData.get('citySlug') ?? '')
  if (!CITIES.some((city) => city.slug === citySlug)) return { error: 'Pick a city from the list.' }

  await db.execute(sql`update profiles set city_slug = ${citySlug} where id = ${auth.id}::uuid`)
  revalidatePath('/bookings')
  return { ok: true, message: 'Home city saved.' }
}
```

- [ ] **Step 3: Write the tests**

Create `tests/profile/actions.test.ts`. These test validation and the query round trip against the hosted DB.

**Use the project's existing fixtures — do not hand-roll the insert.** `tests/helpers/fixtures.ts` already exports `seedPlayer()` and `teardownFixtures()`, and a raw `insert into auth.users (id, email)` fails: that table also requires `instance_id`, `aud` and `role` (see `tests/auth/guards.test.ts`'s own `seedUser` for the full shape). `seedPlayer()` handles all of it and registers the row for teardown, which is what keeps this suite re-runnable against the shared persistent database.

Read `tests/helpers/fixtures.ts` before writing this file to confirm `seedPlayer`'s exact return type, and follow the teardown pattern its existing consumers use.

```ts
import { expect, test, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedPlayer, teardownFixtures } from '../helpers/fixtures'
import { getPlayerProfileFields, getPlayerCitySlug } from '@/lib/profile/queries'
import { CITIES } from '@/lib/geo/cities'
import { normalizePhPhone } from '@/lib/profile/phone'

let userId: string

afterAll(teardownFixtures)

test('a fresh profile reports every field null', async () => {
  userId = await seedPlayer()
  const fields = await getPlayerProfileFields(userId)
  expect(fields).toEqual({ fullName: null, phone: null, citySlug: null })
})

test('getPlayerCitySlug round-trips a city written to the column', async () => {
  await db.execute(sql`update profiles set city_slug = 'cebu-city' where id = ${userId}::uuid`)
  expect(await getPlayerCitySlug(userId)).toBe('cebu-city')
  const fields = await getPlayerProfileFields(userId)
  expect(fields.citySlug).toBe('cebu-city')
})

test('a malformed id returns nulls instead of raising 22P02', async () => {
  expect(await getPlayerCitySlug('not-a-uuid')).toBeNull()
  expect(await getPlayerProfileFields('not-a-uuid')).toEqual({
    fullName: null,
    phone: null,
    citySlug: null,
  })
})

test('every slug the city action would accept exists in CITIES', () => {
  // The action's gate is `CITIES.some(...)`; this pins the vocabulary it
  // enforces so a renamed slug cannot silently widen or narrow it.
  expect(CITIES.some((city) => city.slug === 'cebu-city')).toBe(true)
  expect(CITIES.some((city) => city.slug === 'atlantis')).toBe(false)
})

test('the phone the action would store is always canonical', () => {
  expect(normalizePhPhone('0917 123 4567')).toBe('+639171234567')
  expect(normalizePhPhone('+6329123456')).toBeNull()
})
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/profile/actions.test.ts
```

Foreground, never backgrounded. Expected: all 5 PASS. A timeout rather than an assertion failure is a pool-contention flake on this shared hosted database — re-run the single file to confirm before reporting it as a failure.

- [ ] **Step 5: Confirm the action-coverage test still passes**

```bash
npx vitest run tests/auth/action-coverage.test.ts
```

Expected: PASS. This proves the new `'use server'` file is recognized as guarded. If it fails naming `profile-actions.ts`, the guard reference was lost — fix the action, never the test.

- [ ] **Step 6: Confirm the suite is re-runnable**

The real requirement is that this suite passes twice in a row against the shared persistent database, so just run it again:

```bash
npx vitest run tests/profile/actions.test.ts
```

Expected: PASS a second time, with the same results.

Do **not** verify cleanup by counting `player-%@example.test` rows globally — that pattern is shared by every fixture-using suite in the project, and the database already carries orphaned rows from earlier interrupted runs, so the count is meaningless as a signal. `teardownFixtures` tracks the ids it created; a second green run is the honest proof.

- [ ] **Step 7: Gate and report**

```bash
npx tsc --noEmit && npx eslint
```

Report: both suites passing, the cleanup count, and the clean gate. Do not commit.

- [ ] **Step 8: Extract the writes so they can actually be tested**

**Added 2026-08-08 by user ruling, after review.** Steps 1–7 left the three actions' authorization, validation and SQL inlined in the `'use server'` file, where nothing tests them: the suite from Step 3 only exercises the read queries and two pure functions. A broken implementation — an id read from `FormData` instead of the guard's return, a dropped `.trim()`, a catch clause that lets a non-player through — would pass every test untouched. This is the plan's only security-sensitive task, so that gap gets closed.

This mirrors a pattern this codebase already uses: `src/app/dashboard/settings/actions.ts` keeps only the guard in the `'use server'` file and delegates validation and SQL to `src/lib/owner/settings.ts`, whose plain id-parameterized functions `tests/owner/settings.test.ts` unit-tests directly. **Read both of those files first** and follow their shape.

Create `src/lib/profile/write.ts`:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { CITIES } from '@/lib/geo/cities'
import { normalizePhPhone } from '@/lib/profile/phone'

/**
 * The three profile writes, as plain functions taking an ALREADY-AUTHORIZED
 * player id.
 *
 * Split out of src/app/bookings/profile-actions.ts so this logic is directly
 * testable: a 'use server' action can only be exercised through a mocked
 * session, so inlined validation goes untested and a future edit can break
 * authorization or validation with nothing failing. Same split, and same
 * reason, as src/lib/owner/settings.ts.
 *
 * `playerId` is the guard's return value and NEVER anything read from
 * FormData — a caller that passes a user-supplied id would let one player
 * write another's profile. That contract is this module's whole security
 * assumption, which is exactly why it is worth a test of its own.
 *
 * Each takes `raw: unknown`, not `string`. FormData.get() returns
 * `string | File | null`, and `String(someFile)` yields the literal
 * "[object File]" — non-empty, under the length cap, and silently storable as
 * a player's name. Rejecting a non-string here, in the tested layer, closes
 * that instead of trusting the caller to coerce correctly.
 */
export type ProfileWriteResult = { ok: true } | { ok: false; error: string }

export const NAME_MAX = 80

export async function setFullName(playerId: string, raw: unknown): Promise<ProfileWriteResult> {
  if (typeof raw !== 'string') return { ok: false, error: 'Enter your name.' }
  const fullName = raw.trim()
  if (fullName.length === 0) return { ok: false, error: 'Enter your name.' }
  if (fullName.length > NAME_MAX) {
    return { ok: false, error: `Keep your name under ${NAME_MAX} characters.` }
  }
  await db.execute(sql`update profiles set full_name = ${fullName} where id = ${playerId}::uuid`)
  return { ok: true }
}

export async function setPhone(playerId: string, raw: unknown): Promise<ProfileWriteResult> {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Enter a Philippine mobile number, like 0917 123 4567.' }
  }
  // Normalized, never stored as typed: one person's number gets exactly one
  // representation. Null means it is not a PH mobile.
  const phone = normalizePhPhone(raw)
  if (phone === null) {
    return { ok: false, error: 'Enter a Philippine mobile number, like 0917 123 4567.' }
  }
  await db.execute(sql`update profiles set phone = ${phone} where id = ${playerId}::uuid`)
  return { ok: true }
}

export async function setCitySlug(playerId: string, raw: unknown): Promise<ProfileWriteResult> {
  // The closed set is the gate: a slug outside CITIES never reaches SQL. There
  // is no FK to lean on — the city table is TypeScript, by deliberate design.
  if (typeof raw !== 'string' || !CITIES.some((city) => city.slug === raw)) {
    return { ok: false, error: 'Pick a city from the list.' }
  }
  await db.execute(sql`update profiles set city_slug = ${raw} where id = ${playerId}::uuid`)
  return { ok: true }
}
```

- [ ] **Step 9: Thin the actions down to guard + delegate + revalidate**

Rewrite the three actions in `src/app/bookings/profile-actions.ts` so each does exactly four things: resolve the guard, read its one field off `FormData`, delegate, and revalidate. No validation logic and no SQL may remain in this file. Keep `ProfileFormState`, keep `playerIdOrError`, keep the comment explaining why `requirePlayer` (not `requireUser`) is correct, and keep the note about `tests/auth/action-coverage.test.ts`. Pass `formData.get('…')` through **unchanged** — do not wrap it in `String(...)`; rejecting a non-string is now `write.ts`'s job and its test's.

The success messages stay where they are (they are UI copy, not validation): `'Name saved.'`, `'Mobile number saved.'`, `'Home city saved.'`.

- [ ] **Step 10: Write the tests that were missing**

Create `tests/profile/write.test.ts`. Use `seedPlayer()` and `teardownFixtures()` from `tests/helpers/fixtures.ts` exactly as `tests/profile/actions.test.ts` does. Cover, at minimum:

```ts
// Two players, so the id-scoping test below is meaningful.
test('setFullName trims and stores a valid name')
test('setFullName rejects an empty or whitespace-only name, and writes nothing')
test('setFullName rejects a name over NAME_MAX, and writes nothing')
test('setFullName rejects a non-string (a File coerces to "[object File]" otherwise)')
test('setPhone stores the normalized form, not what was typed')
test('setPhone rejects a non-PH-mobile, and writes nothing')
test('setCitySlug stores a slug that is in CITIES')
test('setCitySlug rejects a slug outside CITIES, and writes nothing')
test('each write touches ONLY the player id it was given, never another player')
```

Two of these carry most of the value and must not be skipped. **The "writes nothing" assertions** — read the row back after a rejected call and assert it is unchanged, since a validation bug that returns an error *and* writes is exactly what a return-value-only assertion misses. **The id-scoping test** — seed two players, write to the first, assert the second's row is untouched; that is the test standing in for the authorization contract this module assumes.

For the non-string case, construct a real `File` (`new File(['x'], 'x.txt')`) rather than a plain object, so the test pins the actual failure mode.

- [ ] **Step 11: Run everything and re-gate**

```bash
npx vitest run tests/profile/ tests/auth/action-coverage.test.ts
```

Foreground. Expected: the new `write.test.ts` passes, the existing `actions.test.ts` still passes **unchanged**, and action-coverage still passes — the last one proves the thinned action file still mentions its guard. Then:

```bash
npx tsc --noEmit && npx eslint
```

Run `npx vitest run tests/profile/` a second time to confirm the new suite is re-runnable against the shared persistent database.

---

### Task 4: The checklist panel

**Files:**
- Create: `src/components/player/profile-completion-panel.tsx`
- Modify: `src/app/bookings/page.tsx`

**Interfaces:**
- Consumes: `profileCompletion`, `ProfileStep` (Task 2); `updateFullNameAction`, `updatePhoneAction`, `updateCityAction`, `ProfileFormState` (Task 3); `getPlayerProfileFields` (Task 3); `CITIES` (Task 1).
- Produces: `<ProfileCompletionPanel fullName phone citySlug />` — a client component taking three plain nullable strings.

- [ ] **Step 1: Read the design source of truth**

Read `design/branding.md` in full before writing any class. The panel uses the **Panel** variant of the card recipe (white, `border-radius: 20px`, no border, `--shadow-sm`) — explicitly **not** an entity card: no cover photo, no hover lift, no stretched link. That distinction is documented there and is a real review criterion in this project.

- [ ] **Step 2: Build the panel**

Create `src/components/player/profile-completion-panel.tsx`. It is a client component; `/bookings` is a Server Component that reads the fields and passes them as props.

```tsx
'use client'

import { useActionState, useState } from 'react'
import { CITIES } from '@/lib/geo/cities'
import { profileCompletion, type ProfileStepKey } from '@/lib/profile/completion'
import {
  updateCityAction,
  updateFullNameAction,
  updatePhoneAction,
  type ProfileFormState,
} from '@/app/bookings/profile-actions'

/**
 * The player's ONLY profile surface. `/dashboard/settings` is owner-only and
 * there is no `/account` page, so this panel is where a player's name, mobile
 * number and home city are both shown and edited.
 *
 * That is why it does NOT disappear at 100%: it collapses to a single line
 * with an Edit toggle instead. A vanishing panel would leave a player unable to
 * ever change the city they just set. If an `/account` page is built later,
 * revisit this.
 */
const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)] max-[560px]:p-5'
const KICKER = 'font-mono text-[11px] uppercase tracking-[.14em] text-[var(--court)]'
const LABEL = 'mb-1.5 block text-[13px] font-semibold text-[var(--ink)]'
const FIELD =
  'h-[var(--btn-h-sm)] w-full rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-3 text-sm text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--court)]'
const SAVE =
  'font-display inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] bg-[var(--ink)] px-4 text-[13px] font-bold text-[var(--ball)] transition-[filter,transform] duration-150 hover:brightness-[1.15] active:scale-[.98] motion-reduce:transition-none disabled:opacity-60'
const ROW =
  'flex w-full items-center gap-2.5 py-2 text-left text-sm text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--court)]'

function Tick({ done }: { done: boolean }) {
  return done ? (
    <span
      aria-hidden
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--court)] text-[11px] font-bold text-white"
    >
      ✓
    </span>
  ) : (
    <span
      aria-hidden
      className="h-[18px] w-[18px] shrink-0 rounded-full border-[1.5px] border-dashed border-[var(--hairline)]"
    />
  )
}

function Message({ state }: { state: ProfileFormState }) {
  if (!state) return null
  return 'error' in state ? (
    <p className="mt-2 text-[13px] text-[#8A4A1E]">{state.error}</p>
  ) : (
    <p className="mt-2 text-[13px] text-[var(--court)]">{state.message}</p>
  )
}

function NameForm({ fullName }: { fullName: string | null }) {
  const [state, action, pending] = useActionState<ProfileFormState, FormData>(
    updateFullNameAction,
    null,
  )
  return (
    <form action={action} className="mt-1 mb-3 flex flex-col gap-2">
      <div>
        <label className={LABEL} htmlFor="profile-full-name">
          Your name
        </label>
        <input
          id="profile-full-name"
          name="fullName"
          type="text"
          required
          maxLength={80}
          defaultValue={fullName ?? ''}
          placeholder="Ana Cruz"
          className={FIELD}
        />
      </div>
      <div>
        <button type="submit" disabled={pending} className={SAVE}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <Message state={state} />
    </form>
  )
}

function PhoneForm({ phone }: { phone: string | null }) {
  const [state, action, pending] = useActionState<ProfileFormState, FormData>(
    updatePhoneAction,
    null,
  )
  return (
    <form action={action} className="mt-1 mb-3 flex flex-col gap-2">
      <div>
        <label className={LABEL} htmlFor="profile-phone">
          Mobile number
        </label>
        <input
          id="profile-phone"
          name="phone"
          type="tel"
          required
          inputMode="tel"
          defaultValue={phone ?? ''}
          placeholder="0917 123 4567"
          className={FIELD}
        />
      </div>
      <div>
        <button type="submit" disabled={pending} className={SAVE}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <Message state={state} />
    </form>
  )
}

function CityForm({ citySlug }: { citySlug: string | null }) {
  const [state, action, pending] = useActionState<ProfileFormState, FormData>(updateCityAction, null)
  return (
    <form action={action} className="mt-1 mb-3 flex flex-col gap-2">
      <div>
        <label className={LABEL} htmlFor="profile-city">
          Home city
        </label>
        <select
          id="profile-city"
          name="citySlug"
          required
          defaultValue={citySlug ?? ''}
          className={`select-chevron-dark ${FIELD}`}
        >
          <option value="" disabled>
            Choose your city
          </option>
          {CITIES.map((city) => (
            <option key={city.slug} value={city.slug}>
              {city.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <button type="submit" disabled={pending} className={SAVE}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <Message state={state} />
    </form>
  )
}

export function ProfileCompletionPanel(props: {
  fullName: string | null
  phone: string | null
  citySlug: string | null
}) {
  const { steps, doneCount, total, percent } = profileCompletion(props)
  const complete = doneCount === total
  // At 100% everything starts collapsed behind Edit; while incomplete the
  // first unfinished step is open, so the panel always has one obvious action.
  const [open, setOpen] = useState<ProfileStepKey | null>(
    complete ? null : (steps.find((step) => !step.done)?.key ?? null),
  )
  const [editing, setEditing] = useState(false)

  if (complete && !editing) {
    return (
      <section aria-label="Profile" className={`${CARD} mb-6 flex items-center gap-3`}>
        <Tick done />
        <p className="flex-1 text-sm font-semibold text-[var(--ink)]">Profile complete</p>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-sm font-semibold text-[var(--court)] hover:text-[var(--court-deep)]"
        >
          Edit
        </button>
      </section>
    )
  }

  return (
    <section aria-label="Profile completion" className={`${CARD} mb-6`}>
      <span className={KICKER}>Your profile</span>
      <h2 className="font-display mt-1.5 text-[22px] font-bold tracking-[-0.02em] text-[var(--ink)]">
        {complete ? 'Profile complete' : 'Complete your profile'}
      </h2>

      <div className="mt-3 flex items-center gap-3">
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Profile completion"
          className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--band-off)]"
        >
          <div className="h-full rounded-full bg-[var(--court)]" style={{ width: `${percent}%` }} />
        </div>
        <span className="font-mono text-[12px] whitespace-nowrap text-[var(--ink-soft)]">
          {percent}% · {doneCount} of {total}
        </span>
      </div>

      <p className="mt-3 max-w-[520px] text-[13.5px] text-[var(--ink-soft)]">
        Your city sets where your searches start, so you see courts you can actually reach. Your
        phone lets a court reach you about a booking.
      </p>

      <ul className="mt-3 divide-y divide-[var(--hairline)]">
        {steps.map((step) => (
          <li key={step.key}>
            <button
              type="button"
              className={ROW}
              aria-expanded={open === step.key}
              onClick={() => setOpen(open === step.key ? null : step.key)}
            >
              <Tick done={step.done} />
              <span className="flex-1">{step.label}</span>
              <span aria-hidden className="text-[var(--ink-soft)]">
                {open === step.key ? '−' : '+'}
              </span>
            </button>
            {open === step.key && step.key === 'full_name' && <NameForm fullName={props.fullName} />}
            {open === step.key && step.key === 'phone' && <PhoneForm phone={props.phone} />}
            {open === step.key && step.key === 'city' && <CityForm citySlug={props.citySlug} />}
          </li>
        ))}
      </ul>
    </section>
  )
}
```

- [ ] **Step 3: Render it on the dashboard**

In `src/app/bookings/page.tsx`, import the panel and the query, then render the panel directly above the stat-card grid (currently around line 68, the `<StatCard kicker="Upcoming" …>` row):

```tsx
import { ProfileCompletionPanel } from '@/components/player/profile-completion-panel'
import { getPlayerProfileFields } from '@/lib/profile/queries'
```

After the existing `getPlayerDashboard` call:

```tsx
const profile = await getPlayerProfileFields(user.id)
```

And immediately before the stat-card grid:

```tsx
<ProfileCompletionPanel
  fullName={profile.fullName}
  phone={profile.phone}
  citySlug={profile.citySlug}
/>
```

- [ ] **Step 4: Verify the client/server boundary did not break the page**

This is the check that catches the trap in the Global Constraints — a bad import type-checks and lints clean, then 500s only at runtime.

```bash
npx tsc --noEmit && npx eslint
```

Then start the dev server with the preview tool and request the page. `/bookings` redirects when signed out, which is itself proof the module graph loaded — a `server-only` violation throws a 500 *before* the redirect:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -L http://localhost:3000/bookings
```

Expected: `200` (the login page after redirect), **never** `500`. Also check the dev server logs for "You're importing a module that depends on 'server-only'" — that string appearing is a failure even if the status code looks fine.

- [ ] **Step 5: Verify the panel renders, without claiming a visual check you cannot make**

`/bookings` requires a signed-in player and this project has **no dev login**, so an agent cannot see the panel. Do NOT claim you did. Instead prove the component renders correctly at every completion level by asserting on its output directly — create `tests/components/profile-completion-panel.test.tsx` only if this project already has a component-test setup; **check first**:

```bash
ls tests/components 2>/dev/null; grep -n 'jsdom\|happy-dom\|environment' vitest.config.ts 2>/dev/null
```

If there is no DOM test environment configured, do **not** add one for this task — say so in your report, and record that the panel's rendering is unverified and needs the user to confirm it in a browser while signed in. Adding a whole test environment is its own task, not a step inside this one.

- [ ] **Step 6: Report**

Report: the `tsc`/`eslint` result, the `/bookings` status code, an explicit statement of whether a DOM test environment exists, and — plainly — that the panel's appearance is unverified pending the user's own check. Do not commit.

---

### Task 5: Seed the Where field from the player's city

**Files:**
- Modify: `src/lib/search/params.ts`, `src/app/search/page.tsx`, `src/app/page.tsx`
- Test: `tests/lib/search/params.test.ts`

**Interfaces:**
- Consumes: `getPlayerCitySlug` (Task 3), `CITIES` (Task 1).
- Produces: `parseSearchParams(params, fallbackCitySlug?: string | null)` — the second parameter is optional, so every existing caller and test is unaffected.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/search/params.test.ts`:

```ts
test('a valid fallback city is used when the URL names no city', () => {
  const parsed = parseSearchParams({}, 'cebu-city')
  expect(parsed.citySlug).toBe('cebu-city')
})

test('an explicit ?city= always beats the fallback', () => {
  // A shared link must show the recipient the same city it showed the sender.
  const parsed = parseSearchParams({ city: 'davao-city' }, 'cebu-city')
  expect(parsed.citySlug).toBe('davao-city')
})

test('an unknown fallback falls through to the default city', () => {
  expect(parseSearchParams({}, 'atlantis').citySlug).toBe(DEFAULT_CITY_SLUG)
  expect(parseSearchParams({}, null).citySlug).toBe(DEFAULT_CITY_SLUG)
  expect(parseSearchParams({}, undefined).citySlug).toBe(DEFAULT_CITY_SLUG)
})

test('omitting the fallback entirely behaves exactly as before', () => {
  expect(parseSearchParams({}).citySlug).toBe(DEFAULT_CITY_SLUG)
})
```

Ensure `DEFAULT_CITY_SLUG` is imported in that test file; add it to the existing import from `@/lib/geo/cities` if it is not already there.

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run tests/lib/search/params.test.ts
```

Expected: the first test FAILS (`citySlug` is `'tacloban'`, not `'cebu-city'`) because the parameter does not exist yet.

- [ ] **Step 3: Add the optional fallback**

In `src/lib/search/params.ts`, change the signature and the `citySlug` resolution. The existing line is:

```ts
const citySlug = CITIES.some((c) => c.slug === one('city')) ? one('city')! : DEFAULT_CITY_SLUG
```

Replace with:

```ts
/**
 * `fallbackCitySlug` is the signed-in player's home city (profiles.city_slug),
 * passed by /search and the home hero. It only applies when the URL names no
 * valid city of its own: an explicit `?city=` ALWAYS wins, because a shared
 * link has to show the recipient the same city it showed the sender.
 *
 * Optional so every existing caller and test is unaffected, and so a
 * signed-out visitor keeps landing on DEFAULT_CITY_SLUG exactly as before.
 */
const known = (slug: string | null | undefined) =>
  typeof slug === 'string' && CITIES.some((c) => c.slug === slug)

const citySlug = known(one('city'))
  ? one('city')!
  : known(fallbackCitySlug)
    ? fallbackCitySlug!
    : DEFAULT_CITY_SLUG
```

and update the function signature to:

```ts
export function parseSearchParams(
  params: Record<string, string | string[] | undefined>,
  fallbackCitySlug?: string | null,
) {
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/lib/search/params.test.ts
```

Expected: every test passes, **including all the pre-existing ones**. If an old test broke, the optional parameter changed default behaviour — that is a real bug in the implementation, not a test to update.

- [ ] **Step 5: Fix the `.then` trap in `/search`**

`src/app/search/page.tsx` currently reads:

```ts
const parsed = await props.searchParams.then(parseSearchParams)
```

`Promise.prototype.then` invokes its callback with exactly **one** argument, so passing `parseSearchParams` by reference would silently ignore the new second parameter forever — type-checking clean the whole time. Restructure:

```ts
const user = await getOptionalUser()
const playerCitySlug = user ? await getPlayerCitySlug(user.id) : null
const parsed = parseSearchParams(await props.searchParams, playerCitySlug)
```

Add the imports for `getOptionalUser` (from `@/lib/auth/guards`) and `getPlayerCitySlug` (from `@/lib/profile/queries`) if absent.

- [ ] **Step 6: Seed the home hero's Where field**

`src/app/page.tsx` already calls `getOptionalUser()`. Add the city read beside it:

```ts
const playerCitySlug = user ? await getPlayerCitySlug(user.id) : null
```

Then change the `#home-search-city` select's `defaultValue` from `DEFAULT_CITY_SLUG` to:

```tsx
defaultValue={playerCitySlug ?? DEFAULT_CITY_SLUG}
```

Guard it the same way `parseSearchParams` does — if the stored slug is somehow not in `CITIES`, fall back rather than rendering a `<select>` with a `defaultValue` matching no option (React leaves such a select on its first option, silently showing the wrong city). Simplest correct form:

```tsx
defaultValue={CITIES.some((c) => c.slug === playerCitySlug) ? playerCitySlug! : DEFAULT_CITY_SLUG}
```

- [ ] **Step 7: Verify signed-out behaviour is untouched**

Both pages are public. With no session, nothing should change. Start the dev server, then:

```js
JSON.stringify({
  home: document.getElementById('home-search-city')?.value,
})
```

on `http://localhost:3000/`, and on `http://localhost:3000/search`:

```js
JSON.stringify({ search: document.getElementById('search-city')?.value, url: location.pathname })
```

Expected signed-out: both `tacloban`. A signed-in player's city cannot be checked by an agent (no dev login) — say so rather than claiming otherwise.

- [ ] **Step 8: Run the full search suites**

```bash
npx vitest run tests/lib/search/params.test.ts tests/branches/search.test.ts
```

Foreground. Expected: all pass.

- [ ] **Step 9: Gate and report**

```bash
npx tsc --noEmit && npx eslint
```

Report: the new tests passing, the pre-existing search tests passing unchanged, both signed-out select values, and the clean gate. Do not commit.

---

### Task 6: Final verification sweep

**Files:**
- Modify: none. If a check fails, **report it — do not fix it here.** A silent fix at this stage ships unreviewed.

- [ ] **Step 1: Confirm scope**

```bash
git status --short
```

Expected, and nothing else:
- `supabase/migrations/20260808000000_profile_city.sql`, `src/db/schema.ts` (regenerated)
- `src/lib/geo/cities.ts`, `src/lib/search/params.ts`
- `src/lib/profile/completion.ts`, `src/lib/profile/phone.ts`, `src/lib/profile/queries.ts`
- `src/app/bookings/profile-actions.ts`, `src/app/bookings/page.tsx`
- `src/components/player/profile-completion-panel.tsx`
- `src/app/page.tsx`, `src/app/search/page.tsx`
- new test files under `tests/`
- untracked docs under `docs/superpowers/`

Anything under `supabase/migrations/` other than the one new file, or any change to `src/lib/payments/`, is a scope violation — stop and report.

- [ ] **Step 2: Static gates**

```bash
npx tsc --noEmit && npx eslint
```

Expected: `tsc` silent, eslint 0 errors and no new warnings against the 9-warning baseline.

- [ ] **Step 3: Full test suite**

```bash
npx vitest run
```

Foreground, never backgrounded. Expected: all pass. Re-run any single file that fails on a timeout to distinguish a pool-contention flake from a real regression, and report which it was.

- [ ] **Step 4: Migration idempotency, once more**

```bash
npx supabase db push --db-url "$DATABASE_URL"
```

Expected: succeeds with nothing left to apply.

- [ ] **Step 5: Public pages still healthy**

`/` and `/search` are public and must not 500 — the most likely failure is a client/server import boundary violation introduced in Task 4 or 5.

```bash
curl -s -o /dev/null -w '/ %{http_code}\n' http://localhost:3000/
curl -s -o /dev/null -w '/search %{http_code}\n' 'http://localhost:3000/search?city=cebu-city'
curl -s -o /dev/null -w '/bookings %{http_code}\n' -L http://localhost:3000/bookings
```

Expected: `200` for all three. Check the dev server logs for `server-only` and for any unhandled error.

- [ ] **Step 6: Report**

Final report to the user:
- The city list grown from 2 to 15, and that `cities.ts`'s "no option returns nothing" promise was rewritten rather than left to become false
- All suites passing, with the count
- Which surfaces were verified and **which were not**: `/bookings` and the panel itself cannot be agent-verified without a dev login, so their appearance is unconfirmed and needs the user's own check while signed in
- The list of files changed
- That **nothing was committed**

---

## Notes for the executing agent

**You are the implementer.** Do not delegate any task in this plan to another subagent — implement it yourself, in the working directory. Do not create a git worktree.

**The two traps most likely to bite, both silent:**
1. A **client/server import boundary** violation in Task 4 (`tsc` and `eslint` stay clean; the page 500s only when requested).
2. The **`.then(parseSearchParams)`** call in Task 5 (adding a parameter changes nothing, with no error anywhere).

Both have explicit verification steps. Do not skip them because the code "looks right".

**Do not fix things you notice in passing.** The spec's "Out of scope" section lists avatar upload, an `/account` page, field visibility rules, and any use of the city beyond the two Where fields. Flag them in your report; do not implement them.
