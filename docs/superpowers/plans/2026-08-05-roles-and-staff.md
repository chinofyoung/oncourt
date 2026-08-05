# Exclusive Roles, Vetted Owners, and Branch Staff — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make player and owner accounts mutually exclusive, make owner accounts admin-vetted, let owners delegate per-branch access to staff, and give owners/staff a way to take their own courts off the market with unpaid `blocked` bookings.

**Architecture:** Three new database facts (`booking_status` gains `blocked`; `bookings` gains nullable `player_id`/`fee_config_snapshot` plus `created_by`/`note`; a new `branch_staff` grant table) plus two new guards (`requirePlayer`, `requireBranchAccess`). A new server-only access layer (`src/lib/staff/access.ts`) resolves one session into "which branches, with which permissions", and every `/dashboard/*` query is re-scoped from a single `ownerId` to that resolved `branchIds` list — which is what admits staff to the dashboard without a second set of queries. Writes follow the slice-before-this pattern exactly: testable logic in `import 'server-only'` modules (`src/lib/blocks/write.ts`, `src/lib/staff/write.ts`), and `'use server'` files exporting nothing but thin guarded actions.

**Tech Stack:** Next.js 16 App Router (TypeScript), Tailwind v4 with brand tokens in `src/app/globals.css`, Drizzle `sql` template over Postgres (never the query builder), Supabase Auth (Google), Vitest against the hosted Supabase project.

**Spec:** `docs/superpowers/specs/2026-08-05-roles-and-staff-design.md`

**Previous slice:** `docs/superpowers/plans/2026-08-02-dashboards-and-account-menu.md` — this plan generalizes its guards and reuses its owner dashboard. Nothing it built is discarded.

## Global Constraints

- **Data access is server-only.** Every read/write goes through a Server Component, Server Action, or Route Handler guarded by `requireUser` / `requirePlayer` / `requireOwner` / `requireOwnerOf` / `requireBranchAccess` / `requireAdmin`. The browser never queries Postgres. TypeScript is the security boundary.
- **Never use the Drizzle query builder.** Only `db.execute(sql\`...\`)`. Do not import `src/db/schema.ts` — it is excluded from `tsconfig.json` and importing it resurfaces a `TS2304`.
- **Money is integer centavos, percentages integer basis points.** Never floats, never `numeric`. Coerce every numeric column out of the driver with `Number()` — the `pg` driver returns `numeric`/`bigint` as strings. Cast money sums to `::bigint` in SQL.
- **Identifiers are lowercase `snake_case`** in SQL; TypeScript is `camelCase`. **Index every foreign key explicitly** — `branch_staff.user_id` and `bookings.created_by` both get their own index in this slice (`branch_staff.branch_id` is covered by the unique constraint's index).
- **RLS is enabled on every new table with zero policies.** `alter table branch_staff enable row level security;` and no policies. Never `force row level security`.
- **All user-facing copy is English only.** No Taglish (see the Language entry in `design/branding.md`).
- **Read `design/branding.md` before any UI work.** Solid colors only — no gradients, no glows. Cards: white, `border-radius: 20px`, `--shadow-sm`. Buttons: `--btn-h` 48px / `--btn-h-sm` 38px, `--btn-radius` 12px, display font weight 700. Mono (`font-mono`) for times, prices, and uppercase kickers. **Never two lime (`--ball`) buttons in one view** — where a view needs a primary and lime is already spent (or the control repeats per branch), use branding.md's alternative primary (`--ink` bg, `--ball` text). Content column 1120px max. Breakpoints 980px and 560px.
- **Branded focus ring on EVERY interactive element.** Declare, in every file that renders one, exactly:
  ```ts
  const FOCUS_RING =
    'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'
  ```
  and append it to the `className` of every `<Link>`, `<button>`, `<select>`, `<input>`, and `<textarea>`. Reviews rejected its omission four times in the previous slice. On dark/photo backgrounds the ring color is `--ball` instead of `--court`.
- **Manila time.** All day boundaries via `src/lib/date-manila.ts` (`manilaToday`, `shiftDay`, `isValidCalendarDate`, `manilaWeekday`). "Today" means today in Manila (UTC+8, no DST), never the server's zone. End-hour extraction treats exact local midnight as `24` (the `MANILA_END_HOUR` / `MANILA_PARTS` fragments in `src/lib/owner/queries.ts` and `src/lib/bookings/queries.ts`) — keep that treatment for blocks. All day filters key off `starts_at`.
- **Migrations.** `npx supabase db push --db-url "$DATABASE_URL"` applies them; **each file runs in its own transaction**. A value added by `alter type ... add value if not exists` **cannot be used in the same transaction**, so the `'blocked'` enum addition is its own migration file and everything referencing `'blocked'` is in a second file. `supabase db reset` is unavailable — **idempotency is proven by applying each migration twice**. `ALTER TABLE ... ADD CONSTRAINT` has no `IF NOT EXISTS` form, so every added constraint sits in a guarded `DO` block whose `pg_constraint` lookup is **`conrelid`-qualified** (`pg_constraint` is a global catalog; an unqualified `conname` match is satisfied by a same-named constraint on any other table and would silently skip the `ALTER`). After any migration, regenerate types with `npx drizzle-kit pull` — and do not import the generated `src/db/schema.ts`.
- **Tests run against the hosted Supabase project** via `DATABASE_URL` in `.env.local` — the Supavisor session pooler on port **5432**, never 6543 (transaction mode drops session state and the hold logic depends on `pg_advisory_xact_lock`). The database is **shared and persistent**: tests must pass on repeated runs, must create their own rows under their own ids, must clean up through `teardownFixtures()`'s id tracking, and must **never mutate seeded singleton rows** (`smash-zone-marikina` and the nine demo branches). **Run every DB-touching test file twice.**
- **Booking status semantics.**
  - `confirmed` + `completed` = real bookings; money surfaces (earnings, gross/net, spend) count only these. The fragment is named `REAL_BOOKING`.
  - `pending_payment` = an unpaid hold. Never rendered as a booking on any dashboard.
  - `expired`, `refunded_manual` = excluded from all earnings math.
  - **`blocked` (new) = an owner/staff block or walk-in.** It **occupies the slot** (the `bookings_no_overlap` exclusion constraint's predicate includes it, and every availability query that enumerates statuses must include it). It carries **zero in every money column** and a **null `fee_config_snapshot`** and a **null `player_id`**, with a non-null `created_by`. It is **excluded from earnings** and from `complete_past_bookings()`. It **never appears on a player surface** (`/bookings`, receipts, reviews). It **does** appear on owner/staff schedule surfaces — the owner day grid and the `/dashboard/bookings` list — because it takes a slot and the people running the venue must see it. The fragment for those surfaces is named `SCHEDULE_ROW` (`confirmed`, `completed`, `blocked`).
- **`'use server'` rule.** Every export of a `'use server'` file must be an async function AND becomes a client-invokable endpoint. Therefore: testable logic lives in server-only modules (`import 'server-only'`) and the `'use server'` file exports **only** thin guarded actions. `tests/auth/action-coverage.test.ts` globs every `'use server'` file and requires one of its `GUARDS` substrings — that list is extended in Task 4, before any new action lands.
- **Commit after every task**, with the exact `git add` paths given in that task's final step. Do not squash tasks into one commit.

---

### Task 1: Migration A — add `blocked` to `booking_status`

**Files:**
- Create: `supabase/migrations/20260805090000_booking_status_blocked.sql`

**Interfaces:**
- Produces: the enum label `'blocked'` on the existing `booking_status` type. Nothing in TypeScript changes in this task.

**Why its own file:** `npx supabase db push` wraps **each migration file** in one transaction, and Postgres forbids *using* an enum value in the same transaction that added it. Every statement that references `'blocked'` — the new CHECK constraints, the `bookings_no_overlap` rebuild — therefore lives in Task 2's separate file. Putting them together produces `ERROR: unsafe use of new value "blocked" of enum type booking_status (SQLSTATE 55P04)`.

- [ ] **Step 1: Load the database URL into the shell**

`DATABASE_URL` lives in the git-ignored `.env.local` and every command below needs it exported.

```bash
set -a; . ./.env.local; set +a; echo "${DATABASE_URL:0:30}…"
```

Expected: a printed prefix beginning `postgresql://postgres.` — confirming the pooler username form. If it prints nothing, `.env.local` is missing and nothing further in this plan can run.

- [ ] **Step 2: Create the migration file**

`supabase/migrations/20260805090000_booking_status_blocked.sql`:

```sql
-- A block (maintenance, walk-in, owner's own game) is a bookings row with
-- status 'blocked', NOT a separate table. Rationale, from the design spec:
-- bookings_no_overlap is the double-booking guarantee and it only sees
-- `bookings` rows. A separate blocks table would need hand-rolled cross-table
-- overlap enforcement, recreating exactly the bug class the exclusion
-- constraint kills.
--
-- ALONE IN THIS FILE ON PURPOSE. `supabase db push` runs each migration file
-- inside one transaction, and Postgres refuses to *use* an enum value added in
-- the same transaction (55P04, "unsafe use of new value"). Everything that
-- references 'blocked' — the CHECK constraints on bookings, the
-- bookings_no_overlap rebuild — is in 20260805090100_branch_staff_and_blocks.sql.
-- Do NOT merge these two files.
--
-- `if not exists` makes this idempotent across repeated applies, which is how
-- idempotency is proven here: `supabase db reset` is unavailable on a hosted
-- project, so each migration is applied twice instead.
alter type booking_status add value if not exists 'blocked';
```

- [ ] **Step 3: Apply the migration**

```bash
npx supabase db push --db-url "$DATABASE_URL"
```

Expected: the CLI lists `20260805090000_booking_status_blocked.sql` as applied and finishes without error.

- [ ] **Step 4: Apply it a second time to prove idempotency**

```bash
npx supabase db push --db-url "$DATABASE_URL"
```

Expected: `Remote database is up to date.` (nothing to apply). If the CLI instead re-runs the file, it must still exit 0 — `add value if not exists` is a no-op the second time.

- [ ] **Step 5: Verify the label actually exists on the type**

```bash
npx tsx -e "import{Pool}from'pg';import{loadEnvFile}from'node:process';loadEnvFile('.env.local');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query(\"select enumlabel from pg_enum where enumtypid='booking_status'::regtype order by enumsortorder\").then(r=>{console.log(r.rows.map(x=>x.enumlabel));return p.end()})"
```

Expected exactly:

```
[
  'pending_payment',
  'confirmed',
  'completed',
  'expired',
  'refunded_manual',
  'blocked'
]
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260805090000_booking_status_blocked.sql
git commit -m "Add blocked to the booking_status enum"
```

---

### Task 2: Migration B — `branch_staff`, block columns, and the no-overlap rebuild

**Files:**
- Create: `supabase/migrations/20260805090100_branch_staff_and_blocks.sql`
- Create: `tests/schema/branch-staff.test.ts`
- Create: `tests/schema/blocks.test.ts`
- Modify: `tests/schema/cron.test.ts` (append one regression test)
- Modify: `src/db/schema.ts` (regenerated by `drizzle-kit pull`, never hand-edited, never imported)

**Interfaces:**
- Produces (schema only — no TypeScript API):
  - table `branch_staff (id, branch_id, user_id, view_bookings, block_slots, manage_courts, view_earnings, created_at)` with `branch_staff_unique (branch_id, user_id)`, `branch_staff_some_permission`, index `branch_staff_user_id_idx`, RLS enabled with zero policies.
  - `bookings.player_id` nullable; `bookings.fee_config_snapshot` nullable.
  - `bookings.created_by uuid references profiles (id)`, `bookings.note text`, index `bookings_created_by_idx`.
  - CHECK constraints `bookings_player_unless_blocked`, `bookings_snapshot_unless_blocked`, `bookings_blocked_has_creator`, `bookings_blocked_is_free`.
  - `bookings_no_overlap` rebuilt with `'blocked'` in its predicate.

- [ ] **Step 1: Write the failing `branch_staff` schema tests**

Create `tests/schema/branch-staff.test.ts`:

```ts
import { expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBranchWithCourts, seedPlayer } from '../helpers/fixtures'

/**
 * Raw inserts, not a fixture helper: this file is about the constraints
 * themselves, so it must be able to write rows a helper would refuse to
 * build (all-false permissions, a duplicate pair). The staff *fixture*
 * helper lands in Task 3 and is used by the guard/action tests instead.
 *
 * branch_staff has no ON DELETE RESTRICT anywhere — branch_id and user_id both
 * CASCADE — so teardownFixtures()'s auth.users delete reclaims every row these
 * tests create, with no extra cleanup here.
 */
async function grant(opts: {
  branchId: string
  userId: string
  viewBookings?: boolean
  blockSlots?: boolean
  manageCourts?: boolean
  viewEarnings?: boolean
}) {
  return db.execute(sql`
    insert into branch_staff (
      branch_id, user_id, view_bookings, block_slots, manage_courts, view_earnings
    ) values (
      ${opts.branchId}::uuid, ${opts.userId}::uuid,
      ${opts.viewBookings ?? false}, ${opts.blockSlots ?? false},
      ${opts.manageCourts ?? false}, ${opts.viewEarnings ?? false}
    )
    returning id
  `)
}

test('a grant with at least one permission is accepted', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const userId = await seedPlayer()

  const result = await grant({ branchId, userId, viewBookings: true })
  expect(result.rows).toHaveLength(1)
})

test('a grant with every permission false is rejected', async () => {
  // branch_staff_some_permission. A row granting nothing is not a weaker
  // grant, it is a lie: requireBranchAccess would find a row and still deny
  // every permission, so the staff page would list a person who cannot do
  // anything. Revoking is a DELETE, not an all-false UPDATE.
  const { branchId } = await seedBranchWithCourts(1)
  const userId = await seedPlayer()

  await expect(grant({ branchId, userId })).rejects.toMatchObject({
    cause: { code: '23514', constraint: 'branch_staff_some_permission' },
  })
})

test('the same user cannot be granted twice on one branch', async () => {
  // branch_staff_unique (branch_id, user_id). One row per (branch, person):
  // permissions are edited in place, not stacked.
  const { branchId } = await seedBranchWithCourts(1)
  const userId = await seedPlayer()

  await grant({ branchId, userId, blockSlots: true })
  await expect(grant({ branchId, userId, viewEarnings: true })).rejects.toMatchObject({
    cause: { code: '23505' },
  })
})

test('the same user can be granted on two branches with different permissions', async () => {
  // Explicitly allowed by the spec: "Same person may be staffed at several
  // branches with different permissions (one row each)."
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  const userId = await seedPlayer()

  await grant({ branchId: first.branchId, userId, viewBookings: true })
  await grant({ branchId: second.branchId, userId, viewEarnings: true })

  const rows = await db.execute(sql`
    select view_bookings, view_earnings from branch_staff
    where user_id = ${userId}::uuid order by view_bookings
  `)
  expect(rows.rows).toHaveLength(2)
})

test('deleting the branch removes its grants', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const userId = await seedPlayer()
  await grant({ branchId, userId, viewBookings: true })

  await db.execute(sql`delete from branches where id = ${branchId}::uuid`)

  const rows = await db.execute(
    sql`select 1 from branch_staff where branch_id = ${branchId}::uuid`,
  )
  expect(rows.rows).toHaveLength(0)
})

test('deleting the staff user removes their grants', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const userId = await seedPlayer()
  await grant({ branchId, userId, viewBookings: true })

  await db.execute(sql`delete from auth.users where id = ${userId}::uuid`)

  const rows = await db.execute(sql`select 1 from branch_staff where user_id = ${userId}::uuid`)
  expect(rows.rows).toHaveLength(0)
})

test('user_id carries its own index, per the index-every-FK rule', async () => {
  // branch_id needs no separate index: branch_staff_unique's implicit index
  // is a btree on (branch_id, user_id), leading with branch_id.
  const result = await db.execute(sql`
    select indexname from pg_indexes
    where schemaname = 'public' and tablename = 'branch_staff'
    order by indexname
  `)
  expect(result.rows.map((r) => r.indexname)).toContain('branch_staff_user_id_idx')
})

test('branch_staff has RLS enabled and zero policies', async () => {
  const result = await db.execute(sql`
    select
      (select relrowsecurity from pg_class
        where relnamespace = 'public'::regnamespace and relname = 'branch_staff') as rls,
      (select count(*)::int from pg_policies
        where schemaname = 'public' and tablename = 'branch_staff') as policies
  `)
  expect(result.rows[0]).toEqual({ rls: true, policies: 0 })
})
```

- [ ] **Step 2: Write the failing block-constraint tests**

Create `tests/schema/blocks.test.ts`:

```ts
import { expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { manilaHour, seedBranchWithCourts, seedPlayer } from '../helpers/fixtures'

/**
 * Raw inserts again, for the same reason as tests/schema/branch-staff.test.ts:
 * these tests must be able to attempt rows no fixture helper would build (a
 * paid booking with a null player_id, a block with no creator, a block with
 * money on it). Task 3's seedBlock() helper is for the query/action tests.
 *
 * Every insert here goes under a fixture-seeded branch/owner, so
 * teardownFixtures() reclaims them — including via its `created_by` clause,
 * added in Task 3, which matters because bookings.created_by is RESTRICT.
 */
const DATE = '2026-11-04'

async function insertPaid(opts: {
  courtId: string
  branchId: string
  playerId: string | null
  startHour: number
  endHour: number
  createdBy?: string | null
  snapshot?: string | null
}) {
  return db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status, created_by,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
      fee_config_snapshot
    ) values (
      ${opts.courtId}::uuid, ${opts.branchId}::uuid, ${opts.playerId}::uuid,
      ${manilaHour(DATE, opts.startHour).toISOString()}::timestamptz,
      ${manilaHour(DATE, opts.endHour).toISOString()}::timestamptz,
      'confirmed', ${opts.createdBy ?? null}::uuid,
      26500, 0, 26500, 2650, 0, 23850,
      ${opts.snapshot === undefined ? '{}' : opts.snapshot}::jsonb
    )
    returning id
  `)
}

async function insertBlock(opts: {
  courtId: string
  branchId: string
  startHour: number
  endHour: number
  createdBy: string | null
  note?: string | null
  money?: number
}) {
  const money = opts.money ?? 0
  return db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status, created_by, note,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
      fee_config_snapshot
    ) values (
      ${opts.courtId}::uuid, ${opts.branchId}::uuid, null,
      ${manilaHour(DATE, opts.startHour).toISOString()}::timestamptz,
      ${manilaHour(DATE, opts.endHour).toISOString()}::timestamptz,
      'blocked', ${opts.createdBy}::uuid, ${opts.note ?? null},
      ${money}, 0, ${money}, ${money}, 0, ${money},
      null::jsonb
    )
    returning id
  `)
}

test('a block with no player, a creator, zero money, and a null snapshot is accepted', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)

  const result = await insertBlock({
    courtId: courtIds[0],
    branchId,
    startHour: 9,
    endHour: 11,
    createdBy: ownerId,
    note: 'Resurfacing',
  })
  expect(result.rows).toHaveLength(1)
})

test('a non-blocked booking with a null player_id is rejected', async () => {
  // bookings_player_unless_blocked. player_id only became nullable to make
  // blocks representable; a paid booking with nobody attached is corruption.
  const { branchId, courtIds } = await seedBranchWithCourts(1)

  await expect(
    insertPaid({ courtId: courtIds[0], branchId, playerId: null, startHour: 12, endHour: 13 }),
  ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'bookings_player_unless_blocked' } })
})

test('a non-blocked booking with a null fee_config_snapshot is rejected', async () => {
  // bookings_snapshot_unless_blocked. Same reasoning: the snapshot is what
  // makes a charge auditable after the fee config changes. Blocks carry no
  // charge, and an empty-object snapshot on one would be a lie, hence null.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await expect(
    insertPaid({
      courtId: courtIds[0],
      branchId,
      playerId,
      startHour: 13,
      endHour: 14,
      snapshot: null,
    }),
  ).rejects.toMatchObject({
    cause: { code: '23514', constraint: 'bookings_snapshot_unless_blocked' },
  })
})

test('a block with a null created_by is rejected', async () => {
  // bookings_blocked_has_creator, forward direction. created_by is the audit
  // trail: a paid booking's creator is its player_id, a block's is whichever
  // owner or staff member took the slot off the market.
  const { branchId, courtIds } = await seedBranchWithCourts(1)

  await expect(
    insertBlock({ courtId: courtIds[0], branchId, startHour: 14, endHour: 15, createdBy: null }),
  ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'bookings_blocked_has_creator' } })
})

test('a non-blocked booking with a created_by set is rejected', async () => {
  // bookings_blocked_has_creator, reverse direction — the constraint is an
  // equivalence, not a one-way requirement. A paid booking's creator is
  // player_id; a second, disagreeing creator column would be two sources of
  // truth for the same fact.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await expect(
    insertPaid({
      courtId: courtIds[0],
      branchId,
      playerId,
      startHour: 15,
      endHour: 16,
      createdBy: ownerId,
    }),
  ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'bookings_blocked_has_creator' } })
})

test('a block carrying nonzero money is rejected', async () => {
  // bookings_blocked_is_free. "Excluded from earnings" is enforced by the
  // status filters in the query layer; this constraint is what makes that
  // enforcement unnecessary to trust — a blocked row cannot hold revenue to
  // leak in the first place, however a future query is written.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)

  await expect(
    insertBlock({
      courtId: courtIds[0],
      branchId,
      startHour: 16,
      endHour: 17,
      createdBy: ownerId,
      money: 30000,
    }),
  ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'bookings_blocked_is_free' } })
})

test('a block excludes an overlapping paid hold on the same court', async () => {
  // The whole reason a block is a bookings row: bookings_no_overlap now lists
  // 'blocked' in its predicate, so the exclusion constraint arbitrates
  // block-vs-booking with no extra code.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await insertBlock({
    courtId: courtIds[0],
    branchId,
    startHour: 18,
    endHour: 20,
    createdBy: ownerId,
  })

  await expect(
    insertPaid({ courtId: courtIds[0], branchId, playerId, startHour: 19, endHour: 21 }),
  ).rejects.toMatchObject({ cause: { code: '23P01', constraint: 'bookings_no_overlap' } })
})

test('a paid booking excludes an overlapping block on the same court', async () => {
  // The other direction, asserted separately: an exclusion constraint is
  // symmetric by definition, but the predicate is not — a bug that dropped
  // 'blocked' from the status list would still pass the test above if the
  // block were inserted second.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await insertPaid({ courtId: courtIds[0], branchId, playerId, startHour: 20, endHour: 22 })

  await expect(
    insertBlock({
      courtId: courtIds[0],
      branchId,
      startHour: 21,
      endHour: 23,
      createdBy: ownerId,
    }),
  ).rejects.toMatchObject({ cause: { code: '23P01', constraint: 'bookings_no_overlap' } })
})

test('a block adjacent to a booking is allowed — half-open bounds still hold', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await insertPaid({ courtId: courtIds[0], branchId, playerId, startHour: 7, endHour: 8 })
  await insertBlock({
    courtId: courtIds[0],
    branchId,
    startHour: 8,
    endHour: 9,
    createdBy: ownerId,
  })

  const result = await db.execute(
    sql`select count(*)::int as n from bookings where court_id = ${courtIds[0]}::uuid`,
  )
  expect(Number(result.rows[0].n)).toBe(2)
})

test('created_by carries its own index, per the index-every-FK rule', async () => {
  const result = await db.execute(sql`
    select indexname from pg_indexes
    where schemaname = 'public' and tablename = 'bookings'
    order by indexname
  `)
  expect(result.rows.map((r) => r.indexname)).toContain('bookings_created_by_idx')
})

test('bookings_no_overlap lists blocked in its predicate', async () => {
  // Reads the live constraint definition rather than inferring it from
  // behavior: this is the assertion that fails loudly if a later migration
  // rebuilds the constraint and forgets 'blocked'.
  const result = await db.execute(sql`
    select pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = 'public.bookings'::regclass and conname = 'bookings_no_overlap'
  `)
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0].def as string).toContain('blocked')
})
```

- [ ] **Step 3: Run both new test files and confirm they fail**

```bash
npx vitest run tests/schema/branch-staff.test.ts tests/schema/blocks.test.ts
```

Expected: FAIL. `branch-staff.test.ts` fails with `42P01 relation "branch_staff" does not exist`; `blocks.test.ts` fails with `42703 column "created_by" of relation "bookings" does not exist`.

- [ ] **Step 4: Create the migration file**

`supabase/migrations/20260805090100_branch_staff_and_blocks.sql`:

```sql
-- Staff grants, and the schema changes that make a `blocked` booking
-- representable. Depends on 20260805090000_booking_status_blocked.sql having
-- already committed the 'blocked' enum label — every reference below would
-- raise 55P04 if the two files were merged.

-- ---------------------------------------------------------------- branch_staff
-- Staff = player + grant. profiles.role stays 'player'; staff-ness lives here
-- and nowhere else, so a person is never half-owner. There is deliberately NO
-- cross-table constraint requiring the granted user to be role='player': a
-- profile's role can change later, and the promote-to-owner path
-- (src/lib/staff/write.ts) owns that edge by deleting the grants. The
-- "existing player account only" rule is enforced in the server action, per
-- this project's TypeScript-is-the-security-boundary design.
create table if not exists branch_staff (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  view_bookings boolean not null default false,
  block_slots boolean not null default false,
  manage_courts boolean not null default false,
  view_earnings boolean not null default false,
  created_at timestamptz not null default now(),
  constraint branch_staff_unique unique (branch_id, user_id),
  -- A grant that grants nothing is not a weaker grant, it is a lie: the staff
  -- page would list someone who can do nothing and requireBranchAccess would
  -- deny them everything. Revoking is a DELETE, never an all-false UPDATE.
  constraint branch_staff_some_permission check (
    view_bookings or block_slots or manage_courts or view_earnings
  )
);

-- FK index rule. branch_id needs no separate index: branch_staff_unique's
-- implicit btree on (branch_id, user_id) leads with it.
create index if not exists branch_staff_user_id_idx on branch_staff (user_id);

-- Deny-by-default, like every other table: the publishable key ships in the
-- browser and must never reach this table. Do NOT add policies, and do NOT
-- use `force row level security` (it would subject the owner role to those
-- non-existent policies and break the app).
alter table branch_staff enable row level security;

-- -------------------------------------------------------------- block columns
-- Blocks have no player. Both of these ALTERs are naturally idempotent —
-- dropping a NOT NULL that is already dropped is a no-op, not an error.
alter table bookings alter column player_id drop not null;
-- An empty-object snapshot on a block would be a lie (there was no fee config
-- applied, because there was no charge), so the column goes nullable rather
-- than getting a placeholder value.
alter table bookings alter column fee_config_snapshot drop not null;

-- Audit: which owner or staff user took the slot off the market. No `on
-- delete` clause, so it inherits Postgres's NO ACTION — matching every other
-- FK on this table (court_id/branch_id/player_id), and required here for a
-- second reason: `on delete set null` would violate
-- bookings_blocked_has_creator the moment the creator's account was deleted.
-- Deleting an account that created blocks raises 23503, which is the intended
-- behavior; tests/helpers/fixtures.ts's teardown deletes such rows first.
--
-- `add column if not exists` skips the whole clause — FK included — when the
-- column is already present, which is exactly the idempotency wanted here.
alter table bookings add column if not exists created_by uuid references profiles (id);
-- Optional human label: "Resurfacing", "Walk-in — Juan". Null on paid bookings
-- in practice; deliberately NOT constrained to be, because that rule is not in
-- the spec's constraint list and locking it in would need a migration to relax
-- the first time someone wants an internal note on a paid booking.
alter table bookings add column if not exists note text;

-- FK index rule.
create index if not exists bookings_created_by_idx on bookings (created_by);

-- ---------------------------------------------------------- block invariants
-- ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS form, so each of these
-- sits in a guarded DO block. Every lookup is qualified by `conrelid`, not
-- just `conname`: pg_constraint is a GLOBAL catalog and constraint names are
-- unique per table, not per database — an unqualified name match would be
-- satisfied by a same-named constraint on some other table and would silently
-- skip the ALTER, shipping the invariant missing with no error. Same reasoning
-- as the original bookings_no_overlap block in
-- 20260801070328_bookings.sql; read its comment.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_player_unless_blocked'
  ) then
    alter table bookings add constraint bookings_player_unless_blocked
      check (status = 'blocked' or player_id is not null);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_snapshot_unless_blocked'
  ) then
    alter table bookings add constraint bookings_snapshot_unless_blocked
      check (status = 'blocked' or fee_config_snapshot is not null);
  end if;

  -- An equivalence, not a one-way requirement: a block MUST name its creator,
  -- and a paid booking MUST NOT — its creator is player_id, and a second,
  -- independently-settable creator column would be a competing source of truth
  -- for the same fact. Null-safe without `is distinct from` because `status` is
  -- NOT NULL, so both sides are always real booleans.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_blocked_has_creator'
  ) then
    alter table bookings add constraint bookings_blocked_has_creator
      check ((status = 'blocked') = (created_by is not null));
  end if;

  -- Blocks carry no money at all. The query layer already excludes 'blocked'
  -- from every earnings sum; this constraint is what makes that exclusion
  -- safe to stop thinking about — a blocked row cannot hold revenue to leak,
  -- however some future query is written. There is no cash bookkeeping for
  -- walk-ins in this product (see the spec's Out of scope).
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_blocked_is_free'
  ) then
    alter table bookings add constraint bookings_blocked_is_free
      check (
        status <> 'blocked'
        or (
          court_fee_centavos = 0
          and transaction_fee_centavos = 0
          and total_charged_centavos = 0
          and platform_fee_centavos = 0
          and processor_fee_centavos = 0
          and owner_net_centavos = 0
        )
      );
  end if;
end $$;

-- ------------------------------------------------- bookings_no_overlap rebuild
-- Exclusion constraints cannot be ALTERed, so widening the predicate means
-- drop-and-re-add. The guard checks the live definition for 'blocked' rather
-- than merely checking the constraint's existence: an existence check would
-- see the OLD constraint and skip the rebuild entirely, leaving blocks
-- overlappable. Checking the rendered definition makes this both correct on
-- first apply and a no-op (no index rebuild) on every apply after.
--
-- conrelid-qualified for the same reason as the checks above.
--
-- 'expired' and 'refunded_manual' stay out: they do not occupy the slot. An
-- expired-but-unswept hold still has status 'pending_payment', which is why
-- both hold creation (src/lib/booking/hold.ts) and block creation
-- (src/lib/blocks/write.ts) sweep stale rows inside their own transaction.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_no_overlap'
      and pg_get_constraintdef(oid) like '%blocked%'
  ) then
    alter table bookings drop constraint if exists bookings_no_overlap;
    alter table bookings add constraint bookings_no_overlap
      exclude using gist (court_id with =, slot with &&)
      where (status in ('pending_payment', 'confirmed', 'completed', 'blocked'));
  end if;
end $$;
```

- [ ] **Step 5: Apply the migration**

```bash
npx supabase db push --db-url "$DATABASE_URL"
```

Expected: `20260805090100_branch_staff_and_blocks.sql` applied, exit 0. If it fails with `55P04`, the enum migration from Task 1 was not committed separately — check the file split.

- [ ] **Step 6: Apply it a second time to prove idempotency**

```bash
npx supabase db push --db-url "$DATABASE_URL"
```

Expected: `Remote database is up to date.`, or a clean re-run with exit 0. Then verify no constraint was duplicated and the exclusion constraint was not rebuilt into a second copy:

```bash
npx tsx -e "import{Pool}from'pg';import{loadEnvFile}from'node:process';loadEnvFile('.env.local');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query(\"select conname, count(*)::int as n from pg_constraint where conrelid='public.bookings'::regclass group by conname having count(*) > 1\").then(r=>{console.log(r.rows);return p.end()})"
```

Expected: `[]` — no constraint name appears twice.

- [ ] **Step 7: Run both new test files and confirm they pass**

```bash
npx vitest run tests/schema/branch-staff.test.ts tests/schema/blocks.test.ts
```

Expected: PASS — 8 tests in `branch-staff.test.ts`, 11 in `blocks.test.ts`.

- [ ] **Step 8: Run them a second time**

```bash
npx vitest run tests/schema/branch-staff.test.ts tests/schema/blocks.test.ts
```

Expected: PASS again. The database keeps rows between runs, so a test that only passes once is a broken test. Every insert above hangs off a freshly seeded branch, so the fixed `DATE`/hour pairs never collide across runs.

- [ ] **Step 9: Append the `complete_past_bookings()` regression test**

The spec pins this by test rather than by code change: the function already filters `status = 'confirmed'`, so a past-dated block must be left alone. Append to `tests/schema/cron.test.ts`, reusing that file's existing `withRollback` helper (the janitor functions are unscoped and run against the whole shared table — the transaction is what keeps their real effect from being persisted):

```ts
test('the completion sweep leaves a past-dated blocked row untouched', async () => {
  // Pinned by test, not by a code change: complete_past_bookings() already
  // filters `status = 'confirmed'`. Without this test, a future edit widening
  // that filter would silently flip blocks to 'completed', which would put
  // them in REAL_BOOKING and therefore into every earnings sum — as ₱0 rows,
  // inflating booking counts and occupancy.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(2)
  const playerId = await seedPlayer()

  await withRollback(async (client) => {
    await client.query(
      `insert into bookings (court_id, branch_id, player_id, starts_at, ends_at, status,
        created_by, note,
        court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
        platform_fee_centavos, processor_fee_centavos, owner_net_centavos, fee_config_snapshot)
       values
        ($1, $2, null, now() - interval '3 hours', now() - interval '2 hours', 'blocked',
         $3, 'Resurfacing', 0, 0, 0, 0, 0, 0, null),
        ($4, $2, $5, now() - interval '3 hours', now() - interval '2 hours', 'confirmed',
         null, null, 26500, 0, 26500, 2650, 0, 23850, '{}'::jsonb)`,
      [courtIds[0], branchId, ownerId, courtIds[1], playerId],
    )

    await client.query('select complete_past_bookings()')

    const result = await client.query(
      `select status::text as status, count(*)::int as n from bookings
       where branch_id = $1 group by status order by status::text`,
      [branchId],
    )
    // The confirmed row completed; the blocked row did not move.
    expect(result.rows).toEqual([
      { status: 'blocked', n: 1 },
      { status: 'completed', n: 1 },
    ])
  })
}, 15_000)
```

- [ ] **Step 10: Run the cron tests twice**

```bash
npx vitest run tests/schema/cron.test.ts && npx vitest run tests/schema/cron.test.ts
```

Expected: PASS both times (5 tests each run).

- [ ] **Step 11: Regenerate the Drizzle types**

Per `CLAUDE.md`: schema truth is the SQL migration files, and `src/db/schema.ts` is regenerated after every migration. It is excluded from `tsconfig.json` and nothing imports it — do not add an import, and do not hand-edit the output.

```bash
npx drizzle-kit pull
```

Expected: it writes `src/db/schema.ts` (plus `supabase/migrations/meta/*`) and reports the pulled tables including `branch_staff`. Confirm the new bits landed:

```bash
grep -n "branchStaff\|createdBy\|blocked" src/db/schema.ts | head -20
```

Expected: a `branchStaff` table export, a `createdBy` column on `bookings`, and `'blocked'` inside the `bookingStatus` enum. Note the file will still lack `bookings_no_overlap` — `drizzle-kit pull` cannot represent GiST exclusion constraints (see the comment in `drizzle.config.ts`); that is known and is why no `generate` script exists.

- [ ] **Step 12: Confirm the data-API lockdown test still passes**

`tests/security/data-api-lockdown.test.ts` enumerates `public` from `pg_class` dynamically, so `branch_staff` is picked up automatically and must satisfy "every governed table has RLS enabled" and "no governed table is forced RLS".

```bash
npx vitest run tests/security/data-api-lockdown.test.ts
```

Expected: PASS. A failure naming `branch_staff` means the `enable row level security` line was dropped from the migration.

- [ ] **Step 13: Run the full suite**

```bash
npx tsc --noEmit && npm test
```

Expected: no type errors; all tests pass. `tests/schema/bookings.test.ts`'s existing inserts all supply `player_id` and a snapshot, so the new checks do not touch them.

- [ ] **Step 14: Commit**

```bash
git add supabase/migrations/20260805090100_branch_staff_and_blocks.sql src/db/schema.ts supabase/migrations/meta tests/schema/branch-staff.test.ts tests/schema/blocks.test.ts tests/schema/cron.test.ts
git commit -m "Add branch_staff, block columns, and rebuild bookings_no_overlap for blocks"
```

---

### Task 3: Fixtures for blocks and staff; blocks occupy slots everywhere a slot is read

**Files:**
- Modify: `tests/helpers/fixtures.ts` (add `seedOwner`, `seedBlock`, `seedStaffGrant`; extend `teardownFixtures`; make `seedBranchWithCourts` return through `seedOwner`)
- Modify: `src/lib/booking/availability.ts:130-139` (occupancy status list)
- Modify: `src/lib/branches/queries.ts:186-193` and `:540-552` (the two other status lists)
- Modify: `tests/booking/availability.test.ts` (append)
- Modify: `tests/branches/search.test.ts` (append one test; add `ownerId` to `seedBranchAt`'s return)
- Modify: `tests/bookings/queries.test.ts` (append one test)

**Interfaces:**
- Produces, from `tests/helpers/fixtures.ts`:

```ts
export async function seedOwner(): Promise<string>
export async function seedBlock(opts: {
  courtId: string
  branchId: string
  createdBy: string
  startsAt: Date
  hours?: number
  note?: string | null
}): Promise<string>
export async function seedStaffGrant(opts: {
  branchId: string
  userId: string
  viewBookings?: boolean
  blockSlots?: boolean
  manageCourts?: boolean
  viewEarnings?: boolean
}): Promise<string>
```
  `seedPlayer`, `seedBranchWithCourts`, `seedBooking`, `manilaHour`, `teardownFixtures` keep their existing signatures unchanged. `seedBooking`'s `status` union stays `'pending_payment' | 'confirmed' | 'completed'`.

**Why `seedBlock` and not a widened `seedBooking`:** a block is not a booking with a different status — it has a different *column shape*. `player_id` is null, `created_by` is required, `fee_config_snapshot` is null, and every money column must be 0 (the DB now rejects anything else). Threading that through `seedBooking`'s options would make `playerId` optional for all ~20 existing call sites and force each of them to reason about a combination that is invalid for them. Two functions over one table, sharing the table and the teardown, is the coherent shape here.

- [ ] **Step 1: Add the three fixture helpers**

In `tests/helpers/fixtures.ts`, insert `seedOwner` immediately after `seedPlayer` (which ends at line 31):

```ts
/**
 * A player promoted to owner. Extracted because three call sites had this
 * exact two-step inline (tests/owner/queries.test.ts,
 * tests/branches/search.test.ts's seedBranchAt, and seedBranchWithCourts
 * below), and because the roles-and-staff slice adds more.
 *
 * Sets ONLY the role. business_name/slug stay null: the real promotion path
 * (promoteToOwner in src/lib/staff/write.ts) sets those, and a fixture that
 * silently filled them in would hide a query that depends on them.
 */
export async function seedOwner(): Promise<string> {
  const id = await seedPlayer()
  await db.execute(sql`update profiles set role = 'owner' where id = ${id}::uuid`)
  return id
}
```

Then replace the first two lines of `seedBranchWithCourts`'s body (currently `const ownerId = await seedPlayer()` followed by the `update profiles` call) with:

```ts
  const ownerId = await seedOwner()
```

- [ ] **Step 2: Add `seedBlock` and `seedStaffGrant`**

Append to the end of `tests/helpers/fixtures.ts`:

```ts
/**
 * Inserts a `blocked` booking — an owner/staff block or walk-in.
 *
 * Separate from seedBooking() rather than a widened `status` option because
 * the column shape genuinely differs, and the database now enforces every
 * difference: player_id must be null (bookings_player_unless_blocked),
 * created_by must be set (bookings_blocked_has_creator), fee_config_snapshot
 * must be null (bookings_snapshot_unless_blocked), and every money column must
 * be 0 (bookings_blocked_is_free). A single helper covering both would make
 * `playerId` optional for every existing seedBooking() caller.
 *
 * `createdBy` is any profile id — there is no DB constraint tying it to the
 * branch's owner or staff. That rule lives in the server action
 * (requireBranchAccess), which is why these tests can and do pass an owner id
 * directly.
 *
 * No teardown tracking of its own: teardownFixtures() deletes bookings by
 * tracked player_id, by branches under tracked owners, AND by tracked
 * created_by (added in Step 3) — the last of which is required, because
 * bookings.created_by is RESTRICT and a surviving block would otherwise abort
 * the auth.users delete with 23503.
 *
 * Callers must choose non-overlapping hours per court: bookings_no_overlap now
 * includes 'blocked' in its predicate, so a block over a booking (or another
 * block) on one court raises 23P01.
 */
export async function seedBlock(opts: {
  courtId: string
  branchId: string
  createdBy: string
  startsAt: Date
  hours?: number
  note?: string | null
}): Promise<string> {
  const hours = opts.hours ?? 1
  const endsAt = new Date(opts.startsAt.getTime() + hours * 3_600_000)

  const result = await db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status, created_by, note,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
      fee_config_snapshot
    ) values (
      ${opts.courtId}::uuid, ${opts.branchId}::uuid, null,
      ${opts.startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz,
      'blocked'::booking_status, ${opts.createdBy}::uuid, ${opts.note ?? null},
      0, 0, 0, 0, 0, 0, null::jsonb
    )
    returning id
  `)
  return result.rows[0].id as string
}

/**
 * A branch_staff grant. At least one permission must be true — the
 * branch_staff_some_permission CHECK rejects an all-false row — so callers
 * always pass at least one flag. Defaults are all false so a caller states
 * exactly the permissions the test is about, which is what makes the
 * requireBranchAccess matrix tests readable.
 *
 * No teardown tracking: branch_staff.branch_id and .user_id both CASCADE, so
 * deleting the tracked auth.users rows reclaims these for free.
 */
export async function seedStaffGrant(opts: {
  branchId: string
  userId: string
  viewBookings?: boolean
  blockSlots?: boolean
  manageCourts?: boolean
  viewEarnings?: boolean
}): Promise<string> {
  const result = await db.execute(sql`
    insert into branch_staff (
      branch_id, user_id, view_bookings, block_slots, manage_courts, view_earnings
    ) values (
      ${opts.branchId}::uuid, ${opts.userId}::uuid,
      ${opts.viewBookings ?? false}, ${opts.blockSlots ?? false},
      ${opts.manageCourts ?? false}, ${opts.viewEarnings ?? false}
    )
    returning id
  `)
  return result.rows[0].id as string
}
```

- [ ] **Step 3: Extend `teardownFixtures` to cover `created_by`**

This is load-bearing, not defensive: `bookings.created_by` has no `ON DELETE` clause, so it is RESTRICT. A block created by a tracked user survives the bookings delete under the current predicate (it has a null `player_id`, and its branch may not be under a tracked owner), and then the `delete from auth.users` raises `23503` — aborting teardown and leaking every row the run created into the shared database.

In `tests/helpers/fixtures.ts`, replace the bookings delete (currently lines 117-123) with:

```ts
  // `created_by` is in this predicate for a hard reason, not for tidiness:
  // bookings.created_by carries no `on delete` clause, so it is RESTRICT. A
  // `blocked` row created by a tracked user has a NULL player_id and may sit
  // under a branch this run did not create, so neither of the other two
  // clauses reaches it — and the `delete from auth.users` below would then
  // raise 23503, aborting teardown and leaking the whole run's rows into this
  // shared, persistent database.
  await db.execute(sql`
    delete from bookings
    where player_id = any (${sql.param(ids)}::uuid[])
       or created_by = any (${sql.param(ids)}::uuid[])
       or branch_id in (
         select id from branches where owner_id = any (${sql.param(ids)}::uuid[])
       )
  `)
```

Also extend the reviews delete immediately above it so its nested `bookings` subquery matches the same set (a review can only exist on a paid booking, so this is belt-and-braces, but the two predicates drifting apart is exactly how the original 23503 bug happened). Replace the innermost `booking_id in (...)` subquery's `where` with:

```ts
       or booking_id in (
         select id from bookings
         where player_id = any (${sql.param(ids)}::uuid[])
            or created_by = any (${sql.param(ids)}::uuid[])
            or branch_id in (
              select id from branches where owner_id = any (${sql.param(ids)}::uuid[])
            )
       )
```

- [ ] **Step 4: Write the failing availability tests**

Append to `tests/booking/availability.test.ts` — note this file currently imports only `seedBranchWithCourts`, so widen the import to `import { manilaHour, seedBlock, seedBranchWithCourts } from '../helpers/fixtures'`:

```ts
test('loadBranchDay marks a blocked hour as booked, not open', async () => {
  // A block occupies the slot. The exclusion constraint already guarantees
  // nobody can book over it; this is the other half — the grid must not offer
  // a slot the constraint would then refuse, which would read to a player as
  // the app losing their booking at the last moment.
  const { branchId, courtIds, ownerId, slug } = await seedBranchWithCourts(1)
  const date = '2026-12-02'
  await seedBlock({
    courtId: courtIds[0],
    branchId,
    createdBy: ownerId,
    startsAt: manilaHour(date, 14),
    hours: 2,
    note: 'Resurfacing',
  })

  const result = await loadBranchDay(slug, date)
  const cells = result!.grid[0].cells
  expect(cells.find((c) => c.hour === 13)!.state).toBe('open')
  expect(cells.find((c) => c.hour === 14)!.state).toBe('booked')
  expect(cells.find((c) => c.hour === 15)!.state).toBe('booked')
  expect(cells.find((c) => c.hour === 16)!.state).toBe('open')
})
```

Append to `tests/branches/search.test.ts`, inside the existing `describe('searchBranches', …)` block, right after `it('excludes a branch whose only court is already booked at that hour', …)`. First add `ownerId` to `seedBranchAt`'s return — change its final line from `return { branchId, courtId, slug }` to `return { ownerId, branchId, courtId, slug }`, and change its first two lines (`const ownerId = await seedPlayer()` plus the `update profiles` call) to `const ownerId = await seedOwner()`, widening the fixtures import to `import { manilaHour, seedOwner, seedPlayer } from '../helpers/fixtures'`. Then:

```ts
  it('excludes a branch whose only court is blocked at that hour', async () => {
    // The "open now"/"open at hour" filter enumerates statuses explicitly
    // rather than reusing the exclusion constraint's predicate, so 'blocked'
    // has to be added by hand here — otherwise search advertises a branch as
    // available at an hour its owner has taken off the market.
    const origin = remoteOrigin()
    const free = await seedBranchAt({ ...origin })
    const blocked = await seedBranchAt({ ...origin })
    await db.execute(sql`
      insert into bookings (
        court_id, branch_id, player_id, starts_at, ends_at, status, created_by,
        court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
        platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
        fee_config_snapshot
      ) values (
        ${blocked.courtId}::uuid, ${blocked.branchId}::uuid, null,
        '2026-09-01T18:00:00+08:00'::timestamptz, '2026-09-01T19:00:00+08:00'::timestamptz,
        'blocked', ${blocked.ownerId}::uuid, 0, 0, 0, 0, 0, 0, null::jsonb
      )
    `)

    const results = await searchBranches({
      ...origin,
      radiusMeters: 5000,
      date: '2026-09-01',
      hour: 18,
    })
    const slugs = results.map((r) => r.slug)
    expect(slugs).toContain(free.slug)
    expect(slugs).not.toContain(blocked.slug)
  })
```

Append to `tests/bookings/queries.test.ts` — widen its fixtures import to include `seedBlock`:

```ts
test('a block never appears on any player surface', async () => {
  // The player dashboard filters to confirmed/completed, so this passes today;
  // the test is what keeps it passing. A block has no player_id at all, so
  // "whose booking is this" has no answer — surfacing one on /bookings would
  // render a booking belonging to nobody.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  await seedBlock({
    courtId: courtIds[0],
    branchId,
    createdBy: ownerId,
    startsAt: futureAt(6, 14),
    note: 'Walk-in',
  })

  const dashboard = await getPlayerDashboard(player)
  expect(dashboard.upcoming).toEqual([])
  expect(dashboard.past).toEqual([])
  expect(dashboard.stats.upcomingCount).toBe(0)
  expect(dashboard.stats.totalSpentCentavos).toBe(0)
})
```

- [ ] **Step 5: Run the three test files and confirm the two occupancy tests fail**

```bash
npx vitest run tests/booking/availability.test.ts tests/branches/search.test.ts tests/bookings/queries.test.ts
```

Expected: FAIL. `loadBranchDay marks a blocked hour as booked` fails with `expected 'open' to be 'booked'`, and `excludes a branch whose only court is blocked at that hour` fails because the blocked branch is still returned. The player-surface test should already PASS — that is the point of pinning it.

- [ ] **Step 6: Add `blocked` to the availability occupancy list**

In `src/lib/booking/availability.ts`, replace the `bookingRows` query's `and (...)` clause (lines 134-138) with:

```ts
      and (
        -- 'blocked' is here for the same reason it is in bookings_no_overlap's
        -- predicate: a block takes the slot. Leaving it out would render an
        -- open, priced cell that the exclusion constraint then refuses on
        -- submit — the app appearing to lose a booking at the last moment.
        status in ('confirmed', 'completed', 'blocked')
        or (status = 'pending_payment' and expires_at > now())
      )
```

- [ ] **Step 7: Add `blocked` to both status lists in `src/lib/branches/queries.ts`**

Two occurrences, both inside a `not exists (select 1 from bookings bk …)`. Replace each `and (…)` block — the one in the hour-availability filter (around line 190) and the one in the home page's `openNowCount` (around line 546) — with:

```ts
            and (
              -- Matches src/lib/booking/availability.ts and
              -- bookings_no_overlap's predicate: a block takes the slot, so a
              -- branch whose only court is blocked at this hour is not open.
              bk.status in ('confirmed', 'completed', 'blocked')
              or (bk.status = 'pending_payment' and bk.expires_at > now())
            )
```

(Preserve each site's existing indentation; the `openNowCount` one is indented two levels less than the search filter one.)

- [ ] **Step 8: Run the tests and confirm they pass**

```bash
npx vitest run tests/booking/availability.test.ts tests/branches/search.test.ts tests/bookings/queries.test.ts
```

Expected: PASS, including the pre-existing tests in all three files.

- [ ] **Step 9: Run them a second time**

```bash
npx vitest run tests/booking/availability.test.ts tests/branches/search.test.ts tests/bookings/queries.test.ts
```

Expected: PASS again.

- [ ] **Step 10: Typecheck, lint, full suite**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: no type errors; lint reports only the pre-existing `<img>` and unused-`table` warnings; all tests pass.

- [ ] **Step 11: Commit**

```bash
git add tests/helpers/fixtures.ts src/lib/booking/availability.ts src/lib/branches/queries.ts tests/booking/availability.test.ts tests/branches/search.test.ts tests/bookings/queries.test.ts
git commit -m "Add block/staff fixtures and make blocks occupy slots in every availability query"
```

---

### Task 4: `requirePlayer`, `requireBranchAccess`, and the permissions vocabulary

**Files:**
- Create: `src/lib/staff/permissions.ts`
- Modify: `src/lib/auth/guards.ts` (add `requirePlayer` after `requireAdmin`; add `requireBranchAccess` after `requireOwnerOf`)
- Modify: `src/lib/auth/page-guards.ts` (add `requirePlayerPage`)
- Modify: `tests/auth/action-coverage.test.ts` (extend `GUARDS`)
- Modify: `tests/auth/guards.test.ts` (append)

**Interfaces:**
- Produces, from `src/lib/staff/permissions.ts` (a **pure** module — no `server-only`, so the client staff form can import the labels):

```ts
export const STAFF_PERMISSIONS: readonly ['view_bookings', 'block_slots', 'manage_courts', 'view_earnings']
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number]
export type StaffPermissions = Record<StaffPermission, boolean>
export const STAFF_PERMISSION_LABELS: Record<StaffPermission, string>
export function allPermissions(): StaffPermissions
export function noPermissions(): StaffPermissions
export function hasAnyPermission(permissions: StaffPermissions): boolean
export function unionPermissions(list: StaffPermissions[]): StaffPermissions
export function parsePermissions(formData: FormData): StaffPermissions
```
- Produces, from `src/lib/auth/guards.ts`:

```ts
export async function requirePlayer(): Promise<SessionUser>
export async function requireBranchAccess(
  branchId: string,
  permission: StaffPermission,
): Promise<SessionUser>
```
- Produces, from `src/lib/auth/page-guards.ts`:

```ts
export async function requirePlayerPage(next: string): Promise<SessionUser>
```
- Consumes: `requireUser`, `AuthError`, `SessionUser` (`src/lib/auth/guards.ts`); `safeNextPath` (`src/lib/auth/next-path.ts`); `db`, `sql`.

**Redirect-loop note (read before implementing):** `requirePlayerPage` sends `owner` **and** `admin` to `/dashboard`, and `requireDashboardPage` (Task 5) sends a session with no owner role and no grants to `/bookings`. These cannot ping-pong, because `isOwner` in Task 5 is `role === 'owner' || role === 'admin'` — the exact same predicate `requireOwner` already uses. An admin therefore always terminates at `/dashboard`; a plain player always terminates at `/bookings`. Do not "fix" either predicate independently.

- [ ] **Step 1: Create the permissions module**

`src/lib/staff/permissions.ts`:

```ts
/**
 * The staff permission vocabulary, in one place.
 *
 * Deliberately NOT `server-only`: the staff management form is a client
 * component and needs STAFF_PERMISSIONS and STAFF_PERMISSION_LABELS to render
 * its checkboxes. Nothing here touches the database or a session — it is a
 * list of four strings, their human labels, and set arithmetic over them.
 *
 * The four flags mirror branch_staff's four boolean columns exactly, and the
 * names ARE the column names: requireBranchAccess indexes a row object by the
 * permission string, so a rename here without a migration would silently deny
 * every check rather than fail loudly. Custom roles beyond these four are out
 * of scope (see the spec).
 */
export const STAFF_PERMISSIONS = [
  'view_bookings',
  'block_slots',
  'manage_courts',
  'view_earnings',
] as const

export type StaffPermission = (typeof STAFF_PERMISSIONS)[number]
export type StaffPermissions = Record<StaffPermission, boolean>

export const STAFF_PERMISSION_LABELS: Record<StaffPermission, string> = {
  view_bookings: 'View bookings',
  block_slots: 'Block slots',
  manage_courts: 'Manage courts',
  view_earnings: 'View earnings',
}

/**
 * Functions, not shared constants: a shared `ALL_PERMISSIONS` object would be
 * handed out by reference to every branch in loadDashboardAccess(), so one
 * caller mutating it would change every other branch's permissions.
 */
export function allPermissions(): StaffPermissions {
  return { view_bookings: true, block_slots: true, manage_courts: true, view_earnings: true }
}

export function noPermissions(): StaffPermissions {
  return { view_bookings: false, block_slots: false, manage_courts: false, view_earnings: false }
}

/**
 * branch_staff_some_permission's TypeScript mirror. Checked before the INSERT
 * so an empty checkbox set comes back as a form error rather than a 23514.
 */
export function hasAnyPermission(permissions: StaffPermissions): boolean {
  return STAFF_PERMISSIONS.some((permission) => permissions[permission])
}

/**
 * "Can this person do X anywhere they have access?" — drives which sidebar
 * items and page sections render. A section gated on the union can still show
 * a branch picker that is narrower than the union; the per-branch write guard
 * (requireBranchAccess) is the real boundary either way.
 */
export function unionPermissions(list: StaffPermissions[]): StaffPermissions {
  const result = noPermissions()
  for (const permissions of list) {
    for (const permission of STAFF_PERMISSIONS) {
      if (permissions[permission]) result[permission] = true
    }
  }
  return result
}

/**
 * An unchecked HTML checkbox submits nothing at all, so absence means false —
 * never "unchanged". That is why the edit form always renders all four
 * checkboxes: a partial form would silently revoke the ones it omitted.
 */
export function parsePermissions(formData: FormData): StaffPermissions {
  const result = noPermissions()
  for (const permission of STAFF_PERMISSIONS) {
    result[permission] = formData.get(permission) !== null
  }
  return result
}
```

- [ ] **Step 2: Write the failing guard tests**

In `tests/auth/guards.test.ts`, first widen the destructured import (line 31) to:

```ts
const {
  requireUser,
  requireAdmin,
  requireOwner,
  requireOwnerOf,
  requirePlayer,
  requireBranchAccess,
  getOptionalUser,
  AuthError,
} = await import('@/lib/auth/guards')
```

This file seeds its own `auth.users` rows via its local `seedUser` and cleans them up in its own `afterAll`; the new tests need a branch and a grant too, so add a local helper next to `seedUser`:

```ts
async function seedBranchFor(ownerId: string) {
  const branch = await db.execute(sql`
    insert into branches (owner_id, name, slug, address, city)
    values (${ownerId}::uuid, 'Guard Branch', ${'guard-' + crypto.randomUUID()},
            '1 Test St', 'Marikina')
    returning id
  `)
  return branch.rows[0].id as string
}

async function grant(
  branchId: string,
  userId: string,
  flags: Partial<Record<'view_bookings' | 'block_slots' | 'manage_courts' | 'view_earnings', boolean>>,
) {
  await db.execute(sql`
    insert into branch_staff (
      branch_id, user_id, view_bookings, block_slots, manage_courts, view_earnings
    ) values (
      ${branchId}::uuid, ${userId}::uuid,
      ${flags.view_bookings ?? false}, ${flags.block_slots ?? false},
      ${flags.manage_courts ?? false}, ${flags.view_earnings ?? false}
    )
  `)
}
```

Then append:

```ts
test('requirePlayer resolves for a player and rejects both owner and admin', async () => {
  // Roles are exclusive now. An owner account is a business account: it can
  // never hold a paid booking anywhere, including on someone else's courts.
  const player = await seedUser('player')
  claims.value = { sub: player.id, email: player.email }
  await expect(requirePlayer()).resolves.toMatchObject({ id: player.id, role: 'player' })

  const owner = await seedUser('owner')
  claims.value = { sub: owner.id, email: owner.email }
  await expect(requirePlayer()).rejects.toMatchObject({ status: 403 })

  // Admins do not book either — moderation is not a shopping account.
  const admin = await seedUser('admin')
  claims.value = { sub: admin.id, email: admin.email }
  await expect(requirePlayer()).rejects.toMatchObject({ status: 403 })
})

test('requirePlayer throws 401, not 403, when there is no session at all', async () => {
  // requirePlayerPage branches on exactly this to choose redirect-to-login
  // over redirect-to-/dashboard.
  await expect(requirePlayer()).rejects.toMatchObject({ status: 401 })
})

test('requireBranchAccess lets the branch owner through for every permission', async () => {
  const owner = await seedUser('owner')
  const branchId = await seedBranchFor(owner.id)
  claims.value = { sub: owner.id, email: owner.email }

  for (const permission of ['view_bookings', 'block_slots', 'manage_courts', 'view_earnings'] as const) {
    await expect(requireBranchAccess(branchId, permission)).resolves.toMatchObject({
      id: owner.id,
    })
  }
})

test('requireBranchAccess lets an admin through without any grant or ownership', async () => {
  const owner = await seedUser('owner')
  const branchId = await seedBranchFor(owner.id)

  const admin = await seedUser('admin')
  claims.value = { sub: admin.id, email: admin.email }
  await expect(requireBranchAccess(branchId, 'block_slots')).resolves.toMatchObject({
    role: 'admin',
  })
})

test('requireBranchAccess admits staff only for the flags they actually hold', async () => {
  const owner = await seedUser('owner')
  const branchId = await seedBranchFor(owner.id)
  const staff = await seedUser('player')
  await grant(branchId, staff.id, { view_bookings: true, block_slots: true })

  claims.value = { sub: staff.id, email: staff.email }
  await expect(requireBranchAccess(branchId, 'view_bookings')).resolves.toMatchObject({
    id: staff.id,
    role: 'player',
  })
  await expect(requireBranchAccess(branchId, 'block_slots')).resolves.toMatchObject({
    id: staff.id,
  })
  // Granted on this branch, but not these two flags.
  await expect(requireBranchAccess(branchId, 'manage_courts')).rejects.toMatchObject({
    status: 403,
  })
  await expect(requireBranchAccess(branchId, 'view_earnings')).rejects.toMatchObject({
    status: 403,
  })
})

test('requireBranchAccess rejects staff on a branch they were not granted', async () => {
  // The scope is the grant's branch, not "any branch of an owner who granted
  // me something" — a front-desk person at one location must not see another.
  const owner = await seedUser('owner')
  const granted = await seedBranchFor(owner.id)
  const otherBranch = await seedBranchFor(owner.id)
  const staff = await seedUser('player')
  await grant(granted, staff.id, { view_bookings: true })

  claims.value = { sub: staff.id, email: staff.email }
  await expect(requireBranchAccess(granted, 'view_bookings')).resolves.toMatchObject({
    id: staff.id,
  })
  await expect(requireBranchAccess(otherBranch, 'view_bookings')).rejects.toMatchObject({
    status: 403,
  })
})

test('requireBranchAccess rejects a plain player and a different owner', async () => {
  const owner = await seedUser('owner')
  const branchId = await seedBranchFor(owner.id)

  const player = await seedUser('player')
  claims.value = { sub: player.id, email: player.email }
  await expect(requireBranchAccess(branchId, 'view_bookings')).rejects.toMatchObject({
    status: 403,
  })

  // Being an owner of SOMETHING is not access to someone else's branch.
  const otherOwner = await seedUser('owner')
  await seedBranchFor(otherOwner.id)
  claims.value = { sub: otherOwner.id, email: otherOwner.email }
  await expect(requireBranchAccess(branchId, 'view_bookings')).rejects.toMatchObject({
    status: 403,
  })
})

test('requireBranchAccess rejects a nonexistent branch id with 403, not a database error', async () => {
  const staff = await seedUser('player')
  claims.value = { sub: staff.id, email: staff.email }
  await expect(requireBranchAccess(crypto.randomUUID(), 'block_slots')).rejects.toMatchObject({
    status: 403,
  })
})

test('requireBranchAccess throws 401, not 403, when there is no session at all', async () => {
  await expect(requireBranchAccess(crypto.randomUUID(), 'view_bookings')).rejects.toMatchObject({
    status: 401,
  })
})
```

- [ ] **Step 3: Run the tests and confirm they fail**

```bash
npx vitest run tests/auth/guards.test.ts
```

Expected: FAIL — `requirePlayer is not a function`.

- [ ] **Step 4: Add `requirePlayer` to `src/lib/auth/guards.ts`**

Add the import at the top of the file, after the `createServerSupabaseClient` import:

```ts
import type { StaffPermission } from '@/lib/staff/permissions'
```

Insert after `requireAdmin` (which ends at line 74):

```ts
/**
 * Players only — the gate on every paid write.
 *
 * Roles are exclusive as of the roles-and-staff slice: an owner account is a
 * business account and can never hold a paid booking, on its own courts or
 * anyone else's. Its only slot writes are `blocked` rows on its own courts,
 * which go through requireBranchAccess instead. Admins are rejected too:
 * moderation is not a shopping account.
 *
 * The review action needs no equivalent change — review eligibility derives
 * from owning a `completed` booking, and only a player can have one.
 */
export async function requirePlayer(): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role !== 'player') throw new AuthError(403, 'Players only')
  return user
}
```

- [ ] **Step 5: Add `requireBranchAccess` to `src/lib/auth/guards.ts`**

Append after `requireOwnerOf`:

```ts
/**
 * Per-branch, per-permission access: passes for the branch's owner, for any
 * admin, or for a user holding a branch_staff row on THAT branch with THAT
 * flag true. This is the guard for surfaces staff share with owners (block
 * writes, schedule reads). `requireOwnerOf` stays the guard for owner-only
 * surfaces — staff management, listings, fee-sensitive pages.
 *
 * The owner short-circuits before the grant is consulted, so an owner passes
 * every permission on their own branches without needing a self-grant.
 *
 * `branchId` must be UUID-shaped: it reaches a `::uuid` cast, and a malformed
 * value raises 22P02 rather than a clean 403. Every caller validates the
 * shape first (or takes the id from the database, which is stronger — see
 * src/lib/blocks/write.ts's branchIdOfCourt).
 *
 * One round trip. The permission is read out of a `to_jsonb(s)` row object in
 * TypeScript rather than interpolated as a column name: `permission` is
 * type-constrained to the four literals, but building SQL identifiers from a
 * variable is a habit worth not forming, and `sql.raw` would be the only way
 * to do it.
 */
export async function requireBranchAccess(
  branchId: string,
  permission: StaffPermission,
): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role === 'admin') return user

  const result = await db.execute(sql`
    select
      exists (
        select 1 from branches b
        where b.id = ${branchId}::uuid and b.owner_id = ${user.id}::uuid
      ) as is_owner,
      (
        select to_jsonb(s) from branch_staff s
        where s.branch_id = ${branchId}::uuid and s.user_id = ${user.id}::uuid
      ) as staff_grant
  `)
  const row = result.rows[0]
  if (row.is_owner === true) return user

  // Aliased `staff_grant`, not `grant`: GRANT is a reserved keyword in
  // Postgres and `as grant` is a syntax error.
  const staffGrant = row.staff_grant as Record<string, unknown> | null
  if (staffGrant && staffGrant[permission] === true) return user

  throw new AuthError(403, 'No access to that branch')
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
npx vitest run tests/auth/guards.test.ts
```

Expected: PASS — the file's 11 pre-existing tests plus the 9 added above.

- [ ] **Step 7: Run them a second time**

```bash
npx vitest run tests/auth/guards.test.ts
```

Expected: PASS again.

- [ ] **Step 8: Add `requirePlayerPage` to `src/lib/auth/page-guards.ts`**

Append:

```ts
/**
 * Player pages. A signed-out visitor goes to login; a signed-in OWNER or ADMIN
 * goes to /dashboard rather than an error page — owners can never have
 * bookings, so /bookings has nothing to render for them, and their real
 * destination exists.
 *
 * This cannot ping-pong with requireDashboardPage's "no role, no grants ->
 * /bookings" redirect: that guard's `isOwner` is the same
 * `role === 'owner' || role === 'admin'` predicate requireOwner uses, so
 * everyone this function sends to /dashboard is admitted there.
 */
export async function requirePlayerPage(next: string): Promise<SessionUser> {
  try {
    return await requirePlayer()
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.status === 401) redirect(`/login?next=${encodeURIComponent(safeNextPath(next))}`)
      redirect('/dashboard')
    }
    throw error
  }
}
```

Widen the file's import from `@/lib/auth/guards` to include `requirePlayer`.

- [ ] **Step 9: Extend the action-coverage guard list**

New actions in Tasks 8 and 11 are guarded by `requireBranchAccess`; `createHoldAction` switches to `requirePlayer` in Task 7 and will no longer contain the string `requireUser`. Extend the list now, before any of those land, so no task lands with a red contract test.

In `tests/auth/action-coverage.test.ts`, replace line 13 with:

```ts
// Every guard a 'use server' file may satisfy this contract with. Extended in
// the roles-and-staff slice: `requirePlayer` (paid writes, now that roles are
// exclusive) and `requireBranchAccess` (per-branch, per-permission writes that
// staff share with owners). `requireOwner`/`requireOwnerOf` cover owner-only
// actions; requireOwnerOf is already listed and is what the staff-management
// actions use.
const GUARDS = [
  'requireUser',
  'requireAdmin',
  'requireOwnerOf',
  'requireOwner',
  'requirePlayer',
  'requireBranchAccess',
]
```

Note `'requireOwner'` is a substring of `'requireOwnerOf'`, which is harmless here — the test only asks whether *some* guard name appears in the source.

- [ ] **Step 10: Typecheck, lint, full suite**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: no type errors; only pre-existing lint warnings; all tests pass.

- [ ] **Step 11: Commit**

```bash
git add src/lib/staff/permissions.ts src/lib/auth/guards.ts src/lib/auth/page-guards.ts tests/auth/guards.test.ts tests/auth/action-coverage.test.ts
git commit -m "Add requirePlayer and requireBranchAccess guards with a staff permission vocabulary"
```

---

### Task 5: The dashboard access layer

**Files:**
- Create: `src/lib/staff/access.ts`
- Modify: `src/lib/auth/page-guards.ts` (add `requireDashboardPage`)
- Create: `tests/staff/access.test.ts`

**Interfaces:**
- Produces, from `src/lib/staff/access.ts`:

```ts
export type DashboardBranch = { id: string; name: string; permissions: StaffPermissions }
export type DashboardAccess = {
  user: SessionUser
  /** role is 'owner' or 'admin' — the same predicate requireOwner uses. */
  isOwner: boolean
  /** Owner: every branch they own, all four permissions true. Staff: only granted branches, with their own flags. Ordered by name. */
  branches: DashboardBranch[]
  /** Union of `branches[].permissions`. Owner with zero branches still gets all-true. */
  can: StaffPermissions
}
export async function loadDashboardAccess(user: SessionUser): Promise<DashboardAccess>
export async function hasAnyStaffGrant(userId: string): Promise<boolean>
```
- Produces, from `src/lib/auth/page-guards.ts`:

```ts
export async function requireDashboardPage(next: string): Promise<DashboardAccess>
```
- Consumes: `SessionUser` (`src/lib/auth/guards.ts`); `StaffPermissions`, `allPermissions`, `noPermissions`, `unionPermissions`, `STAFF_PERMISSIONS` (`src/lib/staff/permissions.ts`); `requireUserPage` (`src/lib/auth/page-guards.ts`).

**Why this module exists:** every `/dashboard/*` query in the previous slice was scoped by a single `ownerId`. Staff are not the owner, so that scoping cannot admit them. This resolves one session into the *list of branch ids* it may read, plus the permissions it holds, and Task 6 re-scopes the owner queries onto that list. One guarded resolution, consumed everywhere, instead of an ownership check per query.

- [ ] **Step 1: Write the failing tests**

Create `tests/staff/access.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  seedBranchWithCourts,
  seedOwner,
  seedPlayer,
  seedStaffGrant,
  teardownFixtures,
} from '../helpers/fixtures'
import { hasAnyStaffGrant, loadDashboardAccess } from '@/lib/staff/access'

afterAll(teardownFixtures)

/**
 * loadDashboardAccess takes an already-resolved SessionUser, so these tests
 * build one directly instead of stubbing the Supabase client the way
 * tests/auth/guards.test.ts has to. That is the point of the split: the
 * session lookup is the guards' job and is tested there; this module is pure
 * database resolution over a known user.
 */
async function sessionUserFor(id: string) {
  const result = await db.execute(sql`
    select id, email, role, avatar_url, full_name, business_name
    from profiles where id = ${id}::uuid
  `)
  const row = result.rows[0]
  return {
    id: row.id as string,
    email: row.email as string,
    role: row.role as 'player' | 'owner' | 'admin',
    fullName: (row.full_name as string | null) ?? null,
    avatarUrl: (row.avatar_url as string | null) ?? null,
    businessName: (row.business_name as string | null) ?? null,
  }
}

test('an owner sees every branch they own, with all four permissions', async () => {
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  // Put both branches under one owner so this exercises the listing, not the
  // ownership filter (which the next test covers).
  await db.execute(
    sql`update branches set owner_id = ${first.ownerId}::uuid where id = ${second.branchId}::uuid`,
  )

  const access = await loadDashboardAccess(await sessionUserFor(first.ownerId))
  expect(access.isOwner).toBe(true)
  expect(access.branches.map((b) => b.id).sort()).toEqual(
    [first.branchId, second.branchId].sort(),
  )
  expect(access.branches[0].permissions).toEqual({
    view_bookings: true,
    block_slots: true,
    manage_courts: true,
    view_earnings: true,
  })
  expect(access.can).toEqual({
    view_bookings: true,
    block_slots: true,
    manage_courts: true,
    view_earnings: true,
  })
})

test('an owner never sees another owner\'s branch', async () => {
  const mine = await seedBranchWithCourts(1)
  const theirs = await seedBranchWithCourts(1)

  const access = await loadDashboardAccess(await sessionUserFor(mine.ownerId))
  const ids = access.branches.map((b) => b.id)
  expect(ids).toContain(mine.branchId)
  expect(ids).not.toContain(theirs.branchId)
})

test('an owner with no branches is still an owner, with an empty branch list', async () => {
  // The dashboard renders its "no branches yet" empty state for this; the
  // guard must admit them rather than bounce them to /bookings.
  const ownerId = await seedOwner()

  const access = await loadDashboardAccess(await sessionUserFor(ownerId))
  expect(access.isOwner).toBe(true)
  expect(access.branches).toEqual([])
  // Still all-true: an owner's capability is not derived from owning a branch.
  expect(access.can.view_earnings).toBe(true)
})

test('an admin is treated as an owner and sees only branches they own', async () => {
  // Same rule as requireOwner: an admin passes the role gate, and the queries
  // scope by branch, so an admin at /dashboard sees only their own branches.
  // Cross-owner oversight is /admin/*'s job, not this one.
  const other = await seedBranchWithCourts(1)
  const adminId = await seedPlayer()
  await db.execute(sql`update profiles set role = 'admin' where id = ${adminId}::uuid`)

  const access = await loadDashboardAccess(await sessionUserFor(adminId))
  expect(access.isOwner).toBe(true)
  expect(access.branches.map((b) => b.id)).not.toContain(other.branchId)
  expect(access.can.manage_courts).toBe(true)
})

test('staff see only granted branches, each with only its own flags', async () => {
  const granted = await seedBranchWithCourts(1)
  const ungranted = await seedBranchWithCourts(1)
  await db.execute(
    sql`update branches set owner_id = ${granted.ownerId}::uuid where id = ${ungranted.branchId}::uuid`,
  )
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: granted.branchId, userId: staffId, viewBookings: true })

  const access = await loadDashboardAccess(await sessionUserFor(staffId))
  expect(access.isOwner).toBe(false)
  expect(access.branches).toHaveLength(1)
  expect(access.branches[0].id).toBe(granted.branchId)
  expect(access.branches[0].permissions).toEqual({
    view_bookings: true,
    block_slots: false,
    manage_courts: false,
    view_earnings: false,
  })
})

test('`can` is the union across a staff member\'s branches, not the intersection', async () => {
  // Drives which sidebar items render. A person who can see earnings at one
  // branch gets the Earnings nav item; the page then scopes to the branches
  // where that flag is actually true.
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: first.branchId, userId: staffId, viewBookings: true })
  await seedStaffGrant({ branchId: second.branchId, userId: staffId, viewEarnings: true })

  const access = await loadDashboardAccess(await sessionUserFor(staffId))
  expect(access.branches).toHaveLength(2)
  expect(access.can).toEqual({
    view_bookings: true,
    block_slots: false,
    manage_courts: false,
    view_earnings: true,
  })
})

test('a plain player has no access at all', async () => {
  const playerId = await seedPlayer()

  const access = await loadDashboardAccess(await sessionUserFor(playerId))
  expect(access.isOwner).toBe(false)
  expect(access.branches).toEqual([])
  expect(access.can).toEqual({
    view_bookings: false,
    block_slots: false,
    manage_courts: false,
    view_earnings: false,
  })
})

test('hasAnyStaffGrant is true only while a grant exists', async () => {
  // Drives the nav account menu's "Venue dashboard" item. One indexed lookup
  // on branch_staff (user_id), which is why the nav can afford it per request.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await expect(hasAnyStaffGrant(staffId)).resolves.toBe(false)

  const grantId = await seedStaffGrant({ branchId, userId: staffId, blockSlots: true })
  await expect(hasAnyStaffGrant(staffId)).resolves.toBe(true)

  await db.execute(sql`delete from branch_staff where id = ${grantId}::uuid`)
  await expect(hasAnyStaffGrant(staffId)).resolves.toBe(false)
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run tests/staff/access.test.ts
```

Expected: FAIL — cannot resolve `@/lib/staff/access`.

- [ ] **Step 3: Create `src/lib/staff/access.ts`**

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { SessionUser } from '@/lib/auth/guards'
import {
  allPermissions,
  noPermissions,
  STAFF_PERMISSIONS,
  unionPermissions,
  type StaffPermissions,
} from '@/lib/staff/permissions'

export type DashboardBranch = { id: string; name: string; permissions: StaffPermissions }

export type DashboardAccess = {
  user: SessionUser
  isOwner: boolean
  branches: DashboardBranch[]
  can: StaffPermissions
}

/**
 * Resolves one session into "which branches may this person see in
 * /dashboard, and what may they do in each".
 *
 * This is the module that admits staff to the owner dashboard. Every
 * /dashboard query in the previous slice was scoped by a single `ownerId`,
 * which structurally cannot include a staff member — they are not the owner.
 * Scoping instead by the branch-id list resolved here works for both, and the
 * resolution happens once per request rather than per query.
 *
 * `isOwner` is `role === 'owner' || role === 'admin'`, the exact predicate
 * requireOwner uses. Keeping it identical is what makes requirePlayerPage's
 * "non-player -> /dashboard" and requireDashboardPage's "no role, no grants ->
 * /bookings" redirects unable to ping-pong. Do not narrow one without the
 * other.
 *
 * An owner's `can` is all-true even with zero branches: capability comes from
 * the role, not from owning something. The empty `branches` list is what makes
 * their queries return nothing, and the dashboard renders its empty state.
 */
export async function loadDashboardAccess(user: SessionUser): Promise<DashboardAccess> {
  const isOwner = user.role === 'owner' || user.role === 'admin'

  if (isOwner) {
    const result = await db.execute(sql`
      select id, name from branches where owner_id = ${user.id}::uuid order by name
    `)
    return {
      user,
      isOwner: true,
      // allPermissions() is a factory, not a shared constant, so each branch
      // gets its own object — a shared one handed out by reference would let
      // any mutation change every branch at once.
      branches: result.rows.map((row) => ({
        id: row.id as string,
        name: row.name as string,
        permissions: allPermissions(),
      })),
      can: allPermissions(),
    }
  }

  const result = await db.execute(sql`
    select b.id, b.name,
      s.view_bookings, s.block_slots, s.manage_courts, s.view_earnings
    from branch_staff s
    join branches b on b.id = s.branch_id
    where s.user_id = ${user.id}::uuid
    order by b.name
  `)

  const branches: DashboardBranch[] = result.rows.map((row) => {
    const permissions = noPermissions()
    for (const permission of STAFF_PERMISSIONS) {
      permissions[permission] = row[permission] === true
    }
    return { id: row.id as string, name: row.name as string, permissions }
  })

  return {
    user,
    isOwner: false,
    branches,
    can: unionPermissions(branches.map((branch) => branch.permissions)),
  }
}

/**
 * "Is this person staff anywhere?" — one indexed lookup on
 * branch_staff (user_id), which is why <Nav> can afford to call it on every
 * request for a signed-in player. It exists separately from
 * loadDashboardAccess because the nav only needs the boolean, not the branch
 * list and permission union.
 */
export async function hasAnyStaffGrant(userId: string): Promise<boolean> {
  const result = await db.execute(sql`
    select 1 from branch_staff where user_id = ${userId}::uuid limit 1
  `)
  return result.rows.length > 0
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run tests/staff/access.test.ts
```

Expected: PASS (8 tests).

- [ ] **Step 5: Run them a second time**

```bash
npx vitest run tests/staff/access.test.ts
```

Expected: PASS again.

- [ ] **Step 6: Add `requireDashboardPage` to `src/lib/auth/page-guards.ts`**

Append, and add `import { loadDashboardAccess, type DashboardAccess } from '@/lib/staff/access'` at the top:

```ts
/**
 * The /dashboard/* gate, and the one guard that admits staff.
 *
 * "Owner, or holds at least one branch_staff row." A signed-out visitor goes
 * to login (via requireUserPage, so the same-origin `next` rule is shared); a
 * signed-in player with no grants goes to /bookings, which is their actual
 * home.
 *
 * Returns the resolved access rather than just the user: the layout needs it
 * for the sidebar, and every page needs its `branches` list to scope queries.
 * App Router cannot pass a value from a layout to a page, so each page calls
 * this again — a claims read, one indexed profile lookup, and one indexed
 * branch/grant query. That is the same cost the previous slice already paid
 * calling requireOwnerPage per page.
 */
export async function requireDashboardPage(next: string): Promise<DashboardAccess> {
  const user = await requireUserPage(next)
  const access = await loadDashboardAccess(user)
  if (!access.isOwner && access.branches.length === 0) redirect('/bookings')
  return access
}
```

- [ ] **Step 7: Typecheck and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors. `requireOwnerPage` is still exported and still used by `/dashboard/*` at this point — Task 6 switches those over.

- [ ] **Step 8: Commit**

```bash
git add src/lib/staff/access.ts src/lib/auth/page-guards.ts tests/staff/access.test.ts
git commit -m "Add the dashboard access layer and requireDashboardPage"
```

---

### Task 6: Owner queries — blocks in the schedule, branch-scoped so staff can read them

**Files:**
- Modify: `src/lib/owner/queries.ts` (type changes, `SCHEDULE_ROW`, left joins, `branchIds` scoping, `getScheduleCourts`; delete `getOwnerBranches`)
- Modify: `src/components/dashboard/owner-day-grid.tsx` (`label`/`isBlock`)
- Modify: `src/app/dashboard/layout.tsx` (guard swap, permission-gated sidebar)
- Modify: `src/app/dashboard/page.tsx` (guard swap, `branchIds`)
- Modify: `src/app/dashboard/bookings/page.tsx` (guard swap, `branchIds`, `access.branches`, block rows)
- Modify: `src/app/dashboard/earnings/page.tsx` (guard swap, `branchIds`, `view_earnings` gate)
- Modify: `tests/owner/queries.test.ts` (rewrite call sites, append block tests)

**Interfaces:**
- Produces, from `src/lib/owner/queries.ts`:

```ts
export type OwnerGridCourt = { courtId: string; courtName: string; branchName: string }
export type OwnerGridBooking = {
  bookingId: string
  courtId: string
  startHour: number
  endHour: number
  /** Player display name, or the block's note, or 'Blocked'. */
  label: string
  isBlock: boolean
  note: string | null
}
export type OwnerStats = {
  bookingsThisWeek: number
  occupancyPct: number | null
  grossCentavos: number
  netCentavos: number
}
export type OwnerPendingCourt = { id: string; name: string; branchName: string; createdAt: string }
export type OwnerActivity = { kind: 'booking' | 'review'; at: string; text: string }
export type OwnerOverview = {
  branchCount: number
  stats: OwnerStats
  courts: OwnerGridCourt[]
  openHour: number
  closeHour: number
  todaysBookings: OwnerGridBooking[]
  pendingCourts: OwnerPendingCourt[]
  activity: OwnerActivity[]
}
export type OwnerBookingRow = {
  bookingId: string
  date: string
  startHour: number
  endHour: number
  branchName: string
  courtName: string
  /** Player display name, or the block's note, or 'Blocked'. */
  label: string
  isBlock: boolean
  note: string | null
  status: string
  totalChargedCentavos: number
  ownerNetCentavos: number
}
export type OwnerEarningsRow = {
  branchId: string
  branchName: string
  bookingCount: number
  grossCentavos: number
  platformFeeCentavos: number
  netCentavos: number
}
export type OwnerEarnings = {
  month: string
  rows: OwnerEarningsRow[]
  totals: { bookingCount: number; grossCentavos: number; platformFeeCentavos: number; netCentavos: number }
}

export async function getScheduleCourts(branchIds: string[]): Promise<OwnerGridCourt[]>
export async function getOwnerOverview(branchIds: string[], day: string): Promise<OwnerOverview>
export async function getOwnerBookings(
  branchIds: string[],
  filters: { day: string; branchId?: string },
): Promise<OwnerBookingRow[]>
export async function getOwnerEarnings(branchIds: string[], month: string): Promise<OwnerEarnings>
```
- **Removed:** `getOwnerBranches(ownerId)`. Its only production caller (`/dashboard/bookings`) now uses `access.branches` from `requireDashboardPage`, which already carries `{ id, name }` and is scoped correctly for staff too. Keeping a second, owner-only branch lister would be a divergent source of truth for "which branches does this session see".
- Consumes: `DashboardAccess` (`src/lib/staff/access.ts`), `requireDashboardPage` (`src/lib/auth/page-guards.ts`), `StaffPermissions` (`src/lib/staff/permissions.ts`).

**The status story, spelled out per query** (this is the ruling the previous slice's final review asked for):

| Query / field | Statuses | Why |
|---|---|---|
| `getOwnerOverview.todaysBookings` | `SCHEDULE_ROW` (`confirmed`, `completed`, `blocked`) | A schedule surface. Blocks occupy slots; owners and staff must see them or the grid lies about what is free. |
| `getOwnerOverview.stats.grossCentavos` / `netCentavos` | `REAL_BOOKING` | Money. Blocks carry zero and are not revenue. |
| `getOwnerOverview.stats.bookingsThisWeek` | `REAL_BOOKING` | A count of *bookings*. A maintenance block is not a booking; counting it would inflate a number owners read as demand. |
| `getOwnerOverview.stats.occupancyPct` | `REAL_BOOKING` subset of `todaysBookings` | Utilization sits beside gross/net and must mean the same thing. A resurfacing block reading as 100% occupancy would be the metric lying. Computed in TypeScript by filtering `todaysBookings` on `!isBlock` — no extra round trip. |
| `getOwnerOverview.pendingCourts` | n/a | Courts, not bookings. |
| `getOwnerOverview.activity` | `REAL_BOOKING` | A feed of things players did. Block creation is an owner's own action and is not news to them. Its `join profiles` stays INNER precisely because `REAL_BOOKING` guarantees a non-null `player_id`. |
| `getOwnerBookings` | `SCHEDULE_ROW` | A schedule surface — the day's list of who has the court. Blocks appear, labelled, with an em dash for money. |
| `getOwnerEarnings` | `REAL_BOOKING` | Money. Pinned by a test that a block contributes zero. |

**The left-join fix (the forward note from the previous slice):** `getOwnerOverview`'s `todaysBookings`/`activity` queries and `getOwnerBookings` all `join profiles pr on pr.id = bk.player_id` — an INNER join. A `blocked` row has a null `player_id`, so every one of them would be silently dropped from the schedule surfaces. The two schedule queries become `left join`, and the display value becomes:

```sql
coalesce(pr.full_name, split_part(pr.email, '@', 1), nullif(btrim(bk.note), ''), 'Blocked') as label
```

`nullif(btrim(...), '')` so a whitespace-only note falls through to `'Blocked'` rather than rendering a blank cell. For a paid booking `pr` is always present, so the note/`'Blocked'` tail is unreachable there.

- [ ] **Step 1: Update the existing tests to the new signatures**

In `tests/owner/queries.test.ts`: drop `getOwnerBranches` from the import, delete the `getOwnerBranches returns only branches the caller owns` test (its coverage moved to `tests/staff/access.test.ts`'s "an owner never sees another owner's branch"), and change every call to pass a branch-id array instead of an owner id:

- `getOwnerOverview(mine.ownerId, today)` → `getOwnerOverview([mine.branchId], today)`
- the zero-branch test's `getOwnerOverview(ownerId, manilaToday())` → `getOwnerOverview([], manilaToday())`, and its `seedPlayer()` + inline `update profiles` becomes `await seedOwner()` (import it) — the row is now unused by the query but keeps the test's intent legible
- `getOwnerBookings(mine.ownerId, { day: today })` → `getOwnerBookings([mine.branchId, other.branchId], { day: today })`
- `getOwnerBookings(mine.ownerId, { day: today, branchId: mine.branchId })` → `getOwnerBookings([mine.branchId, other.branchId], { day: today, branchId: mine.branchId })`, and the `update branches set owner_id = …` line that reparented `other` becomes unnecessary — delete it, since scoping is now by explicit id list
- `getOwnerEarnings(mine.ownerId, month)` → `getOwnerEarnings([mine.branchId], month)`
- in the overview test, the "another owner's booking must not leak in" assertion still stands: `theirs.branchId` is simply absent from the array

Also rename every `playerName` assertion to `label`.

- [ ] **Step 2: Append the failing block tests**

Append to `tests/owner/queries.test.ts`, widening the fixtures import to include `seedBlock` and `seedOwner`:

```ts
test('a block appears on the day grid, labelled by its note', async () => {
  // The forward note from the dashboards slice: the profiles join was INNER,
  // so a blocked row (player_id null) was silently dropped and the grid showed
  // the slot as free while the exclusion constraint refused every booking on
  // it — the worst possible failure, because it is invisible.
  const mine = await seedBranchWithCourts(1)
  const today = manilaToday()

  await seedBlock({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    createdBy: mine.ownerId,
    startsAt: manilaAt(today, 11),
    hours: 2,
    note: 'Resurfacing',
  })

  const overview = await getOwnerOverview([mine.branchId], today)
  expect(overview.todaysBookings).toHaveLength(1)
  expect(overview.todaysBookings[0]).toMatchObject({
    startHour: 11,
    endHour: 13,
    label: 'Resurfacing',
    isBlock: true,
    note: 'Resurfacing',
  })
})

test('a block with no note falls back to the label "Blocked"', async () => {
  const mine = await seedBranchWithCourts(1)
  const today = manilaToday()

  await seedBlock({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    createdBy: mine.ownerId,
    startsAt: manilaAt(today, 13),
  })

  const overview = await getOwnerOverview([mine.branchId], today)
  expect(overview.todaysBookings[0].label).toBe('Blocked')
  expect(overview.todaysBookings[0].note).toBeNull()
})

test('a whitespace-only note still falls back to "Blocked"', async () => {
  // nullif(btrim(note), '') — a blank grid cell reads as a rendering bug.
  const mine = await seedBranchWithCourts(1)
  const today = manilaToday()

  await seedBlock({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    createdBy: mine.ownerId,
    startsAt: manilaAt(today, 14),
    note: '   ',
  })

  const overview = await getOwnerOverview([mine.branchId], today)
  expect(overview.todaysBookings[0].label).toBe('Blocked')
})

test('blocks are excluded from gross, net, the weekly booking count, and occupancy', async () => {
  // The status story: SCHEDULE_ROW for the grid, REAL_BOOKING for every number
  // beside it. A resurfacing block reading as revenue or as occupancy would be
  // the dashboard lying about the business.
  const mine = await seedBranchWithCourts(2)
  const player = await seedPlayer()
  const today = manilaToday()

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 15),
    status: 'confirmed',
    totalCentavos: 50000,
  })
  await seedBlock({
    courtId: mine.courtIds[1],
    branchId: mine.branchId,
    createdBy: mine.ownerId,
    startsAt: manilaAt(today, 15),
    hours: 4,
    note: 'Repainting lines',
  })

  const overview = await getOwnerOverview([mine.branchId], today)
  // Both rows are on the schedule…
  expect(overview.todaysBookings).toHaveLength(2)
  // …and only the paid one is in any number.
  expect(overview.stats.grossCentavos).toBe(50000)
  expect(overview.stats.netCentavos).toBe(50000 - 5000)
  expect(overview.stats.bookingsThisWeek).toBe(1)
  // 1 booked hour over the two courts' operating hours for the day. The
  // block's 4 hours are NOT in the numerator.
  const perCourtHours = 24 - 11
  expect(overview.stats.occupancyPct).toBe(Math.round((1 / (perCourtHours * 2)) * 100))
})

test('getOwnerBookings lists blocks alongside bookings, with zero money', async () => {
  const mine = await seedBranchWithCourts(2)
  const player = await seedPlayer()
  const today = manilaToday()

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 16),
    status: 'confirmed',
    totalCentavos: 40000,
  })
  await seedBlock({
    courtId: mine.courtIds[1],
    branchId: mine.branchId,
    createdBy: mine.ownerId,
    startsAt: manilaAt(today, 16),
    note: 'Walk-in — Juan',
  })

  const rows = await getOwnerBookings([mine.branchId], { day: today })
  expect(rows).toHaveLength(2)
  const block = rows.find((row) => row.isBlock)!
  expect(block.label).toBe('Walk-in — Juan')
  expect(block.status).toBe('blocked')
  expect(block.totalChargedCentavos).toBe(0)
  expect(block.ownerNetCentavos).toBe(0)
  const booking = rows.find((row) => !row.isBlock)!
  expect(booking.totalChargedCentavos).toBe(40000)
})

test('getOwnerEarnings ignores blocks entirely', async () => {
  const mine = await seedBranchWithCourts(2)
  const player = await seedPlayer()
  const today = manilaToday()
  const month = today.slice(0, 7)

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 17),
    status: 'confirmed',
    totalCentavos: 80000,
  })
  await seedBlock({
    courtId: mine.courtIds[1],
    branchId: mine.branchId,
    createdBy: mine.ownerId,
    startsAt: manilaAt(today, 17),
    hours: 3,
  })

  const earnings = await getOwnerEarnings([mine.branchId], month)
  const row = earnings.rows.find((r) => r.branchId === mine.branchId)!
  expect(row.grossCentavos).toBe(80000)
  // The block contributes no row and no count — not a ₱0 row inflating the
  // booking count.
  expect(row.bookingCount).toBe(1)
  expect(earnings.totals.bookingCount).toBe(1)
})

test('a branch id not in the scope list is invisible, even under the same owner', async () => {
  // This is the staff-scoping guarantee: a front-desk person granted one
  // branch must not read another, and the filter is in SQL, never in
  // TypeScript after the fetch.
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  await db.execute(
    sql`update branches set owner_id = ${first.ownerId}::uuid where id = ${second.branchId}::uuid`,
  )
  const player = await seedPlayer()
  const today = manilaToday()

  await seedBooking({
    courtId: second.courtIds[0],
    branchId: second.branchId,
    playerId: player,
    startsAt: manilaAt(today, 18),
    status: 'confirmed',
    totalCentavos: 90000,
  })

  const scoped = await getOwnerOverview([first.branchId], today)
  expect(scoped.branchCount).toBe(1)
  expect(scoped.todaysBookings).toEqual([])
  expect(scoped.stats.grossCentavos).toBe(0)

  const bookings = await getOwnerBookings([first.branchId], { day: today })
  expect(bookings).toEqual([])
})

test('an empty scope list returns empty results without a SQL error', async () => {
  // A player with no grants never reaches these queries (requireDashboardPage
  // redirects them), but an owner with zero branches does. `= any ('{}')` must
  // be a clean no-match, not a cast failure or a division by zero.
  const today = manilaToday()

  const overview = await getOwnerOverview([], today)
  expect(overview.branchCount).toBe(0)
  expect(overview.courts).toEqual([])
  expect(overview.todaysBookings).toEqual([])
  expect(overview.stats.occupancyPct).toBeNull()
  expect(overview.stats.grossCentavos).toBe(0)

  await expect(getOwnerBookings([], { day: today })).resolves.toEqual([])
  const earnings = await getOwnerEarnings([], today.slice(0, 7))
  expect(earnings.rows).toEqual([])
  expect(earnings.totals.grossCentavos).toBe(0)
})

test('getScheduleCourts lists approved courts across the scoped branches only', async () => {
  const mine = await seedBranchWithCourts(2)
  const theirs = await seedBranchWithCourts(1)
  await db.execute(sql`
    insert into courts (branch_id, name, environment, status)
    values (${mine.branchId}::uuid, 'Court Pending', 'outdoor', 'pending')
  `)

  const courts = await getScheduleCourts([mine.branchId])
  const names = courts.map((c) => c.courtName)
  expect(names).toEqual(['Court 1', 'Court 2'])
  // A pending court has no column in the grid and must not be offerable as a
  // block target either — the block writer rejects it too (Task 8).
  expect(names).not.toContain('Court Pending')
  expect(courts.map((c) => c.courtId)).not.toContain(theirs.courtIds[0])
})
```

- [ ] **Step 3: Run the owner tests and confirm they fail**

```bash
npx vitest run tests/owner/queries.test.ts
```

Expected: FAIL — `getScheduleCourts` is not exported, and the block tests report `todaysBookings` as empty (the INNER join dropping them) or `label` as undefined.

- [ ] **Step 4: Rewrite `src/lib/owner/queries.ts`**

Apply these edits precisely.

**4a. Type changes.** Replace `OwnerGridBooking` (lines 6-12) with:

```ts
export type OwnerGridBooking = {
  bookingId: string
  courtId: string
  startHour: number
  endHour: number
  /**
   * Who or what holds this slot: the player's display name for a booking, the
   * block's note for a block, or 'Blocked' when a block carries no note.
   *
   * Named `label`, not `playerName`, since the roles-and-staff slice: a field
   * called playerName holding the string 'Blocked' is a field that lies.
   */
  label: string
  isBlock: boolean
  note: string | null
}
```

In `OwnerBookingRow` (lines 38-49) replace `playerName: string` with:

```ts
  /** Same rule as OwnerGridBooking.label. */
  label: string
  isBlock: boolean
  note: string | null
```

**4b. Status fragments.** Replace the `REAL_BOOKING` block (lines 64-70) with:

```ts
/**
 * MONEY surfaces: gross, net, earnings, the weekly booking count. `confirmed`
 * and `completed` only — the same rule as `src/lib/bookings/queries.ts`'s
 * player-facing module. `blocked` is excluded because a block is not revenue
 * and not a booking; `pending_payment` because an unpaid hold is not either;
 * `expired`/`refunded_manual` because they never became real.
 *
 * Defined locally rather than imported from the player module: it is three
 * words, and importing across query modules for it would be a heavier coupling
 * than the fragment itself.
 */
const REAL_BOOKING = sql`bk.status in ('confirmed', 'completed')`

/**
 * SCHEDULE surfaces: the owner day grid and the /dashboard/bookings list.
 * Real bookings PLUS blocks, because a block occupies the slot and the people
 * running the venue have to see what is actually unavailable — that is the
 * whole point of blocks existing.
 *
 * Deliberately NOT the same as bookings_no_overlap's predicate, which also
 * includes `pending_payment`: an unpaid hold is a checkout in progress, not
 * something an owner acts on, and showing one as taken court time would tell
 * an owner they have a booking nobody has paid for. `expired` and
 * `refunded_manual` occupy nothing.
 */
const SCHEDULE_ROW = sql`bk.status in ('confirmed', 'completed', 'blocked')`

/**
 * The display value for a schedule row, from a LEFT-joined profiles row.
 *
 * The join MUST be left: a `blocked` row has a null `player_id`, and the inner
 * join this replaced silently dropped every block from the grid and the
 * bookings list — the slot rendered free while the exclusion constraint
 * refused every attempt to book it.
 *
 * `nullif(btrim(...), '')` so a whitespace-only note falls through to
 * 'Blocked' instead of rendering an empty cell. For a paid booking the
 * profiles row is always present, so the note/'Blocked' tail is unreachable.
 */
const SCHEDULE_LABEL = sql`
  coalesce(
    pr.full_name,
    split_part(pr.email, '@', 1),
    nullif(btrim(bk.note), ''),
    'Blocked'
  )
`
```

**4c. The scoped-courts fragment.** Replace the `toGridCourt`/`toPlayerName` helpers (lines 101-111) with:

```ts
function toGridCourt(row: Record<string, unknown>): OwnerGridCourt {
  return {
    courtId: row.court_id as string,
    courtName: row.court_name as string,
    branchName: row.branch_name as string,
  }
}

/**
 * Approved courts inside a scoped set of branches.
 *
 * `branchIds` replaces the previous `ownerId` scoping throughout this module.
 * That change is what admits staff: a branch_staff member is not the owner, so
 * `b.owner_id = $` structurally cannot include them, while an explicit id list
 * resolved once by `loadDashboardAccess` works for owners and staff alike. The
 * filter is still entirely in SQL — nothing is filtered in TypeScript after
 * the fetch — and the list itself comes from a guarded query, never from
 * client input.
 *
 * An empty array serializes to the Postgres empty array `{}`, so
 * `= any ('{}'::uuid[])` matches nothing and every query returns zero rows.
 * That is the correct answer for an owner who has not created a branch yet.
 */
function approvedCourtsIn(branchIds: string[]) {
  return sql`
    select c.id as court_id, c.name as court_name, b.id as branch_id, b.name as branch_name
    from courts c
    join branches b on b.id = c.branch_id
    where b.id = any (${sql.param(branchIds)}::uuid[]) and c.status = 'approved'
  `
}

/**
 * The scoped, approved courts as a flat list — the grid's columns, and the
 * option list for the block form (Task 9). Only 'approved' courts: a pending
 * or suspended court has no column in the grid, and the block writer refuses
 * it too, so offering it anywhere would create rows that render nowhere.
 */
export async function getScheduleCourts(branchIds: string[]): Promise<OwnerGridCourt[]> {
  const result = await db.execute(sql`
    with scoped_courts as (${approvedCourtsIn(branchIds)})
    select court_id, court_name, branch_name from scoped_courts
    order by branch_name, court_name
  `)
  return result.rows.map(toGridCourt)
}
```

**4d. Delete `getOwnerBranches`** (lines 113-119) entirely. `access.branches` from `requireDashboardPage` replaces it and is correct for staff.

**4e. `getOwnerOverview`.** Change the signature to `export async function getOwnerOverview(branchIds: string[], day: string): Promise<OwnerOverview>`, then:

- Delete the `branchCountResult` query and replace `const branchCount = …` with `const branchCount = branchIds.length` — the scope list *is* the visible branch count, so a round trip to recount it would only introduce a way for the two to disagree.
- Replace `const ownedApprovedCourts = sql\`…\`` with `const scopedCourts = approvedCourtsIn(branchIds)`, and update the three `with owned_courts as (${ownedApprovedCourts})` references to `with scoped_courts as (${scopedCourts})` plus their `from owned_courts`/`join owned_courts oc` clauses to `scoped_courts`.
- Replace the `courtsResult`/`courts` pair with `const courts = await getScheduleCourts(branchIds)` — same round trip, one definition.
- Replace the `todaysBookingsResult` query and its mapping with:

```ts
  // Scoped to the same scoped_courts set as the operating-hours denominator,
  // so grid, numerator, and denominator all agree on which courts count. A
  // suspended court's rows are invisible here by design: no column, no
  // capacity, so counting its hours would push occupancy past 100% for rows
  // that render nowhere.
  //
  // SCHEDULE_ROW, and a LEFT join on profiles: blocks belong on this surface
  // and have no player_id. The inner join this replaced dropped them silently.
  const todaysBookingsResult = await db.execute(sql`
    with scoped_courts as (${scopedCourts})
    select bk.id as booking_id, bk.court_id,
      extract(hour from (bk.starts_at at time zone 'Asia/Manila'))::int as start_hour,
      ${MANILA_END_HOUR} as end_hour,
      (bk.status = 'blocked') as is_block,
      bk.note,
      ${SCHEDULE_LABEL} as label
    from bookings bk
    join scoped_courts sc on sc.court_id = bk.court_id
    left join profiles pr on pr.id = bk.player_id
    where ${SCHEDULE_ROW}
      and to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') = ${day}
    order by bk.starts_at
  `)
  const todaysBookings: OwnerGridBooking[] = todaysBookingsResult.rows.map((row) => ({
    bookingId: row.booking_id as string,
    courtId: row.court_id as string,
    startHour: Number(row.start_hour),
    endHour: Number(row.end_hour),
    label: row.label as string,
    isBlock: row.is_block === true,
    note: (row.note as string | null) ?? null,
  }))
```

- Replace the `bookedHoursToday` line with:

```ts
  // Occupancy is PAID utilization: it sits in the stat row beside gross and
  // net and has to mean the same thing they do. A resurfacing block reading as
  // 100% occupancy would be the metric lying about the business. Filtered from
  // the rows already fetched — no extra round trip.
  const bookedHoursToday = todaysBookings
    .filter((booking) => !booking.isBlock)
    .reduce((sum, booking) => sum + (booking.endHour - booking.startHour), 0)
```

- In the `statsResult` query, replace `where b.owner_id = ${ownerId}::uuid` with `where b.id = any (${sql.param(branchIds)}::uuid[])`. Leave `${REAL_BOOKING}` — this is the money query.
- In `pendingCourtsResult`, same substitution: `where b.id = any (${sql.param(branchIds)}::uuid[]) and c.status = 'pending'`.
- In `recentBookingsResult` and `recentReviewsResult`, same substitution for the owner filter. Leave both `join profiles pr` as INNER joins and add above `recentBookingsResult`:

```ts
  // Activity is a feed of things PLAYERS did, so REAL_BOOKING — a block is the
  // owner's own action and is not news to them. The `join profiles` below can
  // therefore stay INNER: REAL_BOOKING guarantees a non-null player_id. If
  // that filter is ever widened to include 'blocked', this join must become a
  // LEFT join with SCHEDULE_LABEL, or blocks will be dropped silently.
```

- Replace both `toPlayerName(row)` calls in the `activity` array with `(row.player_name as string)`, and keep those two queries' existing `coalesce(pr.full_name, split_part(pr.email, '@', 1)) as player_name` select items unchanged.

**4f. `getOwnerBookings`.** Replace the whole function with:

```ts
/**
 * The day's schedule for the scoped branches, optionally narrowed to one.
 *
 * SCHEDULE_ROW, not REAL_BOOKING: blocks take slots, and this list is what an
 * owner or front-desk person reads to know who has the court. A
 * `pending_payment` hold still stays out — an unpaid checkout in progress is
 * not court time taken — as do `expired` and `refunded_manual`.
 *
 * `filters.branchId` is belt-and-braces on top of the scope list: the `any`
 * clause already makes an unscoped branch id return nothing, so a forged
 * filter cannot widen access, only narrow it.
 */
export async function getOwnerBookings(
  branchIds: string[],
  filters: { day: string; branchId?: string },
): Promise<OwnerBookingRow[]> {
  const branchFilter = filters.branchId ? sql`and b.id = ${filters.branchId}::uuid` : sql``

  const result = await db.execute(sql`
    select bk.id as booking_id,
      to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as date,
      extract(hour from (bk.starts_at at time zone 'Asia/Manila'))::int as start_hour,
      ${MANILA_END_HOUR} as end_hour,
      b.name as branch_name, c.name as court_name,
      (bk.status = 'blocked') as is_block,
      bk.note,
      ${SCHEDULE_LABEL} as label,
      bk.status,
      bk.total_charged_centavos, bk.owner_net_centavos
    from bookings bk
    join branches b on b.id = bk.branch_id
    join courts c   on c.id = bk.court_id
    left join profiles pr on pr.id = bk.player_id
    where b.id = any (${sql.param(branchIds)}::uuid[])
      and ${SCHEDULE_ROW}
      and to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') = ${filters.day}
      ${branchFilter}
    order by bk.starts_at
  `)

  return result.rows.map((row) => ({
    bookingId: row.booking_id as string,
    date: row.date as string,
    startHour: Number(row.start_hour),
    endHour: Number(row.end_hour),
    branchName: row.branch_name as string,
    courtName: row.court_name as string,
    label: row.label as string,
    isBlock: row.is_block === true,
    note: (row.note as string | null) ?? null,
    status: row.status as string,
    totalChargedCentavos: Number(row.total_charged_centavos),
    ownerNetCentavos: Number(row.owner_net_centavos),
  }))
}
```

**4g. `getOwnerEarnings`.** Change the signature to `(branchIds: string[], month: string)` and replace `where b.owner_id = ${ownerId}::uuid` with `where b.id = any (${sql.param(branchIds)}::uuid[])`. Leave `${REAL_BOOKING}` and add to its docstring: `Blocks never appear: they are excluded by REAL_BOOKING, and bookings_blocked_is_free guarantees they carry no money to leak even if that filter were widened.`

- [ ] **Step 5: Run the owner tests and confirm they pass**

```bash
npx vitest run tests/owner/queries.test.ts
```

Expected: PASS — the file's rewritten pre-existing tests plus the 9 added above.

- [ ] **Step 6: Run them a second time**

```bash
npx vitest run tests/owner/queries.test.ts
```

Expected: PASS again.

- [ ] **Step 7: Update the day grid for `label`/`isBlock`**

In `src/components/dashboard/owner-day-grid.tsx`, replace the cell body (the `{booking ? (…) : (…)}` expression, lines 75-81) with:

```tsx
                    {booking ? (
                      /* Blocks read differently from bookings on purpose: a
                         soft --band-off chip (the mockup's .cell-fill look)
                         versus a solid --court-deep block. Same information
                         density, immediately distinguishable at a glance, and
                         no color outside branding.md's palette. Read-only —
                         the unblock control lives on /dashboard/bookings,
                         where a table row has room for it and a 30px grid
                         cell does not. */
                      <div
                        title={booking.isBlock ? `Blocked — ${booking.label}` : booking.label}
                        className={`truncate rounded-[8px] px-2.5 py-1.5 text-[12px] font-semibold ${
                          booking.isBlock
                            ? 'font-mono bg-[var(--band-off)] text-[var(--court-deep)]'
                            : 'bg-[var(--court-deep)] text-white'
                        }`}
                      >
                        {booking.label}
                      </div>
                    ) : (
                      <div className="h-[30px] rounded-[8px] bg-[var(--surface)]" />
                    )}
```

Also update the component's docstring: add a paragraph saying it renders `blocked` rows as well as bookings, distinguished by `isBlock`, and that it is deliberately read-only.

- [ ] **Step 8: Switch the dashboard layout to `requireDashboardPage` with a permission-gated sidebar**

In `src/app/dashboard/layout.tsx`, replace the import of `requireOwnerPage` with `requireDashboardPage`, and replace the guard call and `items` array (lines 20-26) with:

```tsx
  const access = await requireDashboardPage('/dashboard')
  const user = access.user

  // Only sections this session can actually use. A staff member without
  // view_earnings must not see an Earnings item that then bounces them; a
  // staff member must not see Staff at all, since staff management is
  // owner-only (requireOwnerPage guards that page, and its actions use
  // requireOwnerOf).
  //
  // Overview is unconditional: everyone admitted here has at least one
  // permission on at least one branch (branch_staff_some_permission
  // guarantees it), and the overview degrades to the empty state otherwise.
  const items = [
    { href: '/dashboard', label: 'Overview', show: true },
    { href: '/dashboard/bookings', label: 'Bookings', show: access.can.view_bookings },
    { href: '/dashboard/earnings', label: 'Earnings', show: access.can.view_earnings },
    { href: '/dashboard/staff', label: 'Staff', show: access.isOwner },
  ].filter((item) => item.show)
```

And replace the role kicker (line 58) so staff read as staff rather than as "player":

```tsx
              <div className="font-mono text-[10px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
                {access.isOwner ? user.role : 'Staff'}
              </div>
```

The `FOCUS_RING` constant and its use on the wordmark link, every nav link, and the sign-out button stay exactly as they are.

- [ ] **Step 9: Update the overview page**

In `src/app/dashboard/page.tsx`, replace the `requireOwnerPage` import with `requireDashboardPage` and replace lines 29-32 with:

```tsx
  const access = await requireDashboardPage('/dashboard')
  const day = manilaToday()
  const branchIds = access.branches.map((branch) => branch.id)
  const { branchCount, stats, courts, openHour, closeHour, todaysBookings, pendingCourts, activity } =
    await getOwnerOverview(branchIds, day)
```

Gate the money row so staff without `view_earnings` do not see revenue. Replace the four-`StatCard` grid (lines 52-60) with:

```tsx
          {/* Gross and net are earnings data: a front-desk staff member
              without view_earnings sees the schedule columns only. The grid
              narrows to two columns rather than leaving holes. */}
          <div
            className={`mb-6 grid gap-4 max-[980px]:grid-cols-2 ${
              access.can.view_earnings ? 'grid-cols-4' : 'grid-cols-2'
            }`}
          >
            <StatCard kicker="Bookings this week" value={String(stats.bookingsThisWeek)} />
            <StatCard
              kicker="Occupancy"
              value={stats.occupancyPct === null ? '—' : `${stats.occupancyPct}%`}
            />
            {access.can.view_earnings && (
              <>
                <StatCard kicker="Gross revenue" value={formatPeso(stats.grossCentavos)} />
                <StatCard kicker="Net after fees" value={formatPeso(stats.netCentavos)} />
              </>
            )}
          </div>
```

And change the zero-branch empty-state copy (lines 46-49) so it is true for staff too:

```tsx
        <p className={EMPTY_PANEL}>
          {access.isOwner
            ? "No branches yet — once you add a branch and your courts are approved, this is where the day's bookings appear."
            : 'No branches are shared with you yet. Ask the venue owner to grant you access.'}
        </p>
```

- [ ] **Step 10: Update the bookings page**

In `src/app/dashboard/bookings/page.tsx`:

- Replace the `requireOwnerPage` import with `requireDashboardPage`; drop `getOwnerBranches` from the `@/lib/owner/queries` import.
- Replace lines 38-54 with:

```tsx
  const access = await requireDashboardPage('/dashboard/bookings')
  const { day: rawDay, branch: rawBranch } = await searchParams

  // Staff without view_bookings have no business here. The sidebar already
  // hides the item; this is the boundary, since a URL can be typed.
  if (!access.can.view_bookings) redirect('/dashboard')

  // An invalid or nonexistent date (?day=2026-02-30) falls back to today
  // rather than reaching a ::date cast and raising 22008.
  const day = rawDay && isValidCalendarDate(rawDay) ? rawDay : manilaToday()
  const today = manilaToday()

  // A branch filter is honored only if it is one of THIS session's branches.
  // getOwnerBookings scopes by the same list in SQL, so a foreign id could
  // never widen the result set — dropping it here keeps the <select> and the
  // prev/next links coherent instead of echoing a value that shows nothing.
  const branches = access.branches
  const branchId =
    rawBranch && UUID_RE.test(rawBranch) && branches.some((branch) => branch.id === rawBranch)
      ? rawBranch
      : undefined

  const rows = await getOwnerBookings(
    branches.map((branch) => branch.id),
    { day, branchId },
  )

  // Only a *validated* branch filter is echoed back into prev/next/Today
  // links — an invalid, foreign, or absent `branch` param is dropped.
  const branchQuery = branchId ? `&branch=${branchId}` : ''
```

Add `import { redirect } from 'next/navigation'` at the top.

- Update `humanizeStatus`'s docstring: `getOwnerBookings` now filters to `SCHEDULE_ROW`, so the statuses reaching it are `confirmed`, `completed`, and `blocked` — all single words, so a plain capitalize is still enough.
- Rename the `Player` column header to `Player / block`, and replace the player, status, amount, and net cells (lines 139-150) with:

```tsx
                  <td className="py-4 pr-4 text-[13.5px] text-[var(--ink)]">{row.label}</td>
                  <td className="py-4 pr-4">
                    {/* A block is not a booking status a player would ever
                        see, so it is tagged distinctly: --booked (branding.md's
                        flat disabled tone) rather than the --band-off pill that
                        means "confirmed / completed". */}
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap ${
                        row.isBlock
                          ? 'bg-[var(--booked)] text-[var(--ink-soft)]'
                          : 'bg-[var(--band-off)] text-[var(--court-deep)]'
                      }`}
                    >
                      {humanizeStatus(row.status)}
                    </span>
                  </td>
                  <td className="font-mono py-4 pr-4 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                    {/* An em dash, not ₱0: a block never had a price, and a
                        rendered ₱0 reads as a booking that earned nothing. */}
                    {row.isBlock ? '—' : formatPeso(row.totalChargedCentavos)}
                  </td>
                  <td className="font-mono py-4 pr-5 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                    {row.isBlock ? '—' : formatPeso(row.ownerNetCentavos)}
                  </td>
```

- [ ] **Step 11: Update the earnings page**

In `src/app/dashboard/earnings/page.tsx`, replace the `requireOwnerPage` call with:

```tsx
  const access = await requireDashboardPage('/dashboard/earnings')
  // Earnings is the one dashboard surface that is purely money. Staff see it
  // only with view_earnings; the sidebar hides the item, and this is the
  // boundary for a typed URL.
  if (!access.can.view_earnings) redirect('/dashboard')
```

and pass `access.branches.map((branch) => branch.id)` as `getOwnerEarnings`'s first argument in place of `user.id`. Add `import { redirect } from 'next/navigation'` and swap the `requireOwnerPage` import for `requireDashboardPage`.

- [ ] **Step 12: Typecheck, lint, full suite**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: no type errors. If `tsc` reports `getOwnerBranches` as missing, a page still imports the deleted function — switch it to `access.branches`. All tests pass.

- [ ] **Step 13: Commit**

```bash
git add src/lib/owner/queries.ts src/components/dashboard/owner-day-grid.tsx src/app/dashboard/layout.tsx src/app/dashboard/page.tsx src/app/dashboard/bookings/page.tsx src/app/dashboard/earnings/page.tsx tests/owner/queries.test.ts
git commit -m "Show blocks on owner schedule surfaces and scope the dashboard by branch so staff can read it"
```

---

### Task 7: Owners cannot book — the hold guard, the venue CTA, `/bookings`, and the nav

**Files:**
- Modify: `src/app/venues/[slug]/actions.ts` (`requireUser` → `requirePlayer`)
- Modify: `src/app/venues/[slug]/page.tsx` (resolve `canBook`, pass it down)
- Modify: `src/components/availability-grid.tsx` (accept and honor `canBook`)
- Modify: `src/app/bookings/page.tsx` (`requireUserPage` → `requirePlayerPage`)
- Modify: `src/app/bookings/[id]/page.tsx` (`requireUserPage` → `requirePlayerPage`)
- Modify: `src/components/site/nav.tsx` (resolve `isStaff`)
- Modify: `src/components/site/account-menu.tsx` (role-aware items)

**Interfaces:**
- Consumes: `requirePlayer` (`src/lib/auth/guards.ts`), `requirePlayerPage` (`src/lib/auth/page-guards.ts`), `hasAnyStaffGrant` (`src/lib/staff/access.ts`), `getOptionalUser` (`src/lib/auth/guards.ts`).
- Produces:
  - `<AvailabilityGrid grid branchId slug date canBook />` — `canBook: boolean` is new and **required** (not defaulted: a new call site that forgets it must fail to typecheck rather than silently render a booking CTA to an owner).
  - `AccountMenuUser` gains `isStaff: boolean`.

**Layering note:** the server guard is the boundary; the UI changes only stop offering an action that would be refused. Do not implement one without the other — hiding the CTA alone leaves a forgeable form POST, and guarding alone leaves owners clicking a button that errors.

- [ ] **Step 1: Switch the hold action to `requirePlayer`**

In `src/app/venues/[slug]/actions.ts`, replace the import line and the guard block (lines 6 and 48-54) with:

```ts
import { requirePlayer, AuthError } from '@/lib/auth/guards'
```

```ts
export async function createHoldAction(formData: FormData): Promise<{ error: string } | never> {
  let user
  try {
    // requirePlayer, not requireUser: roles are exclusive as of the
    // roles-and-staff slice. An owner account is a business account that can
    // never hold a paid booking — not on someone else's courts, and not on its
    // own (its own courts are taken off the market with `blocked` rows through
    // /dashboard/bookings instead). Admins are refused for the same reason.
    //
    // 401 and 403 must be told apart here: a signed-out visitor is mid-flow
    // and belongs at /login, while a signed-in owner needs an explanation, not
    // a login page they are already past.
    user = await requirePlayer()
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.status === 401) redirect('/login')
      return {
        error:
          "Owner and admin accounts can't book courts. To hold time on your own courts, use Bookings in your dashboard.",
      }
    }
    throw error
  }
```

The rest of the function — the input validation block, the `createHold` call, `messageFor` — is unchanged. `tests/auth/action-coverage.test.ts` still passes because Task 4 added `requirePlayer` to `GUARDS`.

- [ ] **Step 2: Confirm the action-coverage contract still holds**

```bash
npx vitest run tests/auth/action-coverage.test.ts
```

Expected: PASS. A failure naming `src/app/venues/[slug]/actions.ts` means Task 4's `GUARDS` edit was not applied.

- [ ] **Step 3: Add `canBook` to the availability grid**

In `src/components/availability-grid.tsx`:

- Add `canBook: boolean` to the props type (after `date: string`).
- Guard the cell click and the disabled-state computation. Replace the `aria-disabled` and `onClick` lines (153-156) with:

```tsx
                        // `!canBook` folds into the same non-interactive
                        // treatment as booked/closed rather than getting a
                        // fourth visual state: to an owner, every cell is
                        // simply not theirs to click. Still focusable (not
                        // `disabled`), so a keyboard user can read the prices.
                        aria-disabled={!props.canBook || cell.state !== 'open'}
                        onClick={() => {
                          if (props.canBook && cell.state === 'open') toggle(court.courtId, hour)
                        }}
```

- Replace the summary bar's `!selection` branch (lines 199-202) with:

```tsx
        {!props.canBook ? (
          /* The server guard (requirePlayer in
             src/app/venues/[slug]/actions.ts) is the real boundary; this is
             the explanation, so an owner is not left wondering why the grid
             does not respond. */
          <span className="text-sm text-[var(--ink-soft)]">
            Owner and admin accounts can&rsquo;t book courts. To hold time on your own courts, use
            Bookings in your dashboard.
          </span>
        ) : !selection ? (
          <span className="text-sm text-[var(--ink-soft)]">
            Select open slots in one court&rsquo;s column to book.
          </span>
        ) : (
```

  and close the extra ternary branch at the end of that block (the existing `)}` becomes `)}` for the innermost and the file's closing `</div>` structure is otherwise unchanged — verify with `npx tsc --noEmit`).

- Update the file's header comment: add a line saying `canBook` is false for owner/admin sessions, that the cells and the summary bar both honor it, and that the authoritative check is `requirePlayer` in the action.

- [ ] **Step 4: Resolve `canBook` on the venue page**

In `src/app/venues/[slug]/page.tsx`, add `import { getOptionalUser } from '@/lib/auth/guards'` and, right after the `const isToday = …` line (73), insert:

```tsx
  // Signed-out visitors keep the CTA: clicking it redirects to /login and
  // returns them here, which is the funnel. Only a signed-in non-player has
  // the CTA withdrawn, because for them it can never succeed.
  //
  // <Nav> already calls getOptionalUser() on every page, so this adds no
  // dynamic-rendering cost that was not already paid.
  const viewer = await getOptionalUser()
  const canBook = viewer === null || viewer.role === 'player'
```

Then pass it to the grid:

```tsx
              <AvailabilityGrid
                grid={result.grid}
                branchId={result.branch.id as string}
                slug={slug}
                date={day}
                canBook={canBook}
              />
```

- [ ] **Step 5: Redirect owners away from the player surfaces**

In `src/app/bookings/page.tsx`: change the import from `requireUserPage` to `requirePlayerPage` and the call to `const user = await requirePlayerPage('/bookings')`. Add above it:

```tsx
  // requirePlayerPage, not requireUserPage: owners can never have bookings, so
  // /bookings has nothing to render for them — they go to /dashboard. Staff are
  // players and keep /bookings as their home; their venue access is a separate
  // surface, not a replacement for their own account.
```

In `src/app/bookings/[id]/page.tsx`: same swap, `const user = await requirePlayerPage(\`/bookings/${id}\`)`. A receipt is a player artifact; an owner reaching one has nothing to see there either (and `getBookingReceipt` scopes by `player_id`, so it would return null and 404 anyway — the redirect is the better answer).

- [ ] **Step 6: Resolve staff-ness in the nav**

In `src/components/site/nav.tsx`, add `import { hasAnyStaffGrant } from '@/lib/staff/access'` and replace lines 21-22 with:

```tsx
  const user = await getOptionalUser()
  const onDark = variant === 'overlay'

  // Only asked for players: an owner or admin already gets the dashboard item
  // from their role, and promoteToOwner() deletes a promoted user's grants, so
  // a non-player can never hold one. One indexed lookup on
  // branch_staff (user_id), and only for a signed-in player.
  const isStaff = user?.role === 'player' ? await hasAnyStaffGrant(user.id) : false
```

and pass it through:

```tsx
          {user ? (
            <AccountMenu
              user={{
                email: user.email,
                fullName: user.fullName ?? null,
                avatarUrl: user.avatarUrl,
                role: user.role,
                isStaff,
              }}
              onDark={onDark}
            />
          ) : (
```

- [ ] **Step 7: Make the account menu role-aware**

In `src/components/site/account-menu.tsx`:

- Add `isStaff: boolean` to `AccountMenuUser`, with a comment: `Holds >= 1 branch_staff row. Only ever true for role 'player' — see <Nav>.`
- Replace the derived-values block (lines 57-59) with:

```tsx
  const isOwner = user.role === 'owner' || user.role === 'admin'
  // Owners can never have bookings, so "My bookings" would always be empty for
  // them and /bookings redirects them away anyway.
  const showBookings = !isOwner
  // Staff get the same dashboard, under a name that describes what they are
  // seeing: they do not own the venue, they work at it. Null means no
  // dashboard item at all — a plain player has no dashboard to go to, and an
  // item pointing somewhere that redirects straight back is worse than none.
  const dashboardLabel = isOwner ? 'Owner dashboard' : user.isStaff ? 'Venue dashboard' : null
  const label = user.fullName ?? user.email
  const initial = (user.fullName ?? user.email).charAt(0).toUpperCase()
```

- Replace the "My bookings" `<Link>` (lines 101-107) with:

```tsx
          {showBookings && (
            <Link
              href="/bookings"
              onClick={() => setOpen(false)}
              className={`mt-2 block rounded-[10px] px-3 py-2.5 text-[13.5px] font-medium text-[var(--ink)] ${FOCUS_RING} hover:bg-[var(--surface)]`}
            >
              My bookings
            </Link>
          )}
```

- Replace the `{isOwner && (…)}` dashboard `<Link>` (lines 109-117) with:

```tsx
          {dashboardLabel && (
            <Link
              href="/dashboard"
              onClick={() => setOpen(false)}
              className={`${showBookings ? '' : 'mt-2 '}block rounded-[10px] px-3 py-2.5 text-[13.5px] font-medium text-[var(--ink)] ${FOCUS_RING} hover:bg-[var(--surface)]`}
            >
              {dashboardLabel}
            </Link>
          )}
```

  (the conditional `mt-2` keeps the first item's spacing correct when "My bookings" is absent).

- Hoist the focus-ring string, which is currently repeated verbatim three times in this file, to a module constant above the component and use it on both links and the sign-out button:

```tsx
// One definition instead of the three identical copies this file carried.
// Branded focus-visible ring on every interactive element — Global Constraints.
const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'
```

  The trigger button keeps its own inline ring, because its color flips between `--ball` and `--court` with `onDark`.

- Update the component docstring: note that item visibility is now role-derived (owners lose "My bookings", staff gain "Venue dashboard"), and that `isStaff` is resolved server-side in `<Nav>` because a client component cannot query the database.

- [ ] **Step 8: Typecheck, lint, full suite**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: no type errors. If `tsc` flags a missing `canBook`, an `AvailabilityGrid` call site was missed — `src/app/venues/[slug]/page.tsx` is the only one. Lint reports only the pre-existing warnings; all tests pass.

- [ ] **Step 9: Verify the signed-out paths in the browser**

Start the dev server with `preview_start` (config `oncourt-dev`, already in `.claude/launch.json`), then confirm:
- `/venues/smash-zone-marikina` renders the grid with the normal "Select open slots…" summary bar (signed out ⇒ `canBook` true).
- `/bookings` → redirects to `/login?next=%2Fbookings`.
- `/dashboard` → redirects to `/login?next=%2Fdashboard`.
- No console errors (`read_console_messages`, errors only).

The signed-in owner/staff paths need a real session and are covered in Task 12.

- [ ] **Step 10: Commit**

```bash
git add "src/app/venues/[slug]/actions.ts" "src/app/venues/[slug]/page.tsx" src/components/availability-grid.tsx src/app/bookings/page.tsx "src/app/bookings/[id]/page.tsx" src/components/site/nav.tsx src/components/site/account-menu.tsx
git commit -m "Stop owners booking courts: guard the hold, gate the CTA, redirect /bookings, and make the account menu role-aware"
```

---

### Task 8: Creating and deleting blocks

**Files:**
- Create: `src/lib/db/sql-state.ts`
- Modify: `src/lib/booking/hold.ts` (import the extracted `sqlStateOf`, delete the local copy)
- Modify: `src/lib/bookings/review-write.ts` (use `sqlStateOf` instead of its own `.cause` unwrap)
- Create: `src/lib/blocks/write.ts`
- Create: `src/app/dashboard/blocks/actions.ts`
- Create: `tests/blocks/write.test.ts`

**Interfaces:**
- Produces, from `src/lib/db/sql-state.ts` (pure, no `server-only` — it inspects an error object and touches nothing):

```ts
export function sqlStateOf(error: unknown): string | undefined
export const PG_UNIQUE_VIOLATION = '23505'
export const PG_CHECK_VIOLATION = '23514'
export const PG_EXCLUSION_VIOLATION = '23P01'
export const PG_DEADLOCK_DETECTED = '40P01'
```
- Produces, from `src/lib/blocks/write.ts`:

```ts
export type BlockFormInput = {
  courtId: string
  /** Calendar date in Asia/Manila, `YYYY-MM-DD`. */
  date: string
  startHour: number
  endHour: number
  note: string | null
}
export function parseBlockInput(formData: FormData): BlockFormInput | null
export function parseBlockId(formData: FormData): string | null
export async function branchIdOfCourt(courtId: string): Promise<string | null>
export async function branchIdOfBlock(blockId: string): Promise<string | null>
export type CreateBlockResult =
  | { ok: true; blockId: string }
  | { ok: false; reason: 'slot_taken' | 'court_unavailable' | 'invalid_input' }
export async function createBlock(
  input: BlockFormInput & { branchId: string; createdBy: string },
): Promise<CreateBlockResult>
export type DeleteBlockResult = { ok: true } | { ok: false; reason: 'not_found' }
export async function deleteBlock(blockId: string): Promise<DeleteBlockResult>
```
- Produces, from `src/app/dashboard/blocks/actions.ts`:

```ts
export type BlockFormState = { ok: true } | { error: string } | null
export async function createBlockAction(
  prevState: BlockFormState,
  formData: FormData,
): Promise<BlockFormState>
export async function deleteBlockAction(
  prevState: BlockFormState,
  formData: FormData,
): Promise<BlockFormState>
```
- Consumes: `requireBranchAccess`, `AuthError` (`src/lib/auth/guards.ts`); `isValidCalendarDate` (`src/lib/date-manila.ts`); `revalidatePath`.

**The branch id is never taken from the form.** Both actions read the target's `branch_id` out of the database first (`branchIdOfCourt` / `branchIdOfBlock`) and then call `requireBranchAccess` on *that*. A submitted `branchId` would be a value the attacker chooses for the guard and a different value for the write — the classic confused-deputy shape. Reading it server-side removes the class entirely, which is why `createBlock` has no `invalid_branch` reason and `deleteBlock` takes only a `blockId`.

- [ ] **Step 1: Write the failing tests**

Create `tests/blocks/write.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  manilaHour,
  seedBlock,
  seedBooking,
  seedBranchWithCourts,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'
import {
  branchIdOfBlock,
  branchIdOfCourt,
  createBlock,
  deleteBlock,
  parseBlockId,
  parseBlockInput,
} from '@/lib/blocks/write'

afterAll(teardownFixtures)

const DATE = '2027-01-14'
const UUID = '11111111-2222-3333-4444-555555555555'

function form(entries: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.set(key, value)
  return data
}

test('parseBlockInput accepts a valid submission and trims the note', () => {
  expect(
    parseBlockInput(
      form({ courtId: UUID, date: DATE, startHour: '9', endHour: '11', note: '  Resurfacing  ' }),
    ),
  ).toEqual({ courtId: UUID, date: DATE, startHour: 9, endHour: 11, note: 'Resurfacing' })
})

test('parseBlockInput normalizes an empty or whitespace note to null', () => {
  // The DB coalesce treats a blank note as absent when labelling the cell;
  // storing '' and then rendering 'Blocked' would be two representations of
  // one state.
  for (const note of ['', '   ']) {
    expect(
      parseBlockInput(form({ courtId: UUID, date: DATE, startHour: '9', endHour: '10', note }))
        ?.note,
    ).toBeNull()
  }
})

test('parseBlockInput rejects a non-UUID court id', () => {
  // Without this the id reaches a ::uuid cast and Postgres raises 22P02, which
  // would escape as an unhandled exception rather than a form error.
  expect(
    parseBlockInput(form({ courtId: 'not-a-uuid', date: DATE, startHour: '9', endHour: '10' })),
  ).toBeNull()
})

test('parseBlockInput rejects a shape-valid but nonexistent calendar date', () => {
  // isValidCalendarDate's job: `2027-02-30` passes a YYYY-MM-DD regex and then
  // silently normalizes to March 2 inside Date parsing, landing the block on
  // the wrong day instead of erroring. Same rule createHoldAction applies.
  expect(
    parseBlockInput(form({ courtId: UUID, date: '2027-02-30', startHour: '9', endHour: '10' })),
  ).toBeNull()
  expect(
    parseBlockInput(form({ courtId: UUID, date: 'tomorrow', startHour: '9', endHour: '10' })),
  ).toBeNull()
})

test('parseBlockInput rejects hour ranges the exclusion constraint could not represent', () => {
  // endHour <= startHour reaches tstzrange(start, end, '[)') reversed, which
  // Postgres rejects with 22000 — unrecognized by any catch below.
  const bad = [
    { startHour: '11', endHour: '9' },
    { startHour: '9', endHour: '9' },
    { startHour: '-1', endHour: '2' },
    { startHour: '9', endHour: '25' },
    { startHour: '9.5', endHour: '10' },
    { startHour: 'nine', endHour: 'ten' },
  ]
  for (const hours of bad) {
    expect(parseBlockInput(form({ courtId: UUID, date: DATE, ...hours }))).toBeNull()
  }
})

test('parseBlockInput rejects an over-long note', () => {
  expect(
    parseBlockInput(
      form({ courtId: UUID, date: DATE, startHour: '9', endHour: '10', note: 'x'.repeat(201) }),
    ),
  ).toBeNull()
})

test('parseBlockId accepts a UUID and rejects anything else', () => {
  expect(parseBlockId(form({ blockId: UUID }))).toBe(UUID)
  expect(parseBlockId(form({ blockId: 'nope' }))).toBeNull()
  expect(parseBlockId(new FormData())).toBeNull()
})

test('branchIdOfCourt returns the court\'s real branch, and null for a stranger id', async () => {
  // This is what makes the action's guard trustworthy: the branch it checks
  // access against comes from the database, never from the submitted form.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await expect(branchIdOfCourt(courtIds[0])).resolves.toBe(branchId)
  await expect(branchIdOfCourt(crypto.randomUUID())).resolves.toBeNull()
})

test('branchIdOfBlock resolves only blocked rows', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(2)
  const player = await seedPlayer()
  const blockId = await seedBlock({
    courtId: courtIds[0],
    branchId,
    createdBy: ownerId,
    startsAt: manilaHour(DATE, 12),
  })
  const bookingId = await seedBooking({
    courtId: courtIds[1],
    branchId,
    playerId: player,
    startsAt: manilaHour(DATE, 12),
    status: 'confirmed',
  })

  await expect(branchIdOfBlock(blockId)).resolves.toBe(branchId)
  // A paid booking is NOT a block, so the delete path can never reach one —
  // deleting a financial record is not what this feature does.
  await expect(branchIdOfBlock(bookingId)).resolves.toBeNull()
  await expect(branchIdOfBlock(crypto.randomUUID())).resolves.toBeNull()
})

test('createBlock writes a blocked row with zero money and a null snapshot', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)

  const result = await createBlock({
    courtId: courtIds[0],
    branchId,
    createdBy: ownerId,
    date: DATE,
    startHour: 13,
    endHour: 15,
    note: 'Resurfacing',
  })
  expect(result).toMatchObject({ ok: true })

  const rows = await db.execute(sql`
    select status::text as status, player_id, created_by, note, fee_config_snapshot,
      total_charged_centavos, owner_net_centavos, platform_fee_centavos,
      to_char(starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD HH24') as starts,
      to_char(ends_at   at time zone 'Asia/Manila', 'YYYY-MM-DD HH24') as ends
    from bookings where id = ${(result as { ok: true; blockId: string }).blockId}::uuid
  `)
  expect(rows.rows[0]).toMatchObject({
    status: 'blocked',
    player_id: null,
    created_by: ownerId,
    note: 'Resurfacing',
    fee_config_snapshot: null,
    total_charged_centavos: 0,
    owner_net_centavos: 0,
    platform_fee_centavos: 0,
    starts: `${DATE} 13`,
    ends: `${DATE} 15`,
  })
})

test('createBlock accepts a block outside the court\'s operating hours', async () => {
  // Deliberate: maintenance happens when the venue is shut. The fixtures open
  // at 11, so hour 8 is closed — and blocking it must still work, unlike a
  // paid hold, which createHold refuses with 'court_closed'.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)

  await expect(
    createBlock({
      courtId: courtIds[0],
      branchId,
      createdBy: ownerId,
      date: DATE,
      startHour: 8,
      endHour: 9,
      note: null,
    }),
  ).resolves.toMatchObject({ ok: true })
})

test('createBlock refuses a court that is not approved', async () => {
  // A block on a pending/suspended court would render nowhere: the grid and
  // getScheduleCourts both list approved courts only, so the row would be
  // invisible while still occupying the slot.
  const { branchId, ownerId } = await seedBranchWithCourts(1)
  const pending = await db.execute(sql`
    insert into courts (branch_id, name, environment, status)
    values (${branchId}::uuid, 'Court Pending', 'outdoor', 'pending')
    returning id
  `)

  await expect(
    createBlock({
      courtId: pending.rows[0].id as string,
      branchId,
      createdBy: ownerId,
      date: DATE,
      startHour: 16,
      endHour: 17,
      note: null,
    }),
  ).resolves.toEqual({ ok: false, reason: 'court_unavailable' })
})

test('createBlock reports slot_taken over an existing paid booking', async () => {
  // 23P01 from bookings_no_overlap, translated. The constraint is the
  // authority — no check-then-insert race.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: manilaHour(DATE, 18),
    hours: 2,
    status: 'confirmed',
  })

  await expect(
    createBlock({
      courtId: courtIds[0],
      branchId,
      createdBy: ownerId,
      date: DATE,
      startHour: 19,
      endHour: 21,
      note: null,
    }),
  ).resolves.toEqual({ ok: false, reason: 'slot_taken' })
})

test('createBlock reports slot_taken over an existing block', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  await seedBlock({
    courtId: courtIds[0],
    branchId,
    createdBy: ownerId,
    startsAt: manilaHour(DATE, 21),
    hours: 2,
  })

  await expect(
    createBlock({
      courtId: courtIds[0],
      branchId,
      createdBy: ownerId,
      date: DATE,
      startHour: 22,
      endHour: 23,
      note: null,
    }),
  ).resolves.toEqual({ ok: false, reason: 'slot_taken' })
})

test('createBlock succeeds over an expired-but-unswept hold', async () => {
  // The exclusion constraint's predicate cannot call now() (index predicates
  // must be immutable), so a dead hold still blocks the slot until something
  // sweeps it. createHold sweeps inside its own transaction for exactly this
  // reason; createBlock must too, or an owner cannot reclaim a slot whose
  // checkout was abandoned until the once-a-minute cron catches up.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const holdId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: manilaHour(DATE, 9),
    status: 'pending_payment',
  })
  await db.execute(
    sql`update bookings set expires_at = now() - interval '1 minute' where id = ${holdId}::uuid`,
  )

  await expect(
    createBlock({
      courtId: courtIds[0],
      branchId,
      createdBy: ownerId,
      date: DATE,
      startHour: 9,
      endHour: 10,
      note: null,
    }),
  ).resolves.toMatchObject({ ok: true })

  const hold = await db.execute(
    sql`select status::text as status from bookings where id = ${holdId}::uuid`,
  )
  expect(hold.rows[0].status).toBe('expired')
})

test('createBlock reports slot_taken over a LIVE hold', async () => {
  // The other side of the sweep: a checkout genuinely in progress must not be
  // stolen out from under the player.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: manilaHour(DATE, 10),
    status: 'pending_payment',
  })

  await expect(
    createBlock({
      courtId: courtIds[0],
      branchId,
      createdBy: ownerId,
      date: DATE,
      startHour: 10,
      endHour: 11,
      note: null,
    }),
  ).resolves.toEqual({ ok: false, reason: 'slot_taken' })
})

test('createBlock reports invalid_input for an unparseable date or hour', async () => {
  // createBlock promises a CreateBlockResult, never a throw, for anything a
  // caller can pass. parseBlockInput catches these first in production; this
  // pins the library's own contract.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)

  await expect(
    createBlock({
      courtId: courtIds[0],
      branchId,
      createdBy: ownerId,
      date: 'not-a-date',
      startHour: 9,
      endHour: 10,
      note: null,
    }),
  ).resolves.toEqual({ ok: false, reason: 'invalid_input' })
})

test('deleteBlock frees the slot and lets the same hours be booked', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const blockId = await seedBlock({
    courtId: courtIds[0],
    branchId,
    createdBy: ownerId,
    startsAt: manilaHour(DATE, 11),
  })

  await expect(deleteBlock(blockId)).resolves.toEqual({ ok: true })

  // The slot is genuinely free: the exclusion constraint accepts a booking on
  // the same hours, which a surviving block would refuse with 23P01.
  await expect(
    seedBooking({
      courtId: courtIds[0],
      branchId,
      playerId: player,
      startsAt: manilaHour(DATE, 11),
      status: 'confirmed',
    }),
  ).resolves.toBeTypeOf('string')
})

test('deleteBlock reports not_found for an unknown id and refuses a paid booking', async () => {
  // The status filter in the WHERE clause is the guarantee, not a prior read:
  // the parent spec's "no DELETE on bookings" hardening note is carved out for
  // `blocked` rows only, and a paid booking is a financial record.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: manilaHour(DATE, 20),
    status: 'confirmed',
  })

  await expect(deleteBlock(crypto.randomUUID())).resolves.toEqual({
    ok: false,
    reason: 'not_found',
  })
  await expect(deleteBlock(bookingId)).resolves.toEqual({ ok: false, reason: 'not_found' })

  const still = await db.execute(sql`select 1 from bookings where id = ${bookingId}::uuid`)
  expect(still.rows).toHaveLength(1)
})

test('deleting the same block twice is reported, not thrown', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const blockId = await seedBlock({
    courtId: courtIds[0],
    branchId,
    createdBy: ownerId,
    startsAt: manilaHour(DATE, 22),
  })

  await expect(deleteBlock(blockId)).resolves.toEqual({ ok: true })
  await expect(deleteBlock(blockId)).resolves.toEqual({ ok: false, reason: 'not_found' })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run tests/blocks/write.test.ts
```

Expected: FAIL — cannot resolve `@/lib/blocks/write`.

- [ ] **Step 3: Extract `sqlStateOf` into its own module**

`src/lib/db/sql-state.ts`:

```ts
/**
 * SQLSTATE of a failed query, wherever the driver left it.
 *
 * drizzle-orm 0.45.2's `db.execute`/`tx.execute` wrap the driver error in
 * `DrizzleQueryError` and only expose the original `pg` error as `.cause` (see
 * node_modules/drizzle-orm/pg-core/session.js) — so the code lives at
 * `.cause.code`, not `.code`, for anything raised through drizzle. Checking
 * both keeps this robust either way, including for the raw `pg.Client` some
 * tests use.
 *
 * Extracted from src/lib/booking/hold.ts, which had it as a private function,
 * when src/lib/blocks/write.ts needed the same thing;
 * src/lib/bookings/review-write.ts had a third, hand-rolled copy of the same
 * `.cause` unwrap. One definition, three callers.
 *
 * Not `server-only`: it inspects a plain object and touches nothing.
 */
export function sqlStateOf(error: unknown): string | undefined {
  const withCause = error as { cause?: { code?: string }; code?: string }
  return withCause?.cause?.code ?? withCause?.code
}

export const PG_UNIQUE_VIOLATION = '23505'
export const PG_CHECK_VIOLATION = '23514'
export const PG_EXCLUSION_VIOLATION = '23P01'
/**
 * Two overlapping requests can form a genuine wait-for cycle the deadlock
 * detector has to break, so this is a second way "someone else took this slot"
 * arrives. Treated identically to 23P01 by every caller.
 */
export const PG_DEADLOCK_DETECTED = '40P01'
```

- [ ] **Step 4: Point `hold.ts` and `review-write.ts` at it**

In `src/lib/booking/hold.ts`: delete the local `PG_EXCLUSION_VIOLATION`/`PG_DEADLOCK_DETECTED` constants and the whole `sqlStateOf` function (lines 69-83), keeping the docstring's substance in the new module (it is already reproduced there). Add at the top:

```ts
import {
  PG_DEADLOCK_DETECTED,
  PG_EXCLUSION_VIOLATION,
  sqlStateOf,
} from '@/lib/db/sql-state'
```

The `catch` block at the end is unchanged — it already calls `sqlStateOf(error)` and compares against those two constants.

In `src/lib/bookings/review-write.ts`: replace the `catch` body's hand-rolled unwrap (lines 56-69) with:

```ts
  } catch (error) {
    // reviews.booking_id is UNIQUE; the constraint is the authority on
    // "one review per booking", so a duplicate is a normal outcome to report
    // rather than an exception to propagate.
    if (sqlStateOf(error) === PG_UNIQUE_VIOLATION) {
      return { ok: false, reason: 'already_reviewed' }
    }
    throw error
  }
```

and add `import { PG_UNIQUE_VIOLATION, sqlStateOf } from '@/lib/db/sql-state'`.

- [ ] **Step 5: Confirm the extraction broke nothing**

```bash
npx vitest run tests/booking/hold.test.ts tests/bookings/review-action.test.ts
```

Expected: PASS. These two suites cover every path that reads a SQLSTATE, so a mistake in the extraction shows up here rather than in production.

- [ ] **Step 6: Create `src/lib/blocks/write.ts`**

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { isValidCalendarDate } from '@/lib/date-manila'
import {
  PG_DEADLOCK_DETECTED,
  PG_EXCLUSION_VIOLATION,
  sqlStateOf,
} from '@/lib/db/sql-state'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * A note is a label on a grid cell ("Resurfacing", "Walk-in — Juan"), not a
 * description. Long enough for a real label, short enough that the cell and
 * the table row stay readable. Deliberately much shorter than a review body.
 */
const MAX_NOTE_LENGTH = 200

export type BlockFormInput = {
  courtId: string
  /** Calendar date in Asia/Manila, `YYYY-MM-DD`. */
  date: string
  startHour: number
  endHour: number
  note: string | null
}

/**
 * Validates the block form before any of it reaches SQL. Every rule here
 * corresponds to something that would otherwise raise and escape as an
 * unhandled exception:
 *   - a non-UUID courtId reaches a `::uuid` cast (22P02);
 *   - a shape-valid but nonexistent date like 2027-02-30 does NOT raise — it
 *     silently normalizes to March 2, landing the block on the wrong day, so
 *     isValidCalendarDate is the only thing that catches it (the same rule
 *     src/app/venues/[slug]/actions.ts applies to holds);
 *   - endHour <= startHour reaches `tstzrange(start, end, '[)')` reversed
 *     (22000, "range lower bound must be less than or equal to range upper
 *     bound").
 *
 * Hours run 0..24, not 0..23: a block ending at closing-time midnight has
 * endHour 24, which is a real Manila instant (see hold.ts's manilaInstant
 * docstring) and which court_operating_hours.closes_hour already permits.
 *
 * Exported for tests; src/app/dashboard/blocks/actions.ts is the only
 * production caller.
 */
export function parseBlockInput(formData: FormData): BlockFormInput | null {
  const courtId = String(formData.get('courtId') ?? '')
  const date = String(formData.get('date') ?? '')
  const startHour = Number(formData.get('startHour'))
  const endHour = Number(formData.get('endHour'))
  const rawNote = String(formData.get('note') ?? '').trim()

  if (!UUID_RE.test(courtId)) return null
  if (!isValidCalendarDate(date)) return null
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) return null
  if (startHour < 0 || endHour > 24 || endHour <= startHour) return null
  if (rawNote.length > MAX_NOTE_LENGTH) return null

  return { courtId, date, startHour, endHour, note: rawNote.length > 0 ? rawNote : null }
}

/** The delete form's only field. Shape-checked for the same 22P02 reason. */
export function parseBlockId(formData: FormData): string | null {
  const blockId = String(formData.get('blockId') ?? '')
  return UUID_RE.test(blockId) ? blockId : null
}

/**
 * The court's real branch, read from the database.
 *
 * This is what makes the action's guard trustworthy. If the form supplied a
 * branchId, an attacker would choose one value for requireBranchAccess and the
 * write would use another — a confused deputy. Reading it here means the guard
 * and the write always refer to the same branch, and it is why createBlock has
 * no `invalid_branch` failure reason at all.
 */
export async function branchIdOfCourt(courtId: string): Promise<string | null> {
  const result = await db.execute(sql`
    select branch_id from courts where id = ${courtId}::uuid
  `)
  return (result.rows[0]?.branch_id as string | undefined) ?? null
}

/**
 * The branch of a BLOCK, for the same reason as branchIdOfCourt.
 *
 * Filters `status = 'blocked'` here rather than in the delete: a caller that
 * passes a paid booking's id gets null and is refused before any guard runs,
 * so the delete path can never be pointed at a financial record. The parent
 * spec's "no DELETE on bookings" hardening note is carved out for `blocked`
 * rows only.
 */
export async function branchIdOfBlock(blockId: string): Promise<string | null> {
  const result = await db.execute(sql`
    select branch_id from bookings where id = ${blockId}::uuid and status = 'blocked'
  `)
  return (result.rows[0]?.branch_id as string | undefined) ?? null
}

export type CreateBlockResult =
  | { ok: true; blockId: string }
  | { ok: false; reason: 'slot_taken' | 'court_unavailable' | 'invalid_input' }

/** Manila is UTC+8 with no DST, so a fixed offset is correct and stable. */
function manilaInstant(date: string, hour: number): string | undefined {
  const instant = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+08:00`)
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString()
}

/**
 * Takes a slot off the market: a `bookings` row with status 'blocked', no
 * player, zero in every money column, and a null fee_config_snapshot. The
 * database enforces all four (bookings_player_unless_blocked,
 * bookings_blocked_is_free, bookings_blocked_has_creator,
 * bookings_snapshot_unless_blocked).
 *
 * `branchId` and `createdBy` come from the caller's guarded context, never from
 * a form — `branchId` from branchIdOfCourt above, `createdBy` from the session
 * requireBranchAccess just validated.
 *
 * DELIBERATE DIFFERENCES FROM createHold:
 *   - No operating-hours check. Maintenance happens when the venue is shut, so
 *     refusing a block outside opening hours would refuse the main use case.
 *     createHold's 'court_closed' has no analogue here.
 *   - No hold ceiling and no advisory lock. MAX_CONCURRENT_HOLDS protects
 *     against a player parking inventory they have not paid for; an owner
 *     blocking their own courts has nothing to abuse. The exclusion constraint
 *     is the only arbiter needed, and it needs no lock to be correct.
 *   - No pricing. There is no charge, and there is no cash bookkeeping for
 *     walk-ins in this product (see the spec's Out of scope).
 *
 * SAME AS createHold, and load-bearing: the stale-hold sweep. The exclusion
 * constraint's predicate cannot call now() (index predicates must be
 * immutable), so an expired-but-unswept hold still has status
 * 'pending_payment' and still blocks the slot. Sweeping the overlapping rows
 * inside this same transaction, before the insert, is what lets an owner
 * reclaim a slot whose checkout was abandoned without waiting for the
 * once-a-minute cron. Narrowed to overlapping rows so it never takes row locks
 * on bookings that have nothing to do with this request.
 */
export async function createBlock(
  input: BlockFormInput & { branchId: string; createdBy: string },
): Promise<CreateBlockResult> {
  const startsAt = manilaInstant(input.date, input.startHour)
  const endsAt = manilaInstant(input.date, input.endHour)
  // Checked explicitly rather than caught: this function promises a
  // CreateBlockResult, never a throw, for anything a caller can pass.
  if (startsAt === undefined || endsAt === undefined) {
    return { ok: false, reason: 'invalid_input' }
  }

  try {
    return await db.transaction(
      async (tx) => {
        // Approved only. A pending or suspended court has no column in the
        // grid and is not offered by getScheduleCourts, so a block on one
        // would occupy a slot while rendering nowhere — an invisible
        // unavailability nobody could later remove through the UI.
        const courtRows = await tx.execute(sql`
          select status from courts where id = ${input.courtId}::uuid
        `)
        const court = courtRows.rows[0]
        if (!court || court.status !== 'approved') {
          return { ok: false as const, reason: 'court_unavailable' as const }
        }

        await tx.execute(sql`
          update bookings set status = 'expired'
          where court_id = ${input.courtId}::uuid
            and status = 'pending_payment'
            and expires_at <= now()
            and slot && tstzrange(${startsAt}::timestamptz, ${endsAt}::timestamptz, '[)')
        `)

        const inserted = await tx.execute(sql`
          insert into bookings (
            court_id, branch_id, player_id, starts_at, ends_at, status,
            created_by, note,
            court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
            platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
            fee_config_snapshot
          ) values (
            ${input.courtId}::uuid, ${input.branchId}::uuid, null,
            ${startsAt}::timestamptz, ${endsAt}::timestamptz, 'blocked',
            ${input.createdBy}::uuid, ${input.note},
            0, 0, 0, 0, 0, 0, null::jsonb
          )
          returning id
        `)

        return { ok: true as const, blockId: inserted.rows[0].id as string }
      },
      // Pinned explicitly rather than inheriting default_transaction_isolation,
      // matching src/lib/booking/hold.ts: the sweep-then-insert sequence is
      // correct under READ COMMITTED because each statement takes its own
      // fresh snapshot.
      { isolationLevel: 'read committed' },
    )
  } catch (error) {
    const code = sqlStateOf(error)
    // 23P01: bookings_no_overlap refused the slot — a live hold, a booking, or
    // another block already has it. 40P01: two overlapping requests formed a
    // wait-for cycle the deadlock detector broke. Both mean "someone else has
    // this slot"; the loser may find it free on a retry, which is fail-safe
    // rather than maximally precise.
    if (code === PG_EXCLUSION_VIOLATION || code === PG_DEADLOCK_DETECTED) {
      return { ok: false, reason: 'slot_taken' }
    }
    throw error
  }
}

export type DeleteBlockResult = { ok: true } | { ok: false; reason: 'not_found' }

/**
 * Removes a block, freeing the slot.
 *
 * `status = 'blocked'` is in the WHERE clause, not checked beforehand: a
 * forged id belonging to a paid booking must delete nothing rather than be
 * rejected after a read, and a double-submit must report not_found rather than
 * race. Unlike a paid booking there is no audit-trail reason to keep a block
 * around, which is why this is a real DELETE (the parent spec's "no DELETE on
 * bookings" note is amended to carve out `blocked` rows).
 *
 * A block never has a review (reviews.booking_id references a completed,
 * player-owned booking), so no dependent row can block this delete.
 */
export async function deleteBlock(blockId: string): Promise<DeleteBlockResult> {
  const result = await db.execute(sql`
    delete from bookings where id = ${blockId}::uuid and status = 'blocked' returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'not_found' }
}
```

- [ ] **Step 7: Run the tests and confirm they pass**

```bash
npx vitest run tests/blocks/write.test.ts
```

Expected: PASS (19 tests).

- [ ] **Step 8: Run them a second time**

```bash
npx vitest run tests/blocks/write.test.ts
```

Expected: PASS again. Every insert hangs off a freshly seeded branch, so the fixed `DATE` and hours never collide across runs.

- [ ] **Step 9: Create the actions**

`src/app/dashboard/blocks/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { AuthError, requireBranchAccess } from '@/lib/auth/guards'
import {
  branchIdOfBlock,
  branchIdOfCourt,
  createBlock,
  deleteBlock,
  parseBlockId,
  parseBlockInput,
} from '@/lib/blocks/write'

/**
 * Blocks are created and removed from /dashboard/bookings.
 *
 * This file exports nothing but two async guarded actions, because every
 * export of a 'use server' file becomes a client-invokable endpoint. The parse
 * rules and the SQL live in src/lib/blocks/write.ts (an `import 'server-only'`
 * module) and are unit-tested there — the same split as
 * src/lib/bookings/review-write.ts.
 *
 * Both actions take useActionState's (prevState, formData) shape. The previous
 * state is unused — each submission is judged on its own input — but the
 * parameter must exist for React to bind the action to the form's state, and
 * returning state is what lets the form render "that slot was just taken"
 * instead of appearing to do nothing.
 *
 * NEITHER ACTION TRUSTS A SUBMITTED branchId. Each resolves the target's real
 * branch from the database first and guards against that, so the branch the
 * permission check uses and the branch the write touches are always the same
 * one. requireBranchAccess(branchId, 'block_slots') then admits the branch's
 * owner, an admin, or a staff member holding block_slots on that branch.
 */
export type BlockFormState = { ok: true } | { error: string } | null

const NO_ACCESS = "You don't have permission to block slots at that branch."
const BAD_INPUT = "That block doesn't look right. Check the court, date, and hours and try again."

export async function createBlockAction(
  _prevState: BlockFormState,
  formData: FormData,
): Promise<BlockFormState> {
  const input = parseBlockInput(formData)
  if (!input) return { error: BAD_INPUT }

  const branchId = await branchIdOfCourt(input.courtId)
  // Same message as a parse failure: whether the court does not exist or the
  // id was forged, the caller learns only that the request was wrong. Telling
  // a stranger "that court exists but is not yours" would confirm the id.
  if (!branchId) return { error: BAD_INPUT }

  let user
  try {
    user = await requireBranchAccess(branchId, 'block_slots')
  } catch (error) {
    if (error instanceof AuthError) return { error: NO_ACCESS }
    throw error
  }

  const result = await createBlock({ ...input, branchId, createdBy: user.id })

  if (!result.ok) {
    return {
      error:
        result.reason === 'slot_taken'
          ? 'Those hours are already taken by a booking, a hold, or another block.'
          : result.reason === 'court_unavailable'
            ? 'That court is not approved yet, so it cannot be blocked.'
            : BAD_INPUT,
    }
  }

  // The block changes the owner day grid, the bookings list, the public
  // availability grid, and search's "open now" counts.
  revalidatePath('/dashboard')
  revalidatePath('/dashboard/bookings')
  revalidatePath('/venues', 'layout')
  return { ok: true }
}

export async function deleteBlockAction(
  _prevState: BlockFormState,
  formData: FormData,
): Promise<BlockFormState> {
  const blockId = parseBlockId(formData)
  if (!blockId) return { error: BAD_INPUT }

  // Resolves only `blocked` rows, so a forged id pointing at a paid booking
  // never reaches the guard, let alone the delete.
  const branchId = await branchIdOfBlock(blockId)
  if (!branchId) return { error: 'That block no longer exists.' }

  try {
    await requireBranchAccess(branchId, 'block_slots')
  } catch (error) {
    if (error instanceof AuthError) return { error: NO_ACCESS }
    throw error
  }

  const result = await deleteBlock(blockId)
  if (!result.ok) return { error: 'That block no longer exists.' }

  revalidatePath('/dashboard')
  revalidatePath('/dashboard/bookings')
  revalidatePath('/venues', 'layout')
  return { ok: true }
}
```

- [ ] **Step 10: Confirm the action-coverage contract**

```bash
npx vitest run tests/auth/action-coverage.test.ts
```

Expected: PASS — the file contains `requireBranchAccess`, which Task 4 added to `GUARDS`.

- [ ] **Step 11: Typecheck, lint, full suite**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: no type errors; only pre-existing lint warnings; all tests pass.

- [ ] **Step 12: Commit**

```bash
git add src/lib/db/sql-state.ts src/lib/booking/hold.ts src/lib/bookings/review-write.ts src/lib/blocks/write.ts src/app/dashboard/blocks/actions.ts tests/blocks/write.test.ts
git commit -m "Add block create/delete behind requireBranchAccess and share one sqlStateOf helper"
```

---

### Task 9: Block UI on `/dashboard/bookings`

**Files:**
- Create: `src/components/dashboard/block-form.tsx`
- Create: `src/components/dashboard/unblock-button.tsx`
- Modify: `src/app/dashboard/bookings/page.tsx` (render both; fetch courts)

**Interfaces:**
- Consumes: `createBlockAction`, `deleteBlockAction`, `BlockFormState` (`src/app/dashboard/blocks/actions.ts`); `getScheduleCourts`, `OwnerGridCourt` (`src/lib/owner/queries.ts`); `formatHour` (`src/lib/format.ts`).
- Produces:
  - `<BlockForm day={string} courts={OwnerGridCourt[]} />`
  - `<UnblockButton blockId={string} label={string} />`

**Where the controls live, and why not in the grid:** the day grid's cells are 30px tall — there is no room for a label and a control, and cramming one in would make every empty cell a button too. `/dashboard/bookings` already has the day navigation (so a future date can be blocked), the branch filter, and table rows with room for an action. So: the grid on `/dashboard` stays read-only and simply *shows* blocks (Task 6), and all blocking happens on `/dashboard/bookings`.

**Client components, and only these two:** a Server Component cannot render what a Server Action returns, so a rejected block ("those hours are already taken") would look like nothing happening. `useActionState` gives both returns a home. Same reasoning, same pattern as `src/app/bookings/review-form.tsx`. There is still no DOM test environment in this project (`vitest.config.ts` sets `environment: 'node'`; neither `jsdom` nor `@testing-library/react` is a dependency) — **do not add one here**, that is a toolchain decision outside this slice. These two components are verified in the browser in Task 12; write the labels and ARIA correctly the first time.

- [ ] **Step 1: Create the block form**

`src/components/dashboard/block-form.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { createBlockAction, type BlockFormState } from '@/app/dashboard/blocks/actions'
import { formatHour } from '@/lib/format'
import type { OwnerGridCourt } from '@/lib/owner/queries'

const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const FIELD =
  `h-[var(--btn-h-sm)] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2.5 text-[13px] text-[var(--ink)] ${FOCUS_RING}`

const LABEL = 'font-mono mb-1 block text-[10.5px] tracking-[.12em] text-[var(--ink-soft)] uppercase'

/**
 * Whole hours 0..24. The endHour list starts at 1 and includes 24, because a
 * block running to closing-time midnight legitimately ends at hour 24 — see
 * src/lib/booking/hold.ts's manilaInstant docstring, and
 * court_operating_hours.closes_hour, which the fixtures set to 24.
 *
 * The full 0..24 range is offered rather than the court's operating window on
 * purpose: maintenance happens when the venue is shut, and createBlock
 * deliberately does not apply an operating-hours check. The server still
 * rejects endHour <= startHour, so a nonsense pair is a form error, not a crash.
 */
const START_HOURS = Array.from({ length: 24 }, (_, i) => i)
const END_HOURS = Array.from({ length: 24 }, (_, i) => i + 1)

/**
 * Takes a slot off the market. Lives on /dashboard/bookings rather than beside
 * the overview's day grid: this page owns the day navigation, so a block can be
 * placed on any date, and a 30px grid cell has no room for a control.
 *
 * A client component because a Server Component cannot render what a Server
 * Action returns — a refused block ("those hours are already taken") would
 * otherwise look like nothing happening. On success the action revalidates
 * /dashboard/bookings, so the table below re-renders from the server with the
 * new row and no local success state is needed beyond the status line.
 *
 * `branchId` is deliberately NOT a field here: the action reads the court's
 * real branch from the database and guards against that, so there is nothing
 * for a forged branch id to confuse. Only `courtId` is submitted.
 */
export function BlockForm({ day, courts }: { day: string; courts: OwnerGridCourt[] }) {
  const [state, formAction, pending] = useActionState<BlockFormState, FormData>(
    createBlockAction,
    null,
  )

  if (courts.length === 0) {
    return (
      <p className="text-[13px] text-[var(--ink-soft)]">
        No approved courts yet — once a court is approved you can block time on it here.
      </p>
    )
  }

  // Group into optgroups so a multi-branch owner can tell two "Court 1"s apart.
  const branchNames = [...new Set(courts.map((court) => court.branchName))]

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      {/* The day comes from the page's own prev/next navigation, so the form
          carries it rather than duplicating a date picker that could disagree
          with the table underneath it. */}
      <input type="hidden" name="date" value={day} />

      <div className="min-w-[190px]">
        <label className={LABEL} htmlFor="block-court">
          Court
        </label>
        <select id="block-court" name="courtId" required className={`${FIELD} w-full`}>
          {branchNames.map((branchName) => (
            <optgroup key={branchName} label={branchName}>
              {courts
                .filter((court) => court.branchName === branchName)
                .map((court) => (
                  <option key={court.courtId} value={court.courtId}>
                    {court.courtName}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div>
        <label className={LABEL} htmlFor="block-start">
          From
        </label>
        <select id="block-start" name="startHour" defaultValue="7" className={FIELD}>
          {START_HOURS.map((hour) => (
            <option key={hour} value={hour}>
              {formatHour(hour)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={LABEL} htmlFor="block-end">
          To
        </label>
        <select id="block-end" name="endHour" defaultValue="8" className={FIELD}>
          {END_HOURS.map((hour) => (
            <option key={hour} value={hour}>
              {formatHour(hour)}
            </option>
          ))}
        </select>
      </div>

      <div className="min-w-[200px] flex-1">
        <label className={LABEL} htmlFor="block-note">
          Note (optional)
        </label>
        <input
          id="block-note"
          name="note"
          type="text"
          maxLength={200}
          placeholder="Resurfacing, walk-in, private game…"
          className={`${FIELD} w-full placeholder:text-[var(--ink-soft)]`}
        />
      </div>

      {/* The one lime button in this view — every other control on
          /dashboard/bookings is bordered/neutral, so branding.md's "never two
          lime buttons in one view" holds. The Unblock buttons in the table are
          deliberately bordered, not lime, for the same reason. */}
      <button
        type="submit"
        disabled={pending}
        className={`font-display inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-4 text-[13px] font-bold text-[var(--ball-ink)] transition-[filter] duration-150 hover:brightness-[1.06] disabled:opacity-60 motion-reduce:transition-none ${FOCUS_RING}`}
      >
        {pending ? 'Blocking…' : 'Block slot'}
      </button>

      {state && 'error' in state && (
        <p role="alert" className="w-full text-[12.5px] font-medium text-[var(--ink)]">
          {state.error}
        </p>
      )}
      {state && 'ok' in state && (
        <p role="status" className="w-full text-[12.5px] font-medium text-[var(--court)]">
          Slot blocked.
        </p>
      )}
    </form>
  )
}
```

- [ ] **Step 2: Create the unblock button**

`src/components/dashboard/unblock-button.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import { deleteBlockAction, type BlockFormState } from '@/app/dashboard/blocks/actions'

const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

/**
 * Frees a blocked slot. One instance per block row, so there are only ever as
 * many of these on a page as there are blocks that day.
 *
 * A client component for the same reason as BlockForm: the action can refuse
 * ("that block no longer exists" — someone else removed it, or the page is
 * stale) and a Server Component has nowhere to render that. On success the
 * action revalidates this route and the row disappears.
 *
 * Bordered, never lime: branding.md allows one lime button per view and the
 * block form's submit is it. Deliberately NOT a confirmation dialog — removing
 * a block is immediately reversible by blocking the slot again, and it destroys
 * no record anyone is owed (unlike a paid booking, which cannot be deleted at
 * all; see src/lib/blocks/write.ts's deleteBlock).
 *
 * `label` is the block's own label, folded into the accessible name so a screen
 * reader hears which of several Unblock buttons this is.
 */
export function UnblockButton({ blockId, label }: { blockId: string; label: string }) {
  const [state, formAction, pending] = useActionState<BlockFormState, FormData>(
    deleteBlockAction,
    null,
  )

  return (
    <form action={formAction}>
      <input type="hidden" name="blockId" value={blockId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Unblock ${label}`}
        className={`inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3 text-[12.5px] font-semibold whitespace-nowrap text-[var(--ink)] hover:border-[var(--court)] disabled:opacity-60 ${FOCUS_RING}`}
      >
        {pending ? 'Removing…' : 'Unblock'}
      </button>
      {state && 'error' in state && (
        <p role="alert" className="mt-1 text-[11.5px] font-medium text-[var(--ink)]">
          {state.error}
        </p>
      )}
    </form>
  )
}
```

- [ ] **Step 3: Render both on `/dashboard/bookings`**

In `src/app/dashboard/bookings/page.tsx`:

- Add the imports:

```tsx
import { BlockForm } from '@/components/dashboard/block-form'
import { UnblockButton } from '@/components/dashboard/unblock-button'
import { getOwnerBookings, getScheduleCourts } from '@/lib/owner/queries'
```

- Fetch the courts alongside the rows. Replace the `const rows = await getOwnerBookings(…)` call (added in Task 6) with:

```tsx
  const branchIds = branches.map((branch) => branch.id)
  // Courts are only needed when the viewer can actually block; skipping the
  // query otherwise keeps a view-only staff member's page at one round trip.
  const [rows, courts] = await Promise.all([
    getOwnerBookings(branchIds, { day, branchId }),
    access.can.block_slots ? getScheduleCourts(branchIds) : Promise.resolve([]),
  ])
```

- Insert the block panel between the filter row and the table (immediately before `{rows.length > 0 ? (`):

```tsx
      {access.can.block_slots && (
        <section
          aria-label="Block a slot"
          className="mb-6 rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
        >
          <h2 className="font-display mb-1 text-[15px] font-bold tracking-[-0.01em] text-[var(--ink)]">
            Block a slot
          </h2>
          <p className="mb-4 text-[13px] text-[var(--ink-soft)]">
            Takes court time off the market on {formatDateLabel(day)} — for maintenance, a walk-in,
            or your own game. No payment, and it never counts towards earnings.
          </p>
          <BlockForm day={day} courts={courts} />
        </section>
      )}
```

- Add an actions column to the table. In `<thead>`, after the `Your net` header:

```tsx
                <th className="py-3 pr-5 text-right font-normal">
                  <span className="sr-only">Actions</span>
                </th>
```

  and in each row, after the `Your net` cell:

```tsx
                  <td className="py-4 pr-5 text-right">
                    {/* Only blocks are removable, and only by someone holding
                        block_slots. A paid booking has no delete at all — it is
                        a financial record, and deleteBlock's WHERE clause
                        refuses one even if this cell were forged. */}
                    {row.isBlock && access.can.block_slots && (
                      <UnblockButton blockId={row.bookingId} label={row.label} />
                    )}
                  </td>
```

- Bump the table's `min-w-[720px]` to `min-w-[820px]` so the extra column does not squeeze the others; the wrapper's `overflow-x-auto` keeps the page itself from scrolling sideways, per branding.md's mobile rule.

- Change the empty state so it does not read as "nothing to do here" when a block form is right above it:

```tsx
        <p className={EMPTY_PANEL}>No bookings or blocks on this day.</p>
```

- [ ] **Step 4: Typecheck and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors; only the pre-existing warnings.

- [ ] **Step 5: Confirm nothing regressed**

```bash
npm test
```

Expected: PASS. No test renders these components (there is no DOM environment), so this is a regression check on the query and action modules they consume.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/block-form.tsx src/components/dashboard/unblock-button.tsx src/app/dashboard/bookings/page.tsx
git commit -m "Add block and unblock controls to the dashboard bookings page"
```

---

### Task 10: Staff grants and the promote-to-owner rule

**Files:**
- Create: `src/lib/staff/write.ts`
- Create: `src/lib/staff/queries.ts`
- Create: `tests/staff/write.test.ts`

**Interfaces:**
- Produces, from `src/lib/staff/write.ts`:

```ts
export type StaffTarget = { email: string }
export function parseStaffEmail(formData: FormData): string | null
export function parseStaffId(formData: FormData): string | null

export type AddStaffResult =
  | { ok: true; staffId: string }
  | { ok: false; reason: 'no_such_user' | 'not_a_player' | 'already_staff' | 'no_permission_selected' }
export async function addBranchStaff(input: {
  branchId: string
  email: string
  permissions: StaffPermissions
}): Promise<AddStaffResult>

export type UpdateStaffResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'no_permission_selected' }
export async function updateBranchStaff(input: {
  staffId: string
  branchId: string
  permissions: StaffPermissions
}): Promise<UpdateStaffResult>

export type RevokeStaffResult = { ok: true } | { ok: false; reason: 'not_found' }
export async function revokeBranchStaff(input: {
  staffId: string
  branchId: string
}): Promise<RevokeStaffResult>

export type PromoteResult =
  | { ok: true; revokedGrants: number }
  | { ok: false; reason: 'no_such_user' | 'already_owner' | 'slug_taken' | 'invalid_input' }
export async function promoteToOwner(input: {
  userId: string
  businessName: string
  slug: string
}): Promise<PromoteResult>
```
- Produces, from `src/lib/staff/queries.ts`:

```ts
export type BranchStaffRow = {
  staffId: string
  userId: string
  email: string
  fullName: string | null
  permissions: StaffPermissions
  /** Manila calendar date, `YYYY-MM-DD` — feed straight to formatDateLabel(). */
  createdAt: string
}
export type BranchStaffGroup = { branchId: string; branchName: string; staff: BranchStaffRow[] }
export async function getBranchStaffForOwner(ownerId: string): Promise<BranchStaffGroup[]>
```
- Consumes: `StaffPermissions`, `STAFF_PERMISSIONS`, `hasAnyPermission`, `noPermissions` (`src/lib/staff/permissions.ts`); `sqlStateOf`, `PG_UNIQUE_VIOLATION` (`src/lib/db/sql-state.ts`).

**`promoteToOwner` has no UI in this slice, and that is intentional — do not delete it as dead code.** The spec puts the admin vetting screen in the admin-panel slice but requires the *rule* and its grant-revocation side effect to be pinned by a test here, because that side effect is the thing keeping "a user is never simultaneously an owner and someone's staff" true. The test in this task is its only caller for now.

**Email matching:** the spec says "existing accounts only, by exact `profiles.email`". "Exact" means the whole address — not a prefix, substring, or fuzzy search, so no staff directory can be enumerated by typing letters. It is compared case-insensitively (`lower(...) = lower(...)`), because Google returns lowercase addresses while a person typing a colleague's address types whatever they type, and refusing `Juan@Example.com` for a stored `juan@example.com` would be a bug, not security.

- [ ] **Step 1: Write the failing tests**

Create `tests/staff/write.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  seedBranchWithCourts,
  seedOwner,
  seedPlayer,
  seedStaffGrant,
  teardownFixtures,
} from '../helpers/fixtures'
import { allPermissions, noPermissions } from '@/lib/staff/permissions'
import {
  addBranchStaff,
  parseStaffEmail,
  parseStaffId,
  promoteToOwner,
  revokeBranchStaff,
  updateBranchStaff,
} from '@/lib/staff/write'
import { getBranchStaffForOwner } from '@/lib/staff/queries'

afterAll(teardownFixtures)

const UUID = '11111111-2222-3333-4444-555555555555'

function form(entries: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.set(key, value)
  return data
}

async function emailOf(userId: string): Promise<string> {
  const result = await db.execute(sql`select email from profiles where id = ${userId}::uuid`)
  return result.rows[0].email as string
}

test('parseStaffEmail trims, and rejects blanks and non-addresses', () => {
  expect(parseStaffEmail(form({ email: '  Juan@Example.com  ' }))).toBe('Juan@Example.com')
  expect(parseStaffEmail(form({ email: '' }))).toBeNull()
  expect(parseStaffEmail(form({ email: '   ' }))).toBeNull()
  expect(parseStaffEmail(form({ email: 'not-an-email' }))).toBeNull()
  expect(parseStaffEmail(new FormData())).toBeNull()
})

test('parseStaffId accepts a UUID and rejects anything else', () => {
  expect(parseStaffId(form({ staffId: UUID }))).toBe(UUID)
  expect(parseStaffId(form({ staffId: 'nope' }))).toBeNull()
})

test('addBranchStaff grants an existing player the requested permissions', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()

  const result = await addBranchStaff({
    branchId,
    email: await emailOf(staffId),
    permissions: { ...noPermissions(), view_bookings: true, block_slots: true },
  })
  expect(result).toMatchObject({ ok: true })

  const rows = await db.execute(sql`
    select user_id, view_bookings, block_slots, manage_courts, view_earnings
    from branch_staff where branch_id = ${branchId}::uuid
  `)
  expect(rows.rows[0]).toMatchObject({
    user_id: staffId,
    view_bookings: true,
    block_slots: true,
    manage_courts: false,
    view_earnings: false,
  })
})

test('addBranchStaff matches the email case-insensitively', async () => {
  // Google returns lowercase; a person typing a colleague's address types
  // whatever they type. Refusing a case mismatch would be a bug, not security —
  // and it is still an EXACT whole-address match, never a prefix or search.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const email = await emailOf(staffId)

  await expect(
    addBranchStaff({
      branchId,
      email: email.toUpperCase(),
      permissions: { ...noPermissions(), view_bookings: true },
    }),
  ).resolves.toMatchObject({ ok: true })
})

test('addBranchStaff refuses an email with no account', async () => {
  // No pending-invite state exists (spec's Out of scope): the person must sign
  // in once first, which is what creates their profile row.
  const { branchId } = await seedBranchWithCourts(1)

  await expect(
    addBranchStaff({
      branchId,
      email: `ghost-${crypto.randomUUID()}@example.test`,
      permissions: { ...noPermissions(), view_bookings: true },
    }),
  ).resolves.toEqual({ ok: false, reason: 'no_such_user' })
})

test('addBranchStaff refuses an owner and an admin as a target', async () => {
  // Roles are exclusive: an owner is a business account and can never be
  // someone else's staff. There is deliberately no DB constraint for this —
  // a role can change later, and promoteToOwner owns that edge — so this
  // TypeScript check is the enforcement.
  const { branchId } = await seedBranchWithCourts(1)
  const ownerTarget = await seedOwner()
  const adminTarget = await seedPlayer()
  await db.execute(sql`update profiles set role = 'admin' where id = ${adminTarget}::uuid`)

  for (const target of [ownerTarget, adminTarget]) {
    await expect(
      addBranchStaff({
        branchId,
        email: await emailOf(target),
        permissions: { ...noPermissions(), view_bookings: true },
      }),
    ).resolves.toEqual({ ok: false, reason: 'not_a_player' })
  }
})

test('addBranchStaff refuses an all-false permission set before touching SQL', async () => {
  // branch_staff_some_permission would raise 23514; catching it here turns a
  // crash into a form error, and keeps "revoke" a DELETE rather than an
  // all-false UPDATE.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()

  await expect(
    addBranchStaff({ branchId, email: await emailOf(staffId), permissions: noPermissions() }),
  ).resolves.toEqual({ ok: false, reason: 'no_permission_selected' })

  const rows = await db.execute(sql`select 1 from branch_staff where user_id = ${staffId}::uuid`)
  expect(rows.rows).toHaveLength(0)
})

test('addBranchStaff reports already_staff on a second grant for the same branch', async () => {
  // branch_staff_unique is the authority; the code translates 23505 rather
  // than racing a check-then-insert.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const email = await emailOf(staffId)

  await addBranchStaff({
    branchId,
    email,
    permissions: { ...noPermissions(), view_bookings: true },
  })
  await expect(
    addBranchStaff({ branchId, email, permissions: { ...noPermissions(), view_earnings: true } }),
  ).resolves.toEqual({ ok: false, reason: 'already_staff' })
})

test('addBranchStaff allows the same person on a second branch', async () => {
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const email = await emailOf(staffId)

  await addBranchStaff({
    branchId: first.branchId,
    email,
    permissions: { ...noPermissions(), view_bookings: true },
  })
  await expect(
    addBranchStaff({
      branchId: second.branchId,
      email,
      permissions: { ...noPermissions(), manage_courts: true },
    }),
  ).resolves.toMatchObject({ ok: true })
})

test('addBranchStaff works again after a revoke', async () => {
  // Explicitly in the spec's Testing list: revoking is a DELETE, so re-adding
  // must not trip the unique constraint on a soft-deleted leftover.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const email = await emailOf(staffId)

  const added = await addBranchStaff({
    branchId,
    email,
    permissions: { ...noPermissions(), view_bookings: true },
  })
  await revokeBranchStaff({
    staffId: (added as { ok: true; staffId: string }).staffId,
    branchId,
  })
  await expect(
    addBranchStaff({ branchId, email, permissions: { ...noPermissions(), block_slots: true } }),
  ).resolves.toMatchObject({ ok: true })
})

test('updateBranchStaff replaces the whole permission set', async () => {
  // Not a merge: the edit form always submits all four checkboxes, because an
  // unchecked box submits nothing and a partial update would silently keep
  // permissions the owner just cleared.
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const grantId = await seedStaffGrant({ branchId, userId: staffId, viewBookings: true })

  await expect(
    updateBranchStaff({
      staffId: grantId,
      branchId,
      permissions: { ...noPermissions(), view_earnings: true, manage_courts: true },
    }),
  ).resolves.toEqual({ ok: true })

  const rows = await db.execute(sql`
    select view_bookings, block_slots, manage_courts, view_earnings
    from branch_staff where id = ${grantId}::uuid
  `)
  expect(rows.rows[0]).toEqual({
    view_bookings: false,
    block_slots: false,
    manage_courts: true,
    view_earnings: true,
  })
})

test('updateBranchStaff refuses an all-false set and leaves the row intact', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const grantId = await seedStaffGrant({ branchId, userId: staffId, viewBookings: true })

  await expect(
    updateBranchStaff({ staffId: grantId, branchId, permissions: noPermissions() }),
  ).resolves.toEqual({ ok: false, reason: 'no_permission_selected' })

  const rows = await db.execute(
    sql`select view_bookings from branch_staff where id = ${grantId}::uuid`,
  )
  expect(rows.rows[0].view_bookings).toBe(true)
})

test('updateBranchStaff cannot reach a grant on a different branch', async () => {
  // branchId is in the WHERE clause, not compared after a read. The action
  // guards requireOwnerOf(branchId) on a submitted branchId, so an owner
  // passing their OWN branch id with someone else's staffId must write nothing.
  const mine = await seedBranchWithCourts(1)
  const theirs = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const theirGrant = await seedStaffGrant({
    branchId: theirs.branchId,
    userId: staffId,
    viewBookings: true,
  })

  await expect(
    updateBranchStaff({
      staffId: theirGrant,
      branchId: mine.branchId,
      permissions: allPermissions(),
    }),
  ).resolves.toEqual({ ok: false, reason: 'not_found' })

  const rows = await db.execute(
    sql`select view_earnings from branch_staff where id = ${theirGrant}::uuid`,
  )
  expect(rows.rows[0].view_earnings).toBe(false)
})

test('revokeBranchStaff deletes the grant and is idempotent', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const grantId = await seedStaffGrant({ branchId, userId: staffId, blockSlots: true })

  await expect(revokeBranchStaff({ staffId: grantId, branchId })).resolves.toEqual({ ok: true })
  await expect(revokeBranchStaff({ staffId: grantId, branchId })).resolves.toEqual({
    ok: false,
    reason: 'not_found',
  })
})

test('revokeBranchStaff cannot reach a grant on a different branch', async () => {
  const mine = await seedBranchWithCourts(1)
  const theirs = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  const theirGrant = await seedStaffGrant({
    branchId: theirs.branchId,
    userId: staffId,
    viewBookings: true,
  })

  await expect(
    revokeBranchStaff({ staffId: theirGrant, branchId: mine.branchId }),
  ).resolves.toEqual({ ok: false, reason: 'not_found' })

  const rows = await db.execute(sql`select 1 from branch_staff where id = ${theirGrant}::uuid`)
  expect(rows.rows).toHaveLength(1)
})

test('promoting a staffed player to owner deletes every grant they held', async () => {
  // THE rule this task exists to pin. A user is never simultaneously an owner
  // and someone's staff, and this side effect is what keeps that true. The
  // admin screen that will call this is out of scope for this slice.
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  const userId = await seedPlayer()
  await seedStaffGrant({ branchId: first.branchId, userId, viewBookings: true })
  await seedStaffGrant({ branchId: second.branchId, userId, blockSlots: true })

  const slug = 'promoted-' + crypto.randomUUID()
  await expect(
    promoteToOwner({ userId, businessName: 'Promoted Courts', slug }),
  ).resolves.toEqual({ ok: true, revokedGrants: 2 })

  const profile = await db.execute(sql`
    select role::text as role, business_name, slug from profiles where id = ${userId}::uuid
  `)
  expect(profile.rows[0]).toEqual({
    role: 'owner',
    business_name: 'Promoted Courts',
    slug,
  })

  const grants = await db.execute(sql`select 1 from branch_staff where user_id = ${userId}::uuid`)
  expect(grants.rows).toHaveLength(0)
})

test('promoting an unstaffed player reports zero revoked grants', async () => {
  const userId = await seedPlayer()

  await expect(
    promoteToOwner({
      userId,
      businessName: 'Clean Slate Courts',
      slug: 'clean-' + crypto.randomUUID(),
    }),
  ).resolves.toEqual({ ok: true, revokedGrants: 0 })
})

test('promoteToOwner refuses an existing owner, an admin, and an unknown user', async () => {
  // Never demotes and never re-flips: an admin passing through this path would
  // silently lose their admin role, and re-promoting an owner would overwrite
  // business_name/slug they may have edited.
  const ownerId = await seedOwner()
  await expect(
    promoteToOwner({ userId: ownerId, businessName: 'X', slug: 'x-' + crypto.randomUUID() }),
  ).resolves.toEqual({ ok: false, reason: 'already_owner' })

  const adminId = await seedPlayer()
  await db.execute(sql`update profiles set role = 'admin' where id = ${adminId}::uuid`)
  await expect(
    promoteToOwner({ userId: adminId, businessName: 'X', slug: 'x-' + crypto.randomUUID() }),
  ).resolves.toEqual({ ok: false, reason: 'already_owner' })

  await expect(
    promoteToOwner({
      userId: crypto.randomUUID(),
      businessName: 'X',
      slug: 'x-' + crypto.randomUUID(),
    }),
  ).resolves.toEqual({ ok: false, reason: 'no_such_user' })
})

test('promoteToOwner reports a taken slug instead of throwing, and changes nothing', async () => {
  // profiles.slug is UNIQUE and appears in /owners/<slug> URLs.
  const existing = await seedOwner()
  const slug = 'taken-' + crypto.randomUUID()
  await db.execute(sql`update profiles set slug = ${slug} where id = ${existing}::uuid`)

  const userId = await seedPlayer()
  await expect(
    promoteToOwner({ userId, businessName: 'Colliding Courts', slug }),
  ).resolves.toEqual({ ok: false, reason: 'slug_taken' })

  const profile = await db.execute(sql`select role::text as role from profiles where id = ${userId}::uuid`)
  expect(profile.rows[0].role).toBe('player')
})

test('promoteToOwner rejects a blank business name or a malformed slug', async () => {
  const userId = await seedPlayer()
  const bad = [
    { businessName: '   ', slug: 'fine-slug' },
    { businessName: 'Fine Name', slug: 'Has Spaces' },
    { businessName: 'Fine Name', slug: 'UPPERCASE' },
    { businessName: 'Fine Name', slug: '' },
  ]
  for (const input of bad) {
    await expect(promoteToOwner({ userId, ...input })).resolves.toEqual({
      ok: false,
      reason: 'invalid_input',
    })
  }
})

test('getBranchStaffForOwner groups grants by branch and lists every branch the owner has', async () => {
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  await db.execute(
    sql`update branches set owner_id = ${first.ownerId}::uuid where id = ${second.branchId}::uuid`,
  )
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: first.branchId, userId: staffId, viewBookings: true })

  const groups = await getBranchStaffForOwner(first.ownerId)
  const withStaff = groups.find((group) => group.branchId === first.branchId)!
  const without = groups.find((group) => group.branchId === second.branchId)!

  // A branch with no staff still gets a group: the page renders an "add staff"
  // form per branch, so a branch missing from this list would be unstaffable.
  expect(without.staff).toEqual([])
  expect(withStaff.staff).toHaveLength(1)
  expect(withStaff.staff[0]).toMatchObject({
    userId: staffId,
    permissions: {
      view_bookings: true,
      block_slots: false,
      manage_courts: false,
      view_earnings: false,
    },
  })
  expect(withStaff.staff[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

test('getBranchStaffForOwner never leaks another owner\'s branches or staff', async () => {
  const mine = await seedBranchWithCourts(1)
  const theirs = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: theirs.branchId, userId: staffId, viewBookings: true })

  const groups = await getBranchStaffForOwner(mine.ownerId)
  expect(groups.map((group) => group.branchId)).not.toContain(theirs.branchId)
  expect(groups.flatMap((group) => group.staff.map((row) => row.userId))).not.toContain(staffId)
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run tests/staff/write.test.ts
```

Expected: FAIL — cannot resolve `@/lib/staff/write`.

- [ ] **Step 3: Create `src/lib/staff/write.ts`**

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { PG_UNIQUE_VIOLATION, sqlStateOf } from '@/lib/db/sql-state'
import { hasAnyPermission, type StaffPermissions } from '@/lib/staff/permissions'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * Deliberately loose: one `@` with something either side and a dot in the
 * domain. The database is the real authority on whether an address exists —
 * addBranchStaff looks it up and refuses what it cannot find — so this only
 * has to reject input that is obviously not an address at all, and must not
 * reject the valid-but-unusual ones a stricter pattern would.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Matches the slug shape used everywhere else in this app (branches.slug, /owners/<slug>). */
const SLUG_RE = /^[a-z0-9-]+$/
const MAX_BUSINESS_NAME_LENGTH = 120

/**
 * Exported for tests; src/app/dashboard/staff/actions.ts is the only production
 * caller. Returns the address as typed (trimmed) rather than lowercased — the
 * lookup is case-insensitive in SQL, and echoing the typed value back in an
 * error message is friendlier than echoing a mangled one.
 */
export function parseStaffEmail(formData: FormData): string | null {
  const email = String(formData.get('email') ?? '').trim()
  return EMAIL_RE.test(email) ? email : null
}

/** Shape-checked because it reaches a `::uuid` cast (22P02 otherwise). */
export function parseStaffId(formData: FormData): string | null {
  const staffId = String(formData.get('staffId') ?? '')
  return UUID_RE.test(staffId) ? staffId : null
}

export type AddStaffResult =
  | { ok: true; staffId: string }
  | {
      ok: false
      reason: 'no_such_user' | 'not_a_player' | 'already_staff' | 'no_permission_selected'
    }

/**
 * Grants an existing player account staff access to one branch.
 *
 * "Existing accounts only, by exact email" — there is no pending-invite state
 * in this product (see the spec's Out of scope), so someone who has never
 * signed in cannot be staffed: the profiles row is created by the auth trigger,
 * not by this function.
 *
 * The email match is EXACT on the whole address — never a prefix, substring, or
 * search, so a staff directory cannot be enumerated by typing letters — and
 * case-insensitive, because Google returns lowercase addresses while the person
 * typing a colleague's address types whatever they type.
 *
 * `role = 'player'` is required: an owner is a business account and can never be
 * someone else's staff, and an admin is not staffable either. There is no DB
 * constraint for this on purpose (a role can change later) — promoteToOwner
 * below owns that edge by deleting the grants — so this check is the
 * enforcement, which is exactly the TypeScript-is-the-security-boundary design
 * this project uses everywhere.
 *
 * The lookup is a separate read from the insert rather than one INSERT ... SELECT
 * because the two failure modes must be told apart: "no account with that
 * address" and "that account is not a player" are different things for the
 * person filling in the form. There is no race worth guarding — branch_staff_unique
 * is the authority on duplicates and its 23505 is translated below.
 *
 * `branchId` comes from the caller's guarded context (requireOwnerOf), never
 * from unvalidated input.
 */
export async function addBranchStaff(input: {
  branchId: string
  email: string
  permissions: StaffPermissions
}): Promise<AddStaffResult> {
  // Checked before any SQL: branch_staff_some_permission would raise 23514,
  // and this keeps "revoke" a DELETE rather than an all-false UPDATE.
  if (!hasAnyPermission(input.permissions)) return { ok: false, reason: 'no_permission_selected' }

  const profile = await db.execute(sql`
    select id, role from profiles where lower(email) = lower(${input.email})
  `)
  const target = profile.rows[0]
  if (!target) return { ok: false, reason: 'no_such_user' }
  if (target.role !== 'player') return { ok: false, reason: 'not_a_player' }

  try {
    const result = await db.execute(sql`
      insert into branch_staff (
        branch_id, user_id, view_bookings, block_slots, manage_courts, view_earnings
      ) values (
        ${input.branchId}::uuid, ${target.id as string}::uuid,
        ${input.permissions.view_bookings}, ${input.permissions.block_slots},
        ${input.permissions.manage_courts}, ${input.permissions.view_earnings}
      )
      returning id
    `)
    return { ok: true, staffId: result.rows[0].id as string }
  } catch (error) {
    // branch_staff_unique (branch_id, user_id) is the authority on "one row per
    // person per branch", so a duplicate is a normal outcome to report rather
    // than an exception to propagate.
    if (sqlStateOf(error) === PG_UNIQUE_VIOLATION) return { ok: false, reason: 'already_staff' }
    throw error
  }
}

export type UpdateStaffResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'no_permission_selected' }

/**
 * Replaces a grant's whole permission set.
 *
 * A REPLACE, not a merge: an unchecked HTML checkbox submits nothing at all, so
 * a partial update would silently keep permissions the owner had just cleared.
 * The edit form always renders and submits all four.
 *
 * `branch_id` is in the WHERE clause, not compared after a read. The action
 * above it guards `requireOwnerOf(branchId)` on a submitted branch id, so an
 * owner who passes their own branch id with someone else's staffId must write
 * nothing — which is what this scoping guarantees.
 */
export async function updateBranchStaff(input: {
  staffId: string
  branchId: string
  permissions: StaffPermissions
}): Promise<UpdateStaffResult> {
  if (!hasAnyPermission(input.permissions)) return { ok: false, reason: 'no_permission_selected' }

  const result = await db.execute(sql`
    update branch_staff set
      view_bookings = ${input.permissions.view_bookings},
      block_slots   = ${input.permissions.block_slots},
      manage_courts = ${input.permissions.manage_courts},
      view_earnings = ${input.permissions.view_earnings}
    where id = ${input.staffId}::uuid and branch_id = ${input.branchId}::uuid
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'not_found' }
}

export type RevokeStaffResult = { ok: true } | { ok: false; reason: 'not_found' }

/**
 * Removes a grant entirely. A DELETE, not an all-false UPDATE — the
 * branch_staff_some_permission CHECK would reject the latter, and a row that
 * grants nothing would still list the person on the staff page.
 *
 * Branch-scoped in the WHERE clause for the same reason as updateBranchStaff.
 * Idempotent: a second revoke reports not_found rather than throwing, so a
 * double-submit is harmless.
 */
export async function revokeBranchStaff(input: {
  staffId: string
  branchId: string
}): Promise<RevokeStaffResult> {
  const result = await db.execute(sql`
    delete from branch_staff
    where id = ${input.staffId}::uuid and branch_id = ${input.branchId}::uuid
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'not_found' }
}

export type PromoteResult =
  | { ok: true; revokedGrants: number }
  | { ok: false; reason: 'no_such_user' | 'already_owner' | 'slug_taken' | 'invalid_input' }

/**
 * Vets a player into an owner: flips the role, sets the business fields, and
 * DELETES every branch_staff row they held.
 *
 * NOT DEAD CODE, despite having no UI in this slice. The admin screen that will
 * call this belongs to the admin-panel slice (see the spec's Out of scope), but
 * the rule is specified and pinned here because that grant-revocation side
 * effect is the thing that keeps "a user is never simultaneously an owner and
 * someone's staff" true. tests/staff/write.test.ts is its caller for now.
 *
 * Self-serve promotion is gone: an owner account is no longer granted by
 * submitting a first listing (the parent spec's rule, amended 2026-08-05).
 *
 * `role = 'player'` is required in the WHERE clause, which makes this both
 * non-demoting and non-repeating: an admin passing through would otherwise lose
 * their admin role, and re-promoting an owner would overwrite a business_name
 * and slug they may since have edited.
 *
 * One transaction, so a promoted user can never be left holding grants: the
 * role flip and the revocation commit together or not at all.
 */
export async function promoteToOwner(input: {
  userId: string
  businessName: string
  slug: string
}): Promise<PromoteResult> {
  const businessName = input.businessName.trim()
  if (businessName.length === 0 || businessName.length > MAX_BUSINESS_NAME_LENGTH) {
    return { ok: false, reason: 'invalid_input' }
  }
  // The slug appears in /owners/<slug>, so it follows the same shape rule as
  // branches.slug. Validated here rather than left to the UNIQUE constraint,
  // which only catches collisions, not malformed values.
  if (!SLUG_RE.test(input.slug)) return { ok: false, reason: 'invalid_input' }

  try {
    return await db.transaction(async (tx) => {
      const updated = await tx.execute(sql`
        update profiles set
          role = 'owner',
          business_name = ${businessName},
          slug = ${input.slug}
        where id = ${input.userId}::uuid and role = 'player'
        returning id
      `)

      if (updated.rows.length === 0) {
        // Distinguish "no such profile" from "already not a player" — an admin
        // screen needs to say which.
        const exists = await tx.execute(sql`
          select 1 from profiles where id = ${input.userId}::uuid
        `)
        return exists.rows.length > 0
          ? { ok: false as const, reason: 'already_owner' as const }
          : { ok: false as const, reason: 'no_such_user' as const }
      }

      // The rule: a user is never simultaneously an owner and someone's staff.
      // In the same transaction as the role flip, so the two can never diverge.
      const revoked = await tx.execute(sql`
        delete from branch_staff where user_id = ${input.userId}::uuid returning id
      `)

      return { ok: true as const, revokedGrants: revoked.rows.length }
    })
  } catch (error) {
    // profiles.slug is UNIQUE and shows up in public /owners/<slug> URLs.
    if (sqlStateOf(error) === PG_UNIQUE_VIOLATION) return { ok: false, reason: 'slug_taken' }
    throw error
  }
}
```

- [ ] **Step 4: Create `src/lib/staff/queries.ts`**

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { noPermissions, STAFF_PERMISSIONS, type StaffPermissions } from '@/lib/staff/permissions'

export type BranchStaffRow = {
  staffId: string
  userId: string
  email: string
  fullName: string | null
  permissions: StaffPermissions
  /**
   * A Manila calendar date (`YYYY-MM-DD`), not a raw instant — matching this
   * project's other read modules (see OwnerPendingCourt.createdAt) so callers
   * feed it straight into formatDateLabel() with no second conversion.
   */
  createdAt: string
}

export type BranchStaffGroup = { branchId: string; branchName: string; staff: BranchStaffRow[] }

/**
 * Every branch the owner has, each with its staff.
 *
 * A branch with no staff still gets a group with an empty `staff` array: the
 * page renders one "add staff" form per branch, so a branch missing from this
 * list would be permanently unstaffable — the reason this is a LEFT join from
 * branches rather than a query over branch_staff.
 *
 * Owner-scoped, not branch-id-scoped like src/lib/owner/queries.ts: staff
 * management is owner-only (the page uses requireOwnerPage and the actions
 * requireOwnerOf), so there is no staff-visible variant of this read to
 * generalize for.
 *
 * The email is shown in full, deliberately: it is the identifier the owner
 * typed to add the person, and the only way to tell two colleagues with the
 * same display name apart.
 */
export async function getBranchStaffForOwner(ownerId: string): Promise<BranchStaffGroup[]> {
  const result = await db.execute(sql`
    select
      b.id as branch_id, b.name as branch_name,
      s.id as staff_id, s.user_id,
      p.email, p.full_name,
      s.view_bookings, s.block_slots, s.manage_courts, s.view_earnings,
      to_char(s.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as created_at
    from branches b
    left join branch_staff s on s.branch_id = b.id
    left join profiles p     on p.id = s.user_id
    where b.owner_id = ${ownerId}::uuid
    order by b.name, p.email
  `)

  const groups = new Map<string, BranchStaffGroup>()
  for (const row of result.rows) {
    const branchId = row.branch_id as string
    let group = groups.get(branchId)
    if (!group) {
      group = { branchId, branchName: row.branch_name as string, staff: [] }
      groups.set(branchId, group)
    }
    // A null staff_id is the LEFT join's "this branch has no staff" row.
    if (row.staff_id === null) continue

    const permissions = noPermissions()
    for (const permission of STAFF_PERMISSIONS) {
      permissions[permission] = row[permission] === true
    }

    group.staff.push({
      staffId: row.staff_id as string,
      userId: row.user_id as string,
      email: row.email as string,
      fullName: (row.full_name as string | null) ?? null,
      permissions,
      createdAt: row.created_at as string,
    })
  }

  return [...groups.values()]
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
npx vitest run tests/staff/write.test.ts
```

Expected: PASS (21 tests).

- [ ] **Step 6: Run them a second time**

```bash
npx vitest run tests/staff/write.test.ts
```

Expected: PASS again. Every slug and email is `crypto.randomUUID()`-suffixed, so nothing collides across runs.

- [ ] **Step 7: Typecheck, lint, full suite**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: no type errors; only pre-existing lint warnings; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/staff/write.ts src/lib/staff/queries.ts tests/staff/write.test.ts
git commit -m "Add staff grant add/edit/revoke and the promote-to-owner rule"
```

---

### Task 11: `/dashboard/staff` — the staff management page

**Files:**
- Create: `src/app/dashboard/staff/actions.ts`
- Create: `src/app/dashboard/staff/staff-forms.tsx`
- Create: `src/app/dashboard/staff/page.tsx`

**Interfaces:**
- Consumes: `requireOwnerPage` (`src/lib/auth/page-guards.ts`), `getBranchStaffForOwner` (`src/lib/staff/queries.ts`), `addBranchStaff`/`updateBranchStaff`/`revokeBranchStaff`/`parseStaffEmail`/`parseStaffId` (`src/lib/staff/write.ts`), `parsePermissions`/`STAFF_PERMISSIONS`/`STAFF_PERMISSION_LABELS` (`src/lib/staff/permissions.ts`), `requireOwnerOf` (`src/lib/auth/guards.ts`), `formatDateLabel` (`src/lib/format.ts`).
- Produces:
  - `export type StaffFormState = { ok: true; message: string } | { error: string } | null`
  - `addStaffAction(prevState, formData)`, `updateStaffAction(prevState, formData)`, `revokeStaffAction(prevState, formData)`
  - `<AddStaffForm branchId={string} />`, `<EditStaffForm staffId branchId permissions />`, `<RevokeStaffForm staffId branchId label />`

**Owner-only, deliberately:** the page is guarded by `requireOwnerPage` and every action by `requireOwnerOf(branchId)` — not `requireBranchAccess`. The spec is explicit: "Only the branch's owner (or admin) manages that branch's staff rows." There is no `manage_staff` permission, and staff must not be able to widen their own grant or add colleagues. `requireOwnerOf` already admits admins and is already in the action-coverage `GUARDS` list.

**Lime-button note:** the page renders one "Add staff" form **per branch**, so a lime primary would put several competing primaries on screen. This page therefore uses branding.md's alternative primary (`--ink` background, `--ball` text) for Add, and bordered/neutral for Save and Revoke. No lime anywhere on this page — which also keeps "never two lime buttons in one view" trivially true.

- [ ] **Step 1: Create the actions**

`src/app/dashboard/staff/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { AuthError, requireOwnerOf } from '@/lib/auth/guards'
import { parsePermissions } from '@/lib/staff/permissions'
import {
  addBranchStaff,
  parseStaffEmail,
  parseStaffId,
  revokeBranchStaff,
  updateBranchStaff,
} from '@/lib/staff/write'

/**
 * Staff management, owner-only.
 *
 * requireOwnerOf(branchId), NOT requireBranchAccess: per the spec, only the
 * branch's owner (or an admin) manages that branch's staff rows. There is no
 * `manage_staff` permission, and a staff member must not be able to widen their
 * own grant or add colleagues.
 *
 * A submitted `branchId` is safe to guard on here — unlike in the block actions,
 * where the branch had to be derived from the target row — because every write
 * below is scoped by that same branchId in its own WHERE clause (see
 * src/lib/staff/write.ts). An owner who forges a branchId either fails the guard
 * (not their branch) or passes it and then matches no row (their branch, someone
 * else's grant). Both are safe; neither leaks.
 *
 * This file exports only three async guarded actions. The parse rules and the
 * SQL live in the `import 'server-only'` modules under src/lib/staff/ and are
 * unit-tested there, because every export of a 'use server' file becomes a
 * client-invokable endpoint.
 */
export type StaffFormState = { ok: true; message: string } | { error: string } | null

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOT_YOUR_BRANCH = "That branch isn't yours to manage."

/**
 * Shape-checks the branch id before it reaches requireOwnerOf, which
 * interpolates it into a `::uuid` cast — a malformed value would raise 22P02
 * and escape as an unhandled exception instead of a form error.
 */
function branchIdFrom(formData: FormData): string | null {
  const branchId = String(formData.get('branchId') ?? '')
  return UUID_RE.test(branchId) ? branchId : null
}

export async function addStaffAction(
  _prevState: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const branchId = branchIdFrom(formData)
  if (!branchId) return { error: NOT_YOUR_BRANCH }

  try {
    await requireOwnerOf(branchId)
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_YOUR_BRANCH }
    throw error
  }

  const email = parseStaffEmail(formData)
  if (!email) return { error: 'Enter the email address of an existing OnCourt account.' }

  const result = await addBranchStaff({
    branchId,
    email,
    permissions: parsePermissions(formData),
  })

  if (!result.ok) {
    return {
      error:
        result.reason === 'no_such_user'
          ? `No OnCourt account uses ${email}. Ask them to sign in once, then add them.`
          : result.reason === 'not_a_player'
            ? 'That account is a court owner or an admin, so it cannot be staff.'
            : result.reason === 'already_staff'
              ? 'That person already has access to this branch — edit their permissions below.'
              : 'Pick at least one permission.',
    }
  }

  revalidatePath('/dashboard/staff')
  return { ok: true, message: `${email} now has access to this branch.` }
}

export async function updateStaffAction(
  _prevState: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const branchId = branchIdFrom(formData)
  if (!branchId) return { error: NOT_YOUR_BRANCH }

  try {
    await requireOwnerOf(branchId)
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_YOUR_BRANCH }
    throw error
  }

  const staffId = parseStaffId(formData)
  if (!staffId) return { error: 'That staff member no longer has access to this branch.' }

  const result = await updateBranchStaff({
    staffId,
    branchId,
    permissions: parsePermissions(formData),
  })

  if (!result.ok) {
    return {
      error:
        result.reason === 'no_permission_selected'
          ? 'Pick at least one permission, or revoke their access instead.'
          : 'That staff member no longer has access to this branch.',
    }
  }

  revalidatePath('/dashboard/staff')
  return { ok: true, message: 'Permissions saved.' }
}

export async function revokeStaffAction(
  _prevState: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const branchId = branchIdFrom(formData)
  if (!branchId) return { error: NOT_YOUR_BRANCH }

  try {
    await requireOwnerOf(branchId)
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_YOUR_BRANCH }
    throw error
  }

  const staffId = parseStaffId(formData)
  if (!staffId) return { error: 'That staff member no longer has access to this branch.' }

  const result = await revokeBranchStaff({ staffId, branchId })
  if (!result.ok) return { error: 'That staff member no longer has access to this branch.' }

  revalidatePath('/dashboard/staff')
  return { ok: true, message: 'Access revoked.' }
}
```

- [ ] **Step 2: Create the client forms**

`src/app/dashboard/staff/staff-forms.tsx`:

```tsx
'use client'

import { useActionState } from 'react'
import {
  addStaffAction,
  revokeStaffAction,
  updateStaffAction,
  type StaffFormState,
} from './actions'
import {
  STAFF_PERMISSION_LABELS,
  STAFF_PERMISSIONS,
  type StaffPermissions,
} from '@/lib/staff/permissions'

const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const CHECKBOX = `h-4 w-4 shrink-0 accent-[var(--court)] ${FOCUS_RING}`
const CHECK_LABEL =
  'inline-flex cursor-pointer items-center gap-1.5 text-[12.5px] text-[var(--ink)]'
const BORDERED_BUTTON =
  `inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3.5 text-[13px] font-semibold whitespace-nowrap text-[var(--ink)] hover:border-[var(--court)] disabled:opacity-60 ${FOCUS_RING}`

/**
 * The three staff forms. Client components for one reason: a Server Component
 * cannot render what a Server Action returns, so "no OnCourt account uses that
 * address" or "that person already has access" would look like nothing
 * happening. useActionState gives each return a home. Same pattern as
 * src/app/bookings/review-form.tsx.
 *
 * All four checkboxes are always rendered, in every form. An unchecked HTML
 * checkbox submits nothing at all, so parsePermissions() reads absence as false
 * — which means a form that omitted a checkbox would silently revoke that
 * permission. Rendering all four is what makes "the submitted set IS the new
 * set" true.
 *
 * There is no DOM test environment in this project (vitest.config.ts sets
 * environment: 'node'), so these are verified in the browser in Task 12. The
 * guarded actions and the SQL underneath them are unit-tested.
 */
function PermissionCheckboxes({
  idPrefix,
  defaults,
}: {
  idPrefix: string
  defaults?: StaffPermissions
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <legend className="font-mono mb-1.5 text-[10.5px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
        Permissions
      </legend>
      {STAFF_PERMISSIONS.map((permission) => (
        <label key={permission} className={CHECK_LABEL} htmlFor={`${idPrefix}-${permission}`}>
          <input
            id={`${idPrefix}-${permission}`}
            type="checkbox"
            name={permission}
            defaultChecked={defaults?.[permission] ?? false}
            className={CHECKBOX}
          />
          {STAFF_PERMISSION_LABELS[permission]}
        </label>
      ))}
    </fieldset>
  )
}

function FormMessage({ state }: { state: StaffFormState }) {
  if (!state) return null
  return 'error' in state ? (
    <p role="alert" className="mt-2 text-[12.5px] font-medium text-[var(--ink)]">
      {state.error}
    </p>
  ) : (
    <p role="status" className="mt-2 text-[12.5px] font-medium text-[var(--court)]">
      {state.message}
    </p>
  )
}

export function AddStaffForm({ branchId }: { branchId: string }) {
  const [state, formAction, pending] = useActionState<StaffFormState, FormData>(addStaffAction, null)

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="branchId" value={branchId} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <label
            className="font-mono mb-1 block text-[10.5px] tracking-[.12em] text-[var(--ink-soft)] uppercase"
            htmlFor={`add-email-${branchId}`}
          >
            Email address
          </label>
          <input
            id={`add-email-${branchId}`}
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="colleague@example.com"
            className={`h-[var(--btn-h-sm)] w-full rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2.5 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-soft)] ${FOCUS_RING}`}
          />
        </div>

        {/* branding.md's alternative primary (--ink bg, --ball text), not lime:
            this page renders one Add form PER BRANCH, so a lime primary would
            put several competing primaries on screen. */}
        <button
          type="submit"
          disabled={pending}
          className={`font-display inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] bg-[var(--ink)] px-4 text-[13px] font-bold text-[var(--ball)] transition-[filter] duration-150 hover:brightness-[1.25] disabled:opacity-60 motion-reduce:transition-none ${FOCUS_RING}`}
        >
          {pending ? 'Adding…' : 'Add staff'}
        </button>
      </div>

      <PermissionCheckboxes idPrefix={`add-${branchId}`} />
      <FormMessage state={state} />
    </form>
  )
}

export function EditStaffForm({
  staffId,
  branchId,
  permissions,
}: {
  staffId: string
  branchId: string
  permissions: StaffPermissions
}) {
  const [state, formAction, pending] = useActionState<StaffFormState, FormData>(
    updateStaffAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="staffId" value={staffId} />
      <PermissionCheckboxes idPrefix={`edit-${staffId}`} defaults={permissions} />
      <button type="submit" disabled={pending} className={BORDERED_BUTTON}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      <div className="w-full">
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function RevokeStaffForm({
  staffId,
  branchId,
  label,
}: {
  staffId: string
  branchId: string
  label: string
}) {
  const [state, formAction, pending] = useActionState<StaffFormState, FormData>(
    revokeStaffAction,
    null,
  )

  return (
    <form action={formAction}>
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="staffId" value={staffId} />
      {/* No confirmation dialog: revoking is immediately reversible by adding
          the same address again (tests/staff/write.test.ts pins that), and it
          destroys no record. The accessible name names the person, so a screen
          reader user can tell several Revoke buttons apart. */}
      <button
        type="submit"
        disabled={pending}
        aria-label={`Revoke access for ${label}`}
        className={BORDERED_BUTTON}
      >
        {pending ? 'Revoking…' : 'Revoke'}
      </button>
      <FormMessage state={state} />
    </form>
  )
}
```

- [ ] **Step 3: Create the page**

`src/app/dashboard/staff/page.tsx`:

```tsx
import { requireOwnerPage } from '@/lib/auth/page-guards'
import { getBranchStaffForOwner } from '@/lib/staff/queries'
import { STAFF_PERMISSION_LABELS, STAFF_PERMISSIONS } from '@/lib/staff/permissions'
import { formatDateLabel } from '@/lib/format'
import { AddStaffForm, EditStaffForm, RevokeStaffForm } from './staff-forms'

const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

/**
 * Staff management — one card per branch.
 *
 * requireOwnerPage, NOT requireDashboardPage: staff management is owner-only
 * per the spec, so a staff member must not reach this page even though they
 * reach the rest of /dashboard. The sidebar hides the item for them
 * (`show: access.isOwner`), and this guard is the boundary for a typed URL —
 * it redirects a plain player to /bookings and a signed-out visitor to login.
 *
 * The same person can appear under several branches with different permissions:
 * one branch_staff row each, edited independently. That is why permissions are
 * rendered per row rather than per person.
 */
export default async function StaffPage() {
  const user = await requireOwnerPage('/dashboard/staff')
  const groups = await getBranchStaffForOwner(user.id)

  return (
    <>
      <header className="mb-8">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Staff
        </h1>
        <p className="mt-2 max-w-[560px] text-[15px] text-[var(--ink-soft)]">
          Give a front-desk colleague access to one branch&rsquo;s schedule without sharing your
          account. They keep their own player account and only see the branches you grant.
        </p>
      </header>

      {groups.length === 0 ? (
        <p className={EMPTY_PANEL}>
          No branches yet — add a branch first, then you can give colleagues access to it.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section
              key={group.branchId}
              aria-label={`Staff at ${group.branchName}`}
              className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
            >
              <h2 className="font-display mb-4 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                {group.branchName}
              </h2>

              {group.staff.length > 0 ? (
                <ul className="mb-5 flex flex-col">
                  {group.staff.map((row, index) => (
                    <li
                      key={row.staffId}
                      className={`flex flex-wrap items-start justify-between gap-4 py-4 ${
                        index > 0 ? 'border-t border-[var(--hairline)]' : 'pt-0'
                      }`}
                    >
                      <div className="min-w-[200px]">
                        <div className="text-[13.5px] font-semibold text-[var(--ink)]">
                          {row.fullName ?? row.email}
                        </div>
                        {/* The email always shows, even when a display name
                            exists: it is the identifier the owner typed to add
                            them, and the only way to tell two colleagues with
                            the same name apart. */}
                        <div className="truncate text-[12.5px] text-[var(--ink-soft)]">
                          {row.email}
                        </div>
                        <div className="font-mono mt-1 text-[10.5px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                          Added {formatDateLabel(row.createdAt)}
                        </div>
                        {/* A read-only summary above the editable checkboxes:
                            the current grant at a glance, without reading four
                            checkbox states. Pill-shaped per branding.md, since
                            these are badges, not buttons. */}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {STAFF_PERMISSIONS.filter((permission) => row.permissions[permission]).map(
                            (permission) => (
                              <span
                                key={permission}
                                className="font-mono rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[10.5px] tracking-[.05em] text-[var(--court-deep)] uppercase"
                              >
                                {STAFF_PERMISSION_LABELS[permission]}
                              </span>
                            ),
                          )}
                        </div>
                      </div>

                      <div className="flex flex-1 flex-wrap items-start justify-end gap-4">
                        <EditStaffForm
                          staffId={row.staffId}
                          branchId={group.branchId}
                          permissions={row.permissions}
                        />
                        <RevokeStaffForm
                          staffId={row.staffId}
                          branchId={group.branchId}
                          label={row.fullName ?? row.email}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mb-5 text-[13px] text-[var(--ink-soft)]">
                  Nobody has access to this branch yet.
                </p>
              )}

              <div className="border-t border-[var(--hairline)] pt-5">
                <h3 className="font-display mb-3 text-[14px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                  Add someone
                </h3>
                <p className="mb-3 text-[12.5px] text-[var(--ink-soft)]">
                  They need an OnCourt account already — ask them to sign in once first.
                </p>
                <AddStaffForm branchId={group.branchId} />
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  )
}
```

- [ ] **Step 4: Confirm the action-coverage contract**

```bash
npx vitest run tests/auth/action-coverage.test.ts
```

Expected: PASS — `src/app/dashboard/staff/actions.ts` contains `requireOwnerOf`, which was already in `GUARDS` before this slice.

- [ ] **Step 5: Typecheck, lint, full suite**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: no type errors; only pre-existing lint warnings; all tests pass.

- [ ] **Step 6: Verify the owner-only guard from a signed-out browser**

With the dev server running, navigate to `/dashboard/staff` while signed out. Expected: redirected to `/login?next=%2Fdashboard`. (The layout's guard fires before the page's, so `next` is the layout's path — confirm that is what happens and record it either way.) The signed-in player/staff rejection needs a real session and is Task 12, Step 7.

- [ ] **Step 7: Commit**

```bash
git add src/app/dashboard/staff/actions.ts src/app/dashboard/staff/staff-forms.tsx src/app/dashboard/staff/page.tsx
git commit -m "Add the owner-only staff management page"
```

---

### Task 12: End-to-end verification with real sessions

**Files:** none — this task produces evidence, not code. The one exception is Step 11's doc note.

**Blocking dependency:** requires the user to complete Google sign-in interactively, for **two** accounts (one that becomes an owner, one that becomes staff). The assistant must not authenticate on their behalf. If only one account is available, run Steps 5-8 and record Steps 9-10 as unverified rather than faking a second session.

- [ ] **Step 1: Start the dev server**

Use `preview_start` with config `oncourt-dev`.

- [ ] **Step 2: Verify every signed-out redirect**

Navigate to each and confirm the destination:
- `/bookings` → `/login?next=%2Fbookings`
- `/dashboard` → `/login?next=%2Fdashboard`
- `/dashboard/bookings` → `/login?next=%2Fdashboard` *(layout guard fires first — confirm and record)*
- `/dashboard/earnings` → as above
- `/dashboard/staff` → as above
- `/venues/smash-zone-marikina` → renders, grid interactive, summary bar reads "Select open slots in one court's column to book." (signed out ⇒ `canBook` true, and clicking Book redirects to `/login` — that is the funnel, not a bug)

- [ ] **Step 3: Ask the user to sign in with the first account**

Ask them to complete the Google flow in the browser pane and say when they are back on the app. If the callback fails with a redirect error, the fix is adding `http://localhost:3000/**` to Supabase's URL Configuration → Redirect URLs; tell them that exact string.

- [ ] **Step 4: Confirm the player state before promoting anything**

While this account is still a plain `player`:
- The nav account menu shows **My bookings** and **no** dashboard item (a plain player has neither an owner role nor a grant).
- `/dashboard` redirects to `/bookings`.

This is the `requireDashboardPage` rejection path, and it is easiest to see now — record it before the account changes role.

- [ ] **Step 5: Make the first account an owner with data**

`npm run demo:grant -- --email <address>` (from the previous slice) makes the account an owner and gives it the "Rally Republic" branches. Run it, then confirm the reported branch count is nonzero.

- [ ] **Step 6: Verify the owner cannot book**

- The nav account menu now shows **Owner dashboard** and **no "My bookings"** item.
- `/bookings` redirects to `/dashboard`.
- `/bookings/11111111-2222-3333-4444-555555555555` also redirects to `/dashboard`.
- `/venues/smash-zone-marikina`: every grid cell is non-interactive (clicking one selects nothing) and the summary bar reads "Owner and admin accounts can't book courts. To hold time on your own courts, use Bookings in your dashboard."
- Confirm the server guard independently of the UI, by replaying the form POST the grid would have sent. In the browser console via `javascript_tool`, the grid's cells no longer produce a selection, so instead check that the action rejects: submit the hold form's fields against the action endpoint is awkward from the console, so verify by temporarily re-enabling the CTA is **not** acceptable. Instead assert the guard directly in Node against the live database — sign-in state is not needed, because the guard's own unit tests already cover the role logic (`tests/auth/guards.test.ts`, `requirePlayer rejects owner/admin`). Record that the server-side rejection is covered by test rather than by this browser pass.

- [ ] **Step 7: Verify blocks end to end**

On `/dashboard/bookings`:
- The "Block a slot" panel renders with a court dropdown grouped by branch.
- Block a slot on today: pick a court, `From 7 AM`, `To 9 AM`, note `Resurfacing`. Expected: the status line reads "Slot blocked." and a new row appears in the table with label `Resurfacing`, status pill `Blocked` in the muted `--booked` tone, `—` in both money columns, and an **Unblock** button.
- Submit the same court and hours again. Expected: "Those hours are already taken by a booking, a hold, or another block." and no second row.
- Open `/dashboard` in another tab: the day grid shows the block as a soft `--band-off` chip labelled `Resurfacing`, visually distinct from any solid `--court-deep` booking chip. Confirm the stat row's Gross/Net/Bookings-this-week did **not** change, and Occupancy did **not** change.
- Open the public venue page for that branch and date: the blocked hours render as **Booked**, not open.
- Back on `/dashboard/bookings`, click **Unblock**. Expected: the row disappears, and the public venue page shows those hours open again.

- [ ] **Step 8: Verify the staff page as the owner**

On `/dashboard/staff`:
- One card per branch, each with an "Add someone" form.
- Enter an address with no account. Expected: "No OnCourt account uses <address>. Ask them to sign in once, then add them."
- Enter the owner's own address. Expected: "That account is a court owner or an admin, so it cannot be staff."
- Submit with all four checkboxes clear. Expected: "Pick at least one permission."
- Confirm the sidebar shows Overview / Bookings / Earnings / **Staff**.
- Tab through one staff card and confirm the branded focus ring is visible on every control: the email input, all four checkboxes, Add staff, Save, Revoke.

- [ ] **Step 9: Ask the user to sign in with the second account, then grant it staff access**

Have them sign out, sign in with the second Google account (this creates its profile row), then sign out again and sign back in as the owner. As the owner, add the second address on **one** branch with `View bookings` and `Block slots` only — deliberately **not** `View earnings`.

- [ ] **Step 10: Verify the staff session**

Sign in as the second account and confirm:
- The nav account menu shows **My bookings** *and* **Venue dashboard** (not "Owner dashboard").
- `/bookings` renders normally — staff are players and keep their own dashboard.
- `/dashboard` renders. The sidebar shows Overview and Bookings, and **no Earnings and no Staff item**.
- `/dashboard`'s stat row shows **two** cards (Bookings this week, Occupancy) — no Gross/Net.
- The day grid shows only the granted branch's courts. Confirm against the owner's own `/dashboard`, which shows more.
- `/dashboard/bookings` renders and the "Block a slot" panel is present (they hold `block_slots`). Block an hour, then unblock it. Both succeed.
- `/dashboard/earnings` typed directly → redirects to `/dashboard`.
- `/dashboard/staff` typed directly → redirects to `/bookings` (`requireOwnerPage` sends a player there). Record the actual destination.
- The branch filter dropdown on `/dashboard/bookings` lists **only** the granted branch.
- Append `&branch=<the ungranted branch's id>` to the URL. Expected: the filter is silently dropped and the granted branch's rows still render — no error, no other branch's data.

- [ ] **Step 11: Screenshots and layout checks**

Screenshot `/dashboard/bookings` and `/dashboard/staff` at 1280 and at 375. Confirm at 375, via `javascript_tool`:

```js
document.documentElement.scrollWidth > window.innerWidth
```

Expected: `false` on both pages. The bookings table scrolls inside its own `overflow-x-auto` container; the page itself must not scroll sideways (branding.md's mobile rule).

- [ ] **Step 12: Check the console and server logs**

`read_console_messages` (errors only) and `preview_logs` (level error). Both should be clean. A React key warning or a hydration mismatch on the staff page means a form is missing a stable `key` — fix it rather than recording it.

- [ ] **Step 13: Record what was verified**

Append a short dated entry to `docs/foundation-review-notes.md` recording: which paths were verified with a real owner session and a real staff session, that the owner booking rejection is covered by `tests/auth/guards.test.ts` rather than by a browser replay, and anything Step 6 or Steps 9-10 could not verify. Do not overwrite earlier entries — this file is a history, not a status page.

```bash
git add docs/foundation-review-notes.md
git commit -m "Record end-to-end verification of exclusive roles, blocks, and staff access"
```

---

## Self-Review

**Spec coverage.** Every section of `docs/superpowers/specs/2026-08-05-roles-and-staff-design.md` maps to at least one task:

| Spec section | Tasks |
|---|---|
| Role model — signup unchanged, `ADMIN_EMAILS` promotion unchanged | untouched by design; no task edits `src/app/auth/callback/route.ts` |
| Role model — owner creation is an admin act (flip role + business fields + delete grants) | 10 (`promoteToOwner`, four tests) |
| Role model — players unchanged | 7 (`requirePlayerPage` keeps `/bookings` theirs) |
| Role model — owners cannot create paid bookings, cannot review | 4 (`requirePlayer`), 7 (hold guard + CTA + redirects). Reviews need no change: eligibility derives from owning a `completed` booking, which only a player can have — stated in `requirePlayer`'s docstring |
| Role model — admins do not book | 4 (`requirePlayer` rejects admin, pinned by test) |
| Staff grants — the table, exactly as specced | 2 |
| Staff grants — only the branch's owner or an admin manages rows | 11 (`requireOwnerOf` per action) |
| Staff grants — existing account, exact email, `role = 'player'` | 10 (`addBranchStaff`, four tests) |
| Staff grants — owner UI: list per branch, add by email, edit, revoke | 11 |
| Staff grants — same person, several branches, different permissions | 2 (constraint test), 10 (`addBranchStaff` test), 11 (per-row editing) |
| Blocks — `blocked` enum in its own migration | 1 |
| Blocks — nullable `player_id`/`fee_config_snapshot` with checks | 2 |
| Blocks — money columns stay `not null`, blocked rows write `0` | 2 (`bookings_blocked_is_free`), 8 (`createBlock` writes zeros) |
| Blocks — `created_by` + `note` + FK index | 2 |
| Blocks — rebuild `bookings_no_overlap` with the guarded, `conrelid`-qualified DO pattern | 2 |
| Blocks — blocks occupy the slot; **verify the availability query's status list** | 3 (three enumerating queries found and fixed: `src/lib/booking/availability.ts`, and two in `src/lib/branches/queries.ts` — the search hour filter and the home page's `openNowCount`) |
| Blocks — excluded from earnings, pinned by test | 6 (`getOwnerEarnings ignores blocks entirely`, plus the gross/net/occupancy test) |
| Blocks — `complete_past_bookings()` regression test, no code change | 2 |
| Blocks — player dashboard never shows them | 3 (`a block never appears on any player surface`) |
| Blocks — `expire_stale_holds()` untouched | no task edits it; Task 8 pins the interaction from the other side (`createBlock succeeds over an expired-but-unswept hold`) |
| Blocks — deletable by anyone holding `block_slots`, or the owner | 8 (`deleteBlock` + `deleteBlockAction`), 9 (UI) |
| Enforcement — `requirePlayer` | 4 |
| Enforcement — `requireBranchAccess(branchId, permission)` | 4 |
| Enforcement — `/dashboard` admits staff; branch pickers show granted branches; sections respect flags | 5 (`loadDashboardAccess`, `requireDashboardPage`), 6 (branch scoping, sidebar gating, stat-row gating, earnings gate) |
| Enforcement — `/bookings` redirects owners | 7 |
| Enforcement — nav account menu: dashboard item for staff, "Venue dashboard" label, booking CTAs hidden from owners | 7 |
| Enforcement — venue pages hide Book for owners; `requirePlayer` rejects direct calls | 7 |
| Testing — migration applies twice | 1 (Steps 3-4), 2 (Steps 5-6) |
| Testing — 23P01 both directions | 2 |
| Testing — check constraints (null `player_id`, null `created_by`, all-false permissions, duplicate pair) | 2 |
| Testing — `complete_past_bookings()` leaves a blocked row | 2 |
| Testing — guards: `requirePlayer` rejects owner/admin; `requireBranchAccess` matrix | 4 |
| Testing — actions: staff add/edit/revoke incl. wrong-owner, non-player, unknown email, re-add after revoke | 10 |
| Testing — block create/delete permission matrix | 4 (the `requireBranchAccess` matrix, which is the permission half) + 8 (the write half, incl. wrong-branch unreachability via `branchIdOfBlock`) |
| Testing — earnings ignore blocked rows | 6 |
| Testing — promotion revokes grants | 10 |

**Every spec "Out of scope" item stays out.** No task builds an admin vetting screen, a pending-invite state, cash bookkeeping, payout logic, or a fifth permission.

**Placeholder scan.** No "TBD", no "similar to Task N", no "add validation here". Where a task edits an existing file rather than creating one, it names the file, the anchor (function or line range), and gives the replacement text verbatim — the same style the previous slice's plan used for its page edits.

**Type and name consistency, checked across tasks.**
- `StaffPermission` / `StaffPermissions` are defined once (Task 4, `src/lib/staff/permissions.ts`) and imported identically by `requireBranchAccess` (4), `loadDashboardAccess` (5), `addBranchStaff`/`updateBranchStaff` (10), `getBranchStaffForOwner` (10), and the client forms (11).
- The four permission strings are the four `branch_staff` column names, and `requireBranchAccess` indexes a `to_jsonb` row by the permission string — so the identity between the TypeScript literal and the SQL column is load-bearing and is called out in `permissions.ts`'s docstring.
- `label` replaces `playerName` in **both** `OwnerGridBooking` and `OwnerBookingRow` in Task 6, and every consumer is updated in that same task (`owner-day-grid.tsx`, `/dashboard/bookings`) — Task 9's `UnblockButton` then consumes `row.label` and `row.bookingId`, which both exist.
- `getOwnerOverview`/`getOwnerBookings`/`getOwnerEarnings` take `branchIds: string[]` from Task 6 onward; all three call sites (the overview, bookings, and earnings pages) are changed in that task, and `getOwnerBranches` is deleted with its replacement named. Task 9 then re-shapes only the bookings page's call into a `Promise.all` beside `getScheduleCourts`, keeping the same argument.
- `BlockFormState` is defined in Task 8's action file and imported by both Task 9 components; `StaffFormState` likewise from Task 11's action file.
- `sqlStateOf` moves in Task 8 and both existing callers are updated in the same task, with `tests/booking/hold.test.ts` and `tests/bookings/review-action.test.ts` run as the check.
- `AvailabilityGrid`'s `canBook` is required, not optional, so a missed call site fails `tsc` (Task 7, Step 8 says exactly what to do if it does).

**Migration ordering, re-checked.** Task 1's file contains one statement and never references `'blocked'` in a way that uses it as a value (an `ADD VALUE` is the definition, not a use). Task 2's file references `'blocked'` in four CHECK constraints and the exclusion predicate, and runs in a later, separate transaction. Both are idempotent: Task 1 by `if not exists`; Task 2 by `create table if not exists`, `create index if not exists`, `add column if not exists`, naturally-idempotent `drop not null`, `conrelid`-qualified guarded DO blocks for the four checks, and a **definition**-checking guard for the exclusion rebuild (an existence check would see the old constraint and skip the widening — the one non-obvious trap in the whole file, called out in its comment). Both are applied twice, and Task 2 adds a `pg_constraint` duplicate-name query as the proof.

**Three decisions this plan makes that the spec left open**, each resolved in the code and the comments rather than deferred:

1. **Occupancy excludes blocks.** The spec says blocks are excluded from earnings but is silent on the occupancy stat. Excluding them keeps the four numbers in the stat row meaning one consistent thing; a resurfacing block reading as 100% utilization would be the metric lying. Implemented by filtering the already-fetched rows on `!isBlock` (no extra round trip) and pinned by a test that asserts the exact percentage.
2. **`bookings_blocked_is_free` is a real constraint, not just a convention.** The spec states the invariant ("blocked rows write `0` everywhere") without asking for enforcement. Enforcing it in the database matches this project's house style and makes "excluded from earnings" safe to stop re-checking in every future query.
3. **`note` is *not* constrained to be null on paid bookings.** The spec's parenthetical says it is null there in practice, but its enumerated constraint list does not include a check, and locking it in would need a migration to relax the first time someone wants an internal note on a paid booking. Documented in the migration comment so the omission reads as a decision rather than an oversight.

**Two reminders for implementers, from the spec's Out of scope — do not scope-creep into either:**

1. **There is no admin UI for vetting or promoting owners in this slice.** `promoteToOwner` exists in `src/lib/staff/write.ts` with tests, and nothing else calls it. That is correct and intentional: the spec pins the *rule* here (because the grant-revocation side effect is what keeps roles exclusive) and puts the *screen* in the admin-panel slice. Do not build a page, a route, or an action for it, and do not delete the function as dead code.
2. **There are no pending invites.** Staff can only be added by the exact email of an **existing** account. If the address has no profile row, the answer is "ask them to sign in once, then add them" — not an invitation record, not an email send, not a placeholder row. `addBranchStaff`'s `no_such_user` is the whole feature.

