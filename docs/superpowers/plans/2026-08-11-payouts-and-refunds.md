# Payouts Ledger & Refund Recording — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a way to pay owners what they are owed and to record refunds, closing the two money holes in the MVP — no `payouts` table exists, and `payments.needs_refund` is written by the webhook but read by nothing.

**Architecture:** A `payouts` row stamps the exact bookings it covers via a `payout_bookings` join table whose primary key `(booking_id, kind)` encodes the rule "a booking can be paid at most once and clawed back at most once." Owed is therefore *bookings with no stamp*, which is self-correcting: late arrivals appear in the next pool, refunds after payout become negative clawback lines. Refund records live on `payments` (the thing being refunded), so one action covers both a disputed booking and an orphan payment whose booking never confirmed.

**Tech Stack:** Next.js 16 App Router + TypeScript, Supabase Postgres, Drizzle 0.45.2 as a typed client executing hand-written SQL, Vitest 4 against the hosted database.

**Spec:** `docs/superpowers/specs/2026-08-11-payouts-and-refunds-design.md`. Read it before Task 1. Where this plan and the spec disagree, the spec wins — raise the conflict rather than silently picking.

## Global Constraints

Every task's requirements implicitly include all of these.

- **Money is `integer` centavos.** Never floats, never `numeric`. Percentages are integer basis points. Do not "fix" this.
- **`bigint` comes back from the driver as a string.** Any `::bigint` in a select must go through `Number()` at the mapping edge.
- **Data access is `db.execute(sql\`...\`)` only** — never the Drizzle query builder. Every read/write module starts with `import 'server-only'`.
- **Never import `src/db/schema.ts`.** It is excluded in `tsconfig.json` and importing it resurfaces a `TS2304`.
- **All identifiers are lowercase `snake_case`, unquoted.**
- **Index every foreign key explicitly.** Postgres does not do it for you.
- **RLS enabled on every new table with zero policies.** Never `force row level security`.
- **Migrations are idempotent.** `create table if not exists`, `add column if not exists`, `do $$ ... $$` blocks checking `pg_constraint`. Inline table constraints inside `create table if not exists` are idempotent for free — do not wrap those in do-blocks.
- **Transactions pass `{ isolationLevel: 'read committed' }`** as the second argument to `db.transaction`, matching `src/lib/booking/hold.ts:310` and `src/lib/admin/write.ts:100`.
- **Every exported Server Action calls a guard.** `tests/auth/action-coverage.test.ts` enforces this and must stay green.
- **All user-facing copy is English only.** No Taglish.
- **Read `design/branding.md` before any UI step** and follow it (colors, type, control tokens, radius, no gradients).
- **Tests run against the hosted database** over the Supavisor session pooler, port **5432** — never 6543, because `preparePayout` depends on `pg_advisory_xact_lock`. The database is shared and persistent: tests must pass on repeated runs and must never mutate seeded singleton rows (`platform_settings`, `processor_rates`).
- **Run vitest in the foreground**, never backgrounded.
- **Do NOT run any state-changing git command.** No `git add`, no `git commit`, no branch/stash/checkout. Each task ends by reporting what changed; the user commits.

---

### Task 1: Migration, schema constraints, and fixture teardown

**Files:**
- Create: `supabase/migrations/20260811000000_payouts_and_refunds.sql`
- Create: `tests/schema/payouts.test.ts`
- Modify: `tests/helpers/fixtures.ts` (add `seedPayout`; extend `teardownFixtures`)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `payouts` and `payout_bookings`; enum `payout_line_kind ('payment','clawback')`; columns `payments.refunded_at timestamptz` and `payments.refund_note text`. Fixture `seedPayout(opts: { ownerId: string; netCentavos?: number; grossCentavos?: number; periodStart?: string; periodEnd?: string; status?: 'pending' | 'paid' }): Promise<string>` returning the payout id, and `seedPayoutLine(opts: { payoutId: string; bookingId: string; kind: 'payment' | 'clawback'; netCentavos: number }): Promise<void>`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260811000000_payouts_and_refunds.sql`:

```sql
-- The payouts ledger, and the refund records the webhook's needs_refund flag
-- has had nowhere to land since 20260807090000_payments.sql shipped.
--
-- SAFE TO CREATE AND USE payout_line_kind IN THIS ONE FILE. `supabase db push`
-- wraps each migration in a single transaction, and Postgres forbids *using*
-- an enum value added by `alter type ... add value` in that same transaction
-- (55P04) -- which is why 'blocked' needed its own file in
-- 20260805090000_booking_status_blocked.sql. That restriction does NOT apply
-- to a brand-new type: `create type ... as enum` followed by a column of that
-- type in the same transaction is fine, exactly as payment_status already
-- does. Do not split this file.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'payout_line_kind') then
    create type payout_line_kind as enum ('payment', 'clawback');
  end if;
end $$;

-- payout_status ('pending', 'paid') already exists from
-- 20260801042931_settings_and_enums.sql and is reused as-is.
create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),

  -- No `on delete` clause (Postgres default: NO ACTION / RESTRICT), matching
  -- payments.booking_id and bookings' own FKs. An owner with a payout history
  -- must not silently vanish.
  owner_id uuid not null references profiles (id),

  -- DERIVED at prepare time from the Manila dates of this payout's 'payment'
  -- lines -- NOT admin input. The lines are the truth about what this payout
  -- covers; these two are a display label. Clawback lines are excluded from
  -- the calculation because a clawback can be from any earlier period and
  -- would stretch the label to mean nothing.
  period_start date not null,
  period_end date not null,

  -- Snapshots, integer centavos, computed at prepare time from the covered
  -- bookings. NOT derivable from payout_bookings, which stores only net per
  -- line. Stored so a historical payout reads correctly without re-deriving
  -- it from bookings that may have moved since -- the same reasoning that
  -- makes every booking snapshot its own amounts.
  --   gross = sum(total_charged_centavos), payment lines +, clawback lines -
  --   net   = sum(owner_net_centavos),     same signs
  --   fee   = gross - net
  -- No check constraints on gross/fee: they are derived, and net > 0 below is
  -- the load-bearing gate on the row.
  gross_centavos integer not null,
  fee_centavos integer not null,
  net_centavos integer not null,

  status payout_status not null default 'pending',
  paid_at timestamptz,

  -- The transfer reference (GCash / bank), recorded at mark-paid.
  note text,

  created_at timestamptz not null default now(),

  constraint payouts_period_ordered check (period_end >= period_start),

  -- > 0, not >= 0: you never record a payout of nothing. If owed comes out
  -- zero or negative you do not pay this period; the negative rides forward
  -- as a standing adjustment against the next one.
  constraint payouts_net_positive check (net_centavos > 0),

  -- The two-step flow's invariant, in the database rather than in the action:
  -- paid if and only if timestamped.
  constraint payouts_paid_has_timestamp check ((status = 'paid') = (paid_at is not null))
);

create index if not exists payouts_owner_id_idx on payouts (owner_id);

create table if not exists payout_bookings (
  booking_id uuid not null references bookings (id),
  kind payout_line_kind not null,
  payout_id uuid not null references payouts (id),

  -- Positive on a 'payment' line, negative on a 'clawback' line. Snapshotted
  -- rather than joined back to bookings.owner_net_centavos at read time: a
  -- payout is a historical record and must not move when anything upstream
  -- changes.
  net_centavos integer not null,

  -- THE INVARIANT: a booking can be paid at most once and clawed back at most
  -- once. Deliberately not unique(booking_id) alone -- that would leave a
  -- refunded booking unable to carry its own reversal. booking_id needs no
  -- separate index: it is this key's leading column.
  primary key (booking_id, kind)
);

create index if not exists payout_bookings_payout_id_idx on payout_bookings (payout_id);

-- Refund records live on payments, not on bookings: the thing being refunded
-- is a payment. This is what lets ONE action handle both refund shapes -- a
-- disputed booking (confirmed/completed, flips to refunded_manual) and an
-- orphan payment whose booking never confirmed (expired/pending_payment, no
-- status flip, no ledger effect). See src/lib/payments/webhook.ts:214, which
-- flags exactly those orphans. bookings gains no columns.
alter table payments add column if not exists refunded_at timestamptz;
alter table payments add column if not exists refund_note text;

-- Deny-by-default, like every other table: the publishable key ships in the
-- browser and must never reach these. Do NOT add policies, and do NOT use
-- `force row level security` (it would subject the owner role to those
-- non-existent policies and break the app).
alter table payouts enable row level security;
alter table payout_bookings enable row level security;
```

- [ ] **Step 2: Apply it**

```bash
npx supabase db push --db-url "$DATABASE_URL"
```

Expected: the migration applies cleanly.

- [ ] **Step 3: Prove idempotency by reading, not by re-pushing**

A second `db push` records the migration as already applied and **skips** it, so re-running proves nothing. Instead, read your own file and confirm every statement is guarded: the `do $$` block checks `pg_type`, both `create table` use `if not exists`, both `create index` use `if not exists`, both `alter table ... add column` use `if not exists`, and `enable row level security` is a no-op when already enabled. Inline table constraints need no guard — they are part of the skipped `create table`.

State in your report which statement corresponds to which guard.

- [ ] **Step 4: Regenerate types**

```bash
npx drizzle-kit pull
```

Schema truth is the SQL, not `schema.ts`. Nothing imports `schema.ts`, so this is bookkeeping only — but it must be run, and `npx tsc --noEmit` must stay clean afterward.

- [ ] **Step 5: Extend the fixtures**

In `tests/helpers/fixtures.ts`, add two seed helpers after `seedPayment`:

```ts
/**
 * A `payouts` row. Defaults describe a plausible prepared payout; every field
 * is overridable because the schema tests exist specifically to push each
 * constraint over its edge.
 *
 * No teardown tracking of its own: teardownFixtures() deletes payouts by
 * tracked owner_id, and payout_bookings before them (both FKs are RESTRICT).
 */
export async function seedPayout(opts: {
  ownerId: string
  netCentavos?: number
  grossCentavos?: number
  periodStart?: string
  periodEnd?: string
  status?: 'pending' | 'paid'
}): Promise<string> {
  const net = opts.netCentavos ?? 50000
  const gross = opts.grossCentavos ?? net + 5000
  const status = opts.status ?? 'pending'
  const result = await db.execute(sql`
    insert into payouts (
      owner_id, period_start, period_end,
      gross_centavos, fee_centavos, net_centavos, status, paid_at
    ) values (
      ${opts.ownerId}::uuid,
      ${opts.periodStart ?? '2026-08-01'}::date,
      ${opts.periodEnd ?? '2026-08-07'}::date,
      ${gross}, ${gross - net}, ${net}, ${status}::payout_status,
      ${status === 'paid' ? new Date().toISOString() : null}::timestamptz
    )
    returning id
  `)
  return result.rows[0].id as string
}

/** A single `payout_bookings` line. Sign is the caller's responsibility. */
export async function seedPayoutLine(opts: {
  payoutId: string
  bookingId: string
  kind: 'payment' | 'clawback'
  netCentavos: number
}): Promise<void> {
  await db.execute(sql`
    insert into payout_bookings (booking_id, kind, payout_id, net_centavos)
    values (${opts.bookingId}::uuid, ${opts.kind}::payout_line_kind,
            ${opts.payoutId}::uuid, ${opts.netCentavos})
  `)
}
```

- [ ] **Step 6: Extend `teardownFixtures`**

`payout_bookings.booking_id`, `payout_bookings.payout_id`, and `payouts.owner_id` are all RESTRICT. A surviving line blocks the bookings delete; a surviving payout blocks the `auth.users` delete. Both would abort teardown and leak the run's rows into the shared, persistent database.

Insert these two statements in `teardownFixtures()` **before** the existing `delete from reviews`:

```ts
  // Must precede BOTH the bookings delete and the auth.users delete:
  // payout_bookings.booking_id and .payout_id are NO ACTION (RESTRICT), for
  // the same reason payments and reviews are — a payout line is a financial
  // record. The booking predicate mirrors the bookings delete below exactly,
  // so no line can be missed by a row a later statement removes.
  await db.execute(sql`
    delete from payout_bookings
    where payout_id in (
        select id from payouts where owner_id = any (${sql.param(ids)}::uuid[])
      )
       or booking_id in (
        select id from bookings
        where player_id = any (${sql.param(ids)}::uuid[])
           or created_by = any (${sql.param(ids)}::uuid[])
           or branch_id in (
             select id from branches where owner_id = any (${sql.param(ids)}::uuid[])
           )
      )
  `)

  // payouts.owner_id is RESTRICT, so this must precede the auth.users delete.
  await db.execute(sql`
    delete from payouts where owner_id = any (${sql.param(ids)}::uuid[])
  `)
```

Then update `teardownFixtures`' doc comment: the FK-safe order is now
`payout_bookings → payouts → reviews → payments → bookings → auth.users`.

- [ ] **Step 7: Write the schema tests**

Create `tests/schema/payouts.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedPayout,
  seedPayoutLine,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

/** Postgres SQLSTATEs this file asserts on. */
const UNIQUE_VIOLATION = '23505'
const CHECK_VIOLATION = '23514'

function sqlStateOf(error: unknown): string | undefined {
  return (error as { cause?: { code?: string }; code?: string })?.cause?.code
    ?? (error as { code?: string })?.code
}

async function expectSqlState(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => sqlStateOf(error) === code,
    `expected SQLSTATE ${code}`,
  )
}

test('a booking can be paid once and clawed back once, but never paid twice', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2026-07-02', 12),
    status: 'completed',
  })

  const first = await seedPayout({ ownerId })
  await seedPayoutLine({ payoutId: first, bookingId, kind: 'payment', netCentavos: 27000 })

  // A clawback alongside the payment is exactly what the composite key exists
  // to permit — this is the refund-after-payout path.
  const second = await seedPayout({ ownerId })
  await seedPayoutLine({ payoutId: second, bookingId, kind: 'clawback', netCentavos: -27000 })

  // A second payment line for the same booking is a double-pay, and the
  // primary key is what makes it impossible rather than merely unlikely.
  await expectSqlState(
    seedPayoutLine({ payoutId: second, bookingId, kind: 'payment', netCentavos: 27000 }),
    UNIQUE_VIOLATION,
  )
})

test('a payout of zero or less is rejected', async () => {
  const { ownerId } = await seedBranchWithCourts(1)
  await expectSqlState(seedPayout({ ownerId, netCentavos: 0 }), CHECK_VIOLATION)
  await expectSqlState(seedPayout({ ownerId, netCentavos: -1 }), CHECK_VIOLATION)
})

test('paid and paid_at must agree in both directions', async () => {
  const { ownerId } = await seedBranchWithCourts(1)

  await expectSqlState(
    db.execute(sql`
      insert into payouts (owner_id, period_start, period_end,
                           gross_centavos, fee_centavos, net_centavos, status, paid_at)
      values (${ownerId}::uuid, '2026-08-01'::date, '2026-08-07'::date,
              55000, 5000, 50000, 'paid'::payout_status, null)
    `),
    CHECK_VIOLATION,
  )

  await expectSqlState(
    db.execute(sql`
      insert into payouts (owner_id, period_start, period_end,
                           gross_centavos, fee_centavos, net_centavos, status, paid_at)
      values (${ownerId}::uuid, '2026-08-01'::date, '2026-08-07'::date,
              55000, 5000, 50000, 'pending'::payout_status, now())
    `),
    CHECK_VIOLATION,
  )
})

test('an inverted period is rejected', async () => {
  const { ownerId } = await seedBranchWithCourts(1)
  await expectSqlState(
    seedPayout({ ownerId, periodStart: '2026-08-07', periodEnd: '2026-08-01' }),
    CHECK_VIOLATION,
  )
})
```

- [ ] **Step 8: Run the schema tests**

```bash
npx vitest run tests/schema/payouts.test.ts
```

Expected: 4 passed. If `toSatisfy` is unavailable in this Vitest version, replace `expectSqlState` with a try/catch that asserts on `sqlStateOf(error)` directly — do not weaken the assertion to "it threw."

- [ ] **Step 9: Confirm nothing else regressed**

```bash
npx vitest run tests/schema tests/booking tests/payments
```

Expected: all pass. The fixture teardown change touches every suite, so a leak or an FK error shows up here.

- [ ] **Step 10: Gate and report (do not commit)**

```bash
npx tsc --noEmit && npm run lint
```

Report: the migration path, which guard covers which statement, the fixture additions, and the test counts. The user commits.

---

### Task 2: The ledger read module

**Files:**
- Create: `src/lib/payouts/ledger.ts`
- Create: `tests/payouts/ledger.test.ts`

**Interfaces:**
- Consumes: Task 1's tables and fixtures.
- Produces:
  ```ts
  export type OwnerLedger = {
    ownerId: string
    email: string
    businessName: string | null
    fullName: string | null
    /** Payable minus outstanding clawbacks. May be negative. */
    owedCentavos: number
    payableBookingCount: number
    clawbackBookingCount: number
    /** Sum of prepared-but-untransferred payouts. */
    preparedCentavos: number
    /** Sum of transferred payouts, all time. */
    paidCentavos: number
  }
  export async function getAllOwnerLedgers(): Promise<OwnerLedger[]>
  export async function getOwnerLedger(ownerId: string): Promise<OwnerLedger | null>

  export type PayoutLine = {
    bookingId: string
    kind: 'payment' | 'clawback'
    netCentavos: number
    bookedOn: string
    branchName: string
    courtName: string
    /** True when this line's booking has since become refunded_manual. */
    bookingRefunded: boolean
  }
  export type PayoutRecord = {
    id: string
    periodStart: string
    periodEnd: string
    grossCentavos: number
    feeCentavos: number
    netCentavos: number
    status: 'pending' | 'paid'
    paidOn: string | null
    note: string | null
    createdOn: string
    lines: PayoutLine[]
  }
  export async function getOwnerPayouts(ownerId: string): Promise<PayoutRecord[]>

  export type PayableBooking = {
    bookingId: string
    bookedOn: string
    branchName: string
    courtName: string
    netCentavos: number
  }
  export async function getPayablePool(ownerId: string): Promise<PayableBooking[]>
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/payouts/ledger.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  getOwnerLedger,
  getOwnerPayouts,
  getPayablePool,
} from '@/lib/payouts/ledger'
import {
  manilaHour,
  seedBlock,
  seedBooking,
  seedBranchWithCourts,
  seedPayout,
  seedPayoutLine,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

/**
 * seedBooking's default pricing: total 30000, platform fee 10% = 3000, so
 * owner_net = 27000 on the default 'platform' bearer. Named here because
 * every expectation below is a multiple of it.
 */
const NET = 27000

test('completed bookings with no payout line are what is owed', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-02', 12), status: 'completed',
  })
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-02', 14), status: 'completed',
  })

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(NET * 2)
  expect(ledger?.payableBookingCount).toBe(2)
  expect(ledger?.preparedCentavos).toBe(0)
  expect(ledger?.paidCentavos).toBe(0)
})

test('a stamped booking leaves the payable pool', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const stamped = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-03', 12), status: 'completed',
  })
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-03', 14), status: 'completed',
  })

  const payoutId = await seedPayout({ ownerId, netCentavos: NET })
  await seedPayoutLine({ payoutId, bookingId: stamped, kind: 'payment', netCentavos: NET })

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(NET)
  expect(ledger?.payableBookingCount).toBe(1)
  // Prepared, not paid: seedPayout defaults to status 'pending'.
  expect(ledger?.preparedCentavos).toBe(NET)
  expect(ledger?.paidCentavos).toBe(0)

  const pool = await getPayablePool(ownerId)
  expect(pool).toHaveLength(1)
  expect(pool[0].bookingId).not.toBe(stamped)
})

test('only completed bookings are payable — never confirmed, held, expired, or blocked', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  for (const [hour, status] of [
    [12, 'confirmed'], [14, 'pending_payment'], [16, 'expired'], [18, 'refunded_manual'],
  ] as const) {
    await seedBooking({
      courtId: courtIds[0], branchId, playerId,
      startsAt: manilaHour('2026-07-04', hour), status,
    })
  }
  // complete_past_bookings() only ever moves confirmed -> completed, so a
  // block can never reach the pool. Pinned here so a future change to that
  // cron cannot silently start paying owners for their own walk-ins.
  await seedBlock({
    courtId: courtIds[0], branchId, createdBy: ownerId,
    startsAt: manilaHour('2026-07-04', 20),
  })

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(0)
  expect(ledger?.payableBookingCount).toBe(0)
})

test('a booking refunded BEFORE payout is simply absent — no clawback', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-05', 12), status: 'refunded_manual',
  })

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(0)
  expect(ledger?.clawbackBookingCount).toBe(0)
})

test('a booking refunded AFTER payout becomes a negative adjustment', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const paid = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-06', 12), status: 'completed',
  })
  const payoutId = await seedPayout({ ownerId, netCentavos: NET, status: 'paid' })
  await seedPayoutLine({ payoutId, bookingId: paid, kind: 'payment', netCentavos: NET })

  await db.execute(sql`
    update bookings set status = 'refunded_manual' where id = ${paid}::uuid
  `)

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(-NET)
  expect(ledger?.clawbackBookingCount).toBe(1)
  expect(ledger?.paidCentavos).toBe(NET)
})

test('a booking already clawed back does not adjust twice', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const booking = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-07', 12), status: 'completed',
  })
  const first = await seedPayout({ ownerId, netCentavos: NET, status: 'paid' })
  await seedPayoutLine({ payoutId: first, bookingId: booking, kind: 'payment', netCentavos: NET })
  await db.execute(sql`
    update bookings set status = 'refunded_manual' where id = ${booking}::uuid
  `)
  const second = await seedPayout({ ownerId, netCentavos: 1 })
  await seedPayoutLine({ payoutId: second, bookingId: booking, kind: 'clawback', netCentavos: -NET })

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(0)
  expect(ledger?.clawbackBookingCount).toBe(0)
})

test('getOwnerPayouts returns lines, and flags a line whose booking was since refunded', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const good = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-08', 12), status: 'completed',
  })
  const gone = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-08', 14), status: 'completed',
  })
  const payoutId = await seedPayout({ ownerId, netCentavos: NET * 2 })
  await seedPayoutLine({ payoutId, bookingId: good, kind: 'payment', netCentavos: NET })
  await seedPayoutLine({ payoutId, bookingId: gone, kind: 'payment', netCentavos: NET })
  await db.execute(sql`update bookings set status = 'refunded_manual' where id = ${gone}::uuid`)

  const payouts = await getOwnerPayouts(ownerId)
  expect(payouts).toHaveLength(1)
  expect(payouts[0].lines).toHaveLength(2)
  expect(payouts[0].lines.find((l) => l.bookingId === gone)?.bookingRefunded).toBe(true)
  expect(payouts[0].lines.find((l) => l.bookingId === good)?.bookingRefunded).toBe(false)
  expect(payouts[0].lines[0].bookedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(payouts[0].lines[0].courtName).toBe('Court 1')
})

test('an owner with nothing has a zeroed ledger, not a missing one', async () => {
  const { ownerId } = await seedBranchWithCourts(1)
  const ledger = await getOwnerLedger(ownerId)
  expect(ledger).not.toBeNull()
  expect(ledger?.owedCentavos).toBe(0)
  expect(ledger?.preparedCentavos).toBe(0)
  expect(ledger?.paidCentavos).toBe(0)
  expect(await getPayablePool(ownerId)).toEqual([])
})

test('every money field is a number, not a bigint string', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-07-09', 12), status: 'completed',
  })
  const ledger = await getOwnerLedger(ownerId)
  expect(typeof ledger?.owedCentavos).toBe('number')
  expect(typeof ledger?.preparedCentavos).toBe('number')
  expect(typeof ledger?.paidCentavos).toBe('number')
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/payouts/ledger.test.ts
```

Expected: every test fails to resolve `@/lib/payouts/ledger`.

- [ ] **Step 3: Write the module**

Create `src/lib/payouts/ledger.ts`. Structure it as one private `ledgerRows(ownerFilter)` helper plus the two public entry points, so the admin list and the earnings page can never compute owed differently:

```ts
import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'

export type OwnerLedger = {
  ownerId: string
  email: string
  businessName: string | null
  fullName: string | null
  /** Payable minus outstanding clawbacks. May be negative. */
  owedCentavos: number
  payableBookingCount: number
  clawbackBookingCount: number
  preparedCentavos: number
  paidCentavos: number
}

/**
 * Who counts as an owner for ledger purposes. Identical to the predicate
 * getAdminOwners() uses in src/lib/admin/owners.ts — branches.owner_id has no
 * role constraint, so an admin holding branches is a real owner of record and
 * can be owed money. Kept as a local fragment rather than an import, matching
 * this codebase's existing precedent for shared SQL fragments (see
 * REAL_BOOKING in src/lib/owner/queries.ts).
 */
const IS_OWNER = sql`
  p.role = 'owner'
  or (p.role = 'admin' and exists (select 1 from branches b where b.owner_id = p.id))
`

/**
 * THE owed computation, in one place.
 *
 *   owed = Σ owner_net_centavos over completed bookings with no 'payment' line
 *        − Σ owner_net_centavos over refunded_manual bookings that HAVE a
 *          'payment' line and no 'clawback' line yet
 *
 * `status = 'completed'` excludes owner blocks for free: complete_past_bookings()
 * (20260801110350_storage_and_cron.sql) only ever moves confirmed -> completed,
 * so a 'blocked' row can never reach the pool and no ₱0 line is ever written.
 *
 * Every sum is cast ::bigint and read through Number() — the driver returns
 * bigint as a string, and a string here would concatenate instead of add.
 */
async function ledgerRows(ownerFilter: SQL): Promise<OwnerLedger[]> {
  const result = await db.execute(sql`
    with owners as (
      select p.id, p.email, p.business_name, p.full_name
      from profiles p
      where (${IS_OWNER}) and ${ownerFilter}
    ),
    payable as (
      select b.owner_id, bk.owner_net_centavos as net
      from bookings bk
      join branches b on b.id = bk.branch_id
      where b.owner_id in (select id from owners)
        and bk.status = 'completed'
        and not exists (
          select 1 from payout_bookings pb
          where pb.booking_id = bk.id and pb.kind = 'payment'
        )
    ),
    clawback as (
      select b.owner_id, bk.owner_net_centavos as net
      from bookings bk
      join branches b on b.id = bk.branch_id
      where b.owner_id in (select id from owners)
        and bk.status = 'refunded_manual'
        and exists (
          select 1 from payout_bookings pb
          where pb.booking_id = bk.id and pb.kind = 'payment'
        )
        and not exists (
          select 1 from payout_bookings pb
          where pb.booking_id = bk.id and pb.kind = 'clawback'
        )
    ),
    totals as (
      select owner_id,
        coalesce(sum(net_centavos) filter (where status = 'pending'), 0) as prepared,
        coalesce(sum(net_centavos) filter (where status = 'paid'), 0) as paid
      from payouts
      where owner_id in (select id from owners)
      group by owner_id
    )
    select o.id, o.email, o.business_name, o.full_name,
      coalesce((select sum(net) from payable where owner_id = o.id), 0)::bigint as payable_net,
      coalesce((select count(*) from payable where owner_id = o.id), 0)::int as payable_count,
      coalesce((select sum(net) from clawback where owner_id = o.id), 0)::bigint as clawback_net,
      coalesce((select count(*) from clawback where owner_id = o.id), 0)::int as clawback_count,
      coalesce(t.prepared, 0)::bigint as prepared_centavos,
      coalesce(t.paid, 0)::bigint as paid_centavos
    from owners o
    left join totals t on t.owner_id = o.id
    order by coalesce(o.business_name, o.email), o.id
  `)

  return result.rows.map((row) => ({
    ownerId: row.id as string,
    email: row.email as string,
    businessName: (row.business_name as string | null) ?? null,
    fullName: (row.full_name as string | null) ?? null,
    owedCentavos: Number(row.payable_net) - Number(row.clawback_net),
    payableBookingCount: Number(row.payable_count),
    clawbackBookingCount: Number(row.clawback_count),
    preparedCentavos: Number(row.prepared_centavos),
    paidCentavos: Number(row.paid_centavos),
  }))
}

export async function getAllOwnerLedgers(): Promise<OwnerLedger[]> {
  return ledgerRows(sql`true`)
}

export async function getOwnerLedger(ownerId: string): Promise<OwnerLedger | null> {
  const rows = await ledgerRows(sql`p.id = ${ownerId}::uuid`)
  return rows[0] ?? null
}
```

Then, in the same file, the two detail reads:

```ts
export type PayoutLine = {
  bookingId: string
  kind: 'payment' | 'clawback'
  netCentavos: number
  /** A Manila calendar date (`YYYY-MM-DD`), ready for formatDateLabel(). */
  bookedOn: string
  branchName: string
  courtName: string
  /** True when this line's booking has since become refunded_manual. */
  bookingRefunded: boolean
}

export type PayoutRecord = {
  id: string
  periodStart: string
  periodEnd: string
  grossCentavos: number
  feeCentavos: number
  netCentavos: number
  status: 'pending' | 'paid'
  /** Manila date, null while pending. */
  paidOn: string | null
  note: string | null
  createdOn: string
  lines: PayoutLine[]
}

/**
 * An owner's payouts, newest first, each with its lines.
 *
 * Two queries stitched by id rather than one join: a join multiplies the
 * payout row by its line count and every money column would then need
 * de-duplicating before display. Same shape as getAdminOwners' follow-up
 * queries in src/lib/admin/owners.ts.
 *
 * `bookingRefunded` is why the lines join `bookings` at all — a pending payout
 * containing a since-refunded booking is the one thing the two-step flow
 * exists to let an admin catch before the money leaves.
 */
export async function getOwnerPayouts(ownerId: string): Promise<PayoutRecord[]> {
  const payouts = await db.execute(sql`
    select id, to_char(period_start, 'YYYY-MM-DD') as period_start,
           to_char(period_end, 'YYYY-MM-DD') as period_end,
           gross_centavos, fee_centavos, net_centavos, status::text as status,
           to_char(paid_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as paid_on,
           note,
           to_char(created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as created_on
    from payouts
    where owner_id = ${ownerId}::uuid
    order by created_at desc, id
  `)
  if (payouts.rows.length === 0) return []

  const lines = await db.execute(sql`
    select pb.payout_id, pb.booking_id, pb.kind::text as kind, pb.net_centavos,
           to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as booked_on,
           br.name as branch_name, c.name as court_name,
           (bk.status = 'refunded_manual') as booking_refunded
    from payout_bookings pb
    join payouts p on p.id = pb.payout_id
    join bookings bk on bk.id = pb.booking_id
    join branches br on br.id = bk.branch_id
    join courts c on c.id = bk.court_id
    where p.owner_id = ${ownerId}::uuid
    order by bk.starts_at, pb.booking_id
  `)

  const byPayout = new Map<string, PayoutLine[]>()
  for (const row of lines.rows) {
    const list = byPayout.get(row.payout_id as string) ?? []
    list.push({
      bookingId: row.booking_id as string,
      kind: row.kind as 'payment' | 'clawback',
      netCentavos: Number(row.net_centavos),
      bookedOn: row.booked_on as string,
      branchName: row.branch_name as string,
      courtName: row.court_name as string,
      bookingRefunded: row.booking_refunded === true,
    })
    byPayout.set(row.payout_id as string, list)
  }

  return payouts.rows.map((row) => ({
    id: row.id as string,
    periodStart: row.period_start as string,
    periodEnd: row.period_end as string,
    grossCentavos: Number(row.gross_centavos),
    feeCentavos: Number(row.fee_centavos),
    netCentavos: Number(row.net_centavos),
    status: row.status as 'pending' | 'paid',
    paidOn: (row.paid_on as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    createdOn: row.created_on as string,
    lines: byPayout.get(row.id as string) ?? [],
  }))
}

export type PayableBooking = {
  bookingId: string
  bookedOn: string
  branchName: string
  courtName: string
  netCentavos: number
}

/** The bookings a prepare right now would stamp. Read-only preview. */
export async function getPayablePool(ownerId: string): Promise<PayableBooking[]> {
  const result = await db.execute(sql`
    select bk.id,
           to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as booked_on,
           br.name as branch_name, c.name as court_name, bk.owner_net_centavos
    from bookings bk
    join branches br on br.id = bk.branch_id
    join courts c on c.id = bk.court_id
    where br.owner_id = ${ownerId}::uuid
      and bk.status = 'completed'
      and not exists (
        select 1 from payout_bookings pb
        where pb.booking_id = bk.id and pb.kind = 'payment'
      )
    order by bk.starts_at, bk.id
  `)
  return result.rows.map((row) => ({
    bookingId: row.id as string,
    bookedOn: row.booked_on as string,
    branchName: row.branch_name as string,
    courtName: row.court_name as string,
    netCentavos: Number(row.owner_net_centavos),
  }))
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/payouts/ledger.test.ts
```

Expected: 9 passed.

- [ ] **Step 5: Gate and report (do not commit)**

```bash
npx tsc --noEmit && npm run lint
```

Report the exported signatures verbatim — Tasks 5 and 7 bind to them.

---

### Task 3: `preparePayout` and `markPayoutPaid`

**Files:**
- Create: `src/lib/payouts/write.ts`
- Create: `tests/payouts/write.test.ts`

**Interfaces:**
- Consumes: Task 1's tables; `getOwnerLedger` / `getPayablePool` from Task 2 (tests only).
- Produces:
  ```ts
  export const MAX_PAYOUT_NOTE = 500
  export type PreparePayoutResult =
    | { ok: true; payoutId: string; netCentavos: number; lineCount: number }
    | { ok: false; reason: 'nothing_to_pay' }
  export async function preparePayout(ownerId: string): Promise<PreparePayoutResult>

  export type MarkPaidResult = { ok: true } | { ok: false; reason: 'already_recorded' }
  export async function markPayoutPaid(payoutId: string, note: string): Promise<MarkPaidResult>
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/payouts/write.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { getOwnerLedger, getOwnerPayouts } from '@/lib/payouts/ledger'
import { markPayoutPaid, preparePayout } from '@/lib/payouts/write'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

const NET = 27000
const GROSS = 30000

test('prepare stamps exactly the payable set and locks the amount', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-02', 12), status: 'completed',
  })
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-05', 14), status: 'completed',
  })

  const result = await preparePayout(ownerId)
  expect(result).toMatchObject({ ok: true, netCentavos: NET * 2, lineCount: 2 })

  // The pool is now empty — those bookings are spoken for.
  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(0)
  expect(ledger?.preparedCentavos).toBe(NET * 2)
  expect(ledger?.paidCentavos).toBe(0)

  const [payout] = await getOwnerPayouts(ownerId)
  expect(payout.status).toBe('pending')
  expect(payout.grossCentavos).toBe(GROSS * 2)
  expect(payout.feeCentavos).toBe(GROSS * 2 - NET * 2)
  expect(payout.lines.every((l) => l.kind === 'payment' && l.netCentavos > 0)).toBe(true)
  // Period comes from the payment lines' Manila dates.
  expect(payout.periodStart).toBe('2026-06-02')
  expect(payout.periodEnd).toBe('2026-06-05')
})

test('prepare writes nothing when there is nothing to pay', async () => {
  const { ownerId } = await seedBranchWithCourts(1)
  expect(await preparePayout(ownerId)).toEqual({ ok: false, reason: 'nothing_to_pay' })
  expect(await getOwnerPayouts(ownerId)).toEqual([])
})

test('an outstanding clawback becomes a negative line on the next payout', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const first = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-10', 12), status: 'completed',
  })
  const prepared = await preparePayout(ownerId)
  expect(prepared.ok).toBe(true)

  await db.execute(sql`update bookings set status = 'refunded_manual' where id = ${first}::uuid`)

  // Two more completed bookings, so the next payout can absorb the clawback.
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-11', 12), status: 'completed',
  })
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-11', 14), status: 'completed',
  })

  const second = await preparePayout(ownerId)
  expect(second).toMatchObject({ ok: true, netCentavos: NET * 2 - NET, lineCount: 3 })

  const payouts = await getOwnerPayouts(ownerId)
  const latest = payouts.find((p) => p.netCentavos === NET)
  expect(latest?.lines.filter((l) => l.kind === 'clawback')).toHaveLength(1)
  expect(latest?.lines.find((l) => l.kind === 'clawback')?.netCentavos).toBe(-NET)
  // Clawbacks must not stretch the period label.
  expect(latest?.periodStart).toBe('2026-06-11')
})

test('a clawback larger than the pool writes nothing and stays outstanding', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const big = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-15', 12), status: 'completed', totalCentavos: 100000,
  })
  expect((await preparePayout(ownerId)).ok).toBe(true)
  await db.execute(sql`update bookings set status = 'refunded_manual' where id = ${big}::uuid`)

  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-16', 12), status: 'completed',
  })

  // Owed is negative, so nothing is written — and critically, the clawback is
  // NOT consumed. It must reappear next time.
  expect(await preparePayout(ownerId)).toEqual({ ok: false, reason: 'nothing_to_pay' })
  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.clawbackBookingCount).toBe(1)
  expect(ledger?.owedCentavos).toBe(NET - 90000)
})

test('N concurrent prepares for one owner produce exactly one payout', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  for (let hour = 12; hour < 18; hour++) {
    await seedBooking({
      courtId: courtIds[0], branchId, playerId,
      startsAt: manilaHour('2026-06-20', hour), status: 'completed',
    })
  }

  const results = await Promise.all([1, 2, 3, 4, 5].map(() => preparePayout(ownerId)))
  const winners = results.filter((r) => r.ok)
  expect(winners).toHaveLength(1)
  expect(results.filter((r) => !r.ok && r.reason === 'nothing_to_pay')).toHaveLength(4)

  const payouts = await getOwnerPayouts(ownerId)
  expect(payouts).toHaveLength(1)
  expect(payouts[0].lines).toHaveLength(6)
})

test('mark paid is status-scoped and idempotent', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-25', 12), status: 'completed',
  })
  const prepared = await preparePayout(ownerId)
  if (!prepared.ok) throw new Error('expected a prepared payout')

  expect(await markPayoutPaid(prepared.payoutId, 'GCash ref 123456')).toEqual({ ok: true })
  expect(await markPayoutPaid(prepared.payoutId, 'GCash ref 123456')).toEqual({
    ok: false, reason: 'already_recorded',
  })

  const [payout] = await getOwnerPayouts(ownerId)
  expect(payout.status).toBe('paid')
  expect(payout.paidOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(payout.note).toBe('GCash ref 123456')

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.preparedCentavos).toBe(0)
  expect(ledger?.paidCentavos).toBe(NET)
})

test('mark paid on an unknown id reports already_recorded rather than throwing', async () => {
  expect(await markPayoutPaid(crypto.randomUUID(), 'ref')).toEqual({
    ok: false, reason: 'already_recorded',
  })
})

test('an over-long note is truncated, not rejected', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-06-26', 12), status: 'completed',
  })
  const prepared = await preparePayout(ownerId)
  if (!prepared.ok) throw new Error('expected a prepared payout')

  await markPayoutPaid(prepared.payoutId, 'x'.repeat(900))
  const [payout] = await getOwnerPayouts(ownerId)
  expect(payout.note).toHaveLength(500)
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/payouts/write.test.ts
```

Expected: every test fails to resolve `@/lib/payouts/write`.

- [ ] **Step 3: Write the module**

Create `src/lib/payouts/write.ts`:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

/** Matches MAX_REJECTION_REASON's role in src/lib/admin/moderation.ts: a
 *  typo guard on a free-text field, enforced by truncation rather than by
 *  refusal — an admin who pastes a long bank reference should not lose the
 *  payout they just sent. */
export const MAX_PAYOUT_NOTE = 500

export type PreparePayoutResult =
  | { ok: true; payoutId: string; netCentavos: number; lineCount: number }
  | { ok: false; reason: 'nothing_to_pay' }

type Line = {
  bookingId: string
  kind: 'payment' | 'clawback'
  net: number
  gross: number
  bookedOn: string
}

/**
 * Step one of two. Stamps the bookings this payout covers and locks its
 * amount; the money has not moved yet. markPayoutPaid() is step two.
 *
 * The transaction does two things atomically:
 *
 *   1. pg_advisory_xact_lock on the OWNER, so two admins preparing the same
 *      owner at once queue rather than collide mid-write. Keyed on the owner,
 *      so it never serializes unrelated admin traffic — the same shape and the
 *      same reasoning as createHold's per-player lock in
 *      src/lib/booking/hold.ts:143. Taken first, while holding nothing else,
 *      so it can never be one edge of a wait-for cycle.
 *   2. Resolve the lines, then insert. payout_bookings' (booking_id, kind)
 *      primary key is the real arbiter — the lock only makes the losing path
 *      a clean "nothing to pay" instead of a 23505.
 *
 * READ COMMITTED is required, not incidental: under REPEATABLE READ the
 * transaction's snapshot is fixed at the advisory-lock statement, taken
 * BEFORE the lock is granted, so a queued second prepare would still see the
 * pre-lock pool and stamp bookings the winner already took. Identical to the
 * reasoning pinned in src/lib/booking/hold.ts:123.
 *
 * Writes NOTHING when net <= 0 — including no clawback lines. An outstanding
 * clawback stays outstanding and reappears in every later computation until a
 * payout large enough to absorb it is actually prepared. A negative balance is
 * a standing adjustment, never a written-off one.
 */
export async function preparePayout(ownerId: string): Promise<PreparePayoutResult> {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'payout:' + ownerId}))`)

      const result = await tx.execute(sql`
        select bk.id as booking_id, 'payment' as kind,
               bk.owner_net_centavos as net, bk.total_charged_centavos as gross,
               to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as booked_on
        from bookings bk
        join branches b on b.id = bk.branch_id
        where b.owner_id = ${ownerId}::uuid
          and bk.status = 'completed'
          and not exists (
            select 1 from payout_bookings pb
            where pb.booking_id = bk.id and pb.kind = 'payment'
          )
        union all
        select bk.id, 'clawback',
               -bk.owner_net_centavos, -bk.total_charged_centavos,
               to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD')
        from bookings bk
        join branches b on b.id = bk.branch_id
        where b.owner_id = ${ownerId}::uuid
          and bk.status = 'refunded_manual'
          and exists (
            select 1 from payout_bookings pb
            where pb.booking_id = bk.id and pb.kind = 'payment'
          )
          and not exists (
            select 1 from payout_bookings pb
            where pb.booking_id = bk.id and pb.kind = 'clawback'
          )
      `)

      const lines: Line[] = result.rows.map((row) => ({
        bookingId: row.booking_id as string,
        kind: row.kind as 'payment' | 'clawback',
        net: Number(row.net),
        gross: Number(row.gross),
        bookedOn: row.booked_on as string,
      }))

      const net = lines.reduce((sum, l) => sum + l.net, 0)
      const gross = lines.reduce((sum, l) => sum + l.gross, 0)
      if (net <= 0) return { ok: false as const, reason: 'nothing_to_pay' as const }

      // Period spans the PAYMENT lines only. A clawback can be from any
      // earlier period and would stretch the label to mean nothing. A payment
      // line always exists here: net > 0 is unreachable from clawbacks alone.
      const dates = lines.filter((l) => l.kind === 'payment').map((l) => l.bookedOn).sort()

      const inserted = await tx.execute(sql`
        insert into payouts (
          owner_id, period_start, period_end, gross_centavos, fee_centavos, net_centavos
        ) values (
          ${ownerId}::uuid, ${dates[0]}::date, ${dates[dates.length - 1]}::date,
          ${gross}, ${gross - net}, ${net}
        )
        returning id
      `)
      const payoutId = inserted.rows[0].id as string

      const values = lines.map(
        (l) => sql`(${l.bookingId}::uuid, ${l.kind}::payout_line_kind, ${payoutId}::uuid, ${l.net})`,
      )
      await tx.execute(sql`
        insert into payout_bookings (booking_id, kind, payout_id, net_centavos)
        values ${sql.join(values, sql`, `)}
      `)

      return { ok: true as const, payoutId, netCentavos: net, lineCount: lines.length }
    },
    { isolationLevel: 'read committed' },
  )
}

export type MarkPaidResult = { ok: true } | { ok: false; reason: 'already_recorded' }

/**
 * Step two of two: the transfer has left, record it.
 *
 * Status-scoped, the shape all four of src/lib/admin/write.ts's court
 * transitions use — zero rows updated is a meaningful answer ("it already
 * moved"), not an error, so a double submit and an unknown id both land on
 * the same honest message rather than throwing.
 *
 * `returning id` + rows.length, not rowCount: an UPDATE without `returning`
 * reports zero rows regardless of what it touched, which would make every
 * successful call wrongly report already_recorded. Same trap documented at
 * length in updateOwnerFeeOverride (src/lib/admin/settings.ts).
 */
export async function markPayoutPaid(payoutId: string, note: string): Promise<MarkPaidResult> {
  const trimmed = note.trim().slice(0, MAX_PAYOUT_NOTE)
  const result = await db.execute(sql`
    update payouts
    set status = 'paid'::payout_status, paid_at = now(),
        note = ${trimmed.length > 0 ? trimmed : null}
    where id = ${payoutId}::uuid and status = 'pending'
    returning id
  `)
  return result.rows.length === 0 ? { ok: false, reason: 'already_recorded' } : { ok: true }
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/payouts/write.test.ts
```

Expected: 8 passed. If the concurrency test is flaky, do **not** loosen the assertion — re-run it in isolation first (this hosted database has known pool-contention timeouts under parallel load), and only investigate the lock if it fails in isolation.

- [ ] **Step 5: Confirm the ledger tests still pass**

```bash
npx vitest run tests/payouts
```

Expected: 17 passed across both files.

- [ ] **Step 6: Gate and report (do not commit)**

```bash
npx tsc --noEmit && npm run lint
```

---

### Task 4: Refund queries and the refund write

**Files:**
- Create: `src/lib/refunds/queries.ts`
- Create: `src/lib/refunds/write.ts`
- Create: `tests/refunds/queries.test.ts`
- Create: `tests/refunds/write.test.ts`

**Interfaces:**
- Consumes: Task 1's `payments.refunded_at` / `payments.refund_note`.
- Produces:
  ```ts
  // queries.ts
  export type RefundPayment = {
    paymentId: string
    amountCentavos: number
    paymentMethod: string | null
    status: 'pending' | 'paid' | 'failed'
    needsRefund: boolean
    paidOn: string | null
    refundedOn: string | null
    refundNote: string | null
  }
  export type RefundCandidate = {
    bookingId: string
    bookingStatus: string
    bookedOn: string
    branchName: string
    courtName: string
    playerEmail: string | null
    playerName: string | null
    totalChargedCentavos: number
    payments: RefundPayment[]
  }
  export async function getFlaggedRefunds(): Promise<RefundCandidate[]>
  export async function findRefundCandidates(query: string): Promise<RefundCandidate[]>

  // write.ts
  export const MAX_REFUND_NOTE = 500
  export type RefundResult =
    | { ok: true; bookingRefunded: boolean }
    | { ok: false; reason: 'already_recorded' }
  export async function recordPaymentRefund(paymentId: string, note: string): Promise<RefundResult>
  ```

- [ ] **Step 1: Write the failing write tests**

Create `tests/refunds/write.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { recordPaymentRefund } from '@/lib/refunds/write'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedPayment,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

async function paymentRow(paymentId: string) {
  const result = await db.execute(sql`
    select needs_refund, refunded_at, refund_note from payments where id = ${paymentId}::uuid
  `)
  return result.rows[0]
}

async function bookingStatus(bookingId: string) {
  const result = await db.execute(sql`
    select status::text as status from bookings where id = ${bookingId}::uuid
  `)
  return result.rows[0].status as string
}

test('a confirmed booking flips to refunded_manual and its payment is stamped', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-05-02', 12), status: 'confirmed',
  })
  const paymentId = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  await db.execute(sql`update payments set needs_refund = true where id = ${paymentId}::uuid`)

  expect(await recordPaymentRefund(paymentId, 'PayMongo ref abc')).toEqual({
    ok: true, bookingRefunded: true,
  })
  expect(await bookingStatus(bookingId)).toBe('refunded_manual')

  const payment = await paymentRow(paymentId)
  expect(payment.needs_refund).toBe(false)
  expect(payment.refunded_at).not.toBeNull()
  expect(payment.refund_note).toBe('PayMongo ref abc')
})

test('a completed booking flips too', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-05-03', 12), status: 'completed',
  })
  const paymentId = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })

  expect(await recordPaymentRefund(paymentId, 'ref')).toEqual({ ok: true, bookingRefunded: true })
  expect(await bookingStatus(bookingId)).toBe('refunded_manual')
})

test('an orphan payment clears its flag and leaves the booking alone', async () => {
  // The shape src/lib/payments/webhook.ts produces most often: money landed
  // for a slot that was no longer available, so the booking never confirmed.
  // There is no owner credit to reverse.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-05-04', 12), status: 'expired',
  })
  const paymentId = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  await db.execute(sql`update payments set needs_refund = true where id = ${paymentId}::uuid`)

  expect(await recordPaymentRefund(paymentId, 'orphan')).toEqual({
    ok: true, bookingRefunded: false,
  })
  expect(await bookingStatus(bookingId)).toBe('expired')
  expect((await paymentRow(paymentId)).needs_refund).toBe(false)
})

test('recording twice is a no-op', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-05-05', 12), status: 'confirmed',
  })
  const paymentId = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })

  expect(await recordPaymentRefund(paymentId, 'first')).toEqual({ ok: true, bookingRefunded: true })
  expect(await recordPaymentRefund(paymentId, 'second')).toEqual({
    ok: false, reason: 'already_recorded',
  })
  expect((await paymentRow(paymentId)).refund_note).toBe('first')
})

test('an unknown payment id reports already_recorded rather than throwing', async () => {
  expect(await recordPaymentRefund(crypto.randomUUID(), 'x')).toEqual({
    ok: false, reason: 'already_recorded',
  })
})
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run tests/refunds/write.test.ts
```

Expected: all fail to resolve `@/lib/refunds/write`.

- [ ] **Step 3: Write the refund write module**

Create `src/lib/refunds/write.ts`:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

export const MAX_REFUND_NOTE = 500

export type RefundResult =
  | { ok: true; bookingRefunded: boolean }
  | { ok: false; reason: 'already_recorded' }

/**
 * Bookkeeping, not a money movement: the admin performs the refund in the
 * provider's dashboard, then records it here.
 *
 * PAYMENT-SCOPED, not booking-scoped, and that is the whole design. The
 * webhook (src/lib/payments/webhook.ts:214) flags needs_refund on payments
 * whose booking is `expired` or still `pending_payment` — money that landed
 * for a slot no longer available. Those orphans have no owner credit to
 * reverse and no booking to flip, so a booking-scoped action would have
 * nothing to write for the case the webhook generates most often.
 *
 * Two statements, one transaction:
 *   1. Stamp the payment, guarded by `refunded_at is null` so a replay is a
 *      no-op rather than an overwrite of the original note.
 *   2. Flip the booking, status-scoped to confirmed/completed. Zero rows here
 *      is the EXPECTED outcome for an orphan, not a failure — which is what
 *      `bookingRefunded` reports back to the caller so the UI can say the
 *      right thing.
 *
 * Full refunds only in MVP: the amount refunded is the payment's own
 * amount_centavos. Partial refunds would add a refund_amount_centavos column.
 */
export async function recordPaymentRefund(
  paymentId: string,
  note: string,
): Promise<RefundResult> {
  const trimmed = note.trim().slice(0, MAX_REFUND_NOTE)

  return db.transaction(
    async (tx) => {
      const stamped = await tx.execute(sql`
        update payments
        set needs_refund = false, refunded_at = now(),
            refund_note = ${trimmed.length > 0 ? trimmed : null}
        where id = ${paymentId}::uuid and refunded_at is null
        returning booking_id
      `)
      if (stamped.rows.length === 0) {
        return { ok: false as const, reason: 'already_recorded' as const }
      }

      const flipped = await tx.execute(sql`
        update bookings
        set status = 'refunded_manual'::booking_status
        where id = ${stamped.rows[0].booking_id as string}::uuid
          and status in ('confirmed', 'completed')
        returning id
      `)

      return { ok: true as const, bookingRefunded: flipped.rows.length > 0 }
    },
    { isolationLevel: 'read committed' },
  )
}
```

- [ ] **Step 4: Run the write tests**

```bash
npx vitest run tests/refunds/write.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Write the failing query tests**

Create `tests/refunds/queries.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { findRefundCandidates, getFlaggedRefunds } from '@/lib/refunds/queries'
import { recordPaymentRefund } from '@/lib/refunds/write'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedPayment,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

async function playerEmail(playerId: string) {
  const result = await db.execute(sql`select email from profiles where id = ${playerId}::uuid`)
  return result.rows[0].email as string
}

test('the flagged queue returns only needs_refund payments, and drops them once recorded', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-04-02', 12), status: 'confirmed',
  })
  const flagged = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  await db.execute(sql`update payments set needs_refund = true where id = ${flagged}::uuid`)

  const before = await getFlaggedRefunds()
  const mine = before.find((c) => c.bookingId === bookingId)
  expect(mine).toBeDefined()
  expect(mine?.payments.some((p) => p.paymentId === flagged && p.needsRefund)).toBe(true)
  expect(mine?.branchName).toBe('Fixture Branch')
  expect(mine?.courtName).toBe('Court 1')
  expect(mine?.playerEmail).toBe(await playerEmail(playerId))

  await recordPaymentRefund(flagged, 'done')
  const after = await getFlaggedRefunds()
  expect(after.find((c) => c.bookingId === bookingId)).toBeUndefined()
})

test('lookup matches by player email, case-insensitively', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-04-03', 12), status: 'completed',
  })
  await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })

  const email = await playerEmail(playerId)
  const found = await findRefundCandidates(email.toUpperCase())
  expect(found.map((c) => c.bookingId)).toContain(bookingId)
  expect(found[0].payments).toHaveLength(1)
})

test('lookup matches by booking id', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-04-04', 12), status: 'completed',
  })
  await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })

  const found = await findRefundCandidates(bookingId)
  expect(found).toHaveLength(1)
  expect(found[0].bookingId).toBe(bookingId)
})

test('a non-uuid, non-matching query returns nothing rather than throwing 22P02', async () => {
  expect(await findRefundCandidates('not-a-uuid-or-an-email')).toEqual([])
  expect(await findRefundCandidates('   ')).toEqual([])
})

test('a booking with no payments still returns, with an empty payments list', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-04-05', 12), status: 'completed',
  })

  const found = await findRefundCandidates(bookingId)
  expect(found).toHaveLength(1)
  expect(found[0].payments).toEqual([])
})
```

- [ ] **Step 6: Run and watch them fail**

```bash
npx vitest run tests/refunds/queries.test.ts
```

- [ ] **Step 7: Write the refund query module**

Create `src/lib/refunds/queries.ts`. Both entry points return the same
`RefundCandidate` shape via a shared private builder, so the queue and the
lookup can never render differently:

```ts
import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'

export type RefundPayment = {
  paymentId: string
  amountCentavos: number
  paymentMethod: string | null
  status: 'pending' | 'paid' | 'failed'
  needsRefund: boolean
  /** Manila dates (`YYYY-MM-DD`), ready for formatDateLabel(). */
  paidOn: string | null
  refundedOn: string | null
  refundNote: string | null
}

export type RefundCandidate = {
  bookingId: string
  bookingStatus: string
  bookedOn: string
  branchName: string
  courtName: string
  playerEmail: string | null
  playerName: string | null
  totalChargedCentavos: number
  payments: RefundPayment[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Two queries stitched by booking id, not one join: a join multiplies the
 * booking row by its payment count, and total_charged_centavos would then
 * need de-duplicating before display. Same shape as getAdminOwners' follow-up
 * queries.
 *
 * player_id is left-joined, not inner: a `blocked` row has none. Blocks carry
 * no money and so can never be flagged, but the lookup accepts a raw booking
 * id and must not simply lose one.
 *
 * `limitClause` is a parameter rather than a constant because the two callers
 * need opposite things. The lookup caps at 50 — a support query, and a player
 * with hundreds of bookings does not need all of them on screen. The flagged
 * queue caps at NOTHING: it is a work list of money sitting in the wrong
 * place, and a silent truncation there would read as "that's all of them"
 * when it isn't. It should be short; if it ever isn't, that is precisely when
 * an admin must see every row.
 */
async function candidates(bookingFilter: SQL, limitClause: SQL): Promise<RefundCandidate[]> {
  const bookings = await db.execute(sql`
    select bk.id, bk.status::text as status,
           to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as booked_on,
           br.name as branch_name, c.name as court_name,
           p.email as player_email, p.full_name as player_name,
           bk.total_charged_centavos
    from bookings bk
    join branches br on br.id = bk.branch_id
    join courts c on c.id = bk.court_id
    left join profiles p on p.id = bk.player_id
    where ${bookingFilter}
    order by bk.starts_at desc, bk.id
    ${limitClause}
  `)
  if (bookings.rows.length === 0) return []

  const ids = bookings.rows.map((row) => row.id as string)
  const payments = await db.execute(sql`
    select id, booking_id, amount_centavos, payment_method, status::text as status,
           needs_refund,
           to_char(paid_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as paid_on,
           to_char(refunded_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as refunded_on,
           refund_note
    from payments
    where booking_id = any (${sql.param(ids)}::uuid[])
    order by created_at, id
  `)

  const byBooking = new Map<string, RefundPayment[]>()
  for (const row of payments.rows) {
    const list = byBooking.get(row.booking_id as string) ?? []
    list.push({
      paymentId: row.id as string,
      amountCentavos: Number(row.amount_centavos),
      paymentMethod: (row.payment_method as string | null) ?? null,
      status: row.status as 'pending' | 'paid' | 'failed',
      needsRefund: row.needs_refund === true,
      paidOn: (row.paid_on as string | null) ?? null,
      refundedOn: (row.refunded_on as string | null) ?? null,
      refundNote: (row.refund_note as string | null) ?? null,
    })
    byBooking.set(row.booking_id as string, list)
  }

  return bookings.rows.map((row) => ({
    bookingId: row.id as string,
    bookingStatus: row.status as string,
    bookedOn: row.booked_on as string,
    branchName: row.branch_name as string,
    courtName: row.court_name as string,
    playerEmail: (row.player_email as string | null) ?? null,
    playerName: (row.player_name as string | null) ?? null,
    totalChargedCentavos: Number(row.total_charged_centavos),
    payments: byBooking.get(row.id as string) ?? [],
  }))
}

/**
 * What the webhook flagged and nobody has resolved. This is the queue that
 * did not exist until now — 20260807090000_payments.sql:63 says so.
 */
export async function getFlaggedRefunds(): Promise<RefundCandidate[]> {
  return candidates(
    sql`exists (select 1 from payments pay where pay.booking_id = bk.id and pay.needs_refund)`,
    sql``,
  )
}

/**
 * The dispute path: a player emails support, the admin finds their booking.
 *
 * ONE input, not two. A value that parses as a uuid is a booking id;
 * everything else is treated as an email. The uuid shape check is not
 * cosmetic — feeding arbitrary text to a `::uuid` cast raises 22P02, which
 * would surface as a 500 on a typo.
 */
export async function findRefundCandidates(query: string): Promise<RefundCandidate[]> {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []

  return candidates(
    UUID_RE.test(trimmed)
      ? sql`bk.id = ${trimmed}::uuid`
      : sql`exists (
          select 1 from profiles pl
          where pl.id = bk.player_id and lower(pl.email) = lower(${trimmed})
        )`,
    sql`limit 50`,
  )
}
```

- [ ] **Step 8: Run the query tests**

```bash
npx vitest run tests/refunds
```

Expected: 10 passed across both files.

- [ ] **Step 9: Gate and report (do not commit)**

```bash
npx tsc --noEmit && npm run lint
```

Report the exported signatures verbatim — Task 6 binds to them.

---

### Task 5: The `/admin/payouts` surface

**Files:**
- Create: `src/app/admin/payouts/page.tsx`
- Create: `src/app/admin/payouts/actions.ts`
- Create: `src/app/admin/payouts/payout-forms.tsx`
- Create: `src/app/admin/payouts/[ownerId]/page.tsx`
- Modify: `src/app/admin/layout.tsx` (nav items + the comment explaining them)

**Interfaces:**
- Consumes: `getAllOwnerLedgers`, `getOwnerLedger`, `getOwnerPayouts`, `getPayablePool` (Task 2); `preparePayout`, `markPayoutPaid`, `MAX_PAYOUT_NOTE` (Task 3); `refuseUnlessAdmin` from `@/lib/admin/guard`; `AdminFormState` from `@/app/admin/actions`; `requireAdminPage` from `@/lib/auth/page-guards`; `formatPeso` / `formatDateLabel` from `@/lib/format`; `StatCard` from `@/components/dashboard/stat-card`.
- Produces: `preparePayoutAction` and `markPayoutPaidAction`, both `(prevState: AdminFormState, formData: FormData) => Promise<AdminFormState>`.

- [ ] **Step 1: Read the precedents before writing anything**

Read, in this order: `design/branding.md` (all of it — this task adds two pages), `src/app/admin/page.tsx` (card/table chrome, `KICKER`, `EMPTY_PANEL`, `FOCUS_RING`), `src/app/admin/moderation-forms.tsx` (the `useActionState` client-form pattern and the one-lime-button rule), `src/app/dashboard/earnings/page.tsx` (the money table this page's table should echo), and `src/app/admin/settings/actions.ts` (the guarded-action shape).

Do not invent new card, button, or table classes. Reuse `BORDERED_BUTTON`, `DARK_BUTTON`, `FormMessage`, and `TEXTAREA` from `@/app/dashboard/listings/form-ui`.

- [ ] **Step 2: Write the actions**

Create `src/app/admin/payouts/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import type { AdminFormState } from '@/app/admin/actions'
import { refuseUnlessAdmin } from '@/lib/admin/guard'
import { formatPeso } from '@/lib/format'
import { markPayoutPaid, preparePayout } from '@/lib/payouts/write'

/**
 * The payout ledger's two writes.
 *
 * This file exports exactly two guarded actions — every OTHER export of a
 * 'use server' file becomes a client-invokable endpoint. All SQL lives in
 * src/lib/payouts/, where it is unit-tested.
 *
 * ONE GUARD SHAPE: requireAdmin, via refuseUnlessAdmin in
 * src/lib/admin/guard.ts — imported, not duplicated, exactly as
 * src/app/admin/settings/actions.ts does.
 *
 * A submitted id is safe to guard on because both writes underneath are
 * scoped by something the caller cannot forge: preparePayout resolves its own
 * line set from the owner's bookings, and markPayoutPaid is status-scoped
 * (`and status = 'pending'`). A wrong id matches no row and returns a
 * friendly reason.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BAD_TARGET = "That doesn't look right — reload the page and try again."

function idFrom(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '')
  return UUID_RE.test(value) ? value : null
}

export async function preparePayoutAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const ownerId = idFrom(formData, 'ownerId')
  if (!ownerId) return { error: BAD_TARGET }

  const result = await preparePayout(ownerId)
  if (!result.ok) {
    return { error: 'There is nothing to pay this owner right now.' }
  }

  revalidatePath('/admin/payouts')
  revalidatePath(`/admin/payouts/${ownerId}`)
  revalidatePath('/dashboard/earnings')
  return {
    ok: true,
    message: `Prepared ${formatPeso(result.netCentavos)} across ${result.lineCount} ${
      result.lineCount === 1 ? 'booking' : 'bookings'
    }. Send the transfer, then mark it paid.`,
  }
}

export async function markPayoutPaidAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const payoutId = idFrom(formData, 'payoutId')
  const ownerId = idFrom(formData, 'ownerId')
  if (!payoutId || !ownerId) return { error: BAD_TARGET }

  const result = await markPayoutPaid(payoutId, String(formData.get('note') ?? ''))
  if (!result.ok) {
    return { error: 'That payout has already been recorded as paid.' }
  }

  revalidatePath('/admin/payouts')
  revalidatePath(`/admin/payouts/${ownerId}`)
  revalidatePath('/dashboard/earnings')
  return { ok: true, message: 'Payout recorded.' }
}
```

- [ ] **Step 3: Write the client forms**

Create `src/app/admin/payouts/payout-forms.tsx`. Both are client components for the same reason `moderation-forms.tsx` is: a Server Component cannot render what a Server Action returned, so "already recorded" would look like nothing happening.

```tsx
'use client'

import { useActionState } from 'react'
import { BORDERED_BUTTON, DARK_BUTTON, FIELD, FormMessage } from '@/app/dashboard/listings/form-ui'
import type { AdminFormState } from '@/app/admin/actions'
import { markPayoutPaidAction, preparePayoutAction } from './actions'

export function PrepareForm({ ownerId, disabled }: { ownerId: string; disabled: boolean }) {
  const [state, prepare, pending] = useActionState<AdminFormState, FormData>(
    preparePayoutAction,
    null,
  )
  return (
    <form action={prepare} className="flex flex-col gap-2">
      <input type="hidden" name="ownerId" value={ownerId} />
      <button type="submit" disabled={pending || disabled} className={DARK_BUTTON}>
        {pending ? 'Preparing…' : 'Prepare payout'}
      </button>
      <FormMessage state={state} />
    </form>
  )
}

export function MarkPaidForm({ payoutId, ownerId }: { payoutId: string; ownerId: string }) {
  const [state, markPaid, pending] = useActionState<AdminFormState, FormData>(
    markPayoutPaidAction,
    null,
  )
  return (
    <form action={markPaid} className="mt-4 flex flex-col gap-2">
      <input type="hidden" name="payoutId" value={payoutId} />
      <input type="hidden" name="ownerId" value={ownerId} />
      <label htmlFor={`note-${payoutId}`} className="text-[13px] text-[var(--ink-soft)]">
        Transfer reference
      </label>
      <input
        id={`note-${payoutId}`}
        name="note"
        type="text"
        maxLength={500}
        placeholder="GCash ref, bank transaction no."
        className={FIELD}
      />
      <button type="submit" disabled={pending} className={BORDERED_BUTTON}>
        {pending ? 'Recording…' : 'Mark paid'}
      </button>
      <FormMessage state={state} />
    </form>
  )
}
```

`FIELD` is that module's text-input class (`LIME_BUTTON`, `DARK_BUTTON`, `BORDERED_BUTTON`, `FIELD`, `TEXTAREA`, `LABEL`, `CHECKBOX`, `CHECK_LABEL`, `FOCUS_RING`, and `FormMessage` are its full export list). Do not declare a new control class here.

**One lime button per view:** `DARK_BUTTON` for Prepare (branding.md's alternative primary), `BORDERED_BUTTON` for Mark paid. The list page repeats Prepare once per owner, so lime is forbidden there, exactly as `moderation-forms.tsx` documents.

- [ ] **Step 4: Write the list page**

Create `src/app/admin/payouts/page.tsx`. A Server Component: `await requireAdminPage('/admin/payouts')` first (the layout guards too, but App Router cannot hand a layout's result to a page and this page's own reads are global — gated by construction beats gated by assumption, the same rule `src/app/admin/page.tsx:44` states).

Structure:

```tsx
export default async function AdminPayoutsPage() {
  await requireAdminPage('/admin/payouts')
  const ledgers = await getAllOwnerLedgers()

  const totalOwed = ledgers.reduce((sum, l) => sum + Math.max(l.owedCentavos, 0), 0)
  const totalPrepared = ledgers.reduce((sum, l) => sum + l.preparedCentavos, 0)
  // ...
}
```

Three `StatCard`s across the top: **Owed** (`formatPeso(totalOwed)` — sum of positive balances only, since negative balances are not money you owe anyone), **Prepared** (awaiting transfer), **Paid all time**.

Then one table, echoing `src/app/dashboard/earnings/page.tsx`'s markup exactly (same `overflow-x-auto rounded-[20px] bg-[var(--panel)] shadow-[var(--shadow-sm)]` wrapper, same `font-mono` right-aligned money cells, same header row classes). Columns: Owner (business name, falling back to email, linking to `/admin/payouts/<id>`), Bookings (payable count), Owed, Prepared, Paid, and a final cell holding `<PrepareForm ownerId={l.ownerId} disabled={l.owedCentavos <= 0} />`.

Render a negative `owedCentavos` in `var(--ink-soft)` with the caption explaining it, so a negative reads as "this owner was overpaid and it nets off next time" rather than as a bug. Add a `<caption className="caption-top ...">` saying exactly that, matching the earnings table's caption pattern.

Empty state: if `ledgers` is empty, render the `EMPTY_PANEL` pattern from `src/app/admin/page.tsx` with "No owners yet."

- [ ] **Step 5: Write the detail page**

Create `src/app/admin/payouts/[ownerId]/page.tsx`:

```tsx
export default async function AdminPayoutDetailPage({
  params,
}: {
  params: Promise<{ ownerId: string }>
}) {
  await requireAdminPage('/admin/payouts')
  const { ownerId } = await params
  const ledger = await getOwnerLedger(ownerId)
  if (!ledger) notFound()

  const [payouts, pool] = await Promise.all([getOwnerPayouts(ownerId), getPayablePool(ownerId)])
  const pending = payouts.filter((p) => p.status === 'pending')
  const paid = payouts.filter((p) => p.status === 'paid')
  // ...
}
```

`notFound()` from `next/navigation` on a null ledger — an unknown or non-owner id is a 404, not a crash.

Three sections, each a card:

1. **Awaiting transfer** — one card per pending payout: period (`formatDateLabel`), net, line count, then `<MarkPaidForm payoutId={p.id} ownerId={ownerId} />`. **Above the form, if `p.lines.some((l) => l.bookingRefunded && l.kind === 'payment')`, render a warning panel** naming those bookings: "N booking(s) in this payout have since been refunded. Paying it will overpay by ₱X; the amount is clawed back on the next payout." Compute X as the sum of those lines' `netCentavos`. This warning is the entire reason the flow has two steps — do not omit it.
2. **Payout history** — the `paid` list: period, net, `paidOn`, `note`. `EMPTY_PANEL` when empty.
3. **Payable now** — the `pool` rows: date, branch, court, net; with a total. `EMPTY_PANEL` reading "Nothing payable right now." when empty.

Include a back link to `/admin/payouts` using the `NAV_LINK` shape from `src/app/dashboard/earnings/page.tsx:12`.

- [ ] **Step 6: Add the nav item**

In `src/app/admin/layout.tsx`, add Payouts between Owners and Settings:

```tsx
  const items = [
    { href: '/admin', label: 'Approvals', badge: pending },
    { href: '/admin/owners', label: 'Owners', badge: 0 },
    { href: '/admin/payouts', label: 'Payouts', badge: 0 },
    { href: '/admin/settings', label: 'Settings', badge: 0 },
  ]
```

Update that file's doc comment: it currently reads "Three nav items, not the mockup's six: Payouts, Users and Bookings are later slices." Payouts is no longer a later slice. Rewrite it to say Users and Bookings remain later slices, and that Payouts and Refunds joined once those pages shipped.

- [ ] **Step 7: Gate**

```bash
npx tsc --noEmit && npm run lint && npx vitest run tests/auth/action-coverage.test.ts
```

Expected: clean, and the action-coverage test passes with the two new actions included.

- [ ] **Step 8: Confirm the pages compile and do not 500**

`/admin/*` needs an admin session, which cannot be created from the browser tools in this project. So verify by build, not by browsing:

```bash
npm run build
```

Expected: both new routes appear in the route list and the build succeeds. A missing client/server boundary (importing a `@/lib/...` value into a `'use client'` file) fails here, and it is the failure this project has hit before — client components may only *type*-import from modules that touch `@/db`.

- [ ] **Step 9: Report (do not commit)**

---

### Task 6: The `/admin/refunds` surface

**Files:**
- Create: `src/app/admin/refunds/page.tsx`
- Create: `src/app/admin/refunds/actions.ts`
- Create: `src/app/admin/refunds/refund-forms.tsx`
- Modify: `src/app/admin/layout.tsx` (add the Refunds nav item and its badge)
- Modify: `src/lib/refunds/queries.ts` (add `getFlaggedRefundCount`, Step 4)
- Modify: `tests/refunds/queries.test.ts` (add its test, Step 5)

**Interfaces:**
- Consumes: `getFlaggedRefunds`, `findRefundCandidates`, `RefundCandidate` (Task 4); `recordPaymentRefund` (Task 4); `refuseUnlessAdmin`; `AdminFormState`.
- Produces: `recordRefundAction: (prevState: AdminFormState, formData: FormData) => Promise<AdminFormState>`.

- [ ] **Step 1: Write the action**

Create `src/app/admin/refunds/actions.ts`, same shape as Task 5's actions file (guard first, `UUID_RE` id check, `revalidatePath`). The distinguishing part is the success message, which must tell the admin which of the two shapes happened:

```ts
export async function recordRefundAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const paymentId = idFrom(formData, 'paymentId')
  if (!paymentId) return { error: BAD_TARGET }

  const result = await recordPaymentRefund(paymentId, String(formData.get('note') ?? ''))
  if (!result.ok) return { error: 'That refund has already been recorded.' }

  revalidatePath('/admin/refunds')
  revalidatePath('/admin/payouts')
  revalidatePath('/dashboard/earnings')
  return {
    ok: true,
    message: result.bookingRefunded
      ? 'Refund recorded. The booking is now marked refunded.'
      : 'Refund recorded. That payment never confirmed a booking, so nothing else changed.',
  }
}
```

The two messages are not decoration — an admin needs to know whether a court slot just freed up in the owner's ledger or whether they simply returned orphaned money.

`revalidatePath('/admin/payouts')` matters: a recorded refund changes owed.

- [ ] **Step 2: Write the client form**

Create `src/app/admin/refunds/refund-forms.tsx` with a `RecordRefundForm({ paymentId }: { paymentId: string })` following Task 5's `MarkPaidForm` exactly — `useActionState`, hidden `paymentId`, a text input named `note` with `maxLength={500}` labelled "Provider reference", a `BORDERED_BUTTON`, and `<FormMessage state={state} />`.

- [ ] **Step 3: Write the page**

Create `src/app/admin/refunds/page.tsx`:

```tsx
export default async function AdminRefundsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  await requireAdminPage('/admin/refunds')
  const { q } = await searchParams
  const query = (q ?? '').trim()

  const [flagged, matches] = await Promise.all([
    getFlaggedRefunds(),
    query.length > 0 ? findRefundCandidates(query) : Promise.resolve([]),
  ])
  // ...
}
```

Two sections:

1. **Flagged by the system** — `flagged` rendered as cards. Each shows booking date, branch + court, player email, booking status, and one row per payment with its amount and method. Only payments where `needsRefund` is true get a `<RecordRefundForm paymentId={p.paymentId} />`. Above the list, a short explanation: these are payments that landed for a slot that was no longer available, that did not match what their checkout quoted, or that double-charged a booking already confirmed by a different payment. `EMPTY_PANEL` reading "Nothing flagged." when empty — and that empty state is the good state, so word it as reassurance, not as absence.

2. **Find a booking** — a plain `<form method="get">` with one text input named `q` (a GET form, not a Server Action: the result is a *read*, and a URL you can share and reload is the right shape for support work). Placeholder: "Player email or booking ID". Below it, `matches` rendered with the same card component as section 1 — extract that card into a local `function CandidateCard({ candidate }: { candidate: RefundCandidate })` in this file and use it for both sections so the queue and the lookup can never drift apart.

   In the lookup section, a payment gets a form when `p.status === 'paid' && p.refundedOn === null`. A booking whose payments are all unpaid or already refunded shows the payments with their state and no form — "there is nothing to return" must be visible, not implied by a missing button.

   When `query.length > 0 && matches.length === 0`, render an explicit "No booking matches that email or ID."

- [ ] **Step 4: Add the nav item**

In `src/app/admin/layout.tsx`, add Refunds after Payouts:

```tsx
    { href: '/admin/refunds', label: 'Refunds', badge: 0 },
```

The `badge` field takes a count and `/admin` already uses it for the pending-court count. Wire the flagged count in: import `getFlaggedRefunds` is too heavy for a layout, so add a narrow count query to `src/lib/refunds/queries.ts`:

```ts
/** Just the number, for the nav badge — the full queue query is far heavier. */
export async function getFlaggedRefundCount(): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as count from payments where needs_refund
  `)
  return Number(result.rows[0].count)
}
```

Call it in the layout alongside `getPendingCourtCount()` and pass it as the Refunds badge. A flagged payment is money sitting in the wrong place — it should be visible from every admin page, not only when someone thinks to look.

- [ ] **Step 5: Add a test for the count query**

Append to `tests/refunds/queries.test.ts`:

```ts
test('the flagged count tracks the queue', async () => {
  const before = await getFlaggedRefundCount()

  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-04-06', 12), status: 'confirmed',
  })
  const paymentId = await seedPayment({ bookingId, amountCentavos: 30000, status: 'paid' })
  await db.execute(sql`update payments set needs_refund = true where id = ${paymentId}::uuid`)

  expect(await getFlaggedRefundCount()).toBe(before + 1)
  await recordPaymentRefund(paymentId, 'done')
  expect(await getFlaggedRefundCount()).toBe(before)
})
```

Relative to `before`, not an absolute number: this database is shared and persistent, and another suite may have flagged rows of its own.

Add `getFlaggedRefundCount` to that file's import list.

- [ ] **Step 6: Gate**

```bash
npx vitest run tests/refunds tests/auth/action-coverage.test.ts && npx tsc --noEmit && npm run lint && npm run build
```

Expected: all tests pass, build succeeds, `/admin/refunds` appears in the route list.

- [ ] **Step 7: Report (do not commit)**

---

### Task 7: The owner-facing Payouts section

**Files:**
- Modify: `src/app/dashboard/earnings/page.tsx`
- Modify: `src/lib/payouts/ledger.ts` (add `getBranchesOwnerId`, Step 2)
- Modify: `tests/payouts/ledger.test.ts` (add its test, Step 3)

**Interfaces:**
- Consumes: `getOwnerLedger`, `getOwnerPayouts` (Task 2); the page's existing `requireDashboardPage` / `access.can.view_earnings` gate and its `branchIdsWith` import.
- Produces: `getBranchesOwnerId(branchIds: string[]): Promise<string | null>` on `src/lib/payouts/ledger.ts`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Read the page and branding rules first**

Read `src/app/dashboard/earnings/page.tsx` in full and `design/branding.md`'s Cards and Tables entries. This task appends to a page that is already correct — match its markup, do not restyle it.

- [ ] **Step 2: Resolve the owner id**

The page currently works entirely in branch ids. Payouts are owner-scoped, so it needs the owner. `access` from `requireDashboardPage` carries the session's own profile; a staff member's session is not the owner. Read the owner from the branches the session can see earnings for:

```ts
// Payouts are OWNER-scoped, not branch-scoped: one payout covers everything
// an owner is owed across every branch. So this section needs the owner
// behind the branches this session can see earnings for — for an owner's own
// session that is themselves, and for a staff member it is the person who
// employs them.
const earningsBranchIds = branchIdsWith(access, 'view_earnings')
const ownerId = await getBranchesOwnerId(earningsBranchIds)
```

Add `getBranchesOwnerId` to `src/lib/payouts/ledger.ts`:

```ts
/**
 * The owner behind a set of branches, or null when the set is empty or spans
 * more than one owner. More than one is not reachable today — branch_staff
 * grants come from a single owner — but returning null rather than picking
 * one means a future multi-owner grant hides the payout section instead of
 * showing someone another owner's money.
 */
export async function getBranchesOwnerId(branchIds: string[]): Promise<string | null> {
  if (branchIds.length === 0) return null
  const result = await db.execute(sql`
    select distinct owner_id from branches where id = any (${sql.param(branchIds)}::uuid[])
  `)
  return result.rows.length === 1 ? (result.rows[0].owner_id as string) : null
}
```

- [ ] **Step 3: Add the test for it**

Append to `tests/payouts/ledger.test.ts`:

```ts
test('getBranchesOwnerId resolves one owner, and refuses to guess across two', async () => {
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)

  expect(await getBranchesOwnerId([first.branchId])).toBe(first.ownerId)
  expect(await getBranchesOwnerId([])).toBeNull()
  expect(await getBranchesOwnerId([first.branchId, second.branchId])).toBeNull()
})
```

Add `getBranchesOwnerId` to that file's import list.

```bash
npx vitest run tests/payouts/ledger.test.ts
```

Expected: 10 passed.

- [ ] **Step 4: Fetch and render the section**

After the existing `getOwnerEarnings` call:

```ts
  const [ledger, payouts] = ownerId
    ? await Promise.all([getOwnerLedger(ownerId), getOwnerPayouts(ownerId)])
    : [null, []]
```

Render below the existing table, inside the same fragment:

```tsx
      {ledger && (
        <section className="mt-10">
          <h2 className="font-display text-[20px] font-bold tracking-[-0.02em] text-[var(--ink)]">
            Payouts
          </h2>
          {/* The table above is scoped to the selected month. This section is
              not, and cannot be: a payout covers whatever bookings were owed
              when it was prepared, which never lines up with a calendar
              month. Saying so is load-bearing — the month navigator sits
              directly above, and two figures that disagree with no
              explanation read as a bug. */}
          <p className="mt-1 text-[13px] text-[var(--ink-soft)]">
            All time — not filtered by the month above.
          </p>
          {/* ...stat cards + history list... */}
        </section>
      )}
```

Inside it:

- Two `StatCard`s: **Pending payout** (`formatPeso(ledger.owedCentavos)`) and **Paid all time** (`formatPeso(ledger.paidCentavos)`). When `ledger.preparedCentavos > 0`, add a third: **Awaiting transfer**.
- Below them, a history table of `payouts.filter((p) => p.status === 'paid')` — columns Period (`formatDateLabel(p.periodStart)` – `formatDateLabel(p.periodEnd)`), Paid (`p.paidOn`), Reference (`p.note ?? '—'`), Amount (`formatPeso(p.netCentavos)`, `font-mono` right-aligned). Reuse the exact table wrapper and cell classes from the earnings table above it.
- `EMPTY_PANEL`-style empty state when there are no paid payouts: "No payouts recorded yet." Declare the class locally in this file if the page does not already have one — do not import from an admin page.
- A negative `owedCentavos` needs a sentence, not just a minus sign: "This is an adjustment from a refunded booking that was already paid out. It comes off your next payout." Show it only when the figure is negative.

- [ ] **Step 5: Verify the page renders**

`/dashboard/*` needs a session, so verify by build plus the existing suite:

```bash
npm run build && npx vitest run tests/owner tests/payouts
```

Expected: build succeeds, all tests pass.

The trap this step exists to catch: `src/app/dashboard/earnings/page.tsx` is a Server Component, so importing `@/lib/payouts/ledger` for values is correct here. If any part of this section becomes a client component, it may only *type*-import from that module — a value import pulls `@/db` into the browser bundle, which passes `tsc` and `lint` and then 500s at runtime.

- [ ] **Step 6: Gate and report (do not commit)**

```bash
npx tsc --noEmit && npm run lint
```

---

### Task 8: Full-suite gate and manual verification

**Files:**
- Modify: `CLAUDE.md` (only if this slice changed a project convention — it should not have)

- [ ] **Step 1: Run the whole suite in the foreground**

```bash
npx vitest run
```

Expected: all pass. This hosted database has known pool-contention timeouts under parallel load — if a test times out, re-run that file in isolation before treating it as a real failure, and report which files needed isolating.

- [ ] **Step 2: Full gate**

```bash
npx tsc --noEmit && npm run lint && npm run build
```

Expected: zero errors. Lint warnings about `<img>` and `schema.ts`'s unused `table` are pre-existing — the count must not have grown.

- [ ] **Step 3: Verify the public surfaces did not move**

Start the dev server through the preview tool (never `npm run dev` in Bash) and check that `/`, `/search`, and a `/venues/[slug]` page still render, with no console errors. This slice touches no public page, so anything here is a regression.

- [ ] **Step 4: Walk the ledger end to end against the real database**

The admin and dashboard routes cannot be browsed without a session, so verify the behavior through a scratch script against `DATABASE_URL` instead — seed an owner with two completed bookings, call `preparePayout`, `markPayoutPaid`, then `recordPaymentRefund` on one of the paid bookings, and confirm `getOwnerLedger` reports the negative adjustment. Delete the seeded rows afterward: this database is shared and persistent.

Put the script in the scratchpad directory, not in the repo.

- [ ] **Step 5: Report (do not commit)**

Summarize: files created and modified, test counts per file, the full-gate output, what step 4 showed, and anything the spec called for that did not ship. The user commits.

---

## What this plan deliberately does not build

Carried from the spec's Out of scope, repeated here so a reviewer does not read these as gaps:

- **Partial refunds.** Full only; the extension point is a `refund_amount_centavos` column on `payments`.
- **Cancelling a prepared payout.** No unstamp path; a wrong prepared payout is corrected by the clawback on the next one.
- **Automated payouts** (PayMongo Platforms sub-accounts) and **self-service cancellations** — both Phase 2.
- **The admin all-bookings list.** Its own later slice; `/admin/refunds`' lookup covers the dispute path without preempting it.
- **Refund notification email.** Belongs to the Resend slice, which owns all five lifecycle emails together.
