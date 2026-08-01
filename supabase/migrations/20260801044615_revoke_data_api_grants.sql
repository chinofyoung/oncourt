-- Layer 2 of 3: no grants, including for objects created by later
-- migrations. (Layer 1 is disabling the Data API in the Dashboard, see
-- docs/runbooks/supabase-project-setup.md. Layer 3 is RLS, below.)
--
-- `for role postgres` is REQUIRED: default privileges are keyed to the role
-- that creates the objects. Omitting it silently does nothing.
--
-- Deliberately WIDER than the task-3 plan text, which only revoked
-- select/insert/update/delete on tables by default and never touched
-- sequences or functions. Verified live against pg_default_acl before
-- writing this that the plan's narrower form leaves, on every future
-- `postgres`-owned object:
--   - tables:    anon/authenticated retain TRUNCATE, REFERENCES, TRIGGER,
--                MAINTAIN (RLS does not filter TRUNCATE)
--   - sequences: anon/authenticated retain SELECT, UPDATE, USAGE (never
--                revoked at all under the plan's text)
--   - functions: anon/authenticated retain EXECUTE (never revoked at all)
-- Every function in `public` is a PostgREST RPC endpoint by default — the
-- spec's pg_cron hold-janitor and completion-sweep functions Tasks 4/6-10
-- add would otherwise be anon-callable the moment they're created, and a
-- `security definer` helper among them would be a straight authorization
-- bypass. `revoke all` on all three object kinds closes this for anything
-- `postgres` creates from here on.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role;

-- Immediate revokes for objects that already exist. `service_role` is
-- included here too (matching the default-privilege role list above),
-- deliberately wider than the task-3 plan text again. `service_role` is a
-- server-only secret key, not the plan's primary threat model (the anon key
-- is), but revoking it is cheap defence in depth: this project never uses
-- PostgREST at all — every read and write goes through Drizzle as
-- `postgres` — so a leaked secret key gains nothing in `public` by losing
-- these grants. Checked before adding this: no function or trigger in
-- `public` depends on `service_role` holding table grants there (`public`
-- currently has zero app-defined functions and zero triggers at all; the
-- only triggers in the database live in `storage`, `realtime`, and `cron`,
-- none of which touch `public`). Supabase Auth's tables live in the `auth`
-- schema and Storage's in `storage` — both untouched by this migration,
-- which only ever reaches `public`. Verified live before this change that
-- `service_role` held full SELECT/INSERT/UPDATE/DELETE/REFERENCES/TRIGGER/
-- TRUNCATE on `platform_settings` and `processor_rates` (granted by
-- `postgres`), and confirmed with the actual secret key that
-- `GET /rest/v1/platform_settings` and `.../processor_rates` returned
-- `200 OK` with full row data — a leaked secret key could read this
-- project's application data through the Data API.
revoke all on all tables in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;
revoke all on all functions in schema public from anon, authenticated, service_role;
-- The three revokes above are no-ops for `spatial_ref_sys` and for the
-- ~930 functions the postgis extension installs in `public` (postgis_version,
-- the ST_* family, etc.) — all owned and granted by `supabase_admin`, not
-- `postgres`. A REVOKE only removes privileges the executing role granted
-- (or has grant authority over); `postgres` never granted those, so nothing
-- happens, and Postgres does not raise an error to say so. Verified live:
-- every one of those functions is still anon-EXECUTE after this migration
-- runs, and `postgis_version()`/`postgis_full_version()` remain callable as
-- public RPC endpoints. This migration only ever covers `postgres`-owned
-- objects. See the quarantine list and its accompanying comment in
-- tests/security/data-api-lockdown.test.ts, and the full accounting in
-- docs/runbooks/supabase-project-setup.md, for what remains reachable and
-- why Layer 1 (disabling the Data API) is the control that actually closes
-- it.

-- Layer 3: RLS enabled, zero policies. With no policies, all access by
-- non-bypassing roles is denied. A policy that does not exist cannot have a
-- hole in it. NEVER add `force row level security` — it would subject the
-- table owner to these non-existent policies and deny our own queries.
alter table platform_settings enable row level security;
alter table processor_rates   enable row level security;

-- Note on scope: a schema-level `revoke usage on schema public from public`
-- was considered and deliberately NOT taken here, even though the route is
-- technically available to `postgres` (it owns this database via
-- `pg_database_owner`). `anon`/`authenticated` inherit USAGE on `public`
-- through the `PUBLIC` pseudo-role, not a direct grant, so closing it would
-- require revoking from `PUBLIC` itself — which would also strip
-- `supabase_auth_admin`, the role that fires the signup trigger Task 4 adds.
-- Re-granting USAGE back to each internal Supabase role by hand is fragile
-- against a role set this project does not control and can change under us.
-- Layer 1 — disabling the Data API in the Dashboard — is the chosen
-- mitigation instead, because it is also the only control that reaches what
-- this role-scoped migration structurally cannot: `public.spatial_ref_sys`,
-- `public.geometry_columns`, `public.geography_columns` (all owned by
-- `supabase_admin`), and every `supabase_admin`-owned function in `public`
-- (every PostGIS helper — ~930 of them — each callable today as a PostgREST
-- RPC by anon). See the runbook for the full, verified accounting of that
-- residual exposure.
