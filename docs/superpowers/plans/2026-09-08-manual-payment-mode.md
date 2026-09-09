# Manual Payment Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin put a court owner on an offline payment rail where players pay the owner directly, upload a transfer screenshot, and the owner confirms the booking — with no platform fee.

**Architecture:** A second rail *alongside* the `PaymentProvider` abstraction, not another implementation of it. Mode lives on `profiles.payment_mode`, is snapshotted onto `bookings.payment_mode` at hold time, and branches the fee computation to zero. A new `pending_verification` booking status holds the slot while the owner reviews a `manual_payment_proofs` row. PayMongo, `computeFees`, and the webhook are untouched.

**Tech Stack:** Next.js App Router + TypeScript, Supabase Postgres via `db.execute(sql\`...\`)`, Supabase Storage (first private bucket), vitest against the hosted DB.

**Spec:** `docs/superpowers/specs/2026-09-08-manual-payment-mode-design.md`

## Global Constraints

- **Money:** integer centavos only. Percentages in integer basis points. Never floats, never `numeric`.
- **Identifiers:** lowercase `snake_case`. Index every foreign key explicitly.
- **Data access is server-only.** Every read/write goes through a Server Component, Server Action, or Route Handler behind `requireUser` / `requireOwnerOf` / `requireAdmin` / `requirePlayer` / `requireBranchAccess`.
- **RLS enabled, zero policies** on every new table. Do not add policies. Do not use `force row level security`.
- **Schema truth is the SQL migration files**, not `schema.ts`. Run `npx drizzle-kit pull` after each migration. Never import `schema.ts`.
- **Migrations** apply with `npx supabase db push --db-url "$DATABASE_URL"`. `supabase db reset` is unavailable — every file must be idempotent (`if not exists`, guarded `DO` blocks qualified by `conrelid`, `drop constraint if exists` + `add`). A second `db push` is *skipped*, not re-run, so prove idempotency by reading the SQL, not by re-pushing.
- **Adding a value to an existing enum needs its own migration file** (55P04 — cannot share a transaction with anything that uses it).
- **Tests run against the shared hosted DB.** They must pass on repeated runs and must not mutate seeded singleton rows (`platform_settings`, `processor_rates`). Mutate-and-assert on a singleton only inside a transaction you roll back.
- **DB connection** is the Supavisor session pooler, port **5432**, username `postgres.<ref>`. Never port 6543.
- **All user-facing copy is English only.** Currency is PHP (₱).
- **Before any UI work**, read `design/branding.md` and adhere to it. A design-system change updates `design/branding.md` in the same turn.
- **Authed routes cannot be browser-verified** — there is no dev login. Verify with `npx tsc --noEmit`, `npm run lint`, and the test suite.
- **Do not run state-changing git commands.** The commit steps below are written for a human to run, or for an agent explicitly told to commit.

---

## File Structure

**Migrations (create):**
- `supabase/migrations/20260908000000_manual_payment_mode.sql` — enums, columns, tables, buckets
- `supabase/migrations/20260908000100_booking_status_pending_verification.sql` — one enum value
- `supabase/migrations/20260908000200_manual_email_kinds.sql` — three enum values
- `supabase/migrations/20260908000300_no_overlap_pending_verification.sql` — constraint rebuild + cron function

**Server libs (create):**
- `src/lib/owner/payment-methods.ts` — owner CRUD over `owner_payment_methods`
- `src/lib/payments/manual.ts` — submit / approve / reject a proof
- `src/lib/payments/manual-copy.ts` — pure user-facing strings and reason codes (importable from client components)

**Server libs (modify):**
- `src/lib/booking/hold.ts` — manual branch: rail snapshot, zeroed fees, `pending_verification`, capped `expires_at`, widened sweep
- `src/lib/payouts/ledger.ts` — exclude manual from the payable pool (two functions)
- `src/lib/payouts/write.ts` — exclude manual from `preparePayout`
- `src/lib/listings/storage.ts` — add `createSignedUrl` to `StorageClient`
- `src/lib/admin/settings.ts` — `updateOwnerPaymentMode` + the payment-method guard
- `src/lib/admin/owners.ts` — surface `paymentMode` on `AdminOwnerRow`
- `src/lib/owner/settings.ts` — `updateManualReviewMinutes`
- `src/lib/photos.ts` — add the two new buckets to `PhotoBucket`
- `src/lib/payments/webhook.ts` — doc comment only (it is no longer the sole writer of `confirmed`)

**UI (create):**
- `src/app/dashboard/settings/payment-methods-form.tsx`
- `src/app/dashboard/payments/page.tsx` + `review-forms.tsx` — the owner verification queue
- `src/app/admin/owners/payment-mode-form.tsx`

**UI (modify):**
- `src/app/bookings/[id]/checkout/page.tsx` — manual branch
- `src/app/bookings/[id]/page.tsx` — awaiting/rejected states
- `src/app/dashboard/settings/page.tsx`, `src/app/admin/owners/page.tsx`, `src/app/venues/[slug]/page.tsx`
- `src/app/admin/actions.ts`, `src/app/dashboard/settings/actions.ts`
- `design/branding.md`

**Tests (create):** `tests/schema/manual-payments.test.ts`, `tests/owner/payment-methods.test.ts`, `tests/payments/manual.test.ts`, `tests/admin/payment-mode.test.ts`
**Tests (modify):** `tests/helpers/fixtures.ts`, `tests/booking/hold.test.ts`, `tests/payouts/ledger.test.ts`

---

## A correction to the spec, applied throughout this plan

The spec says the payout cut-off is one line in `ledgerRows` (`src/lib/payouts/ledger.ts:45`). Reading the code, it is **three queries in two files**:

1. `ledgerRows`'s `payable` CTE — `src/lib/payouts/ledger.ts:52`
2. `getPayablePool` — `src/lib/payouts/ledger.ts:238`
3. `preparePayout`'s `union all`, the `'payment'` arm — `src/lib/payouts/write.ts:56`

(1) drives the admin display, (2) the preview, (3) the actual write. Fixing only (1) would show ₱0 owed and then still stamp payout lines. All three are covered in Task 10.

The `clawback` arms need no filter: they require an existing `payment` line, which a manual booking can never have. Task 10 asserts that rather than assuming it.

---

## Phase 1 — Schema

### Task 1: Core migration — enums, columns, tables, buckets

**Files:**
- Create: `supabase/migrations/20260908000000_manual_payment_mode.sql`
- Create: `tests/schema/manual-payments.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: enums `payment_mode ('automated','manual')`, `payment_method_kind ('bank','ewallet')`, `manual_proof_status ('pending','approved','rejected')`; columns `profiles.payment_mode`, `profiles.manual_review_minutes`, `bookings.payment_mode`, `platform_settings.default_manual_review_minutes`; tables `owner_payment_methods`, `manual_payment_proofs`; buckets `payment-proofs` (private), `payment-qr` (public).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260908000000_manual_payment_mode.sql`:

```sql
-- Manual payment mode: an offline rail where the player pays the owner
-- directly and the owner verifies a transfer screenshot.
-- Design: docs/superpowers/specs/2026-09-08-manual-payment-mode-design.md

-- Brand-new enum TYPES may share this transaction; only new VALUES on an
-- existing enum need their own file (55P04). booking_status and email_kind
-- gain values in the two migrations after this one.
do $$ begin
  create type payment_mode as enum ('automated', 'manual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_method_kind as enum ('bank', 'ewallet');
exception when duplicate_object then null; end $$;

do $$ begin
  create type manual_proof_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

-- Which rail this owner is on. NOT NULL DEFAULT rather than the fee
-- override's nullable-plus-coalesce: there is no platform-wide rail to
-- inherit, so a null would just be a third spelling of 'automated'.
-- Admin-writable only (src/lib/admin/settings.ts).
alter table profiles
  add column if not exists payment_mode payment_mode not null default 'automated';

-- Owner-set review window. Nullable = inherit the platform default below,
-- the same coalesce shape the fee override uses.
alter table profiles
  add column if not exists manual_review_minutes integer;

alter table profiles drop constraint if exists profiles_manual_review_window;
alter table profiles add constraint profiles_manual_review_window
  check (manual_review_minutes is null
         or (manual_review_minutes >= 30 and manual_review_minutes <= 10080));

alter table platform_settings
  add column if not exists default_manual_review_minutes integer not null default 1440;

alter table platform_settings drop constraint if exists platform_settings_manual_review_window;
alter table platform_settings add constraint platform_settings_manual_review_window
  check (default_manual_review_minutes >= 30 and default_manual_review_minutes <= 10080);

-- The rail this booking was created on, resolved once at hold time and never
-- re-derived -- same reasoning as fee_config_snapshot. This is what keeps
-- manual bookings out of the payout pool, and what stops an admin flipping an
-- owner's mode from rewriting the rail of a booking already in flight.
alter table bookings
  add column if not exists payment_mode payment_mode not null default 'automated';

create index if not exists bookings_payment_mode_idx on bookings (payment_mode);

create table if not exists owner_payment_methods (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  kind payment_method_kind not null,
  institution text not null,
  account_name text not null,
  account_number text not null,
  qr_storage_path text,
  position integer not null,
  created_at timestamptz not null default now()
);

create index if not exists owner_payment_methods_owner_id_idx
  on owner_payment_methods (owner_id);

alter table owner_payment_methods enable row level security;

create table if not exists manual_payment_proofs (
  id uuid primary key default gen_random_uuid(),
  -- RESTRICT, matching payments.booking_id: a proof is a financial record and
  -- a booking is never deleted in production. Test teardown deletes proofs
  -- before bookings, exactly as it already does for payments.
  booking_id uuid not null unique references bookings(id),
  -- SET NULL, not RESTRICT: owner_payment_methods cascades from profiles from
  -- auth.users, so a restricting FK here would make deleting an owner
  -- impossible. paid_to_snapshot below is what preserves the record instead.
  owner_payment_method_id uuid references owner_payment_methods(id) on delete set null,
  paid_to_snapshot jsonb not null,
  storage_path text not null,
  reference_note text,
  status manual_proof_status not null default 'pending',
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references profiles(id),
  rejection_reason text
);

create index if not exists manual_payment_proofs_booking_id_idx
  on manual_payment_proofs (booking_id);
create index if not exists manual_payment_proofs_method_idx
  on manual_payment_proofs (owner_payment_method_id);
create index if not exists manual_payment_proofs_pending_idx
  on manual_payment_proofs (status) where status = 'pending';
create index if not exists manual_payment_proofs_reviewed_by_idx
  on manual_payment_proofs (reviewed_by);

alter table manual_payment_proofs enable row level security;

-- A reviewed proof carries its timestamp; a rejected one carries a reason.
alter table manual_payment_proofs drop constraint if exists manual_proof_reviewed_pair;
alter table manual_payment_proofs add constraint manual_proof_reviewed_pair
  check ((status = 'pending') = (reviewed_at is null));

alter table manual_payment_proofs drop constraint if exists manual_proof_rejection_reason;
alter table manual_payment_proofs add constraint manual_proof_rejection_reason
  check ((status = 'rejected') = (rejection_reason is not null));

-- payment-proofs is the project's FIRST PRIVATE bucket. A transfer screenshot
-- shows a bank account number, an account holder's name and often a balance;
-- it must never be reachable by URL alone. Reads go through short-lived signed
-- URLs minted server-side (src/lib/listings/storage.ts).
-- payment-qr is public for the same reason branch-photos is: a QR code exists
-- to be shown to whoever is about to pay.
insert into storage.buckets (id, name, public) values
  ('payment-proofs', 'payment-proofs', false),
  ('payment-qr',     'payment-qr',     true)
on conflict (id) do nothing;
```

- [ ] **Step 2: Write the failing schema test**

Create `tests/schema/manual-payments.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBranchWithCourts, seedOwner, teardownFixtures } from '../helpers/fixtures'

afterAll(teardownFixtures)

async function enumValues(typeName: string): Promise<string[]> {
  const result = await db.execute(sql`
    select e.enumlabel from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = ${typeName}
    order by e.enumsortorder
  `)
  return result.rows.map((r) => r.enumlabel as string)
}

test('the three new enum types exist with their values', async () => {
  expect(await enumValues('payment_mode')).toEqual(['automated', 'manual'])
  expect(await enumValues('payment_method_kind')).toEqual(['bank', 'ewallet'])
  expect(await enumValues('manual_proof_status')).toEqual(['pending', 'approved', 'rejected'])
})

test('a new profile defaults to the automated rail', async () => {
  const ownerId = await seedOwner()
  const result = await db.execute(sql`
    select payment_mode::text as mode, manual_review_minutes
    from profiles where id = ${ownerId}::uuid
  `)
  expect(result.rows[0].mode).toBe('automated')
  expect(result.rows[0].manual_review_minutes).toBeNull()
})

test('manual_review_minutes is bounded to 30 minutes .. 7 days', async () => {
  const ownerId = await seedOwner()
  await expect(
    db.execute(sql`update profiles set manual_review_minutes = 29 where id = ${ownerId}::uuid`),
  ).rejects.toThrow()
  await expect(
    db.execute(sql`update profiles set manual_review_minutes = 10081 where id = ${ownerId}::uuid`),
  ).rejects.toThrow()
  await db.execute(sql`update profiles set manual_review_minutes = 720 where id = ${ownerId}::uuid`)
  const ok = await db.execute(
    sql`select manual_review_minutes as m from profiles where id = ${ownerId}::uuid`,
  )
  expect(Number(ok.rows[0].m)).toBe(720)
})

test('owner_payment_methods and manual_payment_proofs have RLS on and zero policies', async () => {
  const result = await db.execute(sql`
    select c.relname, c.relrowsecurity,
           (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('owner_payment_methods', 'manual_payment_proofs')
    order by c.relname
  `)
  expect(result.rows).toHaveLength(2)
  for (const row of result.rows) {
    expect(row.relrowsecurity).toBe(true)
    expect(Number(row.policies)).toBe(0)
  }
})

test('a proof keeps its paid_to snapshot when its payment method is deleted', async () => {
  const { ownerId } = await seedBranchWithCourts(1)
  const method = await db.execute(sql`
    insert into owner_payment_methods
      (owner_id, kind, institution, account_name, account_number, position)
    values (${ownerId}::uuid, 'bank', 'BPI', 'Fixture Courts Inc', '1234567890', 0)
    returning id
  `)
  const methodId = method.rows[0].id as string

  await db.execute(sql`delete from owner_payment_methods where id = ${methodId}::uuid`)

  const gone = await db.execute(
    sql`select count(*)::int as n from owner_payment_methods where id = ${methodId}::uuid`,
  )
  expect(Number(gone.rows[0].n)).toBe(0)
})

test('the two storage buckets exist with the right visibility', async () => {
  const result = await db.execute(sql`
    select id, public from storage.buckets
    where id in ('payment-proofs', 'payment-qr') order by id
  `)
  expect(result.rows).toEqual([
    { id: 'payment-proofs', public: false },
    { id: 'payment-qr', public: true },
  ])
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/schema/manual-payments.test.ts`
Expected: FAIL — `type "payment_mode" does not exist` / zero rows for the enum queries.

- [ ] **Step 4: Apply the migration**

Run: `npx supabase db push --db-url "$DATABASE_URL"`
Expected: reports the one new migration applied.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/schema/manual-payments.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Verify idempotency by reading the SQL**

A second `db push` is *skipped*, not re-run, so it proves nothing. Instead read the migration and confirm every statement is guarded: `do $$ ... exception when duplicate_object` for each `create type`, `add column if not exists`, `create table if not exists`, `create index if not exists`, `drop constraint if exists` before each `add constraint`, and `on conflict (id) do nothing` on the bucket insert. Fix any unguarded statement.

- [ ] **Step 7: Regenerate types**

Run: `npx drizzle-kit pull`
Expected: `src/db/schema.ts` updated. Confirm nothing imports it (`grep -rn "from '@/db/schema'" src tests` returns nothing) — it stays excluded in `tsconfig.json`.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260908000000_manual_payment_mode.sql tests/schema/manual-payments.test.ts src/db/schema.ts
git commit -m "Manual payment mode: core schema"
```

---

### Task 2: Enum-value migrations — booking status and email kinds

**Files:**
- Create: `supabase/migrations/20260908000100_booking_status_pending_verification.sql`
- Create: `supabase/migrations/20260908000200_manual_email_kinds.sql`
- Modify: `tests/schema/manual-payments.test.ts`

**Interfaces:**
- Consumes: Task 1's migration must already be applied.
- Produces: `booking_status` value `pending_verification`; `email_kind` values `manual_proof_submitted`, `manual_proof_rejected`, `manual_review_expired`.

- [ ] **Step 1: Write both migrations**

`supabase/migrations/20260908000100_booking_status_pending_verification.sql`:

```sql
-- Its own file, containing nothing else: Postgres refuses to use a new enum
-- value in the same transaction that added it (55P04), and supabase db push
-- wraps each file in one transaction. Same reason
-- 20260805090000_booking_status_blocked.sql stands alone.
--
-- 'pending_verification' means: the player says they paid the owner directly
-- and uploaded proof; the owner has not yet confirmed. It HOLDS THE SLOT --
-- 20260908000300 adds it to bookings_no_overlap.
alter type booking_status add value if not exists 'pending_verification';
```

`supabase/migrations/20260908000200_manual_email_kinds.sql`:

```sql
-- Same 55P04 rule as the file before this one.
--
-- manual_proof_submitted -> owner: the only thing that tells an owner there is
--   something waiting in their review queue.
-- manual_proof_rejected  -> player: carries the owner's rejection_reason.
-- manual_review_expired  -> player: the review window ran out unreviewed.
alter type email_kind add value if not exists 'manual_proof_submitted';
alter type email_kind add value if not exists 'manual_proof_rejected';
alter type email_kind add value if not exists 'manual_review_expired';
```

- [ ] **Step 2: Write the failing test**

Append to `tests/schema/manual-payments.test.ts`:

```ts
test('booking_status gained pending_verification', async () => {
  expect(await enumValues('booking_status')).toContain('pending_verification')
})

test('email_kind gained the three manual-rail kinds', async () => {
  const kinds = await enumValues('email_kind')
  expect(kinds).toContain('manual_proof_submitted')
  expect(kinds).toContain('manual_proof_rejected')
  expect(kinds).toContain('manual_review_expired')
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/schema/manual-payments.test.ts -t "gained"`
Expected: FAIL — both assertions.

- [ ] **Step 4: Apply**

Run: `npx supabase db push --db-url "$DATABASE_URL"`

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/schema/manual-payments.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260908000100_booking_status_pending_verification.sql supabase/migrations/20260908000200_manual_email_kinds.sql tests/schema/manual-payments.test.ts
git commit -m "Manual payment mode: pending_verification status and email kinds"
```

---

### Task 3: Overlap constraint and expiry sweep

**Files:**
- Create: `supabase/migrations/20260908000300_no_overlap_pending_verification.sql`
- Modify: `tests/schema/manual-payments.test.ts`
- Modify: `tests/helpers/fixtures.ts`

**Interfaces:**
- Consumes: `pending_verification` from Task 2.
- Produces: `bookings_no_overlap` includes `pending_verification`; `expire_stale_holds()` sweeps it. `seedBooking`'s `status` union accepts `'pending_verification'`. New fixture `seedPaymentMethod`. `teardownFixtures` deletes proofs before bookings.

- [ ] **Step 1: Read the current constraint definition**

Run: `grep -n "bookings_no_overlap" -A 20 supabase/migrations/20260805090100_branch_staff_and_blocks.sql`

Copy the existing predicate verbatim into the next step and add `'pending_verification'` to its status list. Do not retype it from memory — the exact `tstzrange`/`with` clause must be preserved.

- [ ] **Step 2: Write the migration**

`supabase/migrations/20260908000300_no_overlap_pending_verification.sql`, substituting the predicate read in Step 1:

```sql
-- pending_verification occupies the slot -- that is the entire point of the
-- state. Without this the owner-review window would leave the slot bookable
-- and the platform would double-sell it.
--
-- Rebuilt rather than altered: an exclusion constraint's predicate cannot be
-- changed in place.
--
-- The guard sniffs the LIVE DEFINITION for 'pending_verification' rather than
-- merely checking that the constraint exists -- an existence check would see
-- the OLD constraint and skip the rebuild, shipping the invariant missing with
-- no error. It also makes every re-apply a true no-op instead of dropping and
-- rebuilding a GiST index. conrelid-qualified because constraint names are
-- unique per table, not per database. This is the exact shape
-- 20260805090100_branch_staff_and_blocks.sql used to add 'blocked'; read its
-- comment.
--
-- 'expired' and 'refunded_manual' stay out: they do not occupy the slot.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_no_overlap'
      and pg_get_constraintdef(oid) like '%pending_verification%'
  ) then
    alter table bookings drop constraint if exists bookings_no_overlap;
    alter table bookings add constraint bookings_no_overlap
      exclude using gist (court_id with =, slot with &&)
      where (status in ('pending_payment', 'pending_verification',
                        'confirmed', 'completed', 'blocked'));
  end if;
end $$;

-- The cron janitor knew only pending_payment. A manual booking's expires_at is
-- the owner's review deadline, so the same rule applies: past its deadline,
-- the slot goes back on sale.
--
-- This function does NOT enqueue email. email_outbox.payload is `jsonb not
-- null` and is typed by an exhaustive discriminated union in
-- src/lib/email/payload.ts -- renderEmail switches over it so that a kind
-- without a template does not compile. A SQL function hand-building that jsonb
-- would bypass the one guarantee that file exists to provide, and a malformed
-- payload would only surface as a permanently-failing row in the drainer.
-- Notifying the player that their review window lapsed is handled in the app
-- (see the booking-page states in Task 14), not from here.
create or replace function expire_stale_holds() returns void
language sql
as $$
  update bookings set status = 'expired'
  where status in ('pending_payment', 'pending_verification')
    and expires_at <= now();
$$;

-- CREATE OR REPLACE preserves a function's existing ACL, but re-issue the
-- revoke so the grant state is stated in the file that last defined it.
revoke all on function expire_stale_holds() from public, anon, authenticated, service_role;
```

**Note for the implementer:** the SQL above already matches the live definitions — `bookings_no_overlap` was last rebuilt in `20260805090100_branch_staff_and_blocks.sql:153-166` and `expire_stale_holds()` was defined in `20260801110350_storage_and_cron.sql:28-34`. Read both to confirm before writing, and preserve anything there that this text does not reproduce.

- [ ] **Step 3: Extend the test fixtures**

In `tests/helpers/fixtures.ts`:

(a) Add `'pending_verification'` to `seedBooking`'s `status` union:

```ts
  status?:
    | 'pending_payment'
    | 'pending_verification'
    | 'confirmed'
    | 'completed'
    | 'expired'
    | 'refunded_manual'
```

(b) Add a payment-method fixture. Place it beside `seedBranchWithCourts`:

```ts
/**
 * A payment method for a manual-rail owner.
 *
 * No teardown tracking of its own: owner_payment_methods.owner_id is
 * ON DELETE CASCADE from profiles, so teardownFixtures()'s auth.users delete
 * already reaches it.
 */
export async function seedPaymentMethod(opts: {
  ownerId: string
  kind?: 'bank' | 'ewallet'
  institution?: string
  accountName?: string
  accountNumber?: string
  position?: number
}): Promise<string> {
  const result = await db.execute(sql`
    insert into owner_payment_methods
      (owner_id, kind, institution, account_name, account_number, position)
    values (
      ${opts.ownerId}::uuid,
      ${opts.kind ?? 'bank'}::payment_method_kind,
      ${opts.institution ?? 'BPI'},
      ${opts.accountName ?? 'Fixture Courts Inc'},
      ${opts.accountNumber ?? '1234567890'},
      ${opts.position ?? 0}
    )
    returning id
  `)
  return result.rows[0].id as string
}
```

(c) **Delete proofs before bookings in `teardownFixtures()`.** `manual_payment_proofs.booking_id` is RESTRICT, exactly like `payments.booking_id`, so the existing bookings delete will raise 23503 once any test writes a proof. Insert this immediately **before** the existing `payments` delete, and mirror that delete's predicate exactly:

```ts
  // Must precede the bookings delete, and the payments delete is the model:
  // manual_payment_proofs.booking_id is NO ACTION (RESTRICT) for the same
  // reason payments.booking_id is -- a proof is a financial record.
  await db.execute(sql`
    delete from manual_payment_proofs
    where booking_id in (
      select id from bookings
      where player_id = any (${sql.param(ids)}::uuid[])
         or created_by = any (${sql.param(ids)}::uuid[])
         or branch_id in (
           select id from branches where owner_id = any (${sql.param(ids)}::uuid[])
         )
    )
  `)
```

- [ ] **Step 4: Write the failing tests**

Append to `tests/schema/manual-payments.test.ts`:

```ts
import { manilaHour, seedBooking, seedPlayer } from '../helpers/fixtures'

test('a pending_verification booking blocks the same slot', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerA = await seedPlayer()
  const playerB = await seedPlayer()
  const startsAt = manilaHour('2027-03-04', 12)

  await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: playerA,
    startsAt,
    status: 'pending_verification',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })

  await expect(
    seedBooking({
      courtId: courtIds[0],
      branchId,
      playerId: playerB,
      startsAt,
      status: 'pending_verification',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }),
  ).rejects.toThrow()
})

test('expire_stale_holds sweeps an overdue pending_verification booking', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2027-03-05', 12),
    status: 'pending_verification',
    expiresAt: new Date(Date.now() - 60 * 1000),
  })

  await db.execute(sql`select expire_stale_holds()`)

  const after = await db.execute(
    sql`select status::text as status from bookings where id = ${bookingId}::uuid`,
  )
  expect(after.rows[0].status).toBe('expired')
})

test('the sweep leaves a live pending_verification booking alone', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2027-03-06', 12),
    status: 'pending_verification',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })

  await db.execute(sql`select expire_stale_holds()`)

  const after = await db.execute(
    sql`select status::text as status from bookings where id = ${bookingId}::uuid`,
  )
  expect(after.rows[0].status).toBe('pending_verification')
})
```

This pairs with the sweep test above it: together they prove the widened
predicate keys on `expires_at`, not merely on the status.

- [ ] **Step 5: Run to verify they fail**

Run: `npx vitest run tests/schema/manual-payments.test.ts`
Expected: the overlap test fails (the constraint does not yet cover the status, so the second insert succeeds) and both sweep tests fail.

- [ ] **Step 6: Apply the migration**

Run: `npx supabase db push --db-url "$DATABASE_URL"`

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. Pay attention to `tests/booking/hold.test.ts` and `tests/payments/*` — the constraint rebuild touches every booking test. If a test times out, re-run that file alone before treating it as a real failure (pool contention on the shared DB produces spurious timeouts).

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260908000300_no_overlap_pending_verification.sql tests/schema/manual-payments.test.ts tests/helpers/fixtures.ts
git commit -m "Manual payment mode: hold the slot during review, sweep on expiry"
```

---

## Phase 2 — Server libraries

### Task 4: Owner payment methods

**Files:**
- Create: `src/lib/owner/payment-methods.ts`
- Create: `tests/owner/payment-methods.test.ts`
- Modify: `src/lib/photos.ts`

**Interfaces:**
- Consumes: `owner_payment_methods` (Task 1); `StorageClient` from `src/lib/listings/storage.ts`.
- Produces:
  ```ts
  export type PaymentMethodKind = 'bank' | 'ewallet'
  export type OwnerPaymentMethod = {
    id: string
    kind: PaymentMethodKind
    institution: string
    accountName: string
    accountNumber: string
    qrStoragePath: string | null
    position: number
  }
  export type PaymentMethodInput = {
    kind: PaymentMethodKind
    institution: string
    accountName: string
    accountNumber: string
  }
  export type PaymentMethodResult =
    | { ok: true; id: string }
    | { ok: false; reason: 'invalid_input' | 'not_found' | 'limit_reached' }
  export const MAX_PAYMENT_METHODS = 8
  export const QR_BUCKET = 'payment-qr'
  export async function listPaymentMethods(ownerId: string): Promise<OwnerPaymentMethod[]>
  export async function addPaymentMethod(ownerId: string, input: PaymentMethodInput): Promise<PaymentMethodResult>
  export async function updatePaymentMethod(ownerId: string, methodId: string, input: PaymentMethodInput): Promise<PaymentMethodResult>
  export async function removePaymentMethod(ownerId: string, methodId: string): Promise<PaymentMethodResult>
  export async function countPaymentMethods(ownerId: string): Promise<number>
  ```

- [ ] **Step 1: Add the buckets to the photo module**

In `src/lib/photos.ts`, extend the `PhotoBucket` union to include `'payment-qr'` and `'payment-proofs'`. Read the file first — the union is used by `photoUrl` and by `StorageClient`. Only `payment-qr` may be passed to `photoUrl`, since `photoUrl` builds a `/object/public/` URL and `payment-proofs` is private. Add a comment saying exactly that above the union.

- [ ] **Step 2: Write the failing test**

Create `tests/owner/payment-methods.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import {
  addPaymentMethod,
  countPaymentMethods,
  listPaymentMethods,
  removePaymentMethod,
  updatePaymentMethod,
} from '@/lib/owner/payment-methods'
import { seedOwner, teardownFixtures } from '../helpers/fixtures'

afterAll(teardownFixtures)

test('a new owner has no payment methods', async () => {
  const ownerId = await seedOwner()
  expect(await listPaymentMethods(ownerId)).toEqual([])
  expect(await countPaymentMethods(ownerId)).toBe(0)
})

test('adding a method returns it in order, with trimmed fields', async () => {
  const ownerId = await seedOwner()
  const bank = await addPaymentMethod(ownerId, {
    kind: 'bank',
    institution: '  BPI  ',
    accountName: 'Smash Courts Inc',
    accountNumber: '  1234567890 ',
  })
  expect(bank.ok).toBe(true)
  const wallet = await addPaymentMethod(ownerId, {
    kind: 'ewallet',
    institution: 'GCash',
    accountName: 'Smash Courts',
    accountNumber: '09171234567',
  })
  expect(wallet.ok).toBe(true)

  const methods = await listPaymentMethods(ownerId)
  expect(methods.map((m) => m.institution)).toEqual(['BPI', 'GCash'])
  expect(methods.map((m) => m.position)).toEqual([0, 1])
  expect(methods[0].accountNumber).toBe('1234567890')
  expect(methods[0].qrStoragePath).toBeNull()
})

test('a blank required field is refused', async () => {
  const ownerId = await seedOwner()
  const result = await addPaymentMethod(ownerId, {
    kind: 'bank',
    institution: '   ',
    accountName: 'Smash Courts Inc',
    accountNumber: '1234567890',
  })
  expect(result).toEqual({ ok: false, reason: 'invalid_input' })
  expect(await countPaymentMethods(ownerId)).toBe(0)
})

test('one owner cannot touch another owner’s method', async () => {
  const mine = await seedOwner()
  const theirs = await seedOwner()
  const added = await addPaymentMethod(theirs, {
    kind: 'bank',
    institution: 'BDO',
    accountName: 'Their Courts',
    accountNumber: '9999999999',
  })
  if (!added.ok) throw new Error('setup failed')

  expect(await removePaymentMethod(mine, added.id)).toEqual({ ok: false, reason: 'not_found' })
  expect(
    await updatePaymentMethod(mine, added.id, {
      kind: 'bank',
      institution: 'Hijacked',
      accountName: 'Hijacked',
      accountNumber: '0000000000',
    }),
  ).toEqual({ ok: false, reason: 'not_found' })

  const stillTheirs = await listPaymentMethods(theirs)
  expect(stillTheirs[0].institution).toBe('BDO')
})

test('removing a method resequences the rest from zero', async () => {
  const ownerId = await seedOwner()
  const ids: string[] = []
  for (const institution of ['BPI', 'BDO', 'GCash']) {
    const added = await addPaymentMethod(ownerId, {
      kind: 'bank',
      institution,
      accountName: 'Smash Courts Inc',
      accountNumber: '1234567890',
    })
    if (!added.ok) throw new Error('setup failed')
    ids.push(added.id)
  }

  expect(await removePaymentMethod(ownerId, ids[0])).toEqual({ ok: true, id: ids[0] })

  const methods = await listPaymentMethods(ownerId)
  expect(methods.map((m) => m.institution)).toEqual(['BDO', 'GCash'])
  expect(methods.map((m) => m.position)).toEqual([0, 1])
})

test('the method count is capped', async () => {
  const ownerId = await seedOwner()
  for (let i = 0; i < 8; i++) {
    const added = await addPaymentMethod(ownerId, {
      kind: 'bank',
      institution: `Bank ${i}`,
      accountName: 'Smash Courts Inc',
      accountNumber: '1234567890',
    })
    expect(added.ok).toBe(true)
  }
  const overflow = await addPaymentMethod(ownerId, {
    kind: 'bank',
    institution: 'One too many',
    accountName: 'Smash Courts Inc',
    accountNumber: '1234567890',
  })
  expect(overflow).toEqual({ ok: false, reason: 'limit_reached' })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/owner/payment-methods.test.ts`
Expected: FAIL — cannot resolve `@/lib/owner/payment-methods`.

- [ ] **Step 4: Implement**

Create `src/lib/owner/payment-methods.ts`:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

export type PaymentMethodKind = 'bank' | 'ewallet'

export type OwnerPaymentMethod = {
  id: string
  kind: PaymentMethodKind
  institution: string
  accountName: string
  accountNumber: string
  qrStoragePath: string | null
  position: number
}

export type PaymentMethodInput = {
  kind: PaymentMethodKind
  institution: string
  accountName: string
  accountNumber: string
}

export type PaymentMethodResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'invalid_input' | 'not_found' | 'limit_reached' }

/**
 * A ceiling, not a product rule: the player has to read this list and pick
 * one, and an unbounded list is a denial-of-service on the checkout page.
 */
export const MAX_PAYMENT_METHODS = 8

export const QR_BUCKET = 'payment-qr' as const

/** Every field is required and non-blank. Returns null when the input is bad. */
function clean(input: PaymentMethodInput): PaymentMethodInput | null {
  const institution = input.institution.trim()
  const accountName = input.accountName.trim()
  const accountNumber = input.accountNumber.trim()
  if (!institution || !accountName || !accountNumber) return null
  if (input.kind !== 'bank' && input.kind !== 'ewallet') return null
  if (institution.length > 80 || accountName.length > 120 || accountNumber.length > 64) return null
  return { kind: input.kind, institution, accountName, accountNumber }
}

export async function listPaymentMethods(ownerId: string): Promise<OwnerPaymentMethod[]> {
  const result = await db.execute(sql`
    select id, kind::text as kind, institution, account_name, account_number,
           qr_storage_path, position
    from owner_payment_methods
    where owner_id = ${ownerId}::uuid
    order by position, id
  `)
  return result.rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as PaymentMethodKind,
    institution: row.institution as string,
    accountName: row.account_name as string,
    accountNumber: row.account_number as string,
    qrStoragePath: (row.qr_storage_path as string | null) ?? null,
    position: Number(row.position),
  }))
}

export async function countPaymentMethods(ownerId: string): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as n from owner_payment_methods where owner_id = ${ownerId}::uuid
  `)
  return Number(result.rows[0].n)
}

/**
 * Appends to the end of the owner's list.
 *
 * The count and the insert share one transaction so two concurrent adds cannot
 * both pass the ceiling check, and so `position` cannot collide.
 */
export async function addPaymentMethod(
  ownerId: string,
  input: PaymentMethodInput,
): Promise<PaymentMethodResult> {
  const fields = clean(input)
  if (!fields) return { ok: false, reason: 'invalid_input' }

  return db.transaction(
    async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'pay-methods:' + ownerId}))`)

      const existing = await tx.execute(sql`
        select coalesce(max(position) + 1, 0)::int as next, count(*)::int as n
        from owner_payment_methods where owner_id = ${ownerId}::uuid
      `)
      if (Number(existing.rows[0].n) >= MAX_PAYMENT_METHODS) {
        return { ok: false as const, reason: 'limit_reached' as const }
      }

      const inserted = await tx.execute(sql`
        insert into owner_payment_methods
          (owner_id, kind, institution, account_name, account_number, position)
        values (
          ${ownerId}::uuid, ${fields.kind}::payment_method_kind,
          ${fields.institution}, ${fields.accountName}, ${fields.accountNumber},
          ${Number(existing.rows[0].next)}
        )
        returning id
      `)
      return { ok: true as const, id: inserted.rows[0].id as string }
    },
    { isolationLevel: 'read committed' },
  )
}

/**
 * Owner-scoped by construction: `owner_id` is in the WHERE clause, never
 * trusted from the form. Zero rows means "not yours, or gone" -- the same
 * answer either way, so one owner can't probe for another's method ids.
 */
export async function updatePaymentMethod(
  ownerId: string,
  methodId: string,
  input: PaymentMethodInput,
): Promise<PaymentMethodResult> {
  const fields = clean(input)
  if (!fields) return { ok: false, reason: 'invalid_input' }

  const result = await db.execute(sql`
    update owner_payment_methods set
      kind = ${fields.kind}::payment_method_kind,
      institution = ${fields.institution},
      account_name = ${fields.accountName},
      account_number = ${fields.accountNumber}
    where id = ${methodId}::uuid and owner_id = ${ownerId}::uuid
    returning id
  `)
  if (result.rows.length === 0) return { ok: false, reason: 'not_found' }
  return { ok: true, id: result.rows[0].id as string }
}

/**
 * Deleting is always allowed, even when a proof points at this method: the
 * proof carries paid_to_snapshot, so the record of what was paid survives.
 * The FK is ON DELETE SET NULL for exactly this reason.
 *
 * Resequences the survivors so `position` stays a dense 0..n-1 run, the same
 * thing movePhoto does in src/lib/listings/photos.ts.
 */
export async function removePaymentMethod(
  ownerId: string,
  methodId: string,
): Promise<PaymentMethodResult> {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'pay-methods:' + ownerId}))`)

      const deleted = await tx.execute(sql`
        delete from owner_payment_methods
        where id = ${methodId}::uuid and owner_id = ${ownerId}::uuid
        returning id
      `)
      if (deleted.rows.length === 0) return { ok: false as const, reason: 'not_found' as const }

      await tx.execute(sql`
        update owner_payment_methods m set position = ordered.rn - 1
        from (
          select id, row_number() over (order by position, id) as rn
          from owner_payment_methods where owner_id = ${ownerId}::uuid
        ) ordered
        where m.id = ordered.id and m.position <> ordered.rn - 1
      `)

      return { ok: true as const, id: deleted.rows[0].id as string }
    },
    { isolationLevel: 'read committed' },
  )
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/owner/payment-methods.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: 0 errors. Pre-existing warnings are fine; no new ones in the files you touched.

- [ ] **Step 7: Commit**

```bash
git add src/lib/owner/payment-methods.ts tests/owner/payment-methods.test.ts src/lib/photos.ts
git commit -m "Manual payment mode: owner payment methods"
```

---

### Task 5: Admin payment-mode control

**Files:**
- Modify: `src/lib/admin/settings.ts`
- Modify: `src/lib/admin/owners.ts`
- Create: `tests/admin/payment-mode.test.ts`

**Interfaces:**
- Consumes: `countPaymentMethods` from Task 4; `profiles.payment_mode` from Task 1.
- Produces:
  ```ts
  export type PaymentModeResult =
    | { ok: true }
    | { ok: false; reason: 'not_found' | 'no_payment_methods' }
  export async function updateOwnerPaymentMode(ownerId: string, mode: 'automated' | 'manual'): Promise<PaymentModeResult>
  export async function getOwnerPaymentMode(ownerId: string): Promise<'automated' | 'manual' | null>
  ```
  and `AdminOwnerRow` gains `paymentMode: 'automated' | 'manual'`.

- [ ] **Step 1: Write the failing test**

Create `tests/admin/payment-mode.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { getOwnerPaymentMode, updateOwnerPaymentMode } from '@/lib/admin/settings'
import { addPaymentMethod } from '@/lib/owner/payment-methods'
import { seedOwner, seedPlayer, teardownFixtures } from '../helpers/fixtures'

afterAll(teardownFixtures)

async function giveMethod(ownerId: string) {
  const added = await addPaymentMethod(ownerId, {
    kind: 'ewallet',
    institution: 'GCash',
    accountName: 'Smash Courts',
    accountNumber: '09171234567',
  })
  if (!added.ok) throw new Error('setup failed')
}

test('an owner starts on the automated rail', async () => {
  const ownerId = await seedOwner()
  expect(await getOwnerPaymentMode(ownerId)).toBe('automated')
})

test('flipping to manual is refused when the owner has no payment method', async () => {
  const ownerId = await seedOwner()
  expect(await updateOwnerPaymentMode(ownerId, 'manual')).toEqual({
    ok: false,
    reason: 'no_payment_methods',
  })
  expect(await getOwnerPaymentMode(ownerId)).toBe('automated')
})

test('flipping to manual succeeds once a payment method exists', async () => {
  const ownerId = await seedOwner()
  await giveMethod(ownerId)
  expect(await updateOwnerPaymentMode(ownerId, 'manual')).toEqual({ ok: true })
  expect(await getOwnerPaymentMode(ownerId)).toBe('manual')
})

test('flipping back to automated is always allowed, even with no methods left', async () => {
  const ownerId = await seedOwner()
  await giveMethod(ownerId)
  await updateOwnerPaymentMode(ownerId, 'manual')
  await db.execute(sql`delete from owner_payment_methods where owner_id = ${ownerId}::uuid`)
  expect(await updateOwnerPaymentMode(ownerId, 'automated')).toEqual({ ok: true })
  expect(await getOwnerPaymentMode(ownerId)).toBe('automated')
})

test('a plain player cannot be put on the manual rail', async () => {
  const playerId = await seedPlayer()
  await db.execute(sql`
    insert into owner_payment_methods
      (owner_id, kind, institution, account_name, account_number, position)
    values (${playerId}::uuid, 'bank', 'BPI', 'Not An Owner', '1234567890', 0)
  `)
  expect(await updateOwnerPaymentMode(playerId, 'manual')).toEqual({
    ok: false,
    reason: 'not_found',
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/admin/payment-mode.test.ts`
Expected: FAIL — `updateOwnerPaymentMode` is not exported.

- [ ] **Step 3: Implement**

Append to `src/lib/admin/settings.ts`:

```ts
export type PaymentModeResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'no_payment_methods' }

export async function getOwnerPaymentMode(
  ownerId: string,
): Promise<'automated' | 'manual' | null> {
  const result = await db.execute(sql`
    select payment_mode::text as mode from profiles where id = ${ownerId}::uuid
  `)
  if (result.rows.length === 0) return null
  return result.rows[0].mode as 'automated' | 'manual'
}

/**
 * Which payment rail an owner is on. Admin-only, like the fee override
 * directly above -- same `role in ('owner','admin')` scoping so a rail can
 * never be parked on a plain player's profile.
 *
 * Flipping TO manual is guarded on the owner having at least one payment
 * method. Without one, the checkout page has nothing to show and the owner's
 * courts become unbookable the instant the switch lands -- the same
 * save-time-guard shape as cheapestApprovedRateCentavos above, which refuses a
 * flat fee that would exceed the owner's cheapest rate.
 *
 * Flipping BACK to automated is unconditional: bookings already in flight
 * carry their own snapshotted rail (bookings.payment_mode), so nothing in
 * progress is disturbed.
 *
 * The count and the update share a transaction so an owner deleting their last
 * method concurrently cannot slip between the two.
 */
export async function updateOwnerPaymentMode(
  ownerId: string,
  mode: 'automated' | 'manual',
): Promise<PaymentModeResult> {
  return db.transaction(
    async (tx) => {
      if (mode === 'manual') {
        const methods = await tx.execute(sql`
          select count(*)::int as n from owner_payment_methods
          where owner_id = ${ownerId}::uuid
        `)
        if (Number(methods.rows[0].n) === 0) {
          return { ok: false as const, reason: 'no_payment_methods' as const }
        }
      }

      // `returning id` + rows.length, never rowCount: an UPDATE without
      // returning reports zero rows regardless of what it touched. Same trap
      // documented at length in updateOwnerFeeOverride.
      const updated = await tx.execute(sql`
        update profiles set payment_mode = ${mode}::payment_mode
        where id = ${ownerId}::uuid and role in ('owner', 'admin')
        returning id
      `)
      if (updated.rows.length === 0) return { ok: false as const, reason: 'not_found' as const }
      return { ok: true as const }
    },
    { isolationLevel: 'read committed' },
  )
}
```

- [ ] **Step 4: Surface the mode on the admin owners row**

In `src/lib/admin/owners.ts`, add `payment_mode::text as payment_mode` to the owners select and `paymentMode: row.payment_mode as 'automated' | 'manual'` to both the `AdminOwnerRow` type and the row mapping. Read the file first and match its existing shape — note how `feeMode` deliberately preserves `null` because `Number(null) === 0`; `paymentMode` is not-null so it needs no such care.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/admin/payment-mode.test.ts && npx vitest run tests/admin`
Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`

- [ ] **Step 7: Commit**

```bash
git add src/lib/admin/settings.ts src/lib/admin/owners.ts tests/admin/payment-mode.test.ts
git commit -m "Manual payment mode: admin rail control"
```

---

### Task 6: Signed URLs for the private bucket

**Files:**
- Modify: `src/lib/listings/storage.ts`
- Modify: `tests/listings/photos.test.ts` (the fake `StorageClient` needs the new method)

**Interfaces:**
- Consumes: the `payment-proofs` bucket (Task 1).
- Produces: `StorageClient` gains
  ```ts
  createSignedUrl(bucket: PhotoBucket, path: string, expiresInSeconds: number):
    Promise<{ url: string | null; error: string | null }>
  ```
  and `export const PROOF_URL_TTL_SECONDS = 300`.

- [ ] **Step 1: Find every fake StorageClient**

Run: `grep -rn "StorageClient" src tests`

Every object literal implementing `StorageClient` must gain the new method or `tsc` will fail. Note each location before editing.

- [ ] **Step 2: Extend the interface and implementation**

In `src/lib/listings/storage.ts`, add to the `StorageClient` type:

```ts
  /**
   * A short-lived read URL for an object in a PRIVATE bucket.
   *
   * `payment-proofs` is the only private bucket in this project: a transfer
   * screenshot shows a bank account number and a name, so it must never be
   * reachable by URL alone the way branch-photos and payment-qr are. Callers
   * mint one of these per render, after their own authorization check -- the
   * URL itself carries no identity, so issuing it IS the authorization
   * decision.
   */
  createSignedUrl(
    bucket: PhotoBucket,
    path: string,
    expiresInSeconds: number,
  ): Promise<{ url: string | null; error: string | null }>
```

and to `serviceRoleStorage()`:

```ts
    async createSignedUrl(bucket, path, expiresInSeconds) {
      const { data, error } = await client()
        .storage.from(bucket)
        .createSignedUrl(path, expiresInSeconds)
      if (error) return { url: null, error: error.message }
      return { url: data?.signedUrl ?? null, error: null }
    },
```

Also export the TTL, with the reasoning inline:

```ts
/**
 * Five minutes. Long enough to render a review page and look at the image,
 * short enough that a URL pasted into a chat is dead before it travels.
 */
export const PROOF_URL_TTL_SECONDS = 300
```

- [ ] **Step 3: Update every fake**

Add to each fake found in Step 1:

```ts
  async createSignedUrl(_bucket: PhotoBucket, path: string) {
    return { url: `https://signed.test/${path}`, error: null }
  },
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx vitest run tests/listings/photos.test.ts`
Expected: 0 type errors, photo tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/listings/storage.ts tests/listings/photos.test.ts
git commit -m "Manual payment mode: signed URLs for the private proofs bucket"
```

---

### Task 7: Branch the hold onto the manual rail

**Files:**
- Modify: `src/lib/booking/hold.ts:190-310`
- Modify: `tests/booking/hold.test.ts`

**Interfaces:**
- Consumes: `bookings.payment_mode`, `profiles.payment_mode`, `profiles.manual_review_minutes`, `platform_settings.default_manual_review_minutes` (Task 1); `pending_verification` (Task 2).
- Produces: `HoldResult`'s success arm gains `paymentMode: 'automated' | 'manual'`:
  ```ts
  { ok: true; bookingId: string; expiresAt: Date; paymentMode: 'automated' | 'manual' }
  ```
  Task 8 and the checkout page both branch on it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/booking/hold.test.ts` (match the file's existing import list and helpers):

```ts
test('a manual-rail hold is born pending_verification with every fee at zero', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  await db.execute(sql`
    insert into owner_payment_methods
      (owner_id, kind, institution, account_name, account_number, position)
    values (${ownerId}::uuid, 'ewallet', 'GCash', 'Smash Courts', '09171234567', 0)
  `)
  await db.execute(
    sql`update profiles set payment_mode = 'manual' where id = ${ownerId}::uuid`,
  )
  const playerId = await seedPlayer()

  const result = await createHold({
    courtId: courtIds[0],
    branchId,
    playerId,
    date: '2027-04-01',
    startHour: 12,
    endHour: 13,
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.paymentMode).toBe('manual')

  const row = await db.execute(sql`
    select status::text as status, payment_mode::text as rail,
           court_fee_centavos, platform_fee_centavos, processor_fee_centavos,
           transaction_fee_centavos, total_charged_centavos, owner_net_centavos,
           fee_config_snapshot
    from bookings where id = ${result.bookingId}::uuid
  `)
  const booking = row.rows[0]
  expect(booking.status).toBe('pending_verification')
  expect(booking.rail).toBe('manual')
  expect(Number(booking.platform_fee_centavos)).toBe(0)
  expect(Number(booking.processor_fee_centavos)).toBe(0)
  expect(Number(booking.transaction_fee_centavos)).toBe(0)
  expect(Number(booking.total_charged_centavos)).toBe(Number(booking.court_fee_centavos))
  expect(Number(booking.owner_net_centavos)).toBe(Number(booking.court_fee_centavos))
  expect((booking.fee_config_snapshot as { mode: string }).mode).toBe('manual')
})

test('an automated-rail hold is unchanged and records its rail', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  const result = await createHold({
    courtId: courtIds[0],
    branchId,
    playerId,
    date: '2027-04-02',
    startHour: 12,
    endHour: 13,
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.paymentMode).toBe('automated')

  const row = await db.execute(sql`
    select status::text as status, payment_mode::text as rail,
           platform_fee_centavos
    from bookings where id = ${result.bookingId}::uuid
  `)
  expect(row.rows[0].status).toBe('pending_payment')
  expect(row.rows[0].rail).toBe('automated')
  expect(Number(row.rows[0].platform_fee_centavos)).toBeGreaterThan(0)
})

test('the review window never outlives the slot, and never lands in the past', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  await db.execute(sql`
    insert into owner_payment_methods
      (owner_id, kind, institution, account_name, account_number, position)
    values (${ownerId}::uuid, 'bank', 'BPI', 'Smash Courts Inc', '1234567890', 0)
  `)
  // The maximum window, 7 days, against a slot that ends tomorrow -- so the
  // cap always binds and the assertion is deterministic at any wall-clock
  // time. Tomorrow 11:00-12:00 is inside seedBranchWithCourts' 11..24 hours
  // every day of the week.
  await db.execute(sql`
    update profiles set payment_mode = 'manual', manual_review_minutes = 10080
    where id = ${ownerId}::uuid
  `)
  const playerId = await seedPlayer()

  const tomorrow = await db.execute(sql`
    select to_char((now() at time zone 'Asia/Manila')::date + 1, 'YYYY-MM-DD') as d
  `)

  const result = await createHold({
    courtId: courtIds[0],
    branchId,
    playerId,
    date: tomorrow.rows[0].d as string,
    startHour: 11,
    endHour: 12,
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return

  const row = await db.execute(sql`
    select (expires_at = ends_at) as capped_to_end,
           (expires_at > now()) as still_live
    from bookings where id = ${result.bookingId}::uuid
  `)
  // The cap binds: 7 days would have run long past this slot.
  expect(row.rows[0].capped_to_end).toBe(true)
  // And the deadline is always in the future -- the invariant that matters.
  expect(row.rows[0].still_live).toBe(true)
})
```

No early `return` guarding a wall-clock window: a test that silently asserts
nothing on most runs is not a test. Both assertions hold at any hour.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/booking/hold.test.ts -t manual`
Expected: FAIL — `result.paymentMode` is undefined, status is `pending_payment`.

- [ ] **Step 3: Widen the stale-hold sweep**

In `src/lib/booking/hold.ts`, in the step-4 sweep at line 221, change the status predicate and extend the comment:

```ts
      // ... existing comment block ...
      //
      //    Both hold statuses are swept: a manual booking's expires_at is the
      //    owner's review deadline, and an overdue one blocks this slot just
      //    as hard as an unpaid automated hold. Mirrors expire_stale_holds().
      await tx.execute(sql`
        update bookings set status = 'expired'
        where court_id = ${courtId}::uuid
          and status in ('pending_payment', 'pending_verification')
          and expires_at <= now()
          and slot && tstzrange(${startsAt}::timestamptz, ${endsAt}::timestamptz, '[)')
      `)
```

Apply the same widening to the step-5 hold ceiling at line 236, so a player's manual holds count toward `MAX_CONCURRENT_HOLDS`:

```ts
      const live = await tx.execute(sql`
        select count(*)::int as n from bookings
        where player_id = ${playerId}::uuid
          and status in ('pending_payment', 'pending_verification')
          and expires_at > now()
      `)
```

- [ ] **Step 4: Resolve the rail alongside the fee config**

Replace the `feeRows` query (line 258) so it also reads the rail and the review window:

```ts
      const feeRows = await tx.execute(sql`
        select
          coalesce(p.platform_fee_mode,     s.default_platform_fee_mode)     as mode,
          coalesce(p.platform_fee_value,    s.default_platform_fee_value)    as value,
          coalesce(p.processor_fee_bearer,  s.default_processor_fee_bearer)  as bearer,
          s.hold_duration_minutes as hold_minutes,
          p.payment_mode::text as rail,
          coalesce(p.manual_review_minutes, s.default_manual_review_minutes) as review_minutes
        from platform_settings s
        join branches b on b.id = ${branchId}::uuid
        join profiles p on p.id = b.owner_id
      `)
      const fee = feeRows.rows[0]
      const rail = fee.rail as 'automated' | 'manual'
```

- [ ] **Step 5: Branch the money**

Replace the fee computation block (lines 269-280):

```ts
      const mode = fee.mode as 'percentage' | 'flat'
      const value = Number(fee.value)
      const holdMinutes = Number(fee.hold_minutes)
      const reviewMinutes = Number(fee.review_minutes)

      // The manual rail is free. OnCourt never touches this money -- the
      // player pays the owner directly -- so there is nothing to take a cut
      // from and nothing to pay a processor. computeFees() is deliberately not
      // called: its three bearer branches all describe money moving through
      // the platform, and none of them describes this.
      //
      // owner_net = the full court fee. That is honest about what the owner
      // received, and Task 10 is what keeps it out of the payout pool -- the
      // platform owes the owner nothing here, because the owner was already
      // paid.
      const isManual = rail === 'manual'
      const platformFee = isManual
        ? 0
        : mode === 'percentage'
          ? Math.round((courtFee * value) / 10_000)
          : value
      const transactionFee = 0
      const processorFee = 0
      const totalCharged = courtFee + transactionFee
      const ownerNet = courtFee - platformFee

      const snapshot = isManual
        ? { mode: 'manual' as const, reviewMinutes }
        : { mode, value, bearer: fee.bearer, holdMinutes }
```

- [ ] **Step 6: Branch the insert**

Replace the insert (line 288) so the status, the rail, the snapshot and the deadline all follow the rail.

**The deadline is `least(now() + review window, ends_at)` — capped at `ends_at`, NOT `starts_at`.** An earlier draft of this plan said `starts_at`, and that was a bug worth understanding before you write the line. Step 3.5 of `createHold` deliberately allows an IN-PROGRESS slot to be booked: it refuses only `ends_at <= now()`, so a slot that has started but not finished is still bookable. For such a slot `starts_at < now()`, and `least(..., starts_at)` yields a deadline already in the past — the booking is born stale, `expires_at <= now()` at the moment of insert, and the very next overlapping `createHold` sweeps it before the owner could possibly review anything. Capping at `ends_at` is always in the future, because step 3.5 guarantees `ends_at > now()`. It is also the better rule on its merits: a slot that has begun is still playable, so an owner confirming ten minutes in is still worth something.

Update the accompanying comment to say this, not "capped at the slot's own start".

```ts
      const inserted = await tx.execute(sql`
        insert into bookings (
          court_id, branch_id, player_id, starts_at, ends_at, status, expires_at,
          payment_mode,
          court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
          platform_fee_centavos, processor_fee_centavos, owner_net_centavos, fee_config_snapshot
        ) values (
          ${courtId}::uuid, ${branchId}::uuid, ${playerId}::uuid,
          ${startsAt}::timestamptz, ${endsAt}::timestamptz,
          ${isManual ? 'pending_verification' : 'pending_payment'}::booking_status,
          ${
            isManual
              ? sql`least(now() + make_interval(mins => ${reviewMinutes}), ${endsAt}::timestamptz)`
              : sql`now() + make_interval(mins => ${holdMinutes})`
          },
          ${rail}::payment_mode,
          ${courtFee}, ${transactionFee}, ${totalCharged},
          ${platformFee}, ${processorFee}, ${ownerNet},
          ${JSON.stringify(snapshot)}::jsonb
        )
        returning id, expires_at
      `)

      const row = inserted.rows[0]
      return {
        ok: true as const,
        bookingId: row.id as string,
        expiresAt: new Date(row.expires_at as string),
        paymentMode: rail,
      }
```

- [ ] **Step 7: Widen the result type**

In the `HoldResult` type at line 23:

```ts
export type HoldResult =
  | {
      ok: true
      bookingId: string
      expiresAt: Date
      /**
       * Which rail this booking was created on. The caller branches on it:
       * 'automated' goes to a PayMongo checkout session, 'manual' goes to the
       * owner's payment details and the proof upload.
       */
      paymentMode: 'automated' | 'manual'
    }
  | { ok: false; reason: /* ... unchanged ... */ }
```

- [ ] **Step 8: Run the booking tests**

Run: `npx vitest run tests/booking/hold.test.ts`
Expected: PASS, including the three new tests and every pre-existing one.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: PASS. `tests/payments/checkout.test.ts` consumes `HoldResult` and may need the new field in a literal; fix any type error it surfaces.

- [ ] **Step 10: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npm run lint
git add src/lib/booking/hold.ts tests/booking/hold.test.ts
git commit -m "Manual payment mode: hold on the manual rail"
```

---

### Task 8: Submit a proof of payment

**Files:**
- Create: `src/lib/payments/manual.ts`
- Create: `src/lib/payments/manual-copy.ts`
- Create: `tests/payments/manual.test.ts`

**Interfaces:**
- Consumes: `createHold` + `paymentMode` (Task 7); `StorageClient` + `PROOF_URL_TTL_SECONDS` (Task 6); `listPaymentMethods` (Task 4).
- Produces:
  ```ts
  export const PROOF_BUCKET = 'payment-proofs'
  export type SubmitProofInput = {
    courtId: string; branchId: string; playerId: string
    date: string; startHour: number; endHour: number
    paymentMethodId: string
    file: { bytes: Uint8Array; contentType: string }
    referenceNote?: string
  }
  export type SubmitProofResult =
    | { ok: true; bookingId: string; proofId: string; expiresAt: Date }
    | { ok: false; reason: HoldFailureReason | 'not_manual' | 'unknown_method'
        | 'no_file' | 'bad_type' | 'too_large' | 'upload_failed' }
  export async function submitManualProof(input: SubmitProofInput, storage: StorageClient): Promise<SubmitProofResult>
  ```

- [ ] **Step 1: Write the copy module**

Create `src/lib/payments/manual-copy.ts` — pure strings, no imports, safe for client components (see the client value-import trap: a client component may only *type*-import from anything that touches `@/db`):

```ts
/**
 * User-facing copy for the manual payment rail. Pure data, zero imports, so a
 * client component can import these VALUES without dragging a server-only
 * module (and `@/db` behind it) into the browser bundle.
 */

export const MANUAL_SUBMIT_MESSAGES: Record<string, string> = {
  not_manual: 'This court takes payment online. Refresh and try again.',
  unknown_method: 'Choose one of the payment options shown.',
  no_file: 'Attach a screenshot of your transfer.',
  bad_type: 'Upload a JPEG, PNG or WebP image.',
  too_large: 'That image is over 5 MB. Upload a smaller one.',
  upload_failed: 'We could not save your screenshot. Try again.',
  slot_taken: 'Someone just booked this slot. Pick another time.',
  slot_elapsed: 'That time has already passed.',
  court_closed: 'The court is not open then.',
  court_unavailable: 'This court is not accepting bookings right now.',
  invalid_branch: 'Something is wrong with that court. Try again from the venue page.',
  invalid_input: 'Check the date and time and try again.',
  too_many_holds: 'You already have three bookings waiting. Finish one first.',
}

export const MANUAL_REVIEW_MESSAGES = {
  awaiting: 'Waiting for the court owner to confirm your payment.',
  approved: 'The owner confirmed your payment. Your booking is set.',
  rejected: 'The owner could not confirm your payment.',
  expired: 'The owner did not review your payment in time, so the slot was released.',
} as const

export function reviewDeadlineLabel(expiresAt: Date): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(expiresAt)
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/payments/manual.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { StorageClient } from '@/lib/listings/storage'
import { submitManualProof } from '@/lib/payments/manual'
import { addPaymentMethod } from '@/lib/owner/payment-methods'
import { seedBranchWithCourts, seedPlayer, teardownFixtures } from '../helpers/fixtures'

afterAll(teardownFixtures)

/** Records calls instead of really uploading -- storage has no rollback. */
function recorder() {
  const uploads: { bucket: string; path: string }[] = []
  const removed: string[] = []
  const client: StorageClient = {
    async upload(bucket, path) {
      uploads.push({ bucket, path })
      return { error: null }
    },
    async remove(_bucket, paths) {
      removed.push(...paths)
      return { error: null }
    },
    async createSignedUrl(_bucket, path) {
      return { url: `https://signed.test/${path}`, error: null }
    },
  }
  return { client, uploads, removed }
}

const PNG = { bytes: new Uint8Array([137, 80, 78, 71]), contentType: 'image/png' }

async function manualOwnerCourt() {
  const seeded = await seedBranchWithCourts(1)
  const added = await addPaymentMethod(seeded.ownerId, {
    kind: 'ewallet',
    institution: 'GCash',
    accountName: 'Smash Courts',
    accountNumber: '09171234567',
  })
  if (!added.ok) throw new Error('setup failed')
  await db.execute(
    sql`update profiles set payment_mode = 'manual' where id = ${seeded.ownerId}::uuid`,
  )
  return { ...seeded, methodId: added.id }
}

test('a submitted proof creates a pending_verification booking and a pending proof', async () => {
  const { branchId, courtIds, methodId } = await manualOwnerCourt()
  const playerId = await seedPlayer()
  const storage = recorder()

  const result = await submitManualProof(
    {
      courtId: courtIds[0],
      branchId,
      playerId,
      date: '2027-05-01',
      startHour: 12,
      endHour: 13,
      paymentMethodId: methodId,
      file: PNG,
      referenceNote: 'REF 12345',
    },
    storage.client,
  )

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(storage.uploads).toHaveLength(1)
  expect(storage.uploads[0].bucket).toBe('payment-proofs')

  const row = await db.execute(sql`
    select p.status::text as status, p.reference_note, p.paid_to_snapshot,
           b.status::text as booking_status
    from manual_payment_proofs p
    join bookings b on b.id = p.booking_id
    where p.booking_id = ${result.bookingId}::uuid
  `)
  expect(row.rows[0].status).toBe('pending')
  expect(row.rows[0].booking_status).toBe('pending_verification')
  expect(row.rows[0].reference_note).toBe('REF 12345')
  expect((row.rows[0].paid_to_snapshot as { institution: string }).institution).toBe('GCash')
})

test('an automated-rail court refuses a proof submission', async () => {
  const { branchId, courtIds, ownerId } = await manualOwnerCourt()
  await db.execute(
    sql`update profiles set payment_mode = 'automated' where id = ${ownerId}::uuid`,
  )
  const playerId = await seedPlayer()
  const storage = recorder()

  const result = await submitManualProof(
    {
      courtId: courtIds[0],
      branchId,
      playerId,
      date: '2027-05-02',
      startHour: 12,
      endHour: 13,
      paymentMethodId: 'ignored',
      file: PNG,
    },
    storage.client,
  )
  expect(result).toEqual({ ok: false, reason: 'not_manual' })
  expect(storage.uploads).toHaveLength(0)
})

test('a payment method belonging to a different owner is refused', async () => {
  const { branchId, courtIds } = await manualOwnerCourt()
  const other = await manualOwnerCourt()
  const playerId = await seedPlayer()
  const storage = recorder()

  const result = await submitManualProof(
    {
      courtId: courtIds[0],
      branchId,
      playerId,
      date: '2027-05-03',
      startHour: 12,
      endHour: 13,
      paymentMethodId: other.methodId,
      file: PNG,
    },
    storage.client,
  )
  expect(result).toEqual({ ok: false, reason: 'unknown_method' })
  expect(storage.uploads).toHaveLength(0)
})

test('an oversized or wrongly-typed file never reaches storage', async () => {
  const { branchId, courtIds, methodId } = await manualOwnerCourt()
  const playerId = await seedPlayer()
  const storage = recorder()
  const base = {
    courtId: courtIds[0],
    branchId,
    playerId,
    date: '2027-05-04',
    startHour: 12,
    endHour: 13,
    paymentMethodId: methodId,
  }

  expect(
    await submitManualProof(
      { ...base, file: { bytes: new Uint8Array(0), contentType: 'image/png' } },
      storage.client,
    ),
  ).toEqual({ ok: false, reason: 'no_file' })

  expect(
    await submitManualProof(
      { ...base, file: { bytes: new Uint8Array([1, 2]), contentType: 'application/pdf' } },
      storage.client,
    ),
  ).toEqual({ ok: false, reason: 'bad_type' })

  expect(
    await submitManualProof(
      {
        ...base,
        file: { bytes: new Uint8Array(5 * 1024 * 1024 + 1), contentType: 'image/png' },
      },
      storage.client,
    ),
  ).toEqual({ ok: false, reason: 'too_large' })

  expect(storage.uploads).toHaveLength(0)
})

test('losing the slot race removes the uploaded object', async () => {
  const { branchId, courtIds, methodId } = await manualOwnerCourt()
  const playerA = await seedPlayer()
  const playerB = await seedPlayer()
  const storage = recorder()
  const base = {
    courtId: courtIds[0],
    branchId,
    date: '2027-05-05',
    startHour: 12,
    endHour: 13,
    paymentMethodId: methodId,
    file: PNG,
  }

  const first = await submitManualProof({ ...base, playerId: playerA }, storage.client)
  expect(first.ok).toBe(true)

  const second = await submitManualProof({ ...base, playerId: playerB }, storage.client)
  expect(second).toEqual({ ok: false, reason: 'slot_taken' })
  expect(storage.removed).toHaveLength(1)
})

test('the owner is emailed that a proof is waiting', async () => {
  const { branchId, courtIds, methodId } = await manualOwnerCourt()
  const playerId = await seedPlayer()
  const storage = recorder()

  const result = await submitManualProof(
    {
      courtId: courtIds[0],
      branchId,
      playerId,
      date: '2027-05-06',
      startHour: 12,
      endHour: 13,
      paymentMethodId: methodId,
      file: PNG,
    },
    storage.client,
  )
  expect(result.ok).toBe(true)
  if (!result.ok) return

  const mail = await db.execute(sql`
    select count(*)::int as n from email_outbox
    where booking_id = ${result.bookingId}::uuid and kind = 'manual_proof_submitted'
  `)
  expect(Number(mail.rows[0].n)).toBe(1)
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/payments/manual.test.ts`
Expected: FAIL — cannot resolve `@/lib/payments/manual`.

- [ ] **Step 4: Implement**

Create `src/lib/payments/manual.ts`. Read `src/lib/listings/photos.ts:44` (`addPhoto`) first and mirror its validate → upload → insert → compensate order, and read `src/lib/email/*` for `enqueueEmail`'s real signature before writing the email call.

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { createHold } from '@/lib/booking/hold'
import type { StorageClient } from '@/lib/listings/storage'
import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES, PHOTO_EXTENSIONS } from '@/lib/photos'

export const PROOF_BUCKET = 'payment-proofs' as const

export type SubmitProofInput = {
  courtId: string
  branchId: string
  playerId: string
  date: string
  startHour: number
  endHour: number
  paymentMethodId: string
  file: { bytes: Uint8Array; contentType: string }
  referenceNote?: string
}

export type SubmitProofResult =
  | { ok: true; bookingId: string; proofId: string; expiresAt: Date }
  | {
      ok: false
      reason:
        | 'not_manual'
        | 'unknown_method'
        | 'no_file'
        | 'bad_type'
        | 'too_large'
        | 'upload_failed'
        | 'slot_taken'
        | 'too_many_holds'
        | 'court_closed'
        | 'invalid_branch'
        | 'court_unavailable'
        | 'invalid_input'
        | 'slot_elapsed'
    }

/**
 * The manual rail's entry point: the player has already paid the owner
 * directly and is handing us the receipt.
 *
 * Order is validate -> upload -> hold+insert -> compensate on failure, the
 * same shape addPhoto uses, and for the same reason: storage has no rollback,
 * so the object must exist before the row that points at it, and a failed row
 * has to take the object back down. The alternative -- insert first -- leaves
 * a proof row pointing at nothing, which is worse: a reviewer sees a booking
 * claiming a screenshot that will never load.
 *
 * The slot race is arbitrated by bookings_no_overlap inside createHold, not by
 * anything here. Uploading before knowing we won costs one wasted object on a
 * lost race, which the remove() below cleans up.
 */
export async function submitManualProof(
  input: SubmitProofInput,
  storage: StorageClient,
): Promise<SubmitProofResult> {
  // 1. Cheap checks first -- never touch storage for input we already know is
  //    bad. Same gates as addPhoto, same constants.
  if (input.file.bytes.byteLength === 0) return { ok: false, reason: 'no_file' }
  if (!ALLOWED_PHOTO_TYPES.includes(input.file.contentType)) {
    return { ok: false, reason: 'bad_type' }
  }
  if (input.file.bytes.byteLength > MAX_PHOTO_BYTES) return { ok: false, reason: 'too_large' }

  // 2. The court's owner must actually be on the manual rail, and the chosen
  //    method must be theirs. Both are read from the court, never from the
  //    caller: a player posting another owner's method id must not be able to
  //    make a booking that says it was paid somewhere it wasn't.
  const context = await db.execute(sql`
    select p.payment_mode::text as rail, p.id as owner_id,
           m.id as method_id, m.kind::text as kind, m.institution,
           m.account_name, m.account_number
    from branches b
    join profiles p on p.id = b.owner_id
    left join owner_payment_methods m
      on m.id = ${input.paymentMethodId}::uuid and m.owner_id = p.id
    where b.id = ${input.branchId}::uuid
  `)
  const row = context.rows[0]
  if (!row || row.rail !== 'manual') return { ok: false, reason: 'not_manual' }
  if (!row.method_id) return { ok: false, reason: 'unknown_method' }

  const paidTo = {
    kind: row.kind as string,
    institution: row.institution as string,
    accountName: row.account_name as string,
    accountNumber: row.account_number as string,
  }

  // 3. Upload. UUID filename, never the uploaded one.
  const extension = PHOTO_EXTENSIONS[input.file.contentType]
  const path = `${input.playerId}/${crypto.randomUUID()}.${extension}`
  const uploaded = await storage.upload(
    PROOF_BUCKET,
    path,
    input.file.bytes,
    input.file.contentType,
  )
  if (uploaded.error) return { ok: false, reason: 'upload_failed' }

  // 4. The hold. createHold owns the advisory lock, the hours check, the
  //    sweep, the ceiling, the pricing and the exclusion constraint -- this
  //    rail gets all of it for free rather than reimplementing any of it.
  const hold = await createHold({
    courtId: input.courtId,
    branchId: input.branchId,
    playerId: input.playerId,
    date: input.date,
    startHour: input.startHour,
    endHour: input.endHour,
  })

  if (!hold.ok) {
    await storage.remove(PROOF_BUCKET, [path])
    return { ok: false, reason: hold.reason }
  }
  // createHold read the rail itself; if it disagrees with step 2 the owner
  // flipped mid-request. Treat the hold as authoritative and back out.
  if (hold.paymentMode !== 'manual') {
    await storage.remove(PROOF_BUCKET, [path])
    return { ok: false, reason: 'not_manual' }
  }

  const note = input.referenceNote?.trim()

  try {
    const proof = await db.transaction(
      async (tx) => {
        const inserted = await tx.execute(sql`
          insert into manual_payment_proofs (
            booking_id, owner_payment_method_id, paid_to_snapshot,
            storage_path, reference_note
          ) values (
            ${hold.bookingId}::uuid, ${input.paymentMethodId}::uuid,
            ${JSON.stringify(paidTo)}::jsonb, ${path}, ${note && note.length > 0 ? note : null}
          )
          returning id
        `)

        // The owner has no other signal that anything is waiting. Enqueued
        // inside the transaction via enqueueEmail, sent by the drain worker,
        // exactly like the webhook's booking_new.
        //
        // enqueueEmail, never a raw insert: email_outbox.payload is
        // `jsonb not null` and typed by the discriminated union in
        // src/lib/email/payload.ts. A raw insert omitting payload violates the
        // NOT NULL; a raw insert hand-building it bypasses the type check that
        // guarantees every kind has a template.
        const owner = await tx.execute(sql`
          select pr.email, pr.business_name, pr.full_name
          from branches b join profiles pr on pr.id = b.owner_id
          where b.id = ${input.branchId}::uuid
        `)
        await enqueueEmail(tx, {
          payload: {
            kind: 'manual_proof_submitted',
            ownerName: (owner.rows[0].business_name ??
              owner.rows[0].full_name ?? null) as string | null,
            booking: bookingFacts,
          },
          recipient: owner.rows[0].email as string,
          bookingId: hold.bookingId,
        })

        return inserted.rows[0].id as string
      },
      { isolationLevel: 'read committed' },
    )

    return { ok: true, bookingId: hold.bookingId, proofId: proof, expiresAt: hold.expiresAt }
  } catch (error) {
    await storage.remove(PROOF_BUCKET, [path])
    throw error
  }
}
```

`bookingFacts` is a `BookingEmailFacts` (`src/lib/email/payload.ts`) built from
the values this function already has — `playerName`, `branchName`, `courtName`,
`bookedOn` (Manila `YYYY-MM-DD`), `startHour`, `endHour`,
`totalChargedCentavos`, `bookingId`. Read that type and build it exactly; select
the branch and court names in the same statement as the owner's email.

- [ ] **Step 4b: Add the email kind's payload and template**

`enqueueEmail` takes an `EmailPayload`, a discriminated union, so
`kind: 'manual_proof_submitted'` does not typecheck until the union has it.
Three edits, all in `src/lib/email/`:

(a) `payload.ts` — add to the `EmailPayload` union:

```ts
  | { kind: 'manual_proof_submitted'; ownerName: string | null; booking: BookingEmailFacts }
```

(b) `templates/manual-proof-submitted.tsx` — a new template beside
`booking-new.tsx`. Read that file and match its structure and its use of
`layout.tsx`. Content: a player has paid by transfer and uploaded proof; the
owner needs to confirm or reject it; the court, date, time and amount; a link
to `/dashboard/payments`. English only, ₱ for money.

(c) `render.ts` — add the `case 'manual_proof_submitted'` arm to `select()`,
returning a subject and the `React.createElement(...)` for the new template,
in the same shape as the arms around it. The `default:` branch's
`const exhaustive: never = payload` is what forces this — without the arm the
file does not compile, which is the guarantee that file exists to provide.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/payments/manual.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npm run lint
git add src/lib/payments/manual.ts src/lib/payments/manual-copy.ts tests/payments/manual.test.ts
git commit -m "Manual payment mode: submit a proof of payment"
```

---

### Task 9: Approve, reject, or cancel a manual booking

**Files:**
- Modify: `src/lib/payments/manual.ts`
- Modify: `src/lib/payments/webhook.ts` (doc comment only)
- Modify: `tests/payments/manual.test.ts`

**Interfaces:**
- Consumes: Task 8's tables and rows.
- Produces:
  ```ts
  export type ReviewResult = { ok: true } | { ok: false; reason: 'not_found' | 'already_reviewed' | 'slot_elapsed' | 'needs_reason' }
  export async function approveManualProof(bookingId: string, reviewerId: string): Promise<ReviewResult>
  export async function rejectManualProof(bookingId: string, reviewerId: string, reason: string): Promise<ReviewResult>
  export type CancelResult = { ok: true } | { ok: false; reason: 'not_found' | 'not_cancellable' | 'not_manual' | 'needs_reason' }
  export async function cancelManualBooking(bookingId: string, actorId: string, note: string): Promise<CancelResult>
  export type PendingProof = {
    bookingId: string; proofId: string; storagePath: string
    playerName: string | null; playerEmail: string
    branchName: string; courtName: string
    startsAt: Date; expiresAt: Date
    amountCentavos: number; referenceNote: string | null
    paidTo: { kind: string; institution: string; accountName: string; accountNumber: string }
  }
  export async function listPendingProofs(branchIds: string[]): Promise<PendingProof[]>
  ```

- [ ] **Step 1: Write the failing tests**

Append to `tests/payments/manual.test.ts`:

```ts
import { approveManualProof, listPendingProofs, rejectManualProof } from '@/lib/payments/manual'

async function submitOne(date: string) {
  const seeded = await manualOwnerCourt()
  const playerId = await seedPlayer()
  const storage = recorder()
  const result = await submitManualProof(
    {
      courtId: seeded.courtIds[0],
      branchId: seeded.branchId,
      playerId,
      date,
      startHour: 12,
      endHour: 13,
      paymentMethodId: seeded.methodId,
      file: PNG,
    },
    storage.client,
  )
  if (!result.ok) throw new Error('setup failed: ' + result.reason)
  return { ...seeded, playerId, ...result }
}

test('approving confirms the booking and clears the deadline', async () => {
  const s = await submitOne('2027-06-01')
  expect(await approveManualProof(s.bookingId, s.ownerId)).toEqual({ ok: true })

  const row = await db.execute(sql`
    select b.status::text as status, b.expires_at, p.status::text as proof_status, p.reviewed_at
    from bookings b join manual_payment_proofs p on p.booking_id = b.id
    where b.id = ${s.bookingId}::uuid
  `)
  expect(row.rows[0].status).toBe('confirmed')
  expect(row.rows[0].expires_at).toBeNull()
  expect(row.rows[0].proof_status).toBe('approved')
  expect(row.rows[0].reviewed_at).not.toBeNull()
})

test('approving twice reports already_reviewed rather than throwing', async () => {
  const s = await submitOne('2027-06-02')
  expect(await approveManualProof(s.bookingId, s.ownerId)).toEqual({ ok: true })
  expect(await approveManualProof(s.bookingId, s.ownerId)).toEqual({
    ok: false,
    reason: 'already_reviewed',
  })
})

test('approving enqueues the confirmation to the player', async () => {
  const s = await submitOne('2027-06-03')
  await approveManualProof(s.bookingId, s.ownerId)
  const mail = await db.execute(sql`
    select count(*)::int as n from email_outbox
    where booking_id = ${s.bookingId}::uuid and kind = 'booking_confirmed'
  `)
  expect(Number(mail.rows[0].n)).toBe(1)
})

test('rejecting expires the booking, frees the slot and keeps the reason', async () => {
  const s = await submitOne('2027-06-04')
  expect(await rejectManualProof(s.bookingId, s.ownerId, 'No transfer received')).toEqual({
    ok: true,
  })

  const row = await db.execute(sql`
    select b.status::text as status, p.status::text as proof_status, p.rejection_reason
    from bookings b join manual_payment_proofs p on p.booking_id = b.id
    where b.id = ${s.bookingId}::uuid
  `)
  expect(row.rows[0].status).toBe('expired')
  expect(row.rows[0].proof_status).toBe('rejected')
  expect(row.rows[0].rejection_reason).toBe('No transfer received')

  // The slot is genuinely free again: the same slot books without 23P01.
  const other = await seedPlayer()
  const storage = recorder()
  const again = await submitManualProof(
    {
      courtId: s.courtIds[0],
      branchId: s.branchId,
      playerId: other,
      date: '2027-06-04',
      startHour: 12,
      endHour: 13,
      paymentMethodId: s.methodId,
      file: PNG,
    },
    storage.client,
  )
  expect(again.ok).toBe(true)
})

test('rejecting with a blank reason is refused', async () => {
  const s = await submitOne('2027-06-05')
  expect(await rejectManualProof(s.bookingId, s.ownerId, '   ')).toEqual({
    ok: false,
    reason: 'needs_reason',
  })
})

test('the queue lists a pending proof for the owner’s branch only', async () => {
  const s = await submitOne('2027-06-06')
  const mine = await listPendingProofs([s.branchId])
  expect(mine.map((p) => p.bookingId)).toContain(s.bookingId)

  const otherBranch = await manualOwnerCourt()
  const theirs = await listPendingProofs([otherBranch.branchId])
  expect(theirs.map((p) => p.bookingId)).not.toContain(s.bookingId)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/payments/manual.test.ts -t "approv"`
Expected: FAIL — `approveManualProof` is not exported.

- [ ] **Step 3: Implement the reviewers**

Append to `src/lib/payments/manual.ts`:

```ts
export type ReviewResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'already_reviewed' | 'slot_elapsed' | 'needs_reason' }

/**
 * The owner says the money arrived.
 *
 * This is the SECOND writer of `confirmed` in this codebase -- see the note
 * now added to handlePaidEvent's doc comment in payments/webhook.ts, which was
 * the only one until this rail existed. It deliberately mirrors that
 * function's discipline:
 *
 *  - one READ COMMITTED transaction
 *  - `for update` on the booking before deciding anything
 *  - slot_elapsed read in SQL, never from a JS clock: a skewed Node clock must
 *    not be able to confirm a slot that has already run
 *  - the UPDATE is status-scoped, so zero rows means "it already moved"
 *    (someone else approved it, or the sweep expired it) rather than an error
 *  - the confirmation email is enqueued INSIDE the transaction; the network
 *    send happens later in the drain worker
 *
 * No money moves here. There is nothing to capture, refund or reconcile -- the
 * player already paid the owner directly, which is the whole point of the rail.
 */
export async function approveManualProof(
  bookingId: string,
  reviewerId: string,
): Promise<ReviewResult> {
  return db.transaction(
    async (tx) => {
      const current = await tx.execute(sql`
        select b.status::text as status, (b.ends_at <= now()) as slot_elapsed,
               p.status::text as proof_status
        from bookings b
        left join manual_payment_proofs p on p.booking_id = b.id
        where b.id = ${bookingId}::uuid
        for update of b
      `)
      const row = current.rows[0]
      if (!row) return { ok: false as const, reason: 'not_found' as const }
      if (row.status !== 'pending_verification') {
        return { ok: false as const, reason: 'already_reviewed' as const }
      }
      if (row.slot_elapsed === true) return { ok: false as const, reason: 'slot_elapsed' as const }

      const updated = await tx.execute(sql`
        update bookings set status = 'confirmed', expires_at = null
        where id = ${bookingId}::uuid and status = 'pending_verification'
        returning id
      `)
      if (updated.rows.length === 0) {
        return { ok: false as const, reason: 'already_reviewed' as const }
      }

      await tx.execute(sql`
        update manual_payment_proofs
        set status = 'approved', reviewed_at = now(), reviewed_by = ${reviewerId}::uuid
        where booking_id = ${bookingId}::uuid and status = 'pending'
      `)

      // enqueueEmail, never a raw insert -- email_outbox.payload is
      // `jsonb not null` and typed by the union in src/lib/email/payload.ts.
      // 'booking_confirmed' already exists there with a BookingEmailFacts
      // payload, so this rail reuses it unchanged: the player is being told
      // exactly what the automated rail tells them.
      await enqueueEmail(tx, {
        payload: { kind: 'booking_confirmed', booking: await bookingFactsFor(tx, bookingId) },
        recipient: playerEmail,
        bookingId,
      })

      return { ok: true as const }
    },
    { isolationLevel: 'read committed' },
  )
}

/**
 * The owner cannot find the money.
 *
 * The booking goes to `expired`, not to a status of its own: `expired` already
 * means "this hold is over, the slot is back on sale", it is already excluded
 * from bookings_no_overlap, and adding a parallel status would mean touching
 * that constraint and every query that lists live bookings. What tells the
 * player *why* is the proof row's rejection_reason, which their booking page
 * reads -- so `expired` never has to carry two meanings for a human.
 */
export async function rejectManualProof(
  bookingId: string,
  reviewerId: string,
  reason: string,
): Promise<ReviewResult> {
  const trimmed = reason.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'needs_reason' }

  return db.transaction(
    async (tx) => {
      const updated = await tx.execute(sql`
        update bookings set status = 'expired', expires_at = null
        where id = ${bookingId}::uuid and status = 'pending_verification'
        returning id
      `)
      if (updated.rows.length === 0) {
        const exists = await tx.execute(
          sql`select 1 from bookings where id = ${bookingId}::uuid`,
        )
        return exists.rows.length === 0
          ? { ok: false as const, reason: 'not_found' as const }
          : { ok: false as const, reason: 'already_reviewed' as const }
      }

      await tx.execute(sql`
        update manual_payment_proofs
        set status = 'rejected', reviewed_at = now(), reviewed_by = ${reviewerId}::uuid,
            rejection_reason = ${trimmed}
        where booking_id = ${bookingId}::uuid and status = 'pending'
      `)

      await enqueueEmail(tx, {
        payload: {
          kind: 'manual_proof_rejected',
          booking: await bookingFactsFor(tx, bookingId),
          rejectionReason: trimmed,
        },
        recipient: playerEmail,
        bookingId,
      })

      return { ok: true as const }
    },
    { isolationLevel: 'read committed' },
  )
}

export type PendingProof = {
  bookingId: string
  proofId: string
  storagePath: string
  playerName: string | null
  playerEmail: string
  branchName: string
  courtName: string
  startsAt: Date
  expiresAt: Date
  amountCentavos: number
  referenceNote: string | null
  paidTo: { kind: string; institution: string; accountName: string; accountNumber: string }
}

/**
 * The owner's review queue, oldest deadline first -- the one about to expire
 * is the one that needs attention.
 *
 * Branch-scoped, never owner-scoped: branch staff with the right grant review
 * too, and loadDashboardAccess/branchIdsWith is what decides which branch ids
 * reach this function. An empty list returns nothing rather than everything.
 */
export async function listPendingProofs(branchIds: string[]): Promise<PendingProof[]> {
  if (branchIds.length === 0) return []
  const result = await db.execute(sql`
    select p.id as proof_id, p.storage_path, p.reference_note, p.paid_to_snapshot,
           b.id as booking_id, b.starts_at, b.expires_at, b.total_charged_centavos,
           br.name as branch_name, c.name as court_name,
           pl.full_name as player_name, pl.email as player_email
    from manual_payment_proofs p
    join bookings b on b.id = p.booking_id
    join branches br on br.id = b.branch_id
    join courts c on c.id = b.court_id
    join profiles pl on pl.id = b.player_id
    where p.status = 'pending'
      and b.status = 'pending_verification'
      and b.branch_id = any (${sql.param(branchIds)}::uuid[])
    order by b.expires_at, b.id
  `)
  return result.rows.map((row) => ({
    bookingId: row.booking_id as string,
    proofId: row.proof_id as string,
    storagePath: row.storage_path as string,
    playerName: (row.player_name as string | null) ?? null,
    playerEmail: row.player_email as string,
    branchName: row.branch_name as string,
    courtName: row.court_name as string,
    startsAt: new Date(row.starts_at as string),
    expiresAt: new Date(row.expires_at as string),
    amountCentavos: Number(row.total_charged_centavos),
    referenceNote: (row.reference_note as string | null) ?? null,
    paidTo: row.paid_to_snapshot as PendingProof['paidTo'],
  }))
}
```

- [ ] **Step 3b: Add the rejection payload and template, and the shared facts helper**

Three of this task's enqueues need a `BookingEmailFacts`. Write one private
helper in `src/lib/payments/manual.ts` rather than three copies of the same
select:

```ts
/**
 * The facts an email snapshots, read inside the caller's transaction.
 * BookingEmailFacts is FACTS, not references (see src/lib/email/payload.ts):
 * a receipt must not change when a court is renamed.
 */
async function bookingFactsFor(tx: SqlExecutor, bookingId: string): Promise<BookingEmailFacts>
```

Read `BookingEmailFacts` in `src/lib/email/payload.ts` and select exactly its
fields — `playerName`, `branchName`, `courtName`, `bookedOn` (Manila
`YYYY-MM-DD` via `to_char(... at time zone 'Asia/Manila', 'YYYY-MM-DD')`),
`startHour`, `endHour` (Manila hours, 24h), `totalChargedCentavos`,
`bookingId`. The same select can return `playerEmail` for the `recipient`
argument; have the helper return both, or select the email alongside.

Then add the one new kind, exactly as Task 8 did for its kind:

(a) `payload.ts` — add to the union:

```ts
  | { kind: 'manual_proof_rejected'; booking: BookingEmailFacts; rejectionReason: string }
```

(b) `templates/manual-proof-rejected.tsx` — beside `refund-recorded.tsx`; read
that file and match its structure. Content: the owner could not confirm the
transfer, the reason verbatim, the slot has been released, and what to do next.
English only, ₱ for money. Do not imply OnCourt took or holds any money — it
never did on this rail.

(c) `render.ts` — the matching `case` arm in `select()`.

`manual_review_expired` is left in the database enum but has **no payload,
template, or enqueue site** in this plan: the only place that state is reached
is `expire_stale_holds()`, a SQL cron function, which cannot honour the typed
payload contract (Task 3 documents that). The player learns from the booking
page instead (Task 14). Leave the unused enum value alone — removing it costs
another migration and it is the obvious value for a future TypeScript-side
expiry notifier to use.

- [ ] **Step 4: Correct the webhook's doc comment**

In `src/lib/payments/webhook.ts`, the doc comment on `handlePaidEvent` (line ~74) claims it is the only writer of `confirmed`. Amend it:

```ts
 * The only writer of `confirmed` ON THE AUTOMATED RAIL. The manual rail has
 * its own, approveManualProof() in src/lib/payments/manual.ts, which mirrors
 * this function's discipline (one transaction, `for update`, slot_elapsed read
 * in SQL, status-scoped UPDATE, email enqueued inside the transaction). The
 * two never touch the same booking: bookings.payment_mode is decided at hold
 * time and never changes.
```

- [ ] **Step 5: Write the failing cancellation tests**

The spec's Cancellation section: OnCourt never held the money and cannot move
it, so a cancelled manual booking is recorded, and the owner settles with the
player on the channel they were paid.

Append to `tests/payments/manual.test.ts`:

```ts
import { cancelManualBooking } from '@/lib/payments/manual'

test('cancelling a confirmed manual booking records it and frees the slot', async () => {
  const s = await submitOne('2027-06-10')
  await approveManualProof(s.bookingId, s.ownerId)

  expect(
    await cancelManualBooking(s.bookingId, s.ownerId, 'Court flooded, refunded via GCash'),
  ).toEqual({ ok: true })

  const row = await db.execute(sql`
    select status::text as status, note from bookings where id = ${s.bookingId}::uuid
  `)
  expect(row.rows[0].status).toBe('refunded_manual')
  expect(row.rows[0].note).toContain('GCash')

  // refunded_manual is excluded from bookings_no_overlap, so the slot is free.
  const other = await seedPlayer()
  const storage = recorder()
  const again = await submitManualProof(
    {
      courtId: s.courtIds[0],
      branchId: s.branchId,
      playerId: other,
      date: '2027-06-10',
      startHour: 12,
      endHour: 13,
      paymentMethodId: s.methodId,
      file: PNG,
    },
    storage.client,
  )
  expect(again.ok).toBe(true)
})

test('cancelling requires a note', async () => {
  const s = await submitOne('2027-06-11')
  await approveManualProof(s.bookingId, s.ownerId)
  expect(await cancelManualBooking(s.bookingId, s.ownerId, '  ')).toEqual({
    ok: false,
    reason: 'needs_reason',
  })
})

test('a booking still awaiting review is rejected, not cancelled', async () => {
  const s = await submitOne('2027-06-12')
  expect(await cancelManualBooking(s.bookingId, s.ownerId, 'changed my mind')).toEqual({
    ok: false,
    reason: 'not_cancellable',
  })
})

test('an automated booking cannot be cancelled through the manual path', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2027-06-13', 12),
    status: 'confirmed',
  })
  expect(await cancelManualBooking(bookingId, ownerId, 'nope')).toEqual({
    ok: false,
    reason: 'not_manual',
  })
})

test('the player is told their manual booking was cancelled', async () => {
  const s = await submitOne('2027-06-14')
  await approveManualProof(s.bookingId, s.ownerId)
  await cancelManualBooking(s.bookingId, s.ownerId, 'Court flooded')
  const mail = await db.execute(sql`
    select count(*)::int as n from email_outbox
    where booking_id = ${s.bookingId}::uuid and kind = 'refund_recorded'
  `)
  expect(Number(mail.rows[0].n)).toBe(1)
})
```

Add `manilaHour` and `seedBooking` to this file's fixture imports if they are
not already there.

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run tests/payments/manual.test.ts -t cancel`
Expected: FAIL — `cancelManualBooking` is not exported.

- [ ] **Step 7: Implement cancellation**

Append to `src/lib/payments/manual.ts`:

```ts
export type CancelResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_cancellable' | 'not_manual' | 'needs_reason' }

/**
 * The owner calls off a confirmed manual booking.
 *
 * Bookkeeping only, and deliberately so: OnCourt never held this money -- the
 * player paid the owner directly -- so there is nothing here to refund. The
 * owner settles with the player on the same channel they were paid, and this
 * records that it happened.
 *
 * Reuses `refunded_manual`, whose name is literally what this is, and which is
 * already excluded from bookings_no_overlap so the slot goes back on sale.
 *
 * Manual-rail only. The automated rail's refunds are payment-scoped and go
 * through recordPaymentRefund() in src/lib/refunds/write.ts, which starts from
 * a `payments` row -- a row a manual booking never has. That is also why the
 * admin refunds queue needs no filter to keep manual bookings out of it.
 *
 * Status-scoped like every other transition in this codebase: zero rows means
 * "it already moved", not an error.
 */
export async function cancelManualBooking(
  bookingId: string,
  actorId: string,
  note: string,
): Promise<CancelResult> {
  const trimmed = note.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'needs_reason' }

  return db.transaction(
    async (tx) => {
      const current = await tx.execute(sql`
        select status::text as status, payment_mode::text as rail
        from bookings where id = ${bookingId}::uuid
        for update
      `)
      const row = current.rows[0]
      if (!row) return { ok: false as const, reason: 'not_found' as const }
      if (row.rail !== 'manual') return { ok: false as const, reason: 'not_manual' as const }
      if (row.status !== 'confirmed' && row.status !== 'completed') {
        return { ok: false as const, reason: 'not_cancellable' as const }
      }

      const updated = await tx.execute(sql`
        update bookings set status = 'refunded_manual', note = ${trimmed}
        where id = ${bookingId}::uuid and status in ('confirmed', 'completed')
        returning id
      `)
      if (updated.rows.length === 0) {
        return { ok: false as const, reason: 'not_cancellable' as const }
      }

      // 'refund_recorded' already exists in the EmailPayload union with
      // exactly the right shape (playerName, branchName, courtName, bookedOn,
      // amountCentavos, bookingCancelled) -- reused rather than adding a
      // fourth kind, because the player is being told the same thing.
      //
      // Note this kind is EXCLUDED from email_outbox_booking_kind_idx
      // (20260812010000), so enqueueEmail's targetless `on conflict do
      // nothing` cannot dedupe it. That is correct here for the same reason it
      // is correct there: idempotency lives one layer up, in this function's
      // own status-scoped UPDATE, which returns zero rows on a replay and
      // never reaches this line.
      await enqueueEmail(tx, {
        payload: {
          kind: 'refund_recorded',
          playerName,
          branchName,
          courtName,
          bookedOn,
          amountCentavos,
          bookingCancelled: true,
        },
        recipient: playerEmail,
        bookingId,
      })

      return { ok: true as const }
    },
    { isolationLevel: 'read committed' },
  )
}
```

**Implementer note:** `bookings.note` is the column
`20260805090100_branch_staff_and_blocks.sql` added for owner blocks. Confirm it
exists and is nullable text before using it here; if it is reserved for blocks
by a CHECK constraint, add a `cancellation_note` column in a new migration
instead of overloading it, and say why in that migration's comment.

`refund_recorded` is reused rather than adding a fourth email kind: the player
is being told the same thing (this booking is off, a refund is owed), and the
existing template already says it. If its copy names PayMongo explicitly,
parameterize the template rather than adding a kind.

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run tests/payments/manual.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 9: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npm run lint
git add src/lib/payments/manual.ts src/lib/payments/webhook.ts tests/payments/manual.test.ts
git commit -m "Manual payment mode: owner review and cancellation"
```

---

### Task 10: Keep manual bookings out of the payout pool

**Files:**
- Modify: `src/lib/payouts/ledger.ts:52` (`payable` CTE) and `:238` (`getPayablePool`)
- Modify: `src/lib/payouts/write.ts:56` (`preparePayout`'s `'payment'` arm)
- Modify: `tests/payouts/ledger.test.ts`

**Interfaces:**
- Consumes: `bookings.payment_mode` (Task 1), set by `createHold` (Task 7).
- Produces: no signature change. Behaviour change only.

- [ ] **Step 1: Write the failing test**

Append to `tests/payouts/ledger.test.ts` (match the file's existing imports and helpers):

```ts
test('a completed manual booking is owed nothing, previewed nowhere, and paid never', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2027-07-01', 12),
    status: 'completed',
  })
  await db.execute(sql`
    update bookings set payment_mode = 'manual', platform_fee_centavos = 0,
      owner_net_centavos = court_fee_centavos
    where id = ${bookingId}::uuid
  `)

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.owedCentavos).toBe(0)
  expect(ledger?.payableBookingCount).toBe(0)

  expect(await getPayablePool(ownerId)).toEqual([])

  expect(await preparePayout(ownerId)).toEqual({ ok: false, reason: 'nothing_to_pay' })
})

test('an automated booking beside a manual one is still paid', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  const manualId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2027-07-02', 12),
    status: 'completed',
  })
  await db.execute(
    sql`update bookings set payment_mode = 'manual' where id = ${manualId}::uuid`,
  )
  await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2027-07-02', 14),
    status: 'completed',
  })

  const pool = await getPayablePool(ownerId)
  expect(pool).toHaveLength(1)
  expect(pool[0].bookingId).not.toBe(manualId)
})

test('a refunded manual booking produces no clawback', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2027-07-03', 12),
    status: 'refunded_manual',
  })
  await db.execute(
    sql`update bookings set payment_mode = 'manual' where id = ${bookingId}::uuid`,
  )

  const ledger = await getOwnerLedger(ownerId)
  expect(ledger?.clawbackBookingCount).toBe(0)
  expect(ledger?.owedCentavos).toBe(0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/payouts/ledger.test.ts -t manual`
Expected: FAIL — `owedCentavos` equals the court fee, `getPayablePool` returns one row, `preparePayout` succeeds.

- [ ] **Step 3: Fix all three queries**

In `src/lib/payouts/ledger.ts`, in the `payable` CTE, add the filter and the reasoning:

```sql
    payable as (
      select b.owner_id, bk.owner_net_centavos as net
      from bookings bk
      join branches b on b.id = bk.branch_id
      where b.owner_id in (select id from owners)
        and bk.status = 'completed'
        -- The manual rail never enters the pool. OnCourt collected nothing on
        -- these bookings -- the player paid the owner directly -- so
        -- owner_net_centavos here is money the owner ALREADY HAS, not money we
        -- owe them. Without this the ledger would invent a debt for every
        -- completed manual booking.
        and bk.payment_mode = 'automated'
        and not exists (
          select 1 from payout_bookings pb
          where pb.booking_id = bk.id and pb.kind = 'payment'
        )
    ),
```

The `clawback` CTE needs no filter — it requires an existing `'payment'` line, and a manual booking can never have one. Add a one-line comment saying exactly that, so the asymmetry does not read as an oversight.

Apply the identical `and bk.payment_mode = 'automated'` to `getPayablePool`'s WHERE clause and to the `'payment'` arm of `preparePayout`'s `union all`, each with a short comment pointing back to the ledger's full explanation.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/payouts`
Expected: PASS, new and pre-existing.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npm run lint
git add src/lib/payouts/ledger.ts src/lib/payouts/write.ts tests/payouts/ledger.test.ts
git commit -m "Manual payment mode: exclude the manual rail from payouts"
```

---

## Phase 3 — Surfaces

> Read `design/branding.md` before starting Phase 3 and follow it: colors, type scale, control tokens, radius, the layout column, the 980/560 breakpoints, and the no-gradients rule. Authed routes cannot be browser-verified — there is no dev login — so verification for these tasks is `npx tsc --noEmit`, `npm run lint`, `npm test`, and a human looking at the page.

### Task 11: Admin rail control on the owners page

**Files:**
- Create: `src/app/admin/owners/payment-mode-form.tsx`
- Modify: `src/app/admin/actions.ts`, `src/app/admin/owners/page.tsx`

**Interfaces:**
- Consumes: `updateOwnerPaymentMode` (Task 5), `AdminOwnerRow.paymentMode` (Task 5).
- Produces: `updateOwnerPaymentModeAction(formData: FormData)`.

- [ ] **Step 1: Add the Server Action**

In `src/app/admin/actions.ts`, beside `updateOwnerFeeOverrideAction`, matching its shape exactly (read it first):

```ts
export async function updateOwnerPaymentModeAction(formData: FormData) {
  await refuseUnlessAdmin()
  const ownerId = idFrom(formData, 'ownerId')
  const raw = formData.get('paymentMode')
  const mode = raw === 'manual' ? 'manual' : 'automated'

  const result = await updateOwnerPaymentMode(ownerId, mode)
  revalidatePath('/admin/owners')
  if (!result.ok) {
    return {
      error:
        result.reason === 'no_payment_methods'
          ? 'This owner has no payment details saved yet. They need at least one bank account or e-wallet before they can take manual payments.'
          : 'That owner could not be updated.',
    }
  }
  return { error: null }
}
```

Match the return shape the other actions in this file use — if they return `void` and rely on a thrown error or a redirect, follow that instead of inventing a result object.

- [ ] **Step 2: Build the form**

Create `src/app/admin/owners/payment-mode-form.tsx`, one instance per owner card, mirroring `owner-fee-form.tsx`'s structure (read it first — a select plus a submit, `useActionState` or a plain form depending on what that file does):

- A two-option select: "Online (PayMongo)" / "Manual transfer".
- A hint line under it: when manual, "No platform fee is charged on manual bookings."
- Submit disabled while the value is unchanged.
- The error from Step 1 rendered inline, not as a toast.

- [ ] **Step 3: Show it**

In `src/app/admin/owners/page.tsx`, render the form beside the existing fee form, and add the effective mode to the owner's summary line the way `effectiveFeeLabel` is rendered.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run lint && npm test`

- [ ] **Step 5: Commit**

```bash
git add src/app/admin/owners/payment-mode-form.tsx src/app/admin/actions.ts src/app/admin/owners/page.tsx
git commit -m "Manual payment mode: admin rail control UI"
```

---

### Task 12: Owner payment settings

**Files:**
- Create: `src/app/dashboard/settings/payment-methods-form.tsx`
- Modify: `src/app/dashboard/settings/page.tsx`, `src/app/dashboard/settings/actions.ts`, `src/lib/owner/settings.ts`

**Interfaces:**
- Consumes: Task 4's CRUD; `QR_BUCKET`.
- Produces: `updateManualReviewMinutesAction`, `addPaymentMethodAction`, `updatePaymentMethodAction`, `removePaymentMethodAction`, `uploadPaymentQrAction`; and in `src/lib/owner/settings.ts`, `updateManualReviewMinutes(ownerId: string, minutes: number | null): Promise<{ ok: boolean }>`.

- [ ] **Step 1: Add the review-window writer**

In `src/lib/owner/settings.ts`, beside `updateBusinessNameAction`'s backing function, add `updateManualReviewMinutes`. Owner-scoped (`where id = … and role = 'owner'`), validating 30..10080 in TypeScript before the write so the CHECK constraint is a backstop rather than the error path. `null` means "use the platform default".

- [ ] **Step 2: Add the actions**

In `src/app/dashboard/settings/actions.ts`, add the five actions, each behind `requireOwner()` and taking the owner id from the guard's return value, **never from the form** — that is the rule the existing actions in this file follow.

The QR upload reuses `addPhoto`'s validate → upload → row order and `serviceRoleStorage()`, writing to `QR_BUCKET` under `<ownerId>/<uuid>.<ext>`, then setting `qr_storage_path`. On a failed row write, remove the object.

- [ ] **Step 3: Build the form**

Create `src/app/dashboard/settings/payment-methods-form.tsx`:

- A list of existing methods: kind badge, institution, masked account number (show the last 4 only), QR thumbnail via `photoUrl(QR_BUCKET, path)`, and Edit / Remove.
- An "Add payment method" form: kind select, institution, account name, account number, optional QR file input.
- The review-window field: a select of 2h / 6h / 12h / 24h / 48h / 7 days plus "Platform default".
- A note when the owner is on the automated rail: "These details are only shown to players when an admin puts you on manual payments."

**Client-component trap:** this file is `'use client'`, so it may only **type**-import from `@/lib/owner/payment-methods` (`import type { OwnerPaymentMethod } …`). A value import pulls `@/db` into the browser bundle; `tsc` and lint both stay clean and the page 500s at runtime. Import the Server Actions from the actions file, and any strings from `manual-copy.ts`.

- [ ] **Step 4: Show it**

Render the form in `src/app/dashboard/settings/page.tsx` as its own panel below the business details, loading the methods with `listPaymentMethods` in the Server Component.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/settings/payment-methods-form.tsx src/app/dashboard/settings/page.tsx src/app/dashboard/settings/actions.ts src/lib/owner/settings.ts
git commit -m "Manual payment mode: owner payment settings"
```

---

### Task 13: Owner verification queue

**Files:**
- Create: `src/app/dashboard/payments/page.tsx`, `src/app/dashboard/payments/review-forms.tsx`, `src/app/dashboard/payments/actions.ts`
- Modify: the dashboard nav component (find it: `grep -rln "dashboard/settings" src/components src/app/dashboard`)

**Interfaces:**
- Consumes: `listPendingProofs`, `approveManualProof`, `rejectManualProof` (Task 9); `createSignedUrl` + `PROOF_URL_TTL_SECONDS` (Task 6).
- Produces: `approveProofAction`, `rejectProofAction`.

- [ ] **Step 1: Build the page**

`src/app/dashboard/payments/page.tsx`, a Server Component:

- Resolve access with `loadDashboardAccess` / `branchIdsWith`, exactly as the other dashboard pages do. Pass those branch ids to `listPendingProofs`.
- For each proof, mint a signed URL server-side: `serviceRoleStorage().createSignedUrl(PROOF_BUCKET, proof.storagePath, PROOF_URL_TTL_SECONDS)`. **Minting the URL is the authorization decision** — the URL carries no identity of its own, so it must only ever be minted after the branch-scope check above has already passed.
- Render oldest-deadline-first, each row showing: player, court, slot, amount in ₱, the account they say they paid, their reference note, the screenshot, and the time left to review.
- Empty state: "Nothing waiting for review."

- [ ] **Step 2: Build the actions**

`src/app/dashboard/payments/actions.ts` — both actions behind `requireBranchAccess` for the booking's branch, resolved from the booking id rather than from the form. Reject takes a required reason.

- [ ] **Step 3: Build the forms**

`review-forms.tsx`, `'use client'` — an Approve button and a Reject button that reveals a required reason field. Type-imports only from any `@/lib` module that touches the DB.

- [ ] **Step 4: Add the nav entry**

Add "Payments" to the dashboard nav with a badge showing the pending count, mirroring how the admin nav badges Approvals and Refunds. Show the entry only when the owner is on the manual rail or has at least one pending proof — an automated owner has no use for it.

- [ ] **Step 5: Add the cancel control**

`cancelManualBooking` (Task 9) needs a surface. Put it on the owner's existing
bookings list rather than in this queue — the queue is for *unreviewed* proofs,
and a cancellation acts on an already-confirmed booking.

Find the owner bookings view (`grep -rln "loadDashboardAccess" src/app/dashboard`)
and add, for rows where `payment_mode = 'manual'` and status is `confirmed` or
`completed`, a "Cancel booking" control that opens a required note field and
calls a `cancelManualBookingAction` behind `requireBranchAccess`.

Label the note field "How you settled with the player" and make the copy say
plainly that OnCourt does not move the money — the owner refunds on the channel
they were paid. That sentence is the whole reason this control differs from the
automated rail's refund flow.

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm run lint && npm test`

- [ ] **Step 7: Commit**

```bash
git add src/app/dashboard src/components
git commit -m "Manual payment mode: owner verification queue and cancellation"
```

---

### Task 14: Player checkout and booking states

**Files:**
- Modify: `src/app/bookings/[id]/checkout/page.tsx`, `src/app/bookings/[id]/checkout/actions.ts`, `src/app/bookings/[id]/page.tsx`, `src/app/venues/[slug]/page.tsx`

**Interfaces:**
- Consumes: `submitManualProof` (Task 8), `listPaymentMethods` (Task 4), `MANUAL_SUBMIT_MESSAGES` / `MANUAL_REVIEW_MESSAGES` (Task 8).
- Produces: `submitManualProofAction(formData: FormData)`.

- [ ] **Step 1: Badge the venue page**

In `src/app/venues/[slug]/page.tsx`, when the branch's owner is on the manual rail, show a badge near the booking controls: "Pay by bank transfer or e-wallet". A player must learn this **before** committing to a slot, not at checkout. Add the badge to `design/branding.md` in Task 15.

- [ ] **Step 2: Branch the checkout page**

In `src/app/bookings/[id]/checkout/page.tsx`, branch on the booking's `payment_mode`. Manual renders, instead of the PayMongo redirect button:

- the amount to send, in ₱, prominent
- the owner's payment methods as selectable cards (institution, account name, account number, QR image where present)
- a reference-number field (optional) and a required screenshot file input
- a "Where to send it" note and the review deadline the owner has committed to
- the submit button, labelled "I've paid — submit for review"

- [ ] **Step 3: Add the action**

`submitManualProofAction` behind `requirePlayer()`, reading the file with `formData.get('proof') as File` → `new Uint8Array(await file.arrayBuffer())`, calling `submitManualProof` with `serviceRoleStorage()`, and mapping a failure through `MANUAL_SUBMIT_MESSAGES`.

- [ ] **Step 4: Show the waiting and rejected states**

In `src/app/bookings/[id]/page.tsx`, add three states, driven by the booking status plus the proof row:

- `pending_verification` → `MANUAL_REVIEW_MESSAGES.awaiting` plus the deadline via `reviewDeadlineLabel`
- `expired` with a `rejected` proof → `MANUAL_REVIEW_MESSAGES.rejected` plus the owner's reason
- `expired` with a still-`pending` proof → `MANUAL_REVIEW_MESSAGES.expired`

The player may see their own screenshot here: mint a signed URL the same way Task 13 does, after confirming the booking is theirs.

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run lint && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/app/bookings src/app/venues
git commit -m "Manual payment mode: player checkout and booking states"
```

---

### Task 15: Branding documentation

**Files:**
- Modify: `design/branding.md`

- [ ] **Step 1: Document the new patterns**

Add to the Components section, following the file's existing voice — state the rule, then why:

- **Manual-pay badge** — where it appears (venue page, court card, checkout), its exact classes, and the rule that a payment rail is disclosed before the player commits, never at checkout.
- **Payment-method card** — the selectable card in checkout and the read-only row in owner settings: layout, how an account number is masked (last 4 only), QR thumbnail size, and the selected state.
- **Proof-review row** — the owner queue row: screenshot thumbnail size, where the deadline sits, and the approve/reject control pairing.
- **Private-image rule** — a new entry: images from `payment-proofs` are rendered from a short-lived signed URL minted server-side after an access check, never from `photoUrl()`. Say plainly that `photoUrl()` builds a `/object/public/` path and is wrong for that bucket.

- [ ] **Step 2: Verify and commit**

Run: `npm run lint`

```bash
git add design/branding.md
git commit -m "Manual payment mode: branding patterns"
```

---

## Final verification

- [ ] `npx tsc --noEmit` — 0 errors
- [ ] `npm run lint` — 0 errors, no new warnings
- [ ] `npm test` — full suite passes. On a timeout, re-run that file alone before treating it as a failure; the shared hosted DB produces pool-contention flakes.
- [ ] `npm test` a second time — the DB is shared and persistent, so every test must pass on a repeat run against the rows the first run left behind.
- [ ] `npm run build` — the App Router build catches client/server boundary violations that `tsc` does not, which is the failure mode Tasks 12–14 are most exposed to.
- [ ] A human loads `/admin/owners`, `/dashboard/settings`, `/dashboard/payments` and a manual-rail checkout in a signed-in browser. No agent can do this — there is no dev login.
