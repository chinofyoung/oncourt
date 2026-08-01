-- court_id/branch_id/player_id deliberately carry NO `on delete` clause
-- (Postgres default: NO ACTION/RESTRICT), unlike every FK above this table
-- in the schema (profiles.id -> auth.users, branches.owner_id -> profiles,
-- courts.branch_id -> branches, all ON DELETE CASCADE). That inconsistency
-- across migrations was flagged in the final whole-branch review: three
-- tasks made three different choices with nothing tying them together.
-- RESTRICT is the correct choice HERE specifically, not an oversight:
-- bookings are financial records (they carry court_fee_centavos,
-- platform_fee_centavos, owner_net_centavos, a fee_config_snapshot) and
-- must not silently vanish because someone deleted a court, a branch, or a
-- player's account. `delete from auth.users where id = <owner or player>`
-- raises 23503 as soon as one booking exists under them, and that is the
-- intended behavior, not a bug to fix — deleting an account with financial
-- history requires an explicit decision (anonymize? retain for tax/dispute
-- records? block the deletion in the UI?) that this schema does not make
-- for you. tests/schema/bookings.test.ts's "deleting a player with an
-- existing booking is rejected, not cascaded" and "deleting a branch owner
-- with an existing booking under their court is rejected, not cascaded"
-- pin this exact behavior (both directions: player_id and court_id) so it
-- is documented by a test, not by omission.
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references courts (id),
  branch_id uuid not null references branches (id),   -- denormalized for owner/admin reads
  player_id uuid not null references profiles (id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- Half-open '[)' bounds so 17-18 and 18-19 coexist while real overlaps are caught.
  slot tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,
  status booking_status not null default 'pending_payment',
  expires_at timestamptz,
  court_fee_centavos integer not null check (court_fee_centavos >= 0),
  transaction_fee_centavos integer not null default 0 check (transaction_fee_centavos >= 0),
  total_charged_centavos integer not null check (total_charged_centavos >= 0),
  platform_fee_centavos integer not null check (platform_fee_centavos >= 0),
  processor_fee_centavos integer not null default 0 check (processor_fee_centavos >= 0),
  owner_net_centavos integer not null,
  fee_config_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  constraint bookings_time_order check (ends_at > starts_at),
  constraint bookings_hold_has_expiry check (
    status <> 'pending_payment' or expires_at is not null
  )
);

create index if not exists bookings_court_id_idx  on bookings (court_id);
create index if not exists bookings_branch_id_idx on bookings (branch_id);
create index if not exists bookings_player_id_idx on bookings (player_id);
-- Drives the availability grid: one court, one day.
create index if not exists bookings_court_starts_at_idx on bookings (court_id, starts_at);
-- Drives the pg_cron janitor.
create index if not exists bookings_expiring_idx on bookings (expires_at)
  where status = 'pending_payment';

-- Double-booking is structurally impossible. 'expired' and 'refunded_manual'
-- are excluded because they do not occupy the slot. An expired-but-unswept
-- hold still has status 'pending_payment', which is why hold creation must
-- expire stale rows inside the same transaction (see src/lib/booking/hold.ts).
-- The `court_id with =` equality term needs btree_gist (installed in
-- 20260801042931_settings_and_enums.sql) to be usable inside a GiST index.
-- Exclusion constraints have no `IF NOT EXISTS` form, so this sits inside a
-- guarded DO block for idempotency across repeated `db push` applies.
-- Qualified by conrelid, not just conname: pg_constraint is a GLOBAL catalog
-- and constraint names are only unique per-table, not per-schema. An
-- unqualified `where conname = 'bookings_no_overlap'` would be satisfied by
-- a same-named constraint on any other table anywhere in the database,
-- silently skipping the ALTER TABLE below and shipping `bookings` with no
-- exclusion constraint at all on a fresh environment build — no error, just
-- a missing invariant.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass and conname = 'bookings_no_overlap'
  ) then
    alter table bookings add constraint bookings_no_overlap
      exclude using gist (court_id with =, slot with &&)
      where (status in ('pending_payment', 'confirmed', 'completed'));
  end if;
end $$;

alter table bookings enable row level security;
