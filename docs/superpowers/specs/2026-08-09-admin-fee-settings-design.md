# Admin fee settings

**Date:** 2026-08-09
**Status:** approved, ready for implementation
**Depends on:** `2026-08-09-admin-owners-directory-design.md`. Build that first —
this spec adds a control to the directory it creates.

## Problem

`platform_settings` and `processor_rates` were created in the very first
migration with sensible defaults and a comment describing them as admin-editable.
Nothing in `src/` has ever written to either. Grepping the whole tree for
`update platform_settings` or `update processor_rates` returns zero matches. The
platform fee, who absorbs the payment processor's cut, and how long a booking
hold survives are all set by hand-run SQL against production.

The per-owner override columns on `profiles` — `platform_fee_mode`,
`platform_fee_value`, `processor_fee_bearer`, complete with a pair constraint
and a passing schema test — have never been written by the application either.
They are correct, tested, dead schema.

## Decisions

| Question | Decision |
|---|---|
| Editable | `platform_settings` (all four fields) and the `profiles` overrides |
| Not editable | `processor_rates` — PayMongo's published pricing, not ours |
| Fee value input | **Two separate inputs**, percent and pesos; the mode picks one |
| New route | `/admin/settings`, with a "Settings" sidebar item |
| Override control | On each owner's card in `/admin/owners` |
| Percentage ceiling | A conditional DB CHECK, added by migration |
| Hold ceiling | TypeScript only — policy, not an invariant |
| Existing bookings | Untouched. Fees are snapshotted and never recomputed |

### Why `processor_rates` stays read-only

Those three rows mirror what PayMongo actually charges. They are not a lever the
business pulls; they are a fact the business records. They change when PayMongo
changes its pricing — roughly never — and the cost of a typo is silent and
uncapped: every subsequent transaction under-collects, and the webhook path
deliberately never re-reads the table (`src/lib/payments/webhook.ts:252` — "Never
from `processor_rates`, which an admin may have edited since"), so the error
would not even surface as a reconciliation mismatch. A migration is the honest
channel for a number the platform does not control.

### Why the fee value gets two inputs

`default_platform_fee_value` is a single `integer` whose **unit depends on
another column**: basis points when `default_platform_fee_mode = 'percentage'`,
centavos when it is `'flat'`. The schema comment says so; nothing enforces it.

A form with one value field and a mode radio is a trap. An admin looking at a
10% fee sees `1000` in the box, switches the radio to "Flat", saves, and has
just set a ₱10.00 flat fee — the number never changed, so nothing looked wrong.
The reverse is worse: a ₱15.00 flat fee (1500) flipped to percentage becomes a
15% cut of every booking.

So the form renders **two fields with their own units baked in** — a percent
field showing `10` and a pesos field showing `15.00` — and the mode radio
decides which one is read. The value's unit is unambiguous at every moment,
including mid-edit. The inactive field is `disabled`, so it submits nothing, and
the server independently reads only the field matching the submitted mode rather
than trusting that.

### Why the percentage ceiling is a DB constraint but the hold ceiling is not

A platform fee above 100% makes `owner_net = courtFee - platformFee` negative on
every booking (`src/lib/booking/hold.ts:274`). That is arithmetic, not policy —
no configuration should be able to express it, so it belongs in the database,
where this project keeps its logic.

The obvious constraint is wrong. `check (default_platform_fee_value <= 10000)`
would also cap a **flat** fee at 10000 centavos — ₱100 — which is a perfectly
ordinary flat booking fee. The dual-unit column defeats an unconditional check.
The constraint must be conditional on the mode:

```sql
check (default_platform_fee_mode is distinct from 'percentage'
       or default_platform_fee_value <= 10000)
```

The hold-duration ceiling is different in kind. There is nothing arithmetically
broken about a 300-minute hold; it is just a bad idea, because it ties a court
up far longer than a payment session lives. That is business policy, it will
change, and encoding it in a constraint means a migration to adjust a number
someone should be able to reconsider. It stays in TypeScript.

### Why editing fees cannot mutate the singleton in tests

`platform_settings` is a **seeded singleton in a shared, persistent database**,
and CLAUDE.md is explicit that tests must not mutate seeded singleton rows.
`tests/booking/hold.test.ts` reads that exact row concurrently to compute a
hold's fees and expiry. A test that updates the fee and restores it in a
`finally` still has a real window where a parallel test computes the wrong
`platform_fee_centavos` — a flake that would look like a fee bug.

So `updatePlatformSettings` takes an **optional executor**, defaulting to `db`.
The test passes a transaction handle, asserts inside the transaction, and rolls
back. Real SQL, real constraints, real round-trip, and read-committed isolation
means no concurrent reader ever sees the uncommitted value. The per-owner
override needs none of this — those rows are fixture-created.

### What changing a fee does and does not do

`createHold` reads `platform_settings` and the owner's overrides once, computes
the fees, and **writes them onto the booking row** along with a
`fee_config_snapshot` jsonb of the inputs. Nothing downstream ever recomputes —
`checkout.ts` says so directly: "A price change must never rewrite a live hold."

So editing these settings changes bookings created **after** the edit. Live
holds keep the terms they were quoted. Past bookings and their payouts are
untouched. This is correct, and it is the single most important thing an admin
needs to know before pressing Save, so the page states it rather than leaving it
to be discovered.

## Design

### 1. Migration — `supabase/migrations/20260809000000_fee_percentage_ceiling.sql`

```sql
alter table platform_settings drop constraint if exists platform_settings_percentage_ceiling;
alter table platform_settings add constraint platform_settings_percentage_ceiling
  check (default_platform_fee_mode is distinct from 'percentage'
         or default_platform_fee_value <= 10000);

alter table profiles drop constraint if exists profiles_fee_percentage_ceiling;
alter table profiles add constraint profiles_fee_percentage_ceiling
  check (platform_fee_mode is distinct from 'percentage'
         or platform_fee_value <= 10000);
```

`drop … if exists` then `add` makes the file **idempotent**, which this project
requires because `supabase db reset` is unavailable — prove it by applying twice
with `npx supabase db push --db-url "$DATABASE_URL"`.

`is distinct from` rather than `<>` because `profiles.platform_fee_mode` is
nullable: with a NULL mode, `mode <> 'percentage'` evaluates to NULL, and while
a NULL CHECK expression does pass, relying on that is a subtlety a future reader
should not have to reconstruct. `is distinct from` is true for NULL and says so.

Adding a CHECK validates existing rows. If any profile already holds a
percentage override above 10000 bps the migration fails loudly, which is the
right outcome — that row is charging over 100%.

After applying, regenerate types: `npx drizzle-kit pull`.

### 2. Unit conversion — `src/lib/money/units.ts` (new, import-free)

**This module must import nothing.** It is consumed by a `'use client'` form,
and this project has already shipped a page that type-checked and linted clean
then 500'd at runtime because a client component reached a module that
transitively imported `@/db`. Pure arithmetic over strings and integers only.

`PESOS_TO_CENTAVOS` currently lives in `src/lib/listings/schedule.ts:49`. **Move
it here** and update that file plus its two consumers in
`court-schedule-fields.tsx` to import from the new module. A money-units module
importing from a listings module would be backwards, and duplicating the
constant is worse. The existing listings tests prove the move broke nothing.

```ts
export const PESOS_TO_CENTAVOS = 100
export const BPS = 10_000

/** '10' | '10.5' | '10.55' | '10%' → 1000 | 1050 | 1055 | 1000. null if unusable. */
export function parsePercentToBps(raw: string): number | null

/** 1050 → '10.5'. For a form input's value: no symbol, no separators. */
export function formatBpsAsPercent(bps: number): string

/** '250' | '250.50' → 25000 | 25050 centavos. null if unusable. */
export function parsePesosToCentavos(raw: string): number | null

/** 25050 → '250.50'. For a form input's value: no ₱, no thousands separators. */
export function formatCentavosAsPesos(centavos: number): string
```

These format functions are **not** `formatPeso`. `formatPeso` renders money for
a human to read (`₱1,022.90`); these render a value for an `<input>` to hold and
round-trip. A `₱` or a thousands separator in an input value comes straight back
as unparseable on the next submit.

Parsing rules, identical in both parsers:

- Trim. Accept an optional single trailing `%` in the percent parser only.
- Reject anything not matching `^\d+(\.\d{1,2})?$` after that — **at most two
  decimal places**, no sign, no exponent, no separators. This regex runs
  *before* any arithmetic, so `'10.555'` is rejected rather than silently
  rounded to `1056`.
- Then `Math.round(Number(value) * 100)`. `Math.round` is load-bearing:
  `10.55 * 100` is `1054.9999999999999` in IEEE-754, and `Math.trunc` or a bare
  cast would yield `1054`. A test pins `'10.55' → 1055`.
- Reject `0` — both the platform fee and an owner override are constrained
  `> 0` in the database, and a zero fee is expressed by mode, not by value.
- The percent parser rejects anything above `10000` bps (100%), mirroring the
  new DB constraint.

Bounds that are policy, not invariants, live in the callers, not here:

- `MAX_HOLD_MINUTES = 120` and `MIN_HOLD_MINUTES = 1` in the settings module.
- `MAX_FLAT_FEE_CENTAVOS = 10_000_00` (₱10,000) as an obvious-typo guard on flat
  fees. It is a guard, not a business rule, and is stated as such in the code.

### 3. Settings read and write — `src/lib/admin/settings.ts` (new)

```ts
import 'server-only'

export type FeeMode = 'percentage' | 'flat'
export type ProcessorFeeBearer = 'player' | 'owner' | 'platform'

export type PlatformSettings = {
  feeMode: FeeMode
  feeValue: number            // bps when 'percentage', centavos when 'flat'
  processorFeeBearer: ProcessorFeeBearer
  holdDurationMinutes: number
  updatedOn: string           // 'YYYY-MM-DD', Manila
}

export async function getPlatformSettings(): Promise<PlatformSettings>
```

```sql
select default_platform_fee_mode::text  as fee_mode,
       default_platform_fee_value       as fee_value,
       default_processor_fee_bearer::text as bearer,
       hold_duration_minutes,
       to_char(updated_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as updated_on
from platform_settings
```

Enums cast `::text` on read, matching `getAdminCourts`. No `where` clause — the
singleton constraint means there is exactly one row, and `limit 1` would imply
otherwise.

```ts
/**
 * Structurally minimal so a Drizzle transaction handle satisfies it. If
 * `{ execute: typeof db.execute }` does not accept a `tx`, widen it to
 * `{ execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[] }> }`
 * rather than casting at the call site.
 */
export type SqlExecutor = { execute: typeof db.execute }

export type SettingsInput = {
  feeMode: FeeMode
  feeValue: number
  processorFeeBearer: ProcessorFeeBearer
  holdDurationMinutes: number
}

export type SettingsWriteResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_fee' | 'invalid_hold' }

export async function updatePlatformSettings(
  input: SettingsInput,
  exec: SqlExecutor = db,
): Promise<SettingsWriteResult>
```

Validation before the UPDATE, mirroring every constraint the database will
enforce plus the two policy bounds, so an admin gets a sentence rather than a
23514:

- `feeValue` an integer `> 0`; `≤ 10000` when `feeMode === 'percentage'`;
  `≤ MAX_FLAT_FEE_CENTAVOS` when `'flat'`.
- `holdDurationMinutes` an integer within `[1, 120]`.

Then one statement, always setting `updated_at`:

```sql
update platform_settings
set default_platform_fee_mode      = ${input.feeMode}::platform_fee_mode,
    default_platform_fee_value     = ${input.feeValue},
    default_processor_fee_bearer   = ${input.processorFeeBearer}::processor_fee_bearer,
    hold_duration_minutes          = ${input.holdDurationMinutes},
    updated_at                     = now()
where id
```

`where id` — the singleton's boolean primary key is itself the predicate, and it
is the same idiom the table's own `check (id)` uses.

**Per-owner override**, in the same module:

```ts
export type OwnerFeeOverride = {
  feeMode: FeeMode | null           // null with feeValue null = inherit
  feeValue: number | null
  processorFeeBearer: ProcessorFeeBearer | null   // null = inherit, independent
}

export type OverrideWriteResult =
  | { ok: true }
  | { ok: false; reason: 'no_such_owner' | 'invalid_fee' | 'unpaired_fee' }

export async function updateOwnerFeeOverride(
  ownerId: string,
  override: OwnerFeeOverride,
): Promise<OverrideWriteResult>
```

`profiles_fee_override_pair` requires mode and value both null or both set, so
`unpaired_fee` is checked in TypeScript first. `processor_fee_bearer` is
independently nullable and is **not** part of that pair — an owner can override
who absorbs the processor fee without overriding the platform fee, and the form
offers those as two separate controls.

The UPDATE is role-scoped and its row count is checked:

```sql
update profiles
set platform_fee_mode    = ${mode}::platform_fee_mode,
    platform_fee_value   = ${value},
    processor_fee_bearer = ${bearer}::processor_fee_bearer
where id = ${ownerId}::uuid and role in ('owner', 'admin')
```

Zero rows updated returns `no_such_owner`. The `role in (…)` is not decoration:
without it an admin could pin a fee override onto a player's profile, where it
would sit invisible and inert until that player was ever promoted, at which
point it would silently take effect.

Note the nulls must be typed in SQL (`${null}::platform_fee_mode`) or Postgres
cannot infer the parameter type.

### 4. The settings page — `src/app/admin/settings/`

`page.tsx` — `requireAdminPage('/admin/settings')`, `getPlatformSettings()`,
renders the form with current values plus a "Last changed" line.

Above the form, a panel stating the snapshot invariant in plain English: changes
apply to bookings made from now on; holds in progress and past bookings keep the
fee they were sold under. This is a `<section aria-label>`'d panel in the
`--band-off` tone, matching the promote page's "Before you promote" precedent —
the same job, of stating consequences before the button rather than after it.

`settings-form.tsx` — `'use client'`, `useActionState`, reusing `FIELD`,
`LABEL`, `DARK_BUTTON` and `FormMessage` from
`@/app/dashboard/listings/form-ui`, exactly as `promote-form.tsx` does.

- Fee mode: two radios in a `<fieldset>` with a `<legend>`.
- Percent input and pesos input, both rendered, each labelled with its unit. A
  `useState` mirrors the selected mode and `disabled`s the inactive one — a
  disabled input submits nothing, so an inactive field cannot reach the server
  at all. This is the one piece of genuine client state on the page.
- Processor fee bearer: three radios, each with a one-line explanation of who
  ends up paying, since the words `player` / `owner` / `platform` alone do not
  convey it.
- Hold duration: a number input, `min=1 max=120`, with the range in its help
  text as well as the attributes — HTML validation is a convenience, not the
  boundary.

`actions.ts` — `'use server'`, `updateSettingsAction(prevState, formData)`
returning the existing `AdminFormState` shape
(`{ ok: true; message } | { error } | null`). It calls `refuseUnlessAdmin()`
first, parses through the units module, maps each typed failure reason to a
human sentence, and on success `revalidatePath('/admin/settings')`.

`refuseUnlessAdmin` currently lives inside `src/app/admin/actions.ts` and is not
exported. Export it and import it here rather than writing a second copy — a
duplicated auth guard is the kind of thing that gets fixed in one place only.

**Sidebar:** add `{ href: '/admin/settings', label: 'Settings', badge: 0 }` to
the `items` array in `src/app/admin/layout.tsx`, after Owners.

### 5. The per-owner override control — `/admin/owners`

`getAdminOwners` (from the sibling spec) gains three fields on `AdminOwnerRow`,
selected in its query 1:

```ts
  feeMode: FeeMode | null
  feeValue: number | null
  processorFeeBearer: ProcessorFeeBearer | null
```

Each owner card gains a fee line reading the **effective** terms — the override
when set, otherwise "Platform default" naming the inherited value — and a small
form:

- A fee select: `Platform default` / `Custom percentage` / `Custom flat fee`,
  plus the corresponding value input.
- A bearer select: `Platform default` / `Player pays` / `Owner pays` /
  `Platform pays`.
- Save.

`src/app/admin/owners/owner-fee-form.tsx`, `'use client'`, one instance per
owner with the owner's id in a hidden field. `updateOwnerFeeOverrideAction` is
added to the existing `src/app/admin/actions.ts` beside `promoteOwnerAction`,
guarded by `refuseUnlessAdmin()` and validating the id with the existing
`idFrom()` helper. On success, `revalidatePath('/admin/owners')`.

Choosing `Platform default` for the fee submits a cleared override — both
columns to null, satisfying the pair constraint.

## Testing

### `tests/lib/money/units.test.ts` — pure, no database

The parsers are where a wrong answer becomes wrong money, and they cost
nothing to test exhaustively.

- `'10' → 1000`, `'10.5' → 1050`, `'0.01' → 1`, `'100' → 10000`.
- **`'10.55' → 1055`** — the IEEE-754 case. Without `Math.round` this is 1054.
- `'10%' → 1000`; `'10 %' → 1000` after trim; `'%10' → null`.
- `'10.555' → null` (three decimals), `'' → null`, `'abc' → null`, `'-5' → null`,
  `'1e2' → null`, `'1,000' → null`, `'0' → null`.
- `'100.01' → null` and `'101' → null` — above the 100% ceiling.
- `parsePesosToCentavos('250.50') → 25050`; `'250' → 25000`; `'0' → null`.
- Round-trip both directions: `formatBpsAsPercent(1050) === '10.5'`,
  `formatBpsAsPercent(1000) === '10'`, `formatCentavosAsPesos(25050) === '250.50'`,
  `formatCentavosAsPesos(25000) === '250'`, and each re-parses to the original
  integer. A format function whose output its own parser rejects is the bug this
  catches.
- Neither format function emits `₱` or a thousands separator.

### `tests/admin/settings.test.ts` — hosted database, foreground

- `getPlatformSettings` returns the singleton with `feeValue` and
  `holdDurationMinutes` as JavaScript **numbers**, not strings, and `feeMode`
  and `processorFeeBearer` as the enum's text values.
- `updatePlatformSettings` **inside a transaction that is rolled back**: pass the
  `tx` handle, write values different from the current ones, read back inside
  the transaction, assert every field changed and `updated_at` advanced. Then,
  **after** the rollback, re-read the singleton through `db` and assert it is
  byte-for-byte what it was before the test. That last assertion is not
  redundant — it is what proves the test is safe to run against a shared
  database, and it must fail if someone later changes the function to ignore
  its executor.
- Validation rejects, without touching the database: `feeValue` 0, negative,
  10001 in percentage mode, non-integer; `holdDurationMinutes` 0, 121,
  non-integer. Each returns the typed reason, not a throw.
- The new DB constraint is real: inside a rolled-back transaction, raw SQL
  setting `default_platform_fee_value = 10001` with mode `'percentage'` rejects,
  and the same value with mode `'flat'` **succeeds** — the second half is what
  proves the constraint is conditional rather than a blanket cap.
- `updateOwnerFeeOverride` against a `seedOwner()` fixture: set a percentage
  override and read it back; set a flat override; clear it and read back three
  nulls; set only the bearer, leaving the fee pair null; reject an unpaired fee
  (mode without value) before it reaches the database; reject 10001 bps.
- `updateOwnerFeeOverride` against a `seedPlayer()` returns `no_such_owner` and
  leaves that profile's three columns null. Both halves — a guard that returns
  the right word while still writing the row is not a guard.

### Existing suites

Must pass unchanged, with two knowingly-excepted files:

- `tests/schema/settings.test.ts` and `tests/booking/hold.test.ts` **already
  fail** because both assert `hold_duration_minutes` is 15 while the hosted
  database holds 5. They are pre-existing, out of scope, and must be left
  exactly as they are. Do not "fix" either by using the new settings page to
  change the live value — that is mutating shared data to satisfy a stale
  assertion.
- `tests/listings/write.test.ts` also fails for an unrelated pre-existing reason
  (a leaked fixture slug). Leave it.

`tests/schema/profiles.test.ts` exercises `profiles_fee_override_pair` directly
and must still pass after the new ceiling constraint is added — if it does not,
the new constraint is wrong.

## Verification

- `npx tsc --noEmit` and `npx eslint` clean. Baseline: **9 warnings, 0 errors**.
- The migration applies **twice** cleanly against `$DATABASE_URL`. Run it twice
  and show both results; this project cannot `supabase db reset`, so idempotency
  is proved by repetition, not by a fresh database.
- `npx drizzle-kit pull` after the migration, and `tsc` still clean afterwards.
- Full suite in the **foreground**. Expect exactly the three known pre-existing
  failures above and no others.
- `/admin/**` is **behind auth and cannot be browser-verified by an agent** —
  this project has no dev login. The two-input fee control, the disabled-field
  behaviour, and the radios must be confirmed by the user or reported explicitly
  as unverified. Do not claim a visual check that did not happen.

## Out of scope

- Editing `processor_rates` from the app.
- An audit log of who changed a fee and when. `updated_at` records that it
  changed, not by whom; a real audit trail is its own design.
- Retroactively repricing existing bookings or holds. Nothing in this spec may
  write to `bookings`, and the snapshot behaviour must not change.
- Per-branch fee overrides. The schema supports per-owner only.
- Any change to `src/lib/payments/fees.ts`, `hold.ts`, `checkout.ts` or
  `webhook.ts`. This spec changes what those modules read, never how they
  compute.
