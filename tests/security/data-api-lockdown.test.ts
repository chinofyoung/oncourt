import { beforeAll, expect, test } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

const publicClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
)

// `service_role` (the secret key) is a server-only credential, not the
// plan's primary threat model — but this project never uses PostgREST at
// all, so revoking its grants in `public` is cheap defence in depth against
// a leaked secret key. See the migration for what was checked before doing
// that (no function/trigger in `public` depends on it).
const serviceClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
)

// Explicit, named quarantine of objects this migration cannot reach, each
// owned by `supabase_admin` — not `postgres`, the role every app migration
// (and this test suite) runs as:
//   - spatial_ref_sys: ordinary table (relkind 'r') seeded by the postgis
//     extension. `alter table ... enable row level security` on it fails
//     with "must be owner of table spatial_ref_sys".
//   - geometry_columns, geography_columns: views (relkind 'v') that postgis
//     also installs in `public`. Views cannot have RLS enabled at all
//     (that's a table-only concept), and their grant to anon/authenticated
//     is likewise owned by supabase_admin: a `revoke` issued by `postgres`
//     only removes privileges `postgres` granted, so it silently no-ops on
//     anything supabase_admin granted, without raising an error.
// This is a NAMED exception list, not a silent ownership filter: the "no new
// escapee" test below independently enumerates every relation in `public`
// not owned by `postgres` and asserts that set is *exactly* this list. A new
// object appearing there — from a future extension, or a mistake in a later
// migration — fails the suite instead of being quietly absorbed. See
// supabase/migrations/20260801044615_revoke_data_api_grants.sql and
// docs/runbooks/supabase-project-setup.md for the full accounting of what
// remains reachable through the Data API and why (it's wider than this
// list — functions are covered separately there, not by this test).
//
// A schema-level `revoke usage on schema public from public` would also
// reach these three (postgres owns the database via `pg_database_owner`,
// so the route exists) but was deliberately NOT taken: anon/authenticated
// inherit `public` schema USAGE through the `PUBLIC` pseudo-role, so closing
// it means revoking from `PUBLIC` itself, which would also strip
// `supabase_auth_admin` — the role that fires the Task 4 signup trigger.
// Layer 1 (disabling the Data API in the Dashboard) is the chosen
// mitigation for this quarantine list instead. See the migration file's
// trailing comment for the full reasoning.
const QUARANTINE = ['geography_columns', 'geometry_columns', 'spatial_ref_sys'] as const
const notQuarantined = sql.raw(QUARANTINE.map((name) => `'${name}'`).join(', '))

let relations: { relname: string; relkind: string; owner: string }[] = []
let governedNames: string[] = []

beforeAll(async () => {
  // Enumerated from pg_class, NOT pg_tables: pg_tables only lists relkind
  // 'r'/'p' (ordinary/partitioned tables) and silently excludes views,
  // materialized views, and foreign tables ('v', 'm', 'f'). A view over
  // sensitive data is exactly as reachable through the Data API as a table —
  // `geometry_columns`/`geography_columns` prove this isn't theoretical.
  const result = await db.execute(sql`
    select relname, relkind, relowner::regrole::text as owner
    from pg_class
    where relnamespace = 'public'::regnamespace
      and relkind in ('r', 'p', 'v', 'm', 'f')
    order by relname
  `)
  relations = result.rows.map((r) => ({
    relname: r.relname as string,
    relkind: r.relkind as string,
    owner: r.owner as string,
  }))
  expect(relations.length).toBeGreaterThan(0)

  governedNames = relations
    .filter((r) => !(QUARANTINE as readonly string[]).includes(r.relname))
    .map((r) => r.relname)
  expect(governedNames.length).toBeGreaterThan(0)
})

test('the only relations in public not owned by postgres are the known PostGIS quarantine list', async () => {
  const nonPostgresOwned = relations
    .filter((r) => r.owner !== 'postgres')
    .map((r) => r.relname)
    .sort()
  // This is the drift alarm: if a new non-postgres-owned relation appears in
  // `public` (a new extension object, or a mistake), this fails loudly
  // instead of the "governed" set silently growing to exclude it.
  expect(nonPostgresOwned).toEqual([...QUARANTINE].sort())
})

test('every governed table has RLS enabled', async () => {
  // Scoped to relkind 'r'/'p' — RLS is a table-only concept, so a
  // quarantined view can never trip this test on its own account.
  const result = await db.execute(sql`
    select relname from pg_class
    where relnamespace = 'public'::regnamespace
      and relkind in ('r', 'p')
      and relname not in (${notQuarantined})
      and relrowsecurity = false
    order by relname
  `)
  expect(result.rows.map((r) => r.relname)).toEqual([])
})

test('no governed table is forced RLS (would deny our own owner-role queries)', async () => {
  const result = await db.execute(sql`
    select relname from pg_class
    where relnamespace = 'public'::regnamespace
      and relkind in ('r', 'p')
      and relname not in (${notQuarantined})
      and relforcerowsecurity = true
    order by relname
  `)
  expect(result.rows.map((r) => r.relname)).toEqual([])
})

test('anon, authenticated, and service_role hold no privileges on any governed table or view', async () => {
  const result = await db.execute(sql`
    select table_name, grantee, privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('anon', 'authenticated', 'service_role')
      and table_name not in (${notQuarantined})
    order by table_name, grantee, privilege_type
  `)
  expect(result.rows).toEqual([])
})

test('the public key is refused by the Data API for every governed table/view', async () => {
  for (const name of governedNames) {
    const { data, error, status } = await publicClient.from(name).select('*').limit(1)
    // A 200 with an empty array is NOT proof of lockdown — it only means the
    // table had no visible rows that moment. `geometry_columns` returns
    // exactly that shape today and would wrongly pass a mere-emptiness
    // check. Require an actual refusal: PostgREST's permission-denied code,
    // or a non-2xx status.
    const refused = error?.code === '42501' || status < 200 || status >= 300
    expect(
      refused,
      `table ${name} was not refused by the Data API: status=${status} error=${JSON.stringify(error)} data=${JSON.stringify(data)}`,
    ).toBe(true)
  }
})

test('the service_role key is refused by the Data API for every governed table/view', async () => {
  // Same genuine-refusal check as the public-key test above, not an
  // empty-array check. service_role isn't the plan's primary threat model,
  // but the migration now revokes its grants too (defence in depth, cheap
  // because this project never uses PostgREST) — this proves that actually
  // took effect, not just that the catalog says so.
  for (const name of governedNames) {
    const { data, error, status } = await serviceClient.from(name).select('*').limit(1)
    const refused = error?.code === '42501' || status < 200 || status >= 300
    expect(
      refused,
      `table ${name} was not refused to service_role by the Data API: status=${status} error=${JSON.stringify(error)} data=${JSON.stringify(data)}`,
    ).toBe(true)
  }
})

// Added by Task 10 as a regression guard, not a one-off check: every
// function in `public` is a PostgREST RPC endpoint by default (see the
// migration comment in 20260801044615_revoke_data_api_grants.sql), so an
// EXECUTE grant to anon/authenticated/service_role on a postgres-owned
// function in this schema is a live, callable API endpoint on a project
// whose Data API is still enabled (Section 1 of the runbook). Task 3 widened
// the default-privilege revoke to cover functions, and Task 4's
// `handle_new_user` plus Task 10's `expire_stale_holds`/
// `complete_past_bookings` are the only postgres-owned functions that widening
// has ever had to hold up against — this test makes that permanent instead
// of leaving it as three ad hoc checks that stop running the moment nobody
// remembers to repeat them.
//
// Catalog-enumerated by ownership (`pg_proc.proowner`), not a hardcoded list
// of function names — the same "govern by ownership, not by name" pattern
// the table-side tests above already use via `relowner`/`QUARANTINE`. This
// means the test automatically covers any function a future task adds,
// without needing an edit here. No quarantine list is needed on the
// function side the way tables need one for PostGIS's `spatial_ref_sys`
// view etc.: PostGIS's ~930 functions in `public` are all owned by
// `supabase_admin`, not `postgres` (verified live, see the runbook), so the
// `o.rolname = 'postgres'` filter excludes them structurally, the same way
// it excludes them from the default-privilege revoke itself.
//
// Fix round 2 (post-review): the original version of this test explicitly
// joined `acl.grantee` to `pg_roles`, which cannot see a grant to PUBLIC —
// PUBLIC's pseudo-grantee is oid 0, which has no `pg_roles` row, so that
// join silently dropped it. PUBLIC EXECUTE is Postgres's *default* for a
// newly created function, and `anon`/`authenticated` both inherit EXECUTE
// through PUBLIC the same way they inherit `public` schema USAGE through it
// (see the schema-level note near the top of this file, and
// 20260801044615_revoke_data_api_grants.sql's trailing comment) — so a
// future `postgres`-owned function that omits its own
// `revoke ... from public` would be anon-executable (a live RPC endpoint
// while the Data API is still enabled) and the old query reported `[]`,
// passing incorrectly.
//
// Rewritten to use `has_function_privilege`, which resolves PUBLIC, role
// inheritance, and explicit per-role grants in one call — there is no ACL
// to explode or a PUBLIC-oid edge case to miss, because Postgres itself
// answers the "can this role actually execute this" question directly.
test('no postgres-owned function in public grants EXECUTE to anon, authenticated, or service_role (including via PUBLIC)', async () => {
  const result = await db.execute(sql`
    select p.proname as routine_name
    from pg_proc p
    join pg_roles o on o.oid = p.proowner
    where p.pronamespace = 'public'::regnamespace
      and o.rolname = 'postgres'
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or has_function_privilege('service_role', p.oid, 'EXECUTE'))
    order by p.proname
  `)
  expect(result.rows).toEqual([])
})
