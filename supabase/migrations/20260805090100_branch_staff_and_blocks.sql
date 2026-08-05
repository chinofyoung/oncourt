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
