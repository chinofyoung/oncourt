-- A platform fee above 100% makes owner_net = courtFee - platformFee negative
-- on every booking (src/lib/booking/hold.ts). That is arithmetic, not policy,
-- so no PERCENTAGE configuration may express it — this constraint covers
-- exactly that case and no other.
--
-- Final whole-branch review, MUST-FIX #1: an earlier version of this comment
-- claimed the percentage ceiling meant no configuration at all could express
-- a negative owner_net. False — the FLAT case (default_platform_fee_mode =
-- 'flat') stores a bare centavo amount with no relation to any court's price,
-- so a flat fee at or above a court's cheapest hourly rate produces the same
-- negative owner_net with this constraint never in play. There is no
-- equivalent unconditional CHECK for the flat case here (a fixed centavo
-- amount can't be bounded without knowing the court's rate, which lives in a
-- different table); it is bounded at SAVE TIME instead, in
-- src/lib/admin/settings.ts's cheapestApprovedRateCentavos guard, with
-- migration 20260809010000_owner_net_non_negative.sql's
-- bookings_owner_net_non_negative CHECK as the database backstop behind it.
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
