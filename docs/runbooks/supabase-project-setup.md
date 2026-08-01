# Supabase hosted project setup

Do these in order when creating the staging or production project.

## 0. Apply migrations and the seed

This is the step nothing in this document previously covered — the sections
below assume tables, functions, and (for Section 5's verification query) seed
data already exist, but getting them onto a fresh hosted project is not
written down anywhere except `CLAUDE.md`'s one-line mention of `db push`.

This project has no local Supabase stack (Docker) and its CLI is not linked
to any project (see `CLAUDE.md`) — every command below targets the hosted
database directly via `--db-url`, using the Supavisor **session pooler**
connection string (`DATABASE_URL` in `.env.local`, port 5432).

1. **Apply migrations:**

   ```bash
   npx supabase db push --db-url "$DATABASE_URL"
   ```

   Every migration in `supabase/migrations/` is written to be safely
   re-appliable (`create table if not exists`, `on conflict do nothing`,
   guarded `DO` blocks for constraints with no `IF NOT EXISTS` form) — this
   project's Definition of Done proves that by double-applying. Re-run the
   same command if a new migration is added later; already-applied
   migrations are skipped by the CLI's own tracking, not by the SQL's own
   idempotency, but the idempotency is what makes a second full run safe
   regardless.

2. **Apply the seed** (`supabase/seed.sql` — creates the
   `smash-zone-marikina` fixture the Definition of Done checks against):

   `[db.seed]` in `supabase/config.toml` only fires on `supabase db reset`,
   which is unavailable against a hosted project (no local stack to reset
   from — see `CLAUDE.md`). `supabase db query --file` does not work either:
   confirmed live, it fails every multi-statement file (including this one,
   which has a `DO $$ ... $$` block alongside plain `insert`s) with
   `cannot insert multiple commands into a prepared statement` — that
   subcommand runs the file through the extended (prepared-statement)
   query protocol, which Postgres restricts to exactly one command. There is
   currently no `supabase` CLI subcommand that runs an arbitrary multi-
   statement `.sql` file against a hosted project over the *simple* query
   protocol. Apply it with a one-off script using `pg` (already a project
   dependency) instead, which does use the simple protocol for a plain
   string query:

   ```bash
   node -e "
   const { Client } = require('pg');
   const fs = require('fs');
   (async () => {
     const c = new Client({ connectionString: process.env.DATABASE_URL });
     await c.connect();
     await c.query(fs.readFileSync('supabase/seed.sql', 'utf8'));
     await c.end();
     console.log('seed applied');
   })();
   "
   ```

   Verified live against this project: succeeds on a first run and on a
   repeat run with no error and no duplicate rows — `seed.sql`'s own header
   comment explains why (deterministic ids, `on conflict ... do nothing`
   throughout, including inside its `DO` block).

## 1. Disable the Data API (highest-value security step)

Dashboard → Project → Integrations → Data API → turn **Enable Data API** OFF.

With it off, none of the auto-generated REST endpoints respond regardless of
grants or RLS. OnCourt never uses PostgREST — all access is Drizzle over a
direct Postgres connection — so this removes the attack surface entirely
rather than guarding it.

**Status on this project: NOT YET DONE — the Data API is currently ENABLED.**
This is a real, open action item, not a hypothetical. Verified directly against
this project's hosted PostgREST endpoint with the publishable key. The full
accounting, not just one table:

- `platform_settings`, `processor_rates` (owned by `postgres`, revoked +
  RLS-enabled by `supabase/migrations/20260801044615_revoke_data_api_grants.sql`):
  the Data API returns `401 Unauthorized`,
  `permission denied for table <name>` (Postgres error `42501`). Grants and
  RLS are doing their job for every table and view this project's migrations
  own.
- `spatial_ref_sys` (ordinary table), `geometry_columns`, `geography_columns`
  (views) — all seeded by the `postgis` extension and owned by
  `supabase_admin`, not `postgres`: the Data API returns `200 OK` for all
  three. `spatial_ref_sys` returns its actual EPSG row data.
  `geometry_columns` still returns `200 OK` with `[]` (this project has no
  `geometry`-typed column). `geography_columns` no longer does: Task 6 added
  `branches.location geography(Point, 4326)`, and this view now names it to
  anonymous callers. Verified live — `select * from geography_columns`
  returns exactly one row: `f_table_schema: public, f_table_name: branches,
  f_geography_column: location, coord_dimension: 2, srid: 4326, type:
  Point`. That is schema metadata, not application data (no branch rows,
  addresses, or coordinates are exposed by this view) — but it is real,
  current exposure, not a hypothetical for a future task.
  None of the three can be secured by grants or RLS from the `postgres` role
  our migrations run as: `alter table ... enable row level security` on
  `spatial_ref_sys` fails with "must be owner of table spatial_ref_sys" (and
  views cannot have RLS enabled at all, ever, regardless of ownership); a
  `revoke` on any of the three silently does nothing (Postgres only lets the
  grantor revoke what it granted; `supabase_admin` granted anon/authenticated
  their privileges here, not `postgres`).
- **Every function in `public` — verified 932 of 932** — is callable by
  `anon` via `POST /rest/v1/rpc/<function>`, including every PostGIS helper.
  Confirmed live: `GET/POST .../rpc/postgis_version` returns `200 OK` with
  `"3.3 USE_GEOS=1 USE_PROJ=1 USE_STATS=1"`, and `.../rpc/postgis_full_version`
  returns the full build string. All 932 are owned by `supabase_admin`, so
  `revoke all on all functions in schema public from anon, authenticated` in
  the migration is a verified no-op against them for the same
  grantor-only-can-revoke reason as above. It does correctly cover — now and
  for every function added later — anything `postgres` creates, via the
  widened `alter default privileges ... revoke all on functions` in the same
  migration.
- A schema-level `revoke usage on schema public from public` was considered
  and rejected: `anon`/`authenticated` inherit `public` schema USAGE through
  the `PUBLIC` pseudo-role, so closing it means revoking from `PUBLIC`
  itself, which would also strip `supabase_auth_admin` — the role that fires
  the Task 4 signup trigger — and hand-restoring USAGE to each internal
  Supabase role is fragile against a role set this project doesn't control.
  See the migration file's trailing comment for the full reasoning.

None of the above is fixable by a role-scoped migration. **This is the
concrete reason Layer 1 is the highest-value step, not just
defense-in-depth**: it is the only control that reaches extension-owned
tables, views, and functions outside every later migration's authority.

Turn off the Data API for this project before it carries any real user data.

Note: as of Supabase's 2026-04-28 change, new tables in `public` are not
auto-exposed to the Data API anyway (default for projects created after
2026-05-30, enforced everywhere from 2026-10-30). Disabling the API is the
belt to that suspenders.

## 2. Enable Google as the only auth provider

Dashboard → Authentication → Providers → Google. Add the OAuth client ID and
secret. Leave every other provider disabled. Set the redirect URL to
`<site-url>/auth/callback`.

**Status on "every other provider disabled": UNVERIFIED.** Unlike Sections
1, 2 (Google itself, below), and 4, this specific sub-item has never been
checked against the Dashboard — this task had no Dashboard access, and
nothing in the codebase can observe provider settings from outside. This
matters beyond generic hygiene: `src/app/auth/callback/route.ts` promotes
*any* verified-JWT email matching `ADMIN_EMAILS` to `role = 'admin'` on
first callback, with no additional check on how that session was created. If
email/password signup (`enable_signup`, off by default in
`supabase/config.toml` but that file only governs the *local* stack — see
CLAUDE.md, this project has no local stack) turns out to be enabled on this
hosted project, anyone who can register an allowlisted address by email/
password self-registers straight into admin, bypassing Google entirely.
**Before launch: open Dashboard → Authentication → Providers and confirm
every provider except Google is OFF** (email/password in particular). Do not
treat this as done until someone has actually looked — it was not checked as
part of this fix wave, and no automated test can check it from here.

**Status on this project: NOT YET DONE.** No Google Cloud OAuth client has
been created for this project, and the Supabase Dashboard's Google provider
has not been configured. Task 5 built the app-side half of Google sign-in
(browser client, server client, the `src/proxy.ts` session-refresh
interceptor, the `/auth/callback` route, and the `/login` page) but could not
exercise it end to end, because neither prerequisite below exists and this
task had no Dashboard access. **Browser sign-in is UNVERIFIED** — do not treat
it as working until someone has completed the two steps below and watched a
real sign-in succeed.

To verify:

1. **Create a Google Cloud OAuth client** (OAuth consent screen + OAuth
   2.0 Client ID, type "Web application") in a Google Cloud project.
   Authorized redirect URI must be this hosted project's Supabase auth
   callback: `https://<project-ref>.supabase.co/auth/v1/callback` (find
   `<project-ref>` in `NEXT_PUBLIC_SUPABASE_URL`) — **not**
   `http://127.0.0.1:54321/auth/v1/callback`, which is only correct for a
   local `supabase start` stack. This project has no local stack (see
   `CLAUDE.md`): it is a hosted project reached over the Supavisor session
   pooler, so the local-stack config-toml flow in the Task 5 plan does not
   apply here — the client/secret goes into the **Dashboard**, not
   `supabase/config.toml`.
2. **Enable Google in the Dashboard** (Authentication → Providers → Google)
   with that client's ID and secret, redirect URL `<site-url>/auth/callback`.
3. With the dev server running (`npm run dev`, or the `oncourt-dev` preview
   config), visit `/login`, click "Continue with Google", complete the
   Google consent screen, and confirm: the browser lands back on `/`, a
   `profiles` row exists for the new `auth.users` row, and there are no
   console errors.
4. Set `ADMIN_EMAILS` in `.env.local` to your own email, sign in again (or
   sign out and back in), and confirm `profiles.role` becomes `'admin'` for
   that row — proving the callback's allowlist promotion runs against a real
   session.

What Task 5 verified instead, in lieu of the above: `tests/auth/guards.test.ts`
(`requireUser`/`requireAdmin` against real `profiles` rows, stubbing only the
Supabase server-client boundary) and `tests/auth/admin-allowlist.test.ts`
(the allowlist parsing `isAdminEmail` reads) both pass against this hosted
database. The dev server was started via the preview tool and `/login` was
confirmed to render the sign-in button with a `200` response and no console
errors — real evidence that the app compiles and the route exists, but not
evidence that Google sign-in itself works.

## 3. Confirm JWT signing keys are asymmetric (RSA)

Dashboard → Authentication → JWT Keys. Projects created after 2025-05-01
default to RSA, which lets `getClaims()` verify locally instead of making a
network call per request. If this project somehow uses a shared secret,
migrate it to asymmetric keys before launch.

## 4. Application database role

Open question carried from the spec: a dedicated least-privilege role with
`bypassrls` normally requires superuser, which hosted Supabase does not grant.

**Outcome for this project: connect as `postgres`.** Attempting a dedicated
role was not necessary to check further — this project connects through the
Supavisor **session pooler** (port 5432) as `postgres.<project-ref>`, and the
effective server-side role is `postgres`. `postgres` already:

- owns every table this project's own migrations create (verified:
  `platform_settings`, `processor_rates` both show `tableowner = postgres`),
  which is exactly why `alter default privileges for role postgres` and plain
  `alter table ... enable row level security` work without a dedicated role;
- holds `rolbypassrls = true` (verified via `pg_roles`), so it bypasses RLS on
  its own tables without needing `force row level security` — which must
  never be added regardless, per the project's global RLS rule;
- is *not* a superuser (`rolsuper = false`) and is *not* the owner of
  extension-created objects such as `spatial_ref_sys` (owned by
  `supabase_admin`), which is exactly the boundary described in Section 1.

No further role work is needed: `postgres` over the session pooler is the
application database role for this project. Record any change to this
decision here if a future task revisits it.

## 5. Verify

Run the lockdown suite against the hosted project by pointing the env vars at
it: `npm test -- tests/security/data-api-lockdown.test.ts`

As of this writing that suite passes 7/7 (it grew from 5 tests: Task 10 added
the function-EXECUTE test and, earlier, a "no relation escapes the named
PostGIS quarantine list" test — see the test file itself for both). It
governs every table/view owned
by `postgres` and separately asserts that the only relations in `public` not
owned by `postgres` are the named PostGIS quarantine list
(`spatial_ref_sys`, `geometry_columns`, `geography_columns`) — so it cannot
and does not claim those three, or any `public` function, are secured. See
Section 1 for the full accounting of what remains reachable until Layer 1 is
done.

There is no automated re-check for the quarantined objects or for functions
— disabling the Data API removes the endpoint they're served from entirely,
so there's nothing left to query afterward. To confirm that directly with
`curl` once Section 1 is done (replace `<project-ref>` and
`<publishable-key>`; expect a connection failure or a Data-API-disabled
response, not `200`):

```bash
curl -i "https://<project-ref>.supabase.co/rest/v1/spatial_ref_sys?limit=1" \
  -H "apikey: <publishable-key>"

curl -i "https://<project-ref>.supabase.co/rest/v1/rpc/postgis_version" \
  -H "apikey: <publishable-key>" -X POST
```
