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
