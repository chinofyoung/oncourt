# Admin Fee Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin edit the platform fee, who absorbs the payment processor's cut, and the booking hold duration — plus set a per-owner override — through the app instead of hand-run SQL.

**Architecture:** A conditional CHECK constraint added by migration, a pure import-free unit-conversion module, one server-only settings module holding both writes, a new `/admin/settings` page, and a small override form on each owner card in the directory.

**Tech Stack:** Next.js App Router (TypeScript), Postgres via `db.execute(sql\`...\`)`, Server Actions with `useActionState`, Tailwind CSS v4, Vitest against a hosted Supabase database.

**Spec:** `docs/superpowers/specs/2026-08-09-admin-fee-settings-design.md`

**Depends on:** `docs/superpowers/plans/2026-08-09-admin-owners-directory.md` must be complete. Task 5 modifies files that plan creates.

## Global Constraints

- Data access is **server-only**. Every read/write goes through a Server Component, Server Action or Route Handler guarded by `requireAdmin` / `requireAdminPage`. TypeScript is the security boundary.
- SQL is written by hand and executed with `db.execute(sql\`...\`)`. **Never** the Drizzle query builder. Never import `src/db/schema.ts`.
- Money is stored as **integer centavos**, percentages as **integer basis points**. Never floats, never `numeric`.
- A module imported by a `'use client'` component must not transitively reach `@/db` or `server-only`. This project has already shipped a page that type-checked and linted clean, then 500'd at runtime for exactly that. Client components may only **type-import** from server modules.
- **Never** use the Tailwind class `outline-none` or `outline-hidden`. In Tailwind v4 it compiles to an ungated `--tw-outline-style: none` that `focus-visible:outline-*` reads back through `var()`, silently killing the focus ring.
- Read `design/branding.md` before writing any markup, and follow it.
- All user-facing copy is **English only**. Currency is PHP (₱).
- Migrations apply with `npx supabase db push --db-url "$DATABASE_URL"` (the CLI is not linked). `supabase db reset` is **unavailable** — prove idempotency by applying the migration twice. After a migration, regenerate types with `npx drizzle-kit pull`.
- Connect only through the Supavisor **session** pooler on port **5432**. Never 6543.
- Tests run against a **hosted, shared, persistent** database. No reset between runs: tests must pass on repeated runs and **must not mutate seeded singleton rows**. `platform_settings` is exactly such a row.
- Run vitest in the **foreground** only. Never with `run_in_background`.
- **Three test files already fail** for pre-existing, unrelated reasons and must be left exactly as they are: `tests/schema/settings.test.ts`, `tests/booking/hold.test.ts` (both assert `hold_duration_minutes` is 15 while the database holds 5), and `tests/listings/write.test.ts`. Do **not** "fix" the first two by changing the live setting — that is mutating shared data to satisfy a stale assertion.
- Verification baseline: `npx tsc --noEmit` clean, `npx eslint .` → **9 warnings, 0 errors**.
- `/admin/**` is behind auth and **cannot be browser-verified** — no dev login exists. Never claim a visual check that did not happen.
- Do NOT run any state-changing git command. The user commits. Where a step says "commit", stop and report instead.

---

### Task 1: The percentage-ceiling constraint

**Files:**
- Create: `supabase/migrations/20260809000000_fee_percentage_ceiling.sql`
- Modify: `src/db/schema.ts` (regenerated, not hand-edited)

**Interfaces:**
- Produces: two CHECK constraints that Task 3's tests assert against.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260809000000_fee_percentage_ceiling.sql`:

```sql
-- A platform fee above 100% makes owner_net = courtFee - platformFee negative
-- on every booking (src/lib/booking/hold.ts). That is arithmetic, not policy,
-- so no configuration may express it.
--
-- The obvious `check (value <= 10000)` is WRONG: default_platform_fee_value is
-- dual-unit — basis points when the mode is 'percentage', centavos when it is
-- 'flat' — so an unconditional cap would also forbid a ₱100 flat fee, which is
-- perfectly ordinary. The check must be conditional on the mode.
--
-- `is distinct from` rather than `<>` because profiles.platform_fee_mode is
-- nullable: with a NULL mode, `mode <> 'percentage'` evaluates to NULL. A NULL
-- CHECK expression does pass, but relying on that is a subtlety a future reader
-- should not have to reconstruct.
--
-- drop-if-exists then add makes this file idempotent. `supabase db reset` is
-- unavailable on this project, so idempotency is proved by applying twice.

alter table platform_settings drop constraint if exists platform_settings_percentage_ceiling;
alter table platform_settings add constraint platform_settings_percentage_ceiling
  check (default_platform_fee_mode is distinct from 'percentage'
         or default_platform_fee_value <= 10000);

alter table profiles drop constraint if exists profiles_fee_percentage_ceiling;
alter table profiles add constraint profiles_fee_percentage_ceiling
  check (platform_fee_mode is distinct from 'percentage'
         or platform_fee_value <= 10000);
```

- [ ] **Step 2: Apply it, twice**

Run: `npx supabase db push --db-url "$DATABASE_URL"`
Then run the **same command again**.
Expected: both succeed. Paste both outputs into the report — this is the idempotency proof, and it is not optional.

If the first application fails with a check-violation on `profiles`, stop and report: some existing owner holds a percentage override above 100%, which is a real data problem this plan must not paper over.

- [ ] **Step 3: Regenerate types**

Run: `npx drizzle-kit pull`
Then: `npx tsc --noEmit` — expect clean.

`src/db/schema.ts` is excluded from `tsconfig.json` and nothing imports it. If `drizzle-kit pull` produces a diff to other files, report it rather than accepting it.

- [ ] **Step 4: Verify the constraints are live**

Run this one-off check and paste its output:

```bash
psql "$DATABASE_URL" -c "select conname from pg_constraint where conname in ('platform_settings_percentage_ceiling','profiles_fee_percentage_ceiling')"
```

If `psql` is unavailable, write a throwaway script under the scratchpad that runs the same query through `db.execute` and delete it afterwards. Expected: both names present.

- [ ] **Step 5: Report (do not commit)**

---

### Task 2: Unit conversion

**Files:**
- Create: `src/lib/money/units.ts`
- Test: `tests/lib/money/units.test.ts`
- Modify: `src/lib/listings/schedule.ts` (move `PESOS_TO_CENTAVOS` out)
- Modify: `src/app/dashboard/listings/[branchId]/courts/court-schedule-fields.tsx` (import path)

**Interfaces:**
- Produces: `parsePercentToBps`, `formatBpsAsPercent`, `parsePesosToCentavos`, `formatCentavosAsPesos`, `PESOS_TO_CENTAVOS`, `BPS`. Tasks 3, 4 and 5 all consume these.

**This module must import nothing at all.** It is consumed by a `'use client'` form. A single import that transitively reaches `@/db` or `server-only` turns the page into a runtime 500 that `tsc` and eslint both pass.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/money/units.test.ts`:

```ts
import { expect, test } from 'vitest'
import {
  formatBpsAsPercent,
  formatCentavosAsPesos,
  parsePercentToBps,
  parsePesosToCentavos,
} from '@/lib/money/units'

test('parsePercentToBps converts whole and fractional percentages', () => {
  expect(parsePercentToBps('10')).toBe(1000)
  expect(parsePercentToBps('10.5')).toBe(1050)
  expect(parsePercentToBps('0.01')).toBe(1)
  expect(parsePercentToBps('100')).toBe(10000)
})

test('parsePercentToBps survives IEEE-754', () => {
  // 10.55 * 100 is 1054.9999999999999. A truncating cast yields 1054 — a
  // silently wrong fee. Math.round is load-bearing, not defensive.
  expect(parsePercentToBps('10.55')).toBe(1055)
  expect(parsePercentToBps('29.29')).toBe(2929)
})

test('parsePercentToBps tolerates a trailing percent sign and whitespace', () => {
  expect(parsePercentToBps('10%')).toBe(1000)
  expect(parsePercentToBps('  10 % ')).toBe(1000)
  expect(parsePercentToBps('%10')).toBeNull()
})

test('parsePercentToBps rejects anything it cannot represent exactly', () => {
  expect(parsePercentToBps('10.555')).toBeNull()
  expect(parsePercentToBps('')).toBeNull()
  expect(parsePercentToBps('abc')).toBeNull()
  expect(parsePercentToBps('-5')).toBeNull()
  expect(parsePercentToBps('1e2')).toBeNull()
  expect(parsePercentToBps('1,000')).toBeNull()
  expect(parsePercentToBps('.5')).toBeNull()
})

test('parsePercentToBps rejects zero and anything over 100 percent', () => {
  // Zero: the database constrains the value > 0, and "no fee" is expressed by
  // mode, not by value. Over 100%: the new conditional CHECK forbids it.
  expect(parsePercentToBps('0')).toBeNull()
  expect(parsePercentToBps('0.00')).toBeNull()
  expect(parsePercentToBps('100.01')).toBeNull()
  expect(parsePercentToBps('101')).toBeNull()
})

test('parsePesosToCentavos converts and rejects on the same rules', () => {
  expect(parsePesosToCentavos('250')).toBe(25000)
  expect(parsePesosToCentavos('250.50')).toBe(25050)
  expect(parsePesosToCentavos('250.05')).toBe(25005)
  expect(parsePesosToCentavos('0')).toBeNull()
  expect(parsePesosToCentavos('250.505')).toBeNull()
  expect(parsePesosToCentavos('-1')).toBeNull()
  expect(parsePesosToCentavos('₱250')).toBeNull()
  // No percent ceiling here, and no percent sign tolerated either.
  expect(parsePesosToCentavos('250%')).toBeNull()
})

test('format functions produce input values, not display strings', () => {
  expect(formatBpsAsPercent(1050)).toBe('10.5')
  expect(formatBpsAsPercent(1000)).toBe('10')
  expect(formatBpsAsPercent(1)).toBe('0.01')
  expect(formatCentavosAsPesos(25050)).toBe('250.50')
  expect(formatCentavosAsPesos(25000)).toBe('250')
  expect(formatCentavosAsPesos(1000000)).toBe('10000')

  // An input value carrying ₱ or a thousands separator comes straight back as
  // unparseable on the next submit. That is what separates these from
  // formatPeso, which is for humans to read.
  for (const value of [formatBpsAsPercent(123456), formatCentavosAsPesos(1234567)]) {
    expect(value).not.toContain('₱')
    expect(value).not.toContain(',')
  }
})

test('every format function round-trips through its own parser', () => {
  for (const bps of [1, 250, 1000, 1050, 1055, 10000]) {
    expect(parsePercentToBps(formatBpsAsPercent(bps))).toBe(bps)
  }
  for (const centavos of [1, 5, 100, 25000, 25050, 25005, 1000000]) {
    expect(parsePesosToCentavos(formatCentavosAsPesos(centavos))).toBe(centavos)
  }
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/lib/money/units.test.ts`
Expected: FAIL — cannot resolve `@/lib/money/units`.

- [ ] **Step 3: Write the module**

Create `src/lib/money/units.ts`:

```ts
/**
 * Conversions between what a person types into a form and what the database
 * stores: integer centavos for money, integer basis points for percentages.
 *
 * Deliberately IMPORT-FREE. The admin fee form is a client component, and a
 * module it reaches that transitively imports `@/db` or `server-only` compiles
 * and lints clean, then 500s at runtime. Nothing here touches a database, a
 * session, or the filesystem — it is arithmetic over strings and integers.
 *
 * These format functions are NOT formatPeso. formatPeso renders money for a
 * human to read (`₱1,022.90`); these render a value for an <input> to hold and
 * round-trip. A ₱ or a thousands separator in an input's value comes straight
 * back as unparseable on the next submit.
 */

export const PESOS_TO_CENTAVOS = 100
export const BPS = 10_000

/** Two decimal places at most, no sign, no exponent, no separators. */
const DECIMAL_RE = /^\d+(\.\d{1,2})?$/

/**
 * The regex runs BEFORE any arithmetic so '10.555' is rejected rather than
 * silently rounded to 1056 — a fee the admin never typed.
 *
 * Math.round is load-bearing: 10.55 * 100 is 1054.9999999999999 in IEEE-754,
 * and a truncating cast would store 1054.
 */
function parseToHundredths(raw: string): number | null {
  const trimmed = raw.trim()
  if (!DECIMAL_RE.test(trimmed)) return null
  const value = Math.round(Number(trimmed) * 100)
  return value > 0 ? value : null
}

/** '10' | '10.5' | '10%' → 1000 | 1050 | 1000. Null if unusable. */
export function parsePercentToBps(raw: string): number | null {
  const withoutSign = raw.trim().replace(/\s*%$/, '')
  const bps = parseToHundredths(withoutSign)
  if (bps === null) return null
  // Mirrors platform_settings_percentage_ceiling / profiles_fee_percentage_ceiling.
  return bps <= BPS ? bps : null
}

/** '250' | '250.50' → 25000 | 25050. Null if unusable. No ceiling here. */
export function parsePesosToCentavos(raw: string): number | null {
  return parseToHundredths(raw)
}

/**
 * String(bps / 100) rather than toFixed: JavaScript prints the shortest
 * representation that round-trips, so 1050 → '10.5' and 1055 → '10.55' with no
 * trailing-zero trimming to get wrong. Exponent notation cannot appear because
 * bps is bounded to [1, 10000] → [0.01, 100].
 */
export function formatBpsAsPercent(bps: number): string {
  return String(bps / 100)
}

/**
 * Pesos pad to two decimals when there is a fractional part and to none when
 * there is not — the same "never a trailing .00" rule formatPeso follows.
 */
export function formatCentavosAsPesos(centavos: number): string {
  return centavos % PESOS_TO_CENTAVOS === 0
    ? String(centavos / PESOS_TO_CENTAVOS)
    : (centavos / PESOS_TO_CENTAVOS).toFixed(2)
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/lib/money/units.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Move `PESOS_TO_CENTAVOS` out of the listings module**

`src/lib/listings/schedule.ts:49` currently declares `PESOS_TO_CENTAVOS`. Delete that declaration and re-import it from the new module:

```ts
import { PESOS_TO_CENTAVOS } from '@/lib/money/units'
```

A money-units module importing from a listings module would be backwards, and two copies of the constant is worse than either. If `schedule.ts` **exports** `PESOS_TO_CENTAVOS`, keep exporting it (re-export from the new module) so no consumer breaks; then update
`src/app/dashboard/listings/[branchId]/courts/court-schedule-fields.tsx` to import from `@/lib/money/units` directly and drop the re-export.

Run: `grep -rn "PESOS_TO_CENTAVOS" src/` and confirm every hit resolves to the new module.

- [ ] **Step 6: Verify the move broke nothing**

Run: `npx tsc --noEmit` — expect clean.
Run: `npx eslint .` — expect 9 warnings, 0 errors.
Run: `npx vitest run tests/listings tests/lib` — the listings suites are the proof the move is safe. `tests/listings/write.test.ts` fails for the known pre-existing reason; every other file must pass.

- [ ] **Step 7: Report (do not commit)**

---

### Task 3: Settings read and write

**Files:**
- Create: `src/lib/admin/settings.ts`
- Test: `tests/admin/settings.test.ts`

**Interfaces:**
- Consumes: `parsePercentToBps` etc. are **not** used here — this module takes already-parsed integers. The action in Task 4 does the parsing.
- Produces: `getPlatformSettings`, `updatePlatformSettings`, `updateOwnerFeeOverride`, and the types `FeeMode`, `ProcessorFeeBearer`, `PlatformSettings`, `SettingsInput`, `SettingsWriteResult`, `OwnerFeeOverride`, `OverrideWriteResult`. Tasks 4 and 5 consume all of them.

- [ ] **Step 1: Write the failing tests**

Create `tests/admin/settings.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  getPlatformSettings,
  updateOwnerFeeOverride,
  updatePlatformSettings,
} from '@/lib/admin/settings'
import { seedOwner, seedPlayer, teardownFixtures } from '../helpers/fixtures'

afterAll(teardownFixtures)

/** Thrown to roll a transaction back after asserting inside it. */
const ROLLBACK = new Error('rollback')

async function feeColumns(userId: string) {
  const result = await db.execute(sql`
    select platform_fee_mode::text as mode, platform_fee_value as value,
           processor_fee_bearer::text as bearer
    from profiles where id = ${userId}::uuid
  `)
  return result.rows[0]
}

test('getPlatformSettings returns numbers, not strings', async () => {
  const settings = await getPlatformSettings()
  expect(typeof settings.feeValue).toBe('number')
  expect(typeof settings.holdDurationMinutes).toBe('number')
  expect(['percentage', 'flat']).toContain(settings.feeMode)
  expect(['player', 'owner', 'platform']).toContain(settings.processorFeeBearer)
  expect(settings.updatedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

test('updatePlatformSettings writes every field, verified inside a rolled-back transaction', async () => {
  // platform_settings is a SEEDED SINGLETON in a shared, persistent database,
  // and tests/booking/hold.test.ts reads it concurrently to price a hold. A
  // mutate-then-restore test has a real window where that test computes the
  // wrong fee. Running inside a transaction we roll back means no concurrent
  // reader ever sees the value, under read-committed isolation.
  const before = await getPlatformSettings()

  await expect(
    db.transaction(async (tx) => {
      const stampBefore = await tx.execute(sql`select updated_at from platform_settings`)

      const result = await updatePlatformSettings(
        {
          feeMode: 'flat',
          feeValue: 4321,
          processorFeeBearer: 'owner',
          holdDurationMinutes: 7,
        },
        tx,
      )
      expect(result).toEqual({ ok: true })

      const after = await tx.execute(sql`
        select default_platform_fee_mode::text as mode, default_platform_fee_value as value,
               default_processor_fee_bearer::text as bearer, hold_duration_minutes, updated_at
        from platform_settings
      `)
      expect(after.rows[0].mode).toBe('flat')
      expect(Number(after.rows[0].value)).toBe(4321)
      expect(after.rows[0].bearer).toBe('owner')
      expect(Number(after.rows[0].hold_duration_minutes)).toBe(7)
      expect(new Date(after.rows[0].updated_at as string).getTime()).toBeGreaterThan(
        new Date(stampBefore.rows[0].updated_at as string).getTime(),
      )

      throw ROLLBACK
    }),
  ).rejects.toBe(ROLLBACK)

  // Not redundant with the rollback: this is what proves the test is safe to
  // run against a shared database, and it fails loudly if updatePlatformSettings
  // is ever changed to ignore its executor argument.
  expect(await getPlatformSettings()).toEqual(before)
})

test('updatePlatformSettings rejects out-of-range input without touching the database', async () => {
  const before = await getPlatformSettings()
  const valid = {
    feeMode: 'percentage' as const,
    feeValue: 1000,
    processorFeeBearer: 'platform' as const,
    holdDurationMinutes: 15,
  }

  expect(await updatePlatformSettings({ ...valid, feeValue: 0 })).toEqual({
    ok: false,
    reason: 'invalid_fee',
  })
  expect(await updatePlatformSettings({ ...valid, feeValue: -1 })).toEqual({
    ok: false,
    reason: 'invalid_fee',
  })
  expect(await updatePlatformSettings({ ...valid, feeValue: 10001 })).toEqual({
    ok: false,
    reason: 'invalid_fee',
  })
  expect(await updatePlatformSettings({ ...valid, feeValue: 10.5 })).toEqual({
    ok: false,
    reason: 'invalid_fee',
  })
  expect(await updatePlatformSettings({ ...valid, holdDurationMinutes: 0 })).toEqual({
    ok: false,
    reason: 'invalid_hold',
  })
  expect(await updatePlatformSettings({ ...valid, holdDurationMinutes: 121 })).toEqual({
    ok: false,
    reason: 'invalid_hold',
  })

  // 10001 is fine in FLAT mode — ₱100.01 — which is exactly what the
  // conditional constraint exists to allow.
  expect(await getPlatformSettings()).toEqual(before)
})

test('the percentage ceiling is a real constraint, and it is conditional', async () => {
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`
        update platform_settings
        set default_platform_fee_mode = 'percentage', default_platform_fee_value = 10001
        where id
      `)
    }),
  ).rejects.toThrow()

  // The same number under 'flat' must succeed — otherwise the constraint is a
  // blanket cap and would forbid a ₱100.01 flat fee.
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`
        update platform_settings
        set default_platform_fee_mode = 'flat', default_platform_fee_value = 10001
        where id
      `)
      throw ROLLBACK
    }),
  ).rejects.toBe(ROLLBACK)
})

test('updateOwnerFeeOverride sets, replaces and clears an override', async () => {
  const ownerId = await seedOwner()

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: 'percentage',
      feeValue: 1500,
      processorFeeBearer: 'owner',
    }),
  ).toEqual({ ok: true })
  expect(await feeColumns(ownerId)).toEqual({ mode: 'percentage', value: 1500, bearer: 'owner' })

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: 'flat',
      feeValue: 25000,
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: true })
  expect(await feeColumns(ownerId)).toEqual({ mode: 'flat', value: 25000, bearer: null })

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: null,
      feeValue: null,
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: true })
  expect(await feeColumns(ownerId)).toEqual({ mode: null, value: null, bearer: null })
})

test('the bearer override is independent of the fee pair', async () => {
  const ownerId = await seedOwner()
  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: null,
      feeValue: null,
      processorFeeBearer: 'player',
    }),
  ).toEqual({ ok: true })
  expect(await feeColumns(ownerId)).toEqual({ mode: null, value: null, bearer: 'player' })
})

test('updateOwnerFeeOverride refuses an unpaired or out-of-range fee', async () => {
  const ownerId = await seedOwner()

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: 'percentage',
      feeValue: null,
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: false, reason: 'unpaired_fee' })

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: null,
      feeValue: 1500,
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: false, reason: 'unpaired_fee' })

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: 'percentage',
      feeValue: 10001,
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: false, reason: 'invalid_fee' })

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: 'percentage',
      feeValue: 0,
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: false, reason: 'invalid_fee' })

  expect(await feeColumns(ownerId)).toEqual({ mode: null, value: null, bearer: null })
})

test('a player can never be given a fee override', async () => {
  const playerId = await seedPlayer()

  expect(
    await updateOwnerFeeOverride(playerId, {
      feeMode: 'percentage',
      feeValue: 1500,
      processorFeeBearer: 'owner',
    }),
  ).toEqual({ ok: false, reason: 'no_such_owner' })

  // Both halves matter: a guard that returns the right word while still
  // writing the row is not a guard. An override left on a player's profile
  // would sit invisible and inert until they were promoted, then take effect.
  expect(await feeColumns(playerId)).toEqual({ mode: null, value: null, bearer: null })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/admin/settings.test.ts`
Expected: FAIL — cannot resolve `@/lib/admin/settings`.

- [ ] **Step 3: Write the module**

Create `src/lib/admin/settings.ts`:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { BPS } from '@/lib/money/units'

export type FeeMode = 'percentage' | 'flat'
export type ProcessorFeeBearer = 'player' | 'owner' | 'platform'

export type PlatformSettings = {
  feeMode: FeeMode
  /** Basis points when feeMode is 'percentage', centavos when it is 'flat'. */
  feeValue: number
  processorFeeBearer: ProcessorFeeBearer
  holdDurationMinutes: number
  updatedOn: string
}

/**
 * Policy bounds, deliberately NOT database constraints.
 *
 * The percentage ceiling IS a constraint (platform_settings_percentage_ceiling)
 * because a fee above 100% makes owner_net structurally negative — arithmetic.
 * These two are judgement: nothing breaks at a 300-minute hold, it is just a
 * bad idea, and encoding a number someone should be able to reconsider into a
 * CHECK means a migration to change your mind.
 */
const MIN_HOLD_MINUTES = 1
const MAX_HOLD_MINUTES = 120
/** ₱10,000. An obvious-typo guard on flat fees, not a business rule. */
const MAX_FLAT_FEE_CENTAVOS = 1_000_000

export async function getPlatformSettings(): Promise<PlatformSettings> {
  // No `where` and no `limit`: platform_settings_singleton means there is
  // exactly one row, and a limit would imply otherwise.
  const result = await db.execute(sql`
    select default_platform_fee_mode::text as fee_mode,
           default_platform_fee_value as fee_value,
           default_processor_fee_bearer::text as bearer,
           hold_duration_minutes,
           to_char(updated_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as updated_on
    from platform_settings
  `)
  const row = result.rows[0]
  return {
    feeMode: row.fee_mode as FeeMode,
    feeValue: Number(row.fee_value),
    processorFeeBearer: row.bearer as ProcessorFeeBearer,
    holdDurationMinutes: Number(row.hold_duration_minutes),
    updatedOn: row.updated_on as string,
  }
}

/**
 * Structurally minimal so a Drizzle transaction handle satisfies it.
 *
 * If `typeof db.execute` does not accept a `tx`, WIDEN this type — do not cast
 * at the call site:
 *   { execute: (query: never) => Promise<{ rows: Record<string, unknown>[] }> }
 * adjusted to the driver's actual signature.
 */
export type SqlExecutor = { execute: typeof db.execute }

export type SettingsInput = {
  feeMode: FeeMode
  feeValue: number
  processorFeeBearer: ProcessorFeeBearer
  holdDurationMinutes: number
}

export type SettingsWriteResult = { ok: true } | { ok: false; reason: 'invalid_fee' | 'invalid_hold' }

function feeValueIsValid(mode: FeeMode, value: number): boolean {
  if (!Number.isInteger(value) || value <= 0) return false
  return mode === 'percentage' ? value <= BPS : value <= MAX_FLAT_FEE_CENTAVOS
}

/**
 * Editing these changes bookings made from now on and nothing else. createHold
 * snapshots the computed fees onto each booking row along with a
 * fee_config_snapshot, and nothing downstream ever recomputes — a price change
 * must never rewrite a live hold.
 *
 * `exec` exists for testing, and only for testing. platform_settings is a
 * seeded singleton in a shared, persistent database that other suites read
 * concurrently, so its test writes through a transaction it rolls back rather
 * than mutating the row and restoring it.
 */
export async function updatePlatformSettings(
  input: SettingsInput,
  exec: SqlExecutor = db,
): Promise<SettingsWriteResult> {
  if (!feeValueIsValid(input.feeMode, input.feeValue)) return { ok: false, reason: 'invalid_fee' }
  if (
    !Number.isInteger(input.holdDurationMinutes) ||
    input.holdDurationMinutes < MIN_HOLD_MINUTES ||
    input.holdDurationMinutes > MAX_HOLD_MINUTES
  ) {
    return { ok: false, reason: 'invalid_hold' }
  }

  await exec.execute(sql`
    update platform_settings
    set default_platform_fee_mode    = ${input.feeMode}::platform_fee_mode,
        default_platform_fee_value   = ${input.feeValue},
        default_processor_fee_bearer = ${input.processorFeeBearer}::processor_fee_bearer,
        hold_duration_minutes        = ${input.holdDurationMinutes},
        updated_at                   = now()
    where id
  `)
  return { ok: true }
}

export type OwnerFeeOverride = {
  /** Null mode AND null value means "inherit the platform default". */
  feeMode: FeeMode | null
  feeValue: number | null
  /** Independently nullable — not part of the fee pair. */
  processorFeeBearer: ProcessorFeeBearer | null
}

export type OverrideWriteResult =
  | { ok: true }
  | { ok: false; reason: 'no_such_owner' | 'invalid_fee' | 'unpaired_fee' }

export async function updateOwnerFeeOverride(
  ownerId: string,
  override: OwnerFeeOverride,
): Promise<OverrideWriteResult> {
  const { feeMode, feeValue } = override
  // profiles_fee_override_pair: both null or both set. Checked here so an
  // admin gets a sentence rather than a 23514.
  if ((feeMode === null) !== (feeValue === null)) return { ok: false, reason: 'unpaired_fee' }
  if (feeMode !== null && feeValue !== null && !feeValueIsValid(feeMode, feeValue)) {
    return { ok: false, reason: 'invalid_fee' }
  }

  // role in ('owner','admin') is not decoration. Without it an admin could pin
  // an override onto a player's profile, where it would sit invisible and
  // inert until that player was promoted, and then silently take effect.
  const result = await db.execute(sql`
    update profiles
    set platform_fee_mode    = ${feeMode}::platform_fee_mode,
        platform_fee_value   = ${feeValue},
        processor_fee_bearer = ${override.processorFeeBearer}::processor_fee_bearer
    where id = ${ownerId}::uuid and role in ('owner', 'admin')
  `)

  const updated = result.rowCount ?? result.rows.length
  return updated === 0 ? { ok: false, reason: 'no_such_owner' } : { ok: true }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/admin/settings.test.ts`
Expected: PASS, 8 tests.

Two things commonly need adjusting here, and both are the plan's fault, not yours:
- If `updatePlatformSettings(input, tx)` does not type-check, widen `SqlExecutor` as the comment describes. Report what you changed it to.
- If `result.rowCount` is not on the driver's result, use whatever the driver exposes and say so in the report. Do **not** fall back to counting `rows` alone for an UPDATE with no `returning` — it will always be 0 and every call would report `no_such_owner`. Add `returning id` and count rows instead.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` — expect clean.
Run: `npx eslint .` — expect 9 warnings, 0 errors.
Run: `npx vitest run tests/admin tests/schema` — `tests/schema/settings.test.ts` fails for the known pre-existing reason; **`tests/schema/profiles.test.ts` must still pass**, which is the proof the new `profiles` constraint did not break the existing pair constraint.

- [ ] **Step 6: Report (do not commit)**

---

### Task 4: The settings page

**Files:**
- Create: `src/app/admin/settings/page.tsx`
- Create: `src/app/admin/settings/settings-form.tsx`
- Create: `src/app/admin/settings/actions.ts`
- Modify: `src/app/admin/actions.ts` (export `refuseUnlessAdmin`)
- Modify: `src/app/admin/layout.tsx` (one nav item)

**Interfaces:**
- Consumes: `getPlatformSettings`, `updatePlatformSettings`, `SettingsInput` (type-only in the client form) from Task 3; the parsers from Task 2; `refuseUnlessAdmin` and `AdminFormState` from `@/app/admin/actions`.
- Produces: the route `/admin/settings`.

Read `design/branding.md` before writing markup, and read `src/app/dashboard/listings/form-ui.tsx` to reuse `FIELD`, `LABEL`, `DARK_BUTTON` and `FormMessage` rather than restyling. Read `src/app/admin/owners/promote/promote-form.tsx` for the `useActionState` shape this must match.

- [ ] **Step 1: Export the shared guard**

In `src/app/admin/actions.ts`, change `async function refuseUnlessAdmin()` to `export async function refuseUnlessAdmin()`. Do not copy it — a duplicated auth guard is the kind of thing that later gets fixed in one place only.

Note that `src/app/admin/actions.ts` is a `'use server'` file, so every export becomes a client-invokable endpoint. `refuseUnlessAdmin` takes no arguments and returns a string or null; exporting it exposes nothing an unauthenticated caller could not already learn. State this in the report so the reviewer evaluates it deliberately. If the reviewer disagrees, the alternative is moving the guard to a plain `src/lib/admin/guard.ts` module that both action files import.

- [ ] **Step 2: Write the action**

Create `src/app/admin/settings/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { refuseUnlessAdmin, type AdminFormState } from '@/app/admin/actions'
import { parsePercentToBps, parsePesosToCentavos } from '@/lib/money/units'
import {
  updatePlatformSettings,
  type FeeMode,
  type ProcessorFeeBearer,
} from '@/lib/admin/settings'

const FEE_MODES: FeeMode[] = ['percentage', 'flat']
const BEARERS: ProcessorFeeBearer[] = ['player', 'owner', 'platform']
const BAD_INPUT = "That doesn't look right — reload the page and try again."

export async function updateSettingsAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const feeMode = String(formData.get('feeMode') ?? '')
  const bearer = String(formData.get('processorFeeBearer') ?? '')
  if (!FEE_MODES.includes(feeMode as FeeMode) || !BEARERS.includes(bearer as ProcessorFeeBearer)) {
    return { error: BAD_INPUT }
  }

  // Read ONLY the field matching the submitted mode. The form disables the
  // other one so it submits nothing, but the server does not trust that: the
  // whole point of two inputs is that the value's unit is never ambiguous, and
  // reading the wrong one would turn 10% into ₱10.00.
  const feeValue =
    feeMode === 'percentage'
      ? parsePercentToBps(String(formData.get('feePercent') ?? ''))
      : parsePesosToCentavos(String(formData.get('feePesos') ?? ''))

  if (feeValue === null) {
    return {
      error:
        feeMode === 'percentage'
          ? 'Enter a fee percentage above 0 and no more than 100, with at most two decimals.'
          : 'Enter a flat fee above ₱0, with at most two decimals.',
    }
  }

  const holdRaw = String(formData.get('holdDurationMinutes') ?? '').trim()
  const holdDurationMinutes = /^\d+$/.test(holdRaw) ? Number(holdRaw) : Number.NaN

  const result = await updatePlatformSettings({
    feeMode: feeMode as FeeMode,
    feeValue,
    processorFeeBearer: bearer as ProcessorFeeBearer,
    holdDurationMinutes,
  })

  if (!result.ok) {
    return {
      error:
        result.reason === 'invalid_hold'
          ? 'Enter a hold duration between 1 and 120 whole minutes.'
          : 'That fee is out of range.',
    }
  }

  revalidatePath('/admin/settings')
  return { ok: true, message: 'Saved. New bookings from now on use these terms.' }
}
```

- [ ] **Step 3: Write the form**

Create `src/app/admin/settings/settings-form.tsx`. It is `'use client'`. It **type-imports** `PlatformSettings` — a value import from `@/lib/admin/settings` would drag `server-only` into the browser bundle.

```tsx
'use client'

import { useActionState, useState } from 'react'
import { DARK_BUTTON, FIELD, FormMessage, LABEL } from '@/app/dashboard/listings/form-ui'
import { formatBpsAsPercent, formatCentavosAsPesos } from '@/lib/money/units'
import type { AdminFormState } from '@/app/admin/actions'
import type { FeeMode, PlatformSettings } from '@/lib/admin/settings'
import { updateSettingsAction } from './actions'

const BEARERS: { value: string; label: string; help: string }[] = [
  { value: 'player', label: 'Player pays', help: 'Added on top of the court fee at checkout.' },
  { value: 'owner', label: 'Owner pays', help: "Deducted from the owner's net for the booking." },
  { value: 'platform', label: 'Platform pays', help: 'Absorbed out of our own margin.' },
]

export function SettingsForm({ settings }: { settings: PlatformSettings }) {
  const [state, submit, saving] = useActionState<AdminFormState, FormData>(
    updateSettingsAction,
    null,
  )
  const [mode, setMode] = useState<FeeMode>(settings.feeMode)

  // The stored value is dual-unit, so each input is seeded only when the
  // stored mode matches it. Switching modes shows an empty field rather than
  // reinterpreting the other unit's number.
  const percentValue = settings.feeMode === 'percentage' ? formatBpsAsPercent(settings.feeValue) : ''
  const pesosValue = settings.feeMode === 'flat' ? formatCentavosAsPesos(settings.feeValue) : ''

  return (
    <form action={submit} className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-3">
        <legend className={LABEL}>Platform fee</legend>

        <label className="flex items-baseline gap-2 text-[13.5px] text-[var(--ink)]">
          <input
            type="radio"
            name="feeMode"
            value="percentage"
            checked={mode === 'percentage'}
            onChange={() => setMode('percentage')}
          />
          A percentage of every booking
        </label>
        <label className="flex flex-col gap-1 pl-6">
          <span className="text-[12.5px] text-[var(--ink-soft)]">Percent (0–100)</span>
          <input
            type="text"
            inputMode="decimal"
            name="feePercent"
            defaultValue={percentValue}
            disabled={mode !== 'percentage'}
            className={FIELD}
          />
        </label>

        <label className="flex items-baseline gap-2 text-[13.5px] text-[var(--ink)]">
          <input
            type="radio"
            name="feeMode"
            value="flat"
            checked={mode === 'flat'}
            onChange={() => setMode('flat')}
          />
          A flat amount per booking
        </label>
        <label className="flex flex-col gap-1 pl-6">
          <span className="text-[12.5px] text-[var(--ink-soft)]">Pesos</span>
          <input
            type="text"
            inputMode="decimal"
            name="feePesos"
            defaultValue={pesosValue}
            disabled={mode !== 'flat'}
            className={FIELD}
          />
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className={LABEL}>Who absorbs the payment processor&rsquo;s fee</legend>
        {BEARERS.map((bearer) => (
          <label key={bearer.value} className="flex items-baseline gap-2 text-[13.5px] text-[var(--ink)]">
            <input
              type="radio"
              name="processorFeeBearer"
              value={bearer.value}
              defaultChecked={settings.processorFeeBearer === bearer.value}
            />
            <span>
              {bearer.label}{' '}
              <span className="text-[12.5px] text-[var(--ink-soft)]">{bearer.help}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Hold duration</span>
        <span className="text-[12.5px] text-[var(--ink-soft)]">
          How long a court stays reserved while a player pays. 1 to 120 whole minutes.
        </span>
        <input
          type="number"
          name="holdDurationMinutes"
          min={1}
          max={120}
          step={1}
          defaultValue={settings.holdDurationMinutes}
          className={FIELD}
        />
      </label>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving} className={DARK_BUTTON}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
      <FormMessage state={state} />
    </form>
  )
}
```

If `FIELD`, `LABEL`, `DARK_BUTTON` or `FormMessage` are not exported from `form-ui` under those exact names, use whatever it does export and report the substitution. Do not restyle from scratch.

- [ ] **Step 4: Write the page**

Create `src/app/admin/settings/page.tsx`:

```tsx
import { requireAdminPage } from '@/lib/auth/page-guards'
import { getPlatformSettings } from '@/lib/admin/settings'
import { formatDateLabel } from '@/lib/format'
import { SettingsForm } from './settings-form'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)] max-[560px]:p-5'

/**
 * Platform fee configuration.
 *
 * The consequences panel is not decoration, for the same reason the promote
 * screen's is not: createHold snapshots the fee onto each booking row and
 * nothing downstream ever recomputes it, so a change here reaches bookings
 * made from now on and nothing else. That is the single most important thing
 * an admin needs to know before pressing Save, so it is stated above the form
 * rather than discovered afterwards.
 *
 * processor_rates (the GCash/Maya/card percentages) is deliberately absent:
 * those mirror PayMongo's published pricing rather than anything this business
 * sets, and a typo there under-collects silently on every transaction.
 */
export default async function AdminSettingsPage() {
  await requireAdminPage('/admin/settings')
  const settings = await getPlatformSettings()

  return (
    <>
      <header className="mb-6">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Settings
        </h1>
        <p className="mt-2 max-w-[620px] text-[15px] text-[var(--ink-soft)]">
          What the platform charges, who absorbs the payment processor&rsquo;s fee, and how long a
          court stays held while a player pays. Last changed {formatDateLabel(settings.updatedOn)}.
        </p>
      </header>

      <section
        aria-label="What changing these does"
        className="mb-6 rounded-[20px] bg-[var(--band-off)] px-5 py-4"
      >
        <h2 className="font-mono text-[11px] tracking-[.14em] text-[var(--court-deep)] uppercase">
          Before you save
        </h2>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] text-[var(--ink)]">
          <li>These terms apply to bookings made from the moment you save, and to nothing else.</li>
          <li>
            A hold already in progress keeps the fee it was quoted. Past bookings and their payouts
            are never repriced.
          </li>
          <li>
            An individual owner can be given different terms on the Owners page. Those override
            what is set here.
          </li>
        </ul>
      </section>

      <section aria-label="Platform fee settings" className={CARD}>
        <SettingsForm settings={settings} />
      </section>
    </>
  )
}
```

- [ ] **Step 5: Add the nav item**

In `src/app/admin/layout.tsx`, extend `items`:

```ts
  const items = [
    { href: '/admin', label: 'Approvals', badge: pending },
    { href: '/admin/owners', label: 'Owners', badge: 0 },
    { href: '/admin/settings', label: 'Settings', badge: 0 },
  ]
```

Leave the file's `FOCUS_RING` constant alone even though it contains `outline-none`. It is a known pre-existing issue tracked separately, and fixing it here would widen this task beyond its scope.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit` — expect clean.
Run: `npx eslint .` — expect 9 warnings, 0 errors.
Run: `grep -rn "outline-none\|outline-hidden" src/app/admin/settings/` — expect no output.
Run this check that the client form did not pull a server module in as a value:
```bash
grep -n "^import" src/app/admin/settings/settings-form.tsx
```
Every import from `@/lib/admin/settings` must be `import type`. A plain `import { ... }` there is the runtime-500 trap.
Run: `npx vitest run` (foreground, whole suite) — expect exactly the three known pre-existing failures.

- [ ] **Step 7: Report (do not commit)**

Report explicitly that the page was **not** seen rendered (no dev login), and that the disabled-input behaviour and the radios are therefore unverified.

---

### Task 5: The per-owner override control

**Files:**
- Modify: `src/lib/admin/owners.ts` (three fields on `AdminOwnerRow`)
- Modify: `tests/admin/owners.test.ts` (one added test)
- Create: `src/app/admin/owners/owner-fee-form.tsx`
- Modify: `src/app/admin/actions.ts` (one added action)
- Modify: `src/app/admin/owners/page.tsx` (render the form and the effective terms)

**Interfaces:**
- Consumes: `updateOwnerFeeOverride`, `FeeMode`, `ProcessorFeeBearer`, `PlatformSettings` from Task 3; the parsers from Task 2; `getAdminOwners` from the owners-directory plan.
- Produces: nothing further consumes this.

- [ ] **Step 1: Add the fee fields to the query**

In `src/lib/admin/owners.ts`, add to `AdminOwnerRow`:

```ts
  /** The owner's override. All three null means "inherit the platform default". */
  feeMode: FeeMode | null
  feeValue: number | null
  processorFeeBearer: ProcessorFeeBearer | null
```

Import those two types with `import type { FeeMode, ProcessorFeeBearer } from '@/lib/admin/settings'`. Extend the first query's select list with `p.platform_fee_mode::text as fee_mode, p.platform_fee_value as fee_value, p.processor_fee_bearer::text as fee_bearer`, and map them, remembering `feeValue` needs `row.fee_value === null ? null : Number(row.fee_value)` — a bare `Number(null)` is `0`, which would render as a real zero-peso override.

Add to `tests/admin/owners.test.ts`:

```ts
test('an owner fee override surfaces on the directory row', async () => {
  const ownerId = await seedOwner()
  await db.execute(sql`
    update profiles set platform_fee_mode = 'percentage', platform_fee_value = 1500,
                        processor_fee_bearer = 'owner'
    where id = ${ownerId}::uuid
  `)

  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  expect(owner!.feeMode).toBe('percentage')
  expect(owner!.feeValue).toBe(1500)
  expect(owner!.processorFeeBearer).toBe('owner')
})

test('an owner with no override reports null, not zero', async () => {
  const ownerId = await seedOwner()
  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  expect(owner!.feeMode).toBeNull()
  expect(owner!.feeValue).toBeNull()
  expect(owner!.processorFeeBearer).toBeNull()
})
```

`seedOwner` must be added to that file's imports if it is not already there.

Run: `npx vitest run tests/admin/owners.test.ts` — expect PASS.

- [ ] **Step 2: Add the action**

In `src/app/admin/actions.ts`, beside `promoteOwnerAction`:

```ts
export async function updateOwnerFeeOverrideAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const ownerId = idFrom(formData, 'ownerId')
  if (!ownerId) return { error: BAD_TARGET }

  // 'inherit' is the explicit third state, distinct from an empty field: it
  // clears both columns together, which is what profiles_fee_override_pair
  // requires.
  const choice = String(formData.get('feeChoice') ?? '')
  let feeMode: FeeMode | null = null
  let feeValue: number | null = null

  if (choice === 'percentage') {
    feeMode = 'percentage'
    feeValue = parsePercentToBps(String(formData.get('feePercent') ?? ''))
    if (feeValue === null) {
      return { error: 'Enter a fee percentage above 0 and no more than 100.' }
    }
  } else if (choice === 'flat') {
    feeMode = 'flat'
    feeValue = parsePesosToCentavos(String(formData.get('feePesos') ?? ''))
    if (feeValue === null) return { error: 'Enter a flat fee above ₱0.' }
  } else if (choice !== 'inherit') {
    return { error: BAD_TARGET }
  }

  const bearerRaw = String(formData.get('processorFeeBearer') ?? 'inherit')
  const bearers = ['player', 'owner', 'platform']
  if (bearerRaw !== 'inherit' && !bearers.includes(bearerRaw)) return { error: BAD_TARGET }
  const processorFeeBearer = bearerRaw === 'inherit' ? null : (bearerRaw as ProcessorFeeBearer)

  const result = await updateOwnerFeeOverride(ownerId, { feeMode, feeValue, processorFeeBearer })
  if (!result.ok) {
    return {
      error:
        result.reason === 'no_such_owner'
          ? 'That account is no longer an owner. Reload the page.'
          : 'That fee is out of range.',
    }
  }

  revalidatePath('/admin/owners')
  return { ok: true, message: 'Saved. New bookings for this owner use these terms.' }
}
```

Add the imports it needs at the top of the file.

- [ ] **Step 3: Write the form**

Create `src/app/admin/owners/owner-fee-form.tsx`, `'use client'`, one instance per owner. Type-import only from `@/lib/admin/settings` and `@/lib/admin/owners`.

It renders:
- a hidden `ownerId`
- a `feeChoice` select: `inherit` (labelled "Platform default"), `percentage` ("Custom percentage"), `flat` ("Custom flat fee"), defaulting to the owner's current state
- a `feePercent` and a `feePesos` input, seeded and enabled by the same `useState` rule the settings form uses — each seeded only when the stored mode matches it
- a `processorFeeBearer` select with `inherit` plus the three bearers
- a Save button and `<FormMessage state={state} />`

Match `settings-form.tsx`'s structure exactly; this is the same problem at smaller scale.

- [ ] **Step 4: Render it on the directory**

In `src/app/admin/owners/page.tsx`:
- call `getPlatformSettings()` alongside `getAdminOwners()` so the inherited value can be named rather than shown as the word "default" with no number
- add a fee line to each owner card reading the **effective** terms: the override when set, otherwise `Platform default (10%)` naming the inherited figure via `formatBpsAsPercent` / `formatCentavosAsPesos`
- render `<OwnerFeeForm ... />` under it

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` — expect clean.
Run: `npx eslint .` — expect 9 warnings, 0 errors.
Run: `grep -n "^import" src/app/admin/owners/owner-fee-form.tsx` — every `@/lib/admin/*` import must be `import type`.
Run: `grep -rn "outline-none\|outline-hidden" src/app/admin/owners/` — expect no output.
Run: `npx vitest run` (foreground, whole suite) — expect exactly the three known pre-existing failures.

- [ ] **Step 6: Report (do not commit)**

---

## Notes for the reviewer

- **The dual-unit column is the whole point of Task 4's two inputs.** Check that the action reads only the field matching the submitted mode, and that neither input is seeded from the other unit's stored value. A single shared value field, or a fallback that reads `feePesos` when `feePercent` is empty, reintroduces exactly the bug this design exists to prevent.
- **Task 3's rollback test must actually roll back.** The final `expect(await getPlatformSettings()).toEqual(before)` is the assertion that matters; if `updatePlatformSettings` were changed to ignore its executor, everything else in that test would still pass.
- The conditional CHECK has a two-sided test — 10001 rejected under `percentage`, accepted under `flat`. A one-sided test would pass against a blanket cap.
- `updateOwnerFeeOverride`'s `role in ('owner','admin')` scope is tested by asserting both the returned reason **and** that the player's columns stayed null.
- Nothing in this plan may touch `src/lib/payments/fees.ts`, `hold.ts`, `checkout.ts`, `webhook.ts`, or write to `bookings`. A diff to any of those means the change escaped its scope.
