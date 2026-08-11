-- Final whole-branch review of the admin fee settings feature, MUST-FIX #1:
-- a flat platform fee configured at or above a court's cheapest hourly rate
-- makes `owner_net_centavos = court_fee_centavos - platform_fee_centavos`
-- negative in src/lib/booking/hold.ts (a ₱500 flat fee on a ₱300 court gives
-- owner_net = -20000), and nothing in the schema caught it: `bookings` has
-- `>= 0` CHECKs on court_fee_centavos, transaction_fee_centavos,
-- total_charged_centavos, platform_fee_centavos and processor_fee_centavos
-- (20260801070328_bookings.sql, 20260807090000_payments.sql) but never on
-- owner_net_centavos. The negative value reaches sum(bk.owner_net_centavos)
-- in src/lib/owner/queries.ts and renders on the owner's earnings page, with
-- no error anywhere.
--
-- src/lib/admin/settings.ts now refuses to SAVE a flat fee that meets or
-- exceeds the cheapest approved court's rate — for both the platform default
-- (updatePlatformSettings) and a per-owner override (updateOwnerFeeOverride),
-- via cheapestApprovedRateCentavos. That is a save-time guard, not a database
-- invariant: this project's rule is that TypeScript is the security boundary
-- and the database is the backstop for anything TypeScript gets wrong or
-- never reaches — a row written before the guard existed, or some future
-- write path that forgets to call it. This constraint is that backstop.
--
-- 0 is allowed, not just values > 0: a 'blocked' booking's
-- bookings_blocked_is_free constraint (20260805090100_branch_staff_and_blocks
-- .sql) requires every money column, owner_net_centavos included, to be
-- exactly 0 — this constraint must not conflict with that one, so it is
-- `>= 0`, matching the pattern every other money column on this table already
-- uses.
--
-- Verified before writing this migration: `select count(*) from bookings
-- where owner_net_centavos < 0` against the live hosted database returned 0
-- — no existing row would violate this constraint. Had that count been
-- non-zero, the correct response would have been to stop and report it, not
-- to weaken this CHECK or delete rows.
--
-- Guarded exactly like bookings_player_unless_blocked et al. in
-- 20260805090100_branch_staff_and_blocks.sql: a conrelid-qualified existence
-- check in a DO block, so a literal replay is a true no-op. `supabase db
-- reset` is unavailable on this project, so applying this migration twice
-- with `supabase db push` does NOT exercise that idempotency — the second
-- apply is skipped by migration tracking, not re-executed. The guard's shape
-- is what proves idempotency, not a repeat apply.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_owner_net_non_negative'
  ) then
    alter table bookings add constraint bookings_owner_net_non_negative
      check (owner_net_centavos >= 0);
  end if;
end $$;
