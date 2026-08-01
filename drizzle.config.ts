import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './supabase/migrations',
  casing: 'snake_case',
  // Excludes postgis's own system objects (spatial_ref_sys, geometry_columns,
  // geography_columns) from `drizzle-kit pull` introspection output.
  extensionsFilters: ['postgis'],
  // `drizzle-kit pull` cannot represent GiST exclusion constraints
  // (`EXCLUDE USING gist (...)`), so `bookings_no_overlap` — the
  // no-double-booking invariant — and `court_rate_bands_no_overlap` are
  // silently absent from the generated `src/db/schema.ts` model. A stray
  // `npx drizzle-kit generate` run against that model would therefore emit
  // a migration that DROPS both constraints, since drizzle-kit diffs the
  // (incomplete) model against the (complete) database. No npm script
  // invokes `generate` today — only `pull` and hand-authored SQL migrations
  // are used. Keep it that way; do not add a `generate` script or run it
  // ad hoc without re-adding the exclusion constraints to the diff by hand.
  dbCredentials: { url: process.env.DATABASE_URL! },
})
