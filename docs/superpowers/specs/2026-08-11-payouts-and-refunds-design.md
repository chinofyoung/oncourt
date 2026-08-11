# Payouts Ledger & Refund Recording — Design Spec

**Date:** 2026-08-11
**Status:** Approved design, pending implementation plan
**Slice:** The tail of the product spec's phase 6 (`docs/superpowers/specs/2026-07-31-pickleball-court-booking-platform-design.md`)

## Why this slice

The platform account collects every payment. Today there is no way to pay
owners what they are owed, and no way to record a refund. Two concrete holes:

1. **No `payouts` table exists.** The product spec describes one; it was never
   created. There is no ledger, no record-payout action, and the owner earnings
   page shows revenue with no payout history beside it.
2. **`payments.needs_refund` is written but never read.** `src/lib/payments/webhook.ts:214`
   flags payments that landed for an unavailable slot, that do not match what
   their session quoted, or that double-charged a booking already confirmed by a
   different payment. Nothing anywhere surfaces those rows. The payments
   migration says so itself at `supabase/migrations/20260807090000_payments.sql:63`
   — "the refund screen itself ships with the payouts work."

The second is the more urgent: money can be taken that needs returning, and no
one finds out. This slice closes both.

## Decisions

| Question | Decision |
|---|---|
| How a payout decides what it covers | A join table stamps the exact bookings. Not a date range. |
| What makes a booking payable | `status = 'completed'` only. |
| Refund after the owner was already paid | A negative clawback line reduces the next payout. |
| How an admin reaches a booking to refund | `/admin/refunds`: flagged queue plus lookup by player email or booking id. |
| What owners see | A Payouts section on `/dashboard/earnings`, gated on `view_earnings`, owner-wide. |
| Recording a payout | Two steps: prepare (stamps, locks the amount), then mark paid. |

### Why stamping, not a date range

The product spec's `payouts` table carries `period_start` / `period_end`,
implying "sum the net over this window." That drifts. A booking that confirms
after its window was already paid is missed forever; two overlapping windows
double-pay. Stamping each booking makes "owed" mean *bookings with no payout
line*, which is self-correcting by construction — late arrivals simply appear in
the next pool, and double-paying is rejected by a primary key rather than by
care.

`period_start` / `period_end` survive as **derived display labels**, computed
from the stamped bookings' Manila dates. They are not inputs.

### Why `completed` only

Money is collected at `confirmed`, but the court time has not been delivered
yet. Paying at `confirmed` means a pre-slot dispute is settled by clawing money
back from an owner who already has it. Paying at `completed` settles it by not
paying. `complete_past_bookings()` flips `confirmed` → `completed` every five
minutes, so the delay is the slot's own end time plus minutes.

## Schema

One migration, idempotent (`create table if not exists`, constraints inside
`do $$ ... $$` blocks that check `pg_constraint` first — Postgres has no
`ADD CONSTRAINT IF NOT EXISTS`).

### New enum

```sql
create type payout_line_kind as enum ('payment', 'clawback');
```

Safe to create *and use* in the same migration file: the 55P04 restriction
applies to values added to an existing type via `alter type ... add value`, not
to a brand-new `create type`. `supabase/migrations/20260807090000_payments.sql`
documents this precedent for `payment_status`. Do not split the file.

`payout_status ('pending', 'paid')` already exists from
`20260801042931_settings_and_enums.sql` and is reused as-is.

### `payouts`

```sql
create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles (id),

  -- DERIVED from the stamped payment lines' Manila dates, not admin input.
  -- Display only; the lines are the truth about what this payout covers.
  period_start date not null,
  period_end date not null,
  check (period_end >= period_start),

  -- Snapshots, integer centavos, computed at prepare time from the covered
  -- bookings (NOT derivable from payout_bookings, which stores only net per
  -- line). Stored so a historical payout reads correctly without re-deriving
  -- it from bookings that may have moved since. Definitions below.
  -- No check constraints on these two: they are derived, and net > 0 is the
  -- load-bearing gate on the row.
  gross_centavos integer not null,
  fee_centavos integer not null,

  -- > 0, not >= 0: you never record a payout of nothing. If owed comes out
  -- zero or negative you do not pay this week; the negative rides forward as
  -- an adjustment against the next one.
  net_centavos integer not null check (net_centavos > 0),

  status payout_status not null default 'pending',
  paid_at timestamptz,
  -- The transfer reference (GCash / bank), recorded at mark-paid.
  note text,
  created_at timestamptz not null default now(),

  -- The two-step flow's invariant, in the database rather than in the action:
  -- paid iff timestamped.
  check ((status = 'paid') = (paid_at is not null))
);

create index if not exists payouts_owner_id_idx on payouts (owner_id);
```

### `payout_bookings`

```sql
create table if not exists payout_bookings (
  booking_id uuid not null references bookings (id),
  kind payout_line_kind not null,
  payout_id uuid not null references payouts (id),
  -- Positive on a 'payment' line, negative on a 'clawback' line.
  net_centavos integer not null,

  -- THE INVARIANT: a booking can be paid at most once and clawed back at most
  -- once. Not unique(booking_id) alone -- that would leave a refunded booking
  -- unable to carry its own reversal.
  primary key (booking_id, kind)
);

create index if not exists payout_bookings_payout_id_idx on payout_bookings (payout_id);
```

`net_centavos` is snapshotted onto the line rather than joined back to
`bookings.owner_net_centavos` at read time, matching how bookings already
snapshot their own amounts: a payout is a historical record and must not move
when anything upstream changes.

No `on delete` clause on either FK — Postgres defaults to `NO ACTION` /
RESTRICT, matching `payments.booking_id` and `bookings`' own FKs. A booking
covered by a payout must not silently vanish.

`booking_id` needs no separate index: it is the primary key's leading column.
`payout_id` gets one explicitly, per the project's index-every-FK rule.

### A note on idempotency

Inline table constraints (the three `check`s above, the primary key) live
inside `create table if not exists` and are idempotent for free — a repeat
apply skips the whole statement. Only the `alter table` statements below need
`if not exists` / `do $$ ... $$` guards.

### `payments` — two columns

```sql
alter table payments add column if not exists refunded_at timestamptz;
alter table payments add column if not exists refund_note text;
```

Refund records live on `payments`, not on `bookings`. The thing being refunded
is a payment; the booking is a reservation. This is what lets one action handle
every refund shape — see *Three shapes of refund* below. `bookings` gains no
columns: the existing `refunded_manual` status plus the payment's record is the
complete picture.

### RLS

Both new tables get `enable row level security` with **zero policies**, like
every other table. No `force row level security`.

## The owed math

Per owner, over integer centavos:

```
owed = Σ owner_net_centavos   -- completed, no 'payment' stamp
     − Σ owner_net_centavos   -- refunded_manual, HAS a 'payment' stamp,
                              -- no 'clawback' stamp yet
```

As SQL, parameterized by an owner-id list so `/admin/payouts` (all owners) and
`/dashboard/earnings` (one owner) share one query:

```sql
with payable as (
  select b.owner_id, bk.id as booking_id, bk.owner_net_centavos
  from bookings bk
  join branches b on b.id = bk.branch_id
  where b.owner_id = any (${ownerIds}::uuid[])
    and bk.status = 'completed'
    and not exists (
      select 1 from payout_bookings pb
      where pb.booking_id = bk.id and pb.kind = 'payment'
    )
),
clawback as (
  select b.owner_id, bk.id as booking_id, bk.owner_net_centavos
  from bookings bk
  join branches b on b.id = bk.branch_id
  where b.owner_id = any (${ownerIds}::uuid[])
    and bk.status = 'refunded_manual'
    and exists (
      select 1 from payout_bookings pb
      where pb.booking_id = bk.id and pb.kind = 'payment'
    )
    and not exists (
      select 1 from payout_bookings pb
      where pb.booking_id = bk.id and pb.kind = 'clawback'
    )
)
-- owed = coalesce(sum(payable.net), 0) - coalesce(sum(clawback.net), 0)
```

Alongside it, per owner: **prepared** = `sum(payouts.net_centavos)` where
`status = 'pending'`, and **lifetime paid** = the same sum where
`status = 'paid'`.

**Blocks are excluded for free.** `complete_past_bookings()` only ever moves
`confirmed` → `completed`, so a `blocked` row can never enter the pool. Scoping
to `status = 'completed'` needs no extra predicate and no ₱0 lines are ever
written.

**A prepared payout removes its bookings from the pool** — they are spoken for.
That is why `prepared` is displayed separately from `owed`.

### A payout's three money columns

Over the bookings a payout covers, payment lines counting positive and clawback
lines negative:

```
gross_centavos = Σ total_charged_centavos
net_centavos   = Σ owner_net_centavos          (= Σ payout_bookings.net_centavos)
fee_centavos   = gross_centavos − net_centavos
```

Defining `fee` as the difference rather than as its own sum is deliberate: it
cannot drift from the other two. It equals platform fee plus the
processor fee the owner actually bore, which is exactly what
`getOwnerEarnings` in `src/lib/owner/queries.ts` already reports — and that
identity holds for all three processor-fee bearers, so a payout and the
earnings table can never disagree about the same booking.

`gross` and `fee` are **signed adjustments and may be negative**: when an
owner's fee rate changes between a clawed-back booking and the bookings
absorbing it, the clawback's negative gross can exceed the payment lines' gross
even while `net` stays positive. `net` is the load-bearing figure — it is what
gets transferred, and `net > 0` is the check constraint on the row. Deliberately
no check constraint on `gross`/`fee`: one would reject a payout whose `net` is
correct and positive, leaving the clawback permanently unabsorbable and the
owner unpayable with no escape hatch.

## Three shapes of refund

`src/lib/payments/webhook.ts` sets `needs_refund` on payments whose booking is
`expired` or still `pending_payment` — documented at
`src/app/bookings/[id]/page.tsx:66`. Those payments have **no owner credit to
reverse**: money needs returning, but nothing ever entered the ledger.

| Shape | Booking | Effect |
|---|---|---|
| Booking refund (a dispute) | `confirmed` / `completed`, and this payment is the only live paid one | Payment stamped, flag cleared, booking → `refunded_manual`, ledger adjusts |
| Duplicate refund (a flagged double charge) | `confirmed` / `completed`, still funded by another live paid payment | Payment stamped, flag cleared, **booking untouched**, no ledger effect |
| Orphan payment refund | `pending_payment` / `expired` | Payment stamped, flag cleared, booking untouched, no ledger effect |

The middle row is not a special case of the first, and an earlier draft of this
document wrongly collapsed the two. *"A payment whose booking is confirmed"* and
*"the payment that confirmed the booking"* are the same thing right up until a
double charge, where they are precisely not: the webhook's `double_charge`,
`not_payable` and `amount_mismatch` shapes all flag a paid payment sitting on a
booking a **different** payment legitimately funded. Flipping that booking would
remove the owner's legitimate `owner_net` from the payable pool while the
platform keeps the original payment, show the player a refunded booking whose
money is still held, and free the slot — `bookings_no_overlap` excludes
`refunded_manual` from its predicate, so another player could book over a paid,
confirmed slot. The booking flip is therefore scoped by whether any **other**
live paid payment still covers the booking, not by the booking's status alone.

One payment-scoped action covers all three. A booking-scoped action would have
no row to write in the orphan case, which is precisely the case the webhook
generates most often, and no way to tell the duplicate apart from the payment it
duplicates.

**Full refunds only.** The amount refunded is the payment's
`amount_centavos`. Partial refunds are out of scope; the extension point is a
`refund_amount_centavos` column on `payments`.

## Modules

Four focused modules under `src/lib/`, following the existing split between
read modules (`src/lib/owner/queries.ts`, `src/lib/admin/queries.ts`) and write
modules (`src/lib/admin/write.ts`, `src/lib/listings/write.ts`):

- `src/lib/payouts/ledger.ts` — the owed query above, parameterized by owner-id
  list; payout history reads.
- `src/lib/payouts/write.ts` — `preparePayout`, `markPayoutPaid`.
- `src/lib/refunds/queries.ts` — the flagged queue, the lookup.
- `src/lib/refunds/write.ts` — `recordPaymentRefund`.

The `'use server'` files (`src/app/admin/payouts/actions.ts`,
`src/app/admin/refunds/actions.ts`) stay thin: `refuseUnlessAdmin()` first,
parse the form, call the lib. Logic does not live in them — every export of a
`'use server'` file is a client-invokable endpoint, which is why
`src/lib/admin/guard.ts` exists as a shared module rather than as an export of
either action file.

### `preparePayout(ownerId)`

One transaction:

1. `select pg_advisory_xact_lock(hashtext('payout:' || ownerId))` — keyed on the
   owner, so it never serializes unrelated admin traffic. Same shape and same
   reasoning as the booking hold's per-player lock.
2. Resolve the payable set and the clawback-due set.
3. If net ≤ 0, return "nothing to pay" and write **nothing at all** — including
   no clawback lines. An outstanding clawback stays outstanding and reappears
   in every subsequent computation until a payout large enough to absorb it is
   actually prepared. A negative balance is therefore a standing adjustment,
   never a written-off one.
4. Insert the `payouts` row: `status = 'pending'`, gross/fee/net snapshots,
   `period_start`/`period_end` from the min/max Manila date of the **payment**
   lines only (a clawback can be from any earlier period and must not stretch
   the label).
5. Insert one `payout_bookings` row per booking — `kind = 'payment'` with
   positive net, `kind = 'clawback'` with negative net.

The primary key is the real arbiter; the lock exists so two concurrent prepares
queue cleanly instead of colliding mid-write.

A payout always has at least one `payment` line, because `net > 0` cannot be
reached from clawbacks alone.

### `markPayoutPaid(payoutId, note)`

A status-scoped UPDATE: `where id = ? and status = 'pending'`, setting
`status = 'paid'`, `paid_at = now()`, `note`. Zero rows updated is a meaningful
answer — "it already moved" — not an error. This is the shape all four of
`src/lib/admin/write.ts`'s court transitions already use.

### `recordPaymentRefund(paymentId, note)`

One transaction:

1. `update payments set needs_refund = false, refunded_at = now(), refund_note = ?
   where id = ? and refunded_at is null and status = 'paid'`. Zero rows =
   already recorded (or a paymentId that was never paid — see below), return
   as such. The `status = 'paid'` guard is the database-scoped enforcement
   against a forged or stale `paymentId`: a Server Action reads it from
   `FormData`, which accepts any string regardless of what the page rendered,
   and an abandoned checkout's payment row can sit at `status = 'pending'`
   forever once a different session's payment confirms the same booking. The
   UI-level gate ("Lookup finds a booking with no paid payment → no refund
   form") remains the usability layer on top of this, not a substitute for it.
2. `update bookings set status = 'refunded_manual'
   where id = <that payment's booking> and status in ('confirmed', 'completed')`.
   Zero rows here is the **expected** outcome for the orphan shape, not a
   failure.

## Surfaces

Admin nav goes from three items to five: Approvals, Owners, **Payouts**,
**Refunds**, Settings. `src/app/admin/layout.tsx` currently documents why
Payouts is absent ("later slices ... an item pointing at a 404 is worse than no
item"); that comment gets updated as the items land.

### `/admin/payouts`

One row per owner: business name, **owed**, **prepared** (awaiting transfer),
**lifetime paid**. A "Prepare payout" form appears only when owed > 0. Owners
with nothing owed still list, showing zeros — the same choice the earnings page
already makes for a zero-booking month.

No pagination, matching every other admin and dashboard list.

### `/admin/payouts/[ownerId]`

- Pending payouts, each with its lines and a Mark-paid form taking a reference
  note.
- Payout history (paid), newest first.
- The bookings currently in the payable pool.

**One thing this page must do:** if a pending payout contains a line whose
booking has since become `refunded_manual`, flag that line visibly. The clawback
would net it off next payout regardless, but the two-step flow exists precisely
so the admin can catch it before the money leaves.

### `/admin/refunds`

- **Flagged queue** — payments with `needs_refund`, newest first, each showing
  the booking, its status, the player, the amount, and why it is flagged
  (inferable from booking status plus amount vs. quote). Each row carries a
  record-refund form taking a note.
- **Lookup** — a single text input. If the value parses as a uuid it is treated
  as a booking id; otherwise as a player email (exact, case-insensitive). One
  field rather than two, because the admin always has exactly one of the two in
  front of them and picking a radio button first is friction with no payoff.
  Results show the booking, its status, and its payments, with the same
  record-refund form. A booking with no paid payment shows no form: there is
  nothing to return.

### `/dashboard/earnings`

A **Payouts** section below the existing table:

- **Pending payout** — what is owed right now, owner-wide.
- **History** — recorded payouts: period, amount, date paid, note.

Gated on `view_earnings` (the page already redirects without it). Shown
**owner-wide**, not per-branch, because a payout is not a per-branch object —
which means a staff member holding `view_earnings` on only some branches sees
owner-wide payout figures. That is a deliberate, documented consequence of
payouts being owner-scoped.

The section carries its own heading and an explicit note that it is **not**
filtered by the month navigator above it. The earnings table is month-scoped;
payouts do not decompose by month, and the two sitting on one page without that
note would read as a contradiction.

All three pages follow `design/branding.md` — control tokens, radius, the
no-gradients rule — and reuse `StatCard`, the existing table shell, and the
admin card patterns rather than inventing new ones.

## Edge cases

| Case | Behavior |
|---|---|
| Two admins prepare the same owner concurrently | Advisory lock serializes; the second finds an empty pool and returns "nothing to pay" |
| A booking completes mid-prepare | Whatever the pool held at lock time is stamped; the rest lands in the next payout |
| Mark-paid submitted twice | Status-scoped UPDATE, zero rows = "already recorded" |
| Refund recorded twice | `refunded_at is null` guard makes the second a no-op |
| Refund on a booking inside a *pending* payout | Allowed; flagged on the detail page; clawback nets it next payout |
| Refund of an orphan payment | Flag cleared, note recorded, no status flip, no ledger effect |
| `owed` is negative | No Prepare button; the figure displays negative and nets off future earnings |
| Owner with no branches or no completed bookings | owed 0, no button, row still lists |
| Lookup finds a booking with no paid payment | No refund form |
| A court or branch is suspended | Irrelevant to the ledger — suspension never touches `bookings`, per `src/lib/admin/write.ts` |

## Testing

Against the hosted Supabase project over the Supavisor **session** pooler (port
5432, never 6543 — `preparePayout` depends on `pg_advisory_xact_lock`). The
database is shared and persistent, so every test must pass on repeated runs and
must not mutate seeded singleton rows.

**Ledger math** (`tests/payouts/ledger.test.ts`)
- Completed bookings with no stamp sum into owed.
- A stamped booking is excluded.
- `confirmed`, `pending_payment`, `expired`, and `blocked` bookings never enter
  the pool.
- A booking refunded *before* payout is simply absent — no clawback line.
- A booking refunded *after* payout produces a negative adjustment.
- A booking already clawed back does not produce a second adjustment.
- Prepared vs. paid totals are reported separately.

**Prepare** (`tests/payouts/write.test.ts`)
- Stamps exactly the payable set, with a positive line per booking.
- Clawback lines are negative and reference the right bookings.
- `period_start`/`period_end` come from the payment lines only, not clawbacks.
- Net ≤ 0 writes nothing and reports "nothing to pay".
- **Concurrency:** N parallel prepares for one owner produce exactly one payout;
  the rest report an empty pool.

**Schema** (`tests/schema/payouts.test.ts`)
- The `(booking_id, kind)` primary key rejects a second `payment` stamp for the
  same booking, and permits a `clawback` stamp alongside it.
- `net_centavos > 0` rejects a zero and a negative payout.
- `(status = 'paid') = (paid_at is not null)` rejects both violating shapes.

**Refunds** (`tests/refunds/write.test.ts`)
- A `confirmed` booking flips to `refunded_manual`, its payment is stamped, the
  flag clears.
- A `completed` booking does the same.
- An orphan payment on an `expired` booking clears the flag and leaves the
  booking's status alone.
- A replay is a no-op and reports as already recorded.

**Queries** (`tests/refunds/queries.test.ts`)
- The flagged queue returns only `needs_refund` payments, and drops one once
  recorded.
- Lookup matches by player email and by booking id.

**Authorization** — the existing `tests/auth/action-coverage.test.ts` asserts
every exported Server Action calls a guard, and picks up the two new action
files automatically. No new test needed; it must stay green.

**Migration idempotency** is proven by *reading* the SQL for `if not exists` /
`pg_constraint` guards on every statement. A second `supabase db push` is
skipped rather than re-run, so it proves nothing.

**Fixtures** — `tests/helpers/fixtures.ts` deletes payments before bookings
today because of the RESTRICT FK. `payout_bookings` and `payouts` add the same
dependency, so teardown order becomes:

```
payout_bookings → payouts → payments → bookings
```

## Out of scope

- **Partial refunds.** Full only; extension point noted above.
- **Automated payouts.** PayMongo Platforms sub-accounts remain Phase 2.
- **Cancellations and self-service refunds.** Phase 2, unchanged.
- **Cancelling a prepared payout.** The two-step flow has no unstamp path. If a
  prepared payout is wrong, the clawback mechanism corrects it on the next one.
  Note the limit of that: the clawback corrects a *refunded* booking, not an
  *abandoned prepare* — bookings stamped by a payout nobody ever marks paid are
  permanently neither payable nor paid, and the list page's "Prepared" column is
  what makes them visible.
- **The admin all-bookings list.** Its own later slice; `/admin/refunds`' lookup
  covers the dispute path without preempting it.
- **Refund notification email.** Belongs to the Resend slice, which owns all
  five lifecycle emails together.
