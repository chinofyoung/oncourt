# OnCourt — Pickleball Court Booking Platform (Philippines)

Marketplace where players find and book pickleball courts, court owners list
courts across branches, and admins moderate listings. Bookings are paid online
(GCash/Maya/card) and confirm only after payment.

## Key documents

- **Product spec:** `docs/superpowers/specs/2026-07-31-pickleball-court-booking-platform-design.md`
  — data model, flows, fee system. Follow it; raise conflicts instead of silently deviating.
- **Branding guidelines:** `design/branding.md` — the design source of truth.

## Design rules (IMPORTANT)

- Before ANY design/UI work — mockups, components, pages, styling changes —
  read `design/branding.md` and adhere to it (colors, type, control tokens,
  radius, layout column, no-gradients rule).
- **Whenever the user asks for a branding/design-system change (colors, fonts,
  sizing, radius, spacing, tone, etc.), update `design/branding.md` in the same
  turn** so it stays authoritative, then apply the change to affected files.
- Mockups are self-contained HTML files in `design/mockups/`, previewed in the
  browser pane. Do NOT use DesignSync, Pencil, or external design tools.

## Project conventions

- Stack (planned): Next.js (App Router, TS) + Supabase (Postgres, Auth, Storage);
  Supabase Auth with Google only; Drizzle as a typed client executing
  hand-written SQL (`db.execute(sql\`...\`)`, never the query builder) over
  migrations in `supabase/migrations`; PayMongo behind a `PaymentProvider`
  interface; Resend for email.
- Data access is **server-only** — the browser never queries Postgres. All reads
  and writes go through Server Components, Server Actions, and Route Handlers,
  each guarded by `requireUser` / `requireOwnerOf` / `requireAdmin` /
  `requirePlayer` / `requireBranchAccess`; `src/lib/staff/access.ts`'s
  `loadDashboardAccess`/`branchIdsWith` scoping layer is the backbone of every
  `/dashboard` page, resolving a session to the exact branches and permissions
  each query may use. TypeScript is the security boundary.
- RLS is **enabled on every table with zero policies** (deny-by-default), because
  the public anon key ships in the browser and must not reach any table. Do NOT
  add policies without reason, and do NOT use `force row level security` — it
  would subject the owner role to those non-existent policies and break the app.
- All money is stored as `integer` centavos; percentages as integer basis points.
  Never floats — and deliberately not `numeric`, because PayMongo denominates in
  centavos and `numeric` returns as a string in JS. Don't "fix" this to `numeric`.
- Identifiers are lowercase `snake_case`; Drizzle uses `casing: 'snake_case'`.
  Index every foreign key explicitly.
- Schema truth is the SQL migration files, not `schema.ts` — after a migration,
  regenerate types with `drizzle-kit pull`.
- `src/db/schema.ts` is excluded in `tsconfig.json`: `drizzle-kit pull` (0.31.10)
  emits `profiles`' FK to `auth.users` as `foreignColumns: [users.id]` without
  ever importing `users`, which is a `TS2304` error. The exclude only works
  because nothing imports `schema.ts` — this project reads/writes exclusively
  via `db.execute(sql\`...\`)`, never the Drizzle query builder. **Importing
  `schema.ts` will resurface the error**; fix the generation, don't add to the
  exclude. Narrowing `schemaFilter`/`tablesFilter` to pull just `auth.users` is
  closed off by a drizzle-kit 0.31.10 bug (`tablesFilter`'s matcher logic
  ignores `matcher.negate`, so `extensionsFilters: ['postgis']`'s injected
  negations defeat any positive `tablesFilter`) — recheck on a drizzle-kit
  upgrade.
- Tests run against a **hosted** Supabase project, not mocks: the DB
  constraints are the logic. Reached via `DATABASE_URL` in the git-ignored
  `.env.local`. The direct host `db.<ref>.supabase.co` is **IPv6-only** and
  unreachable from this machine (`ENOTFOUND`, not a credentials problem) —
  connect through the **Supavisor session pooler**, port **5432**, username
  `postgres.<project-ref>`. **Never use port 6543** (transaction mode) — it
  drops session state, and the booking hold logic depends on
  `pg_advisory_xact_lock`. The CLI is not linked, so migrations apply with
  `npx supabase db push --db-url "$DATABASE_URL"` (`supabase db reset` is
  unavailable — prove idempotency by applying the migration twice). The
  database is **shared and persistent**: no reset between runs, so tests must
  pass on repeated runs and must not mutate seeded singleton rows.
- Currency is PHP (₱); market is the Philippines. **All user-facing copy is
  English only** — no Taglish (this reverses an earlier "light Taglish is fine"
  rule; see the Language entry in `design/branding.md`).
- Brand name "OnCourt" is a placeholder — keep it easily swappable.
