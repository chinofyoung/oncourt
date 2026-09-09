# Manual payment mode — design

**Status:** Approved design, pending implementation
**Date:** 2026-09-08
**Supersedes nothing.** Extends `docs/superpowers/specs/2026-07-31-pickleball-court-booking-platform-design.md`,
which assumes every booking is paid online through PayMongo and does not
contemplate an offline rail.

## Summary

A court owner can run on OnCourt without accepting online payments. Players
booking that owner's courts pay by bank transfer or e-wallet directly to the
owner, upload a screenshot of the transfer, and the **owner** reviews that
screenshot and confirms the booking.

An admin decides which rail each owner is on: `automated` (PayMongo, with the
normal platform fee) or `manual` (offline, **no platform fee**). The two modes
are mutually exclusive per owner. `automated` is the default; manual must be
granted explicitly.

## Decisions

These were settled during brainstorming and are not open questions:

| Question | Decision |
|---|---|
| How does OnCourt earn on manual bookings? | **It doesn't.** Manual mode carries no commission. No ledger of owner debt, no invoicing, no arrears. |
| Who verifies the transfer screenshot? | **The court owner.** They are the only party who can see their own bank/e-wallet account. Admin is not in the per-booking loop. |
| How long is the slot held awaiting review? | **Owner-configurable window**, capped at the booking's own start time. Auto-expires when it runs out. |
| Scope of payment details? | **Per-owner, a list of methods.** Each is a bank account or an e-wallet, each may carry its own QR image. |
| Cancellations / refunds? | **Out-of-band, tracked as a status.** OnCourt never held the money and cannot move it. The existing admin refunds queue stays PayMongo-only. |
| When does the player upload proof? | **Required to submit.** No proof, no booking — the booking is created already awaiting review. |
| Can an owner run both rails? | **No.** Mutually exclusive. |
| Default for a new owner? | **`automated`.** Nobody lands in the free tier by accident. |

## Why this is not just another `PaymentProvider`

`src/lib/payments/provider.ts` is shaped around a hosted redirect plus a
webhook: `createCheckoutSession` returns a `checkoutUrl`,
`verifyWebhookSignature` and `parsePaidEvent` consume a signed callback, and
`retrieveSession` is a pull-mode fallback. A manual rail has no session URL, no
signature, no provider event, and no pull endpoint. Forcing it through that
interface would mean four methods that either throw or lie.

Manual mode is therefore a **second rail alongside** the provider abstraction,
not a second implementation of it. `PaymentProvider` and PayMongo are untouched.

## Data model

### Mode flag, on `profiles`

```sql
create type payment_mode as enum ('automated', 'manual');

alter table profiles
  add column payment_mode payment_mode not null default 'automated',
  add column manual_review_minutes integer;

alter table profiles add constraint profiles_manual_review_window
  check (manual_review_minutes is null
         or (manual_review_minutes >= 30 and manual_review_minutes <= 10080));
```

`payment_mode` is **not-null with a default**, deliberately unlike the fee
override's nullable-plus-`coalesce` pattern
(`profiles.platform_fee_mode` et al., resolved at `src/lib/booking/hold.ts:258-267`).
There is no platform-wide default for a rail to inherit, so a null would just
be a third way to spell `automated`.

Writers, following `updateOwnerFeeOverride` (`src/lib/admin/settings.ts:212`)
exactly:

- `payment_mode` — **admin only**, `where id = … and role in ('owner','admin') returning id`.
- `manual_review_minutes` — **owner only**, via the owner settings surface.

`manual_review_minutes` null means the platform default (see
`platform_settings` below).

### Rail snapshot, on `bookings`

```sql
alter table bookings
  add column payment_mode payment_mode not null default 'automated';
```

Resolved once at hold time and never re-derived, in the same spirit as
`fee_config_snapshot`. This column is load-bearing for two reasons:

1. It is what excludes manual bookings from the payout pool.
2. An admin flipping an owner's mode must never rewrite the rail of a booking
   already in flight.

### Owner payment methods

```sql
create type payment_method_kind as enum ('bank', 'ewallet');

create table owner_payment_methods (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  kind payment_method_kind not null,
  institution text not null,        -- "BPI", "GCash"
  account_name text not null,
  account_number text not null,     -- account number, or mobile number for a wallet
  qr_storage_path text,
  position integer not null,
  created_at timestamptz not null default now()
);

create index on owner_payment_methods (owner_id);
```

`position` is resequenced in one transaction the way `movePhoto`
(`src/lib/listings/photos.ts`) already does. RLS enabled with zero policies,
like every other table.

### Proof of payment

```sql
create type manual_proof_status as enum ('pending', 'approved', 'rejected');

create table manual_payment_proofs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings(id),
  owner_payment_method_id uuid references owner_payment_methods(id) on delete set null,
  paid_to_snapshot jsonb not null,   -- {kind, institution, account_name, account_number}
  storage_path text not null,
  reference_note text,
  status manual_proof_status not null default 'pending',
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references profiles(id),
  rejection_reason text
);

create index on manual_payment_proofs (booking_id);
create index on manual_payment_proofs (owner_payment_method_id);
create index on manual_payment_proofs (status) where status = 'pending';
```

**`paid_to_snapshot` exists because the FK alone cannot carry this record.**
The first draft of this spec made `owner_payment_method_id` `not null` with the
default `NO ACTION`, reasoning that a proof must keep pointing at the account it
was paid into. That deadlocks with owner deletion: `owner_payment_methods`
cascades from `profiles`, which cascades from `auth.users`, so deleting an owner
would try to cascade into a restricting FK and fail — breaking, among other
things, the test-fixture teardown in `tests/helpers/fixtures.ts`, which deletes
by cascading from `auth.users`.

Snapshotting the account details onto the proof at submission time resolves it
in the right direction: the FK becomes nullable `on delete set null`, the
cascade completes, and the proof retains a human-readable record of exactly
which account was paid even after the method is edited or removed. This is the
same reasoning that puts `fee_config_snapshot` on `bookings` — resolve once,
store the resolution, never re-derive it from mutable config.

An owner may still delete a payment method freely; live proofs keep their
snapshot.

### Platform default for the review window

```sql
alter table platform_settings
  add column default_manual_review_minutes integer not null default 1440;
```

Resolved as `coalesce(profiles.manual_review_minutes, platform_settings.default_manual_review_minutes)`
— the same `coalesce` shape the fee resolution already uses, at the same single
resolution point.

### Why manual bookings are not written to `payments`

`payments` is shaped around provider semantics: `provider_session_id`,
`provider_payment_id unique` (the idempotency primitive), `needs_refund`, and a
`raw_event` blob. The admin refunds queue
(`src/lib/refunds/queries.ts`, `src/lib/refunds/write.ts:74`) reads directly off
that table and is payment-scoped. Manual rows would surface there as junk that
admin can neither refund nor dismiss.

The money columns on `bookings` already carry the amounts, so nothing about the
booking record is lost. `manual_payment_proofs` is the manual rail's payment
record.

A useful consequence: manual bookings stay out of the admin refunds queue with
**no filter**, because the queue starts from a `payments` row that never exists.

## Booking and verification flow

### New booking status

```sql
alter type booking_status add value if not exists 'pending_verification';
```

Its own migration file — adding a value to an existing enum cannot share a
transaction with anything that uses it (55P04), the same rule
`20260805090000_booking_status_blocked.sql` already follows.

`bookings_no_overlap` is rebuilt to include `pending_verification`. Occupying
the slot is the entire point of the state.

The four `bookings_*_unless_blocked` CHECKs from
`20260805090100_branch_staff_and_blocks.sql` are unaffected: a manual booking
has a real player and a real `fee_config_snapshot`.

### Submission

Proof is required to submit, so there is no state where a manual booking exists
without one.

1. Player picks a slot on a manual-mode court, sees the owner's payment methods
   and QR, pays in their own banking app.
2. Player uploads the screenshot and optionally types a reference number.
3. **The screenshot uploads to storage before the transaction opens.** Storage
   is not transactional; this is the object-first order `addPhoto`
   (`src/lib/listings/photos.ts:44`) already uses.
4. One transaction, reusing `src/lib/booking/hold.ts` end to end — the same
   per-player `pg_advisory_xact_lock`, `MAX_CONCURRENT_HOLDS = 3`, court-approved
   check, operating-hours window, `slot_elapsed` computed in SQL rather than from
   a JS clock, stale-hold sweep, and `bookings_no_overlap` as the arbiter. It
   inserts the booking as `pending_verification` plus the
   `manual_payment_proofs` row, resolving `paid_to_snapshot` from the chosen
   payment method in the same statement so the record is fixed at submission
   time.
5. If the insert loses the race (`23P01`/`40P01` → `slot_taken`), the uploaded
   object is removed — the same compensating cleanup `addPhoto` performs on a
   `23503`.

`expires_at = least(now() + review window, starts_at)`. Holding a slot past the
time it was booked for is meaningless.

### Fees

Manual mode branches ahead of the fee resolution at `hold.ts:258-267`:

| Column | Manual value |
|---|---|
| `court_fee_centavos` | from `court_rate_bands`, unchanged |
| `platform_fee_centavos` | `0` |
| `processor_fee_centavos` | `0` |
| `transaction_fee_centavos` | `0` |
| `total_charged_centavos` | `= court_fee_centavos` |
| `owner_net_centavos` | `= court_fee_centavos` |
| `fee_config_snapshot` | `{"mode":"manual"}` |

`computeFees` in `src/lib/payments/fees.ts` is **not** called for a manual
booking and is not modified. `bookings_owner_net_non_negative` is satisfied
trivially.

### Owner review

A new `approveManualProof(bookingId, ownerId)` in `src/lib/payments/manual.ts`.

This makes **`handlePaidEvent` no longer the only writer of `confirmed`** — a
deliberate change to an invariant documented at `src/lib/payments/webhook.ts:74`,
whose doc comment must be updated to say so. The new writer mirrors its
discipline:

- one READ COMMITTED transaction
- `for update` on the booking, `slot_elapsed` re-read in SQL
- status-scoped `where status = 'pending_verification'`, so zero rows means
  "it already moved" rather than an error
- `booking_confirmed` email enqueued **inside** the transaction via
  `enqueueEmail(tx, …)`; the network send stays in the drain worker

Rejection sets the proof to `rejected` with a reason and the booking to
**`expired`** — the existing "hold is over, slot is free" state, already
excluded from `bookings_no_overlap`. No new enum value. The proof row's
`rejection_reason` is what the player's booking page renders, so `expired`
never has to carry two meanings for a human reader.

Both actions are guarded by `requireBranchAccess` for the court's branch, so
branch staff with the right permission can review too.

### Emails

Three new `email_kind` values, all enqueued inside their transaction via
`enqueueEmail(tx, …)` and sent by the existing drain worker:

| Kind | To | When |
|---|---|---|
| `manual_proof_submitted` | owner | a player submits proof — this is the only thing that tells an owner there is something to review |
| `manual_proof_rejected` | player | the owner rejects, carrying `rejection_reason` |
| `manual_review_expired` | player | the review window ran out unreviewed |

`booking_confirmed` (player) and `booking_new` (owner) are reused unchanged on
approval.

`email_kind` is an enum, so **these values need their own migration file**, the
same 55P04 rule that splits the `booking_status` change out. The unique
`(booking_id, kind)` index on `email_outbox` (as rebuilt by
`20260812010000_refund_email_per_payment.sql`) already gives each of these
once-per-booking semantics, which is the behaviour we want.

`manual_review_expired` is enqueued by the expiry sweep. Because
`expire_stale_holds()` is a SQL cron function rather than application code, that
email is enqueued by an `insert … select` inside the same function rather than
through `enqueueEmail` — this is a genuine deviation from the "emails are
enqueued from TypeScript" pattern and should be called out in the function's
comment. The alternative, moving expiry into a Route Handler drainer like
`src/app/api/cron/drain-email/route.ts`, is a larger change than this feature
justifies.

### Expiry

`expire_stale_holds()` (`supabase/migrations/20260801110350_storage_and_cron.sql:28`)
knows only `pending_payment`. It is extended to sweep `pending_verification` on
the same `expires_at <= now()` rule.

The in-transaction sweep at `hold.ts:221` needs the same widening — the
exclusion-constraint predicate cannot call `now()`, which is exactly why that
sweep exists.

An expired-unreviewed booking is distinguishable from an expired-unpaid one by
its proof row (`status = 'pending'`, never reviewed), which the player's
booking page uses to explain what happened.

### Cancellation

The owner can cancel a confirmed manual booking with a note, moving it to the
existing `refunded_manual` status. Settling with the player happens on the
channel they were paid. OnCourt records that it is owed, not that it moved
money.

## Storage

Both existing buckets are `public = true`. A transfer screenshot shows a bank
account number, an account holder's name, and often a balance. It cannot live
in a public bucket.

| Bucket | Public | Contents |
|---|---|---|
| `payment-proofs` | **no** | Player-uploaded transfer screenshots |
| `payment-qr` | yes | Owner-uploaded payment QR codes |

`payment-proofs` is the project's **first private bucket**. Reads go through
short-lived signed URLs minted server-side, issued only to the booking's own
player and to the court's owner/branch staff. This requires adding
`createSignedUrl` to the `StorageClient` interface in
`src/lib/listings/storage.ts`, which today exposes only `upload` and `remove`.
It stays a constructor/parameter dependency everywhere so tests keep faking the
one un-rollbackable boundary.

`payment-qr` is public for the same reason `branch-photos` is: a QR code exists
to be shown to whoever is about to pay.

Both reuse the gates in `src/lib/photos.ts` unchanged — `MAX_PHOTO_BYTES`
(5 MB), `ALLOWED_PHOTO_TYPES` (JPEG/PNG/WebP), UUID filenames, never the
uploaded filename.

## Surfaces

### Owner

- **Settings** (`src/app/dashboard/settings/`, today business name and logo
  only) gains a payment-methods section: add, edit, remove, reorder, and a QR
  upload per method. Plus the review-window field. Both are visible regardless
  of the owner's current mode, so an owner can be ready before admin flips them.
- **Verification queue**, a new dashboard page: pending proofs with the
  screenshot, amount, slot, player, and approve/reject controls. Ordered oldest
  first, with the remaining review time shown per row.
- Scoped through `loadDashboardAccess`/`branchIdsWith` like every other
  dashboard page.

### Player

- The venue and court pages carry a **manual-pay badge before the player
  commits**. Discovering the payment method at checkout is a bad surprise.
- Checkout swaps the PayMongo redirect for: the owner's payment methods, the
  selected method's QR, the amount to send, a reference-number field, and the
  screenshot upload.
- The booking detail page shows "waiting for the owner to confirm" with the
  deadline, or the rejection reason, or the confirmation.

### Admin

- `/admin/owners` gains a payment-mode control beside the existing fee-override
  form, with the same `refuseUnlessAdmin()` + `idFrom()` + role-scoped-`WHERE`
  shape.
- **Save-time guard:** flipping an owner to `manual` is refused unless they have
  at least one payment method. Otherwise their courts become unbookable the
  instant the switch lands. This mirrors how `cheapestApprovedRateCentavos`
  (`src/lib/admin/settings.ts:128`) refuses a fee that would exceed the owner's
  cheapest rate.
- Flipping back to `automated` is always allowed. In-flight bookings keep their
  snapshotted rail.
- The owners directory shows each owner's effective mode, the way it already
  shows `effectiveFeeLabel`.

## Payouts — the cut-off

`ledgerRows` (`src/lib/payouts/ledger.ts:45`) sums `owner_net_centavos` over
every `completed` booking. A manual booking's `owner_net` is the full court fee,
which OnCourt never collected.

**Without an explicit exclusion, every completed manual booking reads as a debt
OnCourt owes the owner.** The ledger query gains
`and b.payment_mode = 'automated'`.

Manual bookings therefore never enter the payable pool, never produce a
`payout_bookings` line of either kind, and never produce a clawback. The
`payouts` and `payout_bookings` tables are otherwise untouched.

## Testing

Against the hosted Supabase project, per project convention — the DB
constraints are the logic. Tests must pass on repeated runs and must not mutate
seeded singleton rows.

- `bookings_no_overlap` blocks a second booking against a `pending_verification`
  hold; approve keeps the slot, reject and expiry free it
- two concurrent approvals land once — the loser's status-scoped update returns
  zero rows and is reported as already-moved, not as an error
- every fee column is zero on a manual booking, `total_charged == court_fee`,
  `owner_net == court_fee`, and `fee_config_snapshot` says `{"mode":"manual"}`
- **the payout ledger returns nothing for a completed manual booking** — the
  regression that would otherwise pay owners for money OnCourt never received
- `expires_at` is capped at `starts_at` when the review window would overrun it
- both expiry paths sweep `pending_verification`: the cron function and the
  in-transaction sweep in `hold.ts`
- the admin flip to manual is refused when the owner has no payment method
- deleting a payment method a proof references nulls the FK and leaves
  `paid_to_snapshot` intact and readable
- deleting the owner's `auth.users` row cascades all the way through
  `owner_payment_methods` and `manual_payment_proofs` without a FK error — the
  case that forced the snapshot design, and the one the fixture teardown hits
- a signed proof URL is not issued to an unrelated player
- the booking's `payment_mode` snapshot survives an admin flipping the owner's
  mode mid-flight
- migration applies twice cleanly (idempotency, since `supabase db reset` is
  unavailable)

## Migrations

Slotting in after `20260812010000_refund_email_per_payment.sql`:

1. `20260908000000_manual_payment_mode.sql` — `payment_mode`,
   `payment_method_kind`, `manual_proof_status` enums; the `profiles` and
   `bookings` columns; `platform_settings.default_manual_review_minutes`;
   `owner_payment_methods`; `manual_payment_proofs`; the two storage buckets.
2. `20260908000100_booking_status_pending_verification.sql` — the
   `booking_status` value alone, per 55P04.
3. `20260908000200_manual_email_kinds.sql` — the three `email_kind` values
   alone, same rule.
4. `20260908000300_no_overlap_pending_verification.sql` — rebuild
   `bookings_no_overlap` to include `pending_verification`, and extend
   `expire_stale_holds()` to sweep it. Must come after (2), since a constraint
   predicate cannot reference an enum value added in the same transaction.

Each written idempotently (`if not exists`, guarded `DO` blocks qualified by
`conrelid`, `drop constraint if exists` + `add`). Regenerate types with
`drizzle-kit pull` afterwards.

## Out of scope

- Mixed mode — an owner is on one rail or the other
- Partial or split payments
- Automated OCR, amount-matching, or any machine verification of the screenshot
- Any platform fee, subscription, or owner-debt ledger for manual bookings
- Admin review of individual proofs (admin controls the mode, not the bookings)
- Self-service player cancellation, which remains out of scope platform-wide

## Documentation

`design/branding.md` is updated in the same pass with the new UI patterns — the
manual-pay badge, the payment-method card, and the proof-review row — per the
project rule that a design-system change lands with the doc.
