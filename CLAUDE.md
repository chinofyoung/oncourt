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
  Supabase Auth with Google only; Drizzle as typed query builder over SQL
  migrations in `supabase/migrations`; PayMongo behind a `PaymentProvider`
  interface; Resend for email.
- Data access is **server-only** — the browser never queries Postgres. All reads
  and writes go through Server Components, Server Actions, and Route Handlers.
  TypeScript is the security boundary; RLS is defense-in-depth (Drizzle connects
  as a DB role, so RLS does not constrain our own queries).
- All money is stored as `integer` centavos; percentages as integer basis points.
  Never floats.
- Schema truth is the SQL migration files, not `schema.ts` — after a migration,
  regenerate types with `drizzle-kit pull`.
- Tests run against the local Supabase stack (Docker), not mocks: the DB
  constraints are the logic.
- Currency is PHP (₱); market is the Philippines. Copy may use light Taglish.
- Brand name "OnCourt" is a placeholder — keep it easily swappable.
