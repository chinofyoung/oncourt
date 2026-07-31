# Pickleball Court Booking Platform — Design Spec

**Date:** 2026-07-31
**Status:** Approved design, pending implementation plan
**Market:** Philippines
**Revision:** 2026-07-31 — backend switched from Convex to Supabase (Postgres + Supabase Auth). Product design unchanged; stack, data model, authorization, geo search, scheduling, and testing sections rewritten.

## Overview

A responsive web app where players find and book pickleball courts near them, court owners list and manage their courts across one or more branches, and admins keep listing quality high. Bookings are paid online and confirm only after payment succeeds.

## Goals (MVP)

- Players search courts by date, time, and location; book a specific court; pay online.
- Court owners list branches and individual courts, manage bookings, and track earnings.
- Admin approves court listings, oversees users/bookings, and manages manual payouts and refunds.
- Ratings & reviews from completed bookings.
- Email notifications for the booking lifecycle.

## Non-goals (Phase 2)

- Player matchmaking / open play sessions
- Native mobile apps
- Automated split payouts to owners (PayMongo Platforms sub-accounts; Xendit XenPlatform as alternative)
- Staff/manager accounts with per-branch permissions
- Cancellations and self-service refunds
- SMS notifications

## Users & Roles

| Role | How they get it | What they can do |
|---|---|---|
| Player | Default on first Google sign-in | Search, book, pay, review |
| Owner | Automatically when they submit their first branch/court listing | Everything a player can, plus manage branches, courts, bookings calendar, earnings |
| Admin | Env-var email allowlist, applied at sign-in | Approval queue, user/booking oversight, refund recording, payout ledger |

- **Auth:** Supabase Auth with Google as the only provider. No passwords, no signup forms. Name, email, and avatar come from the Google profile. Owners are prompted for a phone number when creating their first listing.
- Owners are also players — they can book other owners' courts with the same account.
- A trigger on `auth.users` insert creates the matching `profiles` row with `role = 'player'`. The auth callback route checks the admin email allowlist (`ADMIN_EMAILS` env var) and promotes to `admin` on sign-in.
- Role is **not** stamped into the JWT. A custom access-token hook is deliberately deferred — all data access is server-side, so authorization decisions read `profiles.role` directly. Add the hook later only if RLS policy performance ever becomes a concern.

## Architecture & Stack

- **Frontend:** Next.js (App Router, TypeScript), Tailwind CSS + shadcn/ui. Single app with three route groups:
  - Public/player: `/`, `/search`, `/venues/[slug]` (branch page), `/owners/[slug]` (brand/owner profile), `/bookings` (my bookings)
  - Owner: `/dashboard/*`
  - Admin: `/admin/*`
- **Backend:** Supabase — Postgres (data), Supabase Auth (Google OIDC), Supabase Storage (branch and court photos). No Edge Functions; all server logic is Next.js server-side code.
- **Sessions:** `@supabase/ssr` with cookie-based sessions and a Next.js middleware that refreshes tokens on navigation.
- **Data access:** server-only. The browser never queries Postgres. All reads and writes go through Server Components, Server Actions, and Route Handlers.
- **Query layer:** Drizzle as a typed query builder. Schema truth lives in versioned SQL under `supabase/migrations`; `drizzle-kit pull` regenerates `schema.ts` from the live database after each migration. Drop to raw SQL where clearer.
- **Migrations:** Supabase CLI. Local development runs the Supabase stack in Docker (`supabase start`), which is a required local prerequisite. Hosted Supabase projects for staging and production.
- **Geo search:** PostGIS. `branches.location` is `geography(Point, 4326)` with a GIST index; radius search via `ST_DWithin`, distance ordering via `ST_Distance`.
- **Email:** Resend, called directly from server-side code.
- **Payments:** `PaymentProvider` interface with PayMongo as the first adapter (GCash, Maya, cards). Provider is swappable (e.g., Xendit) without touching booking logic. The webhook is a Next.js Route Handler.

### Authorization model

TypeScript is the primary security boundary. Every Server Action and Route Handler resolves the session, loads `profiles.role`, and checks authorization before touching data. Route groups are UI organization only, never a security boundary.

RLS is enabled on every table with restrictive policies, but its role here is **defense-in-depth against a different access path**, not a check on our own queries. This trade-off is deliberate and worth stating plainly: Drizzle connects to Postgres as a database role, not as an end user, so it does not carry a JWT and RLS does not constrain it. RLS therefore protects against a leaked anon key or a future client-direct feature — it is not what stops our own server code from over-fetching. If we later want RLS to apply to our queries too, the path is `SET LOCAL role` plus `request.jwt.claims` per transaction; that is out of scope for now.

Secrets (service role key, PayMongo keys, Resend key) exist only in server environment variables.

### Realtime

Deferred. The availability grid is server-rendered and refetches on window focus and after navigation. Correctness does not depend on freshness: the database exclusion constraint (below) means a stale grid can only ever produce a clean "that slot was just taken" error at booking time, never a double booking.

When built, the approach is a Postgres trigger on `bookings` calling `realtime.broadcast_changes()` to a per-court topic carrying only `{court_id, starts_at, status}` — no PII, and no table exposed to the browser. This needs no schema change, so deferring costs nothing.

## Data Model

Hierarchy: **Owner (profile) → Branches → Courts**. An owner may have many branches (e.g., Smash Zone with 8 locations); each branch has many individually listed courts.

### Cross-cutting conventions

- **All money is `integer` centavos.** Never floats, never whole pesos. Processor fees produce fractional pesos (₱22.30) and the gross-up formula produces worse; centavos keep every amount exact. Display formatting divides by 100 at the edge.
- **Percentages are integer basis points** (1000 = 10%), for the same reason.
- Primary keys are `uuid` with `gen_random_uuid()`.
- Timestamps are `timestamptz`. Application timezone is `Asia/Manila`; conversion happens at the presentation edge.
- Enums are Postgres enum types: `user_role`, `court_environment`, `court_status`, `booking_status`, `payout_status`, `platform_fee_mode`, `processor_fee_bearer`.

### Tables

- **profiles** — `id` (uuid, FK → `auth.users.id`, cascade delete), full_name, email, avatar_url, `role user_role`, phone?, business_name?, business_logo_path?, slug (unique but **nullable** — set only when the user becomes an owner and gets a brand page), and nullable per-owner fee override columns: `platform_fee_mode?`, `platform_fee_value?`, `processor_fee_bearer?` (all null = inherit the global default; admin-editable only).
  - **`platform_fee_value` is dual-unit and always read together with `platform_fee_mode`:** basis points when mode is `percentage` (1000 = 10%), centavos when mode is `flat` (5000 = ₱50). A `CHECK` requires both columns to be null or both non-null. The same pairing applies to `platform_settings.default_platform_fee_mode` / `default_platform_fee_value`.
- **branches** — owner_id → profiles, name (e.g., "Smash Zone – Marikina"), slug (unique), description, address, city, `location geography(Point, 4326)` (GIST indexed), `amenities text[]`, contact_phone, contact_email.
- **branch_photos** — branch_id, storage_path, sort_order.
- **courts** — branch_id, name (e.g., "Court 1"), `environment court_environment` (`indoor | outdoor`), surface?, `status court_status` (`pending | approved | rejected | suspended`), rejection_reason?.
- **court_photos** — court_id, storage_path, sort_order.
- **court_rate_bands** — court_id, start_hour, end_hour, price_centavos. Time-of-day pricing. Overlap is prevented at the database level:
  ```sql
  ALTER TABLE court_rate_bands ADD CONSTRAINT rate_bands_no_overlap
    EXCLUDE USING gist (court_id WITH =, int4range(start_hour, end_hour) WITH &&);
  ```
- **court_operating_hours** — court_id, day_of_week (0–6), opens_hour, closes_hour, unique on (court_id, day_of_week).
- **bookings** — court_id, branch_id (denormalized), player_id → profiles, `starts_at`, `ends_at`, generated `slot tstzrange`, `status booking_status` (`pending_payment | confirmed | completed | expired | refunded_manual`), `expires_at?` (set only while `pending_payment`), and the money columns: court_fee_centavos, transaction_fee_centavos, total_charged_centavos, platform_fee_centavos, processor_fee_centavos, owner_net_centavos, `fee_config_snapshot jsonb`.
- **platform_settings** — singleton (`id boolean PRIMARY KEY DEFAULT true CHECK (id)`): default_platform_fee_mode, default_platform_fee_value, default_processor_fee_bearer, hold_duration_minutes.
- **processor_rates** — payment_method (PK), percentage_bps, fixed_fee_centavos, updated_at. Admin-editable so processor rate changes need no deploy.
- **payments** — booking_id, provider (`paymongo`), `provider_ref` (**unique** — this is what makes webhook replays idempotent at the database level), amount_centavos, `status text` (deliberately not an enum: it mirrors provider-specific states, which differ per provider and change without our involvement), `raw_payload jsonb` (audit trail).
- **reviews** — booking_id (**unique**), court_id, branch_id, player_id, rating (smallint, check 1–5), comment?. Aggregate rating rolls up to branch and to owner/brand.
- **payouts** — owner_id, period_start, period_end, gross_centavos, fee_centavos, net_centavos, `status payout_status` (`pending | paid`), paid_at?, note (admin records manual GCash/bank payout).

### Modeling decisions

- **Slot granularity:** hourly. A booking spans one or more consecutive hours on one court on one date. Capacity per court per hour is 1.
- **Bookings store a time range, not date + hour columns.** `starts_at`/`ends_at` are the truth, with a stored generated column:
  ```sql
  slot tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED
  ```
  Half-open `[)` bounds are load-bearing: they let a 5–6pm and a 6–7pm booking coexist while still catching real overlaps. Hourly granularity is a validation rule in application code, not a storage shape.
- **Double-booking is structurally impossible**, enforced by the schema rather than by application logic:
  ```sql
  CREATE EXTENSION IF NOT EXISTS btree_gist;

  ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (court_id WITH =, slot WITH &&)
    WHERE (status IN ('pending_payment', 'confirmed', 'completed'));
  ```
  Two concurrent booking attempts on the same slot: one commits, the other receives `23P01 exclusion_violation`, which the application surfaces as "that slot was just taken."
- **Time-of-day pricing (rate bands):** a court's price is a list of bands, e.g. `[{11:00–15:00, ₱265}, {15:00–17:00, ₱315}, {17:00–24:00, ₱365}]`. A booking's amount is the sum of the band price for each booked hour. A court with uniform pricing is simply one band. **The database prevents overlapping bands** (exclusion constraint above); **application code prevents gaps** — the "bands must fully cover operating hours" rule is validated in TypeScript on save, where it is straightforward to test.
- **Per-court everything:** rate bands, indoor/outdoor, hours, photos, and approval status live on the court, because real facilities price courts differently.
- **Branch visibility:** a branch appears publicly (search + pages) once it has ≥ 1 approved court.
- **Price changes** affect new bookings only; a booking snapshots its amounts and fee config at creation.

## Key Flows

### Owner onboarding & listing

1. Sign in with Google → "List your court" → create first branch (address with map-pin placement, photos, amenities) → add courts under it (rate bands, indoor/outdoor, hours, photos) → submit. The rate-band editor validates full coverage of operating hours with no overlaps.
2. Each court enters `pending`. Admin approves or rejects with a reason (owner notified by email).
3. Editing a court's key fields (rate bands, hours, environment) re-queues only that court to `pending`; other courts and branches are unaffected. Non-key edits (photos, description) do not re-queue.
4. Owners can add branches and courts anytime; owner role is granted on first submission.

### Search

1. Player enters date, time range, and location (browser geolocation, or city/area picker fallback).
2. Query: `ST_DWithin` lookup of branches within radius → filter to branches with ≥ 1 approved court open during that window with the slot(s) unbooked → order by `ST_Distance`.
3. Result cards: branch name, distance, rating, price range, indoor/outdoor mix, next available slots.
4. Filters: indoor/outdoor, max price. Results reflect availability as of page load; see Realtime above.

### Booking & payment

1. On a branch page, player picks a court, date, and consecutive hour slots. A Server Action computes fees in TypeScript, then calls the `create_booking_hold` Postgres function to create a `pending_payment` booking.

   **Why this one piece of logic lives in the database:** an exclusion constraint predicate cannot call `now()`, so an expired-but-unswept hold would keep blocking its slot. `create_booking_hold` therefore does three things in a single transaction — expire stale `pending_payment` rows for that court, enforce the max-3-concurrent-holds rule for the player, then insert the new booking and let the exclusion constraint arbitrate. Hold correctness depends on no scheduled job running. This is the only business logic in SQL; fee math, payment calls, and email stay in TypeScript.
2. The pending booking holds the slot for **15 minutes** (`platform_settings.hold_duration_minutes`), recorded as `expires_at`. A review step shows the price breakdown; if the owner's fee config sets the processor-fee bearer to `player`, the player picks a payment method here and the exact grossed-up transaction fee appears as a line item. Server creates a PayMongo checkout session (restricted to the chosen method in that case); player is redirected to pay (GCash/Maya/card).
3. Expiry is **computed, not scheduled**: any `pending_payment` booking with `expires_at <= now()` is already dead and is treated as such by reads and by `create_booking_hold`. A `pg_cron` job runs every minute to flip stale rows to `expired`, purely so the UI and reports don't show phantom holds. If cron never fires, no slot is wrongly held.
4. The PayMongo **webhook** (`payment.paid`) is the source of truth: it flips the booking to `confirmed` and triggers confirmation emails to player and owner. The browser redirect alone never confirms a booking.
5. A `pg_cron` job marks confirmed bookings `completed` once the slot's end time has passed, making them reviewable.
6. **No cancellations in MVP.** Disputes go to the owner/admin; admin performs refunds manually in the provider dashboard and records the booking as `refunded_manual`.

### Fee configuration (global default + per-owner override)

Two independent knobs, stored as a global default in `platform_settings` and overridable **per owner** by admin (nullable columns on `profiles`):

1. **Platform fee:** `percentage` of courtFee (default **10%**, stored as 1000 basis points) **or** `flat` amount per booking (e.g., ₱50 = 5000 centavos).
2. **Processor fee bearer:** who absorbs the payment processor's fee — `player`, `owner`, or `platform` (default).

How each bearer works (₱1,000 GCash booking, 10% platform fee, GCash rate 2.23%):

- **`platform` (default):** player pays ₱1,000; owner is credited ₱900; the processor's ₱22.30 comes out of the platform's ₱100 fee, leaving a ₱77.70 margin.
- **`owner`:** player pays ₱1,000; owner is credited ₱1,000 − ₱100 − ₱22.30 = ₱877.70; platform keeps the full ₱100.
- **`player`:** player first selects a payment method on our checkout page (GCash / Maya / card), because the processor fee differs per method. We compute the exact fee, **grossed-up** so the platform is made whole (the processor also takes its percentage of the fee line itself: `total = (courtFee + fixedFee) / (1 − rate)`), and show it as a "Transaction fee" line item. The PayMongo checkout session is restricted to the chosen method so the shown fee is always the charged fee. Owner gets ₱900; platform keeps ₱100.

All of this arithmetic is TypeScript over integer centavos, with rounding direction fixed and tested. Every booking snapshots the resolved fee config and all computed amounts (`fee_config_snapshot`, `processor_fee_centavos`, `owner_net_centavos`), so later config changes never rewrite history. Processor rates per method live in the admin-editable `processor_rates` table.

### Payouts (manual in MVP)

- The platform account collects all payments. Each booking records the owner's net per the fee configuration above.
- Admin panel maintains a per-owner ledger: gross bookings, fees, net owed, minus recorded payouts. These are SQL aggregates over `bookings` and `payouts`.
- Admin pays owners weekly via bank transfer/GCash and records the payout. Automation is Phase 2.
- **Phase 2 path — PayMongo Platforms:** onboard each owner as a child merchant (sub-account); payment splitting routes the platform fee to the parent account and the owner's share to their sub-account wallet automatically, with PayMongo handling disbursement. Requires per-owner KYC and custom pricing (from ₱75/month per activated sub-account), so MVP launches with the manual ledger and migrates when volume justifies it.

### Reviews

- A player may leave one review per `completed` booking: 1–5 stars + optional comment. Enforced by the unique constraint on `reviews.booking_id`.
- Ratings aggregate at branch level (shown in search/branch page) and roll up to the owner/brand page.

### Notifications (email, via Resend)

| Event | Recipient |
|---|---|
| Booking confirmed + receipt | Player |
| New booking | Owner |
| Day-of reminder | Player |
| Court approved / rejected (with reason) | Owner |
| Booking refund recorded | Player |

## Storage

Supabase Storage, two buckets: `branch-photos` and `court-photos`. Public read; writes go through server-side code that verifies the caller owns the branch/court. Tables store `storage_path`, never a full URL.

## Pages

### Public / Player
- **Home** — value prop, search entry, featured branches
- **Search results** — list + map toggle, filters
- **Branch page** (`/venues/[slug]`) — two-column layout. Left: photo gallery, name, address, rates summary, amenities, map, reviews. Right: the **availability grid** — the primary booking UI:
  - Date navigator: prev/next day arrows, date picker, "Today" badge
  - A rates strip summarizing the day's bands (e.g. "₱265 11 AM–3 PM · ₱315 3–5 PM · ₱365 5 PM–12 AM")
  - Grid with **time rows** (hourly, grouped Morning / Afternoon / Evening, each row showing that hour's price) × **court columns** (court name + indoor/outdoor label); booked cells greyed out and disabled, open cells clickable
  - Player selects consecutive open cells in one court's column → running total → "Book" proceeds to payment
  - Server-rendered, refetched on window focus and navigation. A slot taken since page load produces a clean "just taken" message on Book, with the grid refreshed.
- **Owner/brand profile** (`/owners/[slug]`) — brand header (logo, business name, overall rating), then one section per branch with address and its courts. Single-branch owners see one section.
- **My bookings** — upcoming/past, receipt details, leave-review action

### Owner dashboard
- Branch & court management (create/edit, status visibility)
- Bookings calendar — day/week view with branch and court selectors
- Earnings — gross, platform fee, net; per branch and rolled up; payout history

### Admin panel
- Approval queue (court listings with branch context; approve / reject with reason)
- Suspend/unsuspend courts or entire branches
- Users list, all-bookings view
- Refund recording; payout ledger and payout recording
- Fee settings: global defaults (platform fee % or flat; processor fee bearer), processor rate table per payment method, and per-owner fee overrides on the user detail page

## Error Handling & Edge Cases

- **Concurrent booking of the same slot:** the loser gets `23P01` from the exclusion constraint, surfaced as "that slot was just taken" with a refreshed grid. No application-level locking needed.
- **Webhook after hold expiry:** if payment lands after the booking expired, re-confirm if the slot is still free; otherwise alert admin for a manual refund (rare; logged).
- **Duplicate webhooks:** idempotent by `payments.provider_ref` unique constraint — replays are no-ops at the database level.
- **Suspension with future bookings:** confirmed bookings stay honored; the court/branch just leaves search. Admin handles case-by-case.
- **Overlapping hold spam:** a player may hold at most 3 pending bookings at a time, enforced inside `create_booking_hold`.
- **Geolocation denied:** fall back to city/area picker; search still works.
- **Payment provider outage:** if the checkout session can't be created, the just-created pending booking is deleted immediately and the player sees a retry message — no orphaned holds.
- **`pg_cron` not firing:** hold expiry and slot release are unaffected (expiry is computed). Only cosmetic staleness in admin views.

## Testing

Tests run against the **local Supabase stack, not mocks.** The constraints are the logic here — a mocked database would verify nothing that matters.

- **Integration (Vitest + local Supabase):** slot availability and overlap, hold expiry semantics including the expire-then-insert transaction, the max-3-holds rule, webhook idempotency and out-of-order handling, authorization checks on every Server Action, rate-band coverage validation, booking-amount calculation across bands, fee resolution (global default vs per-owner override) and math for all three processor-fee bearers including gross-up rounding, review eligibility.
- **Concurrency:** a dedicated test fires N parallel `create_booking_hold` calls at one slot and asserts exactly one winner and N−1 clean `23P01` failures.
- **Schema:** assertions that the exclusion constraints and unique constraints exist and reject the cases they are meant to reject.
- **Payment adapter:** integration tests against PayMongo test mode; webhook signature verification.
- **E2E (Playwright):** one happy path — search → pick court → book → mock payment → confirmed booking appears in "My bookings" and owner calendar.

## Open Items (decided defaults)

- **Platform fee:** default **10% percentage**, processor fee borne by **platform**; both overridable globally and per owner by admin.
- **Payment provider:** PayMongo first; interface keeps Xendit possible.
- **Hold duration:** 15 minutes.
- **Drizzle + PostGIS:** Drizzle's PostGIS type support is thin. `branches.location` may need a custom type or raw SQL when search is implemented. The column and index are created in the foundation so this never requires a migration.

## Implementation Phasing

The MVP is too large for a single implementation plan. Slices, each getting its own plan:

1. **Foundation** (next) — scaffold Next.js + Supabase, Google auth with the three roles, full schema with constraints, RLS, PostGIS column, storage buckets, and one vertical slice: the branch-page availability grid reading real data, with slot clicks creating real holds via `create_booking_hold`, proven by the concurrency test. Stops before payment.
2. Payments — PaymentProvider interface, PayMongo adapter, checkout, webhook, fee math, confirmation emails.
3. Owner listing management — branch/court CRUD, rate-band editor, photo upload.
4. Admin panel — approval queue, suspensions, fee settings.
5. Search — PostGIS radius search, filters, map.
6. Reviews, earnings, and payout ledger.
7. Live-updating availability grid (broadcast-from-trigger). Lowest priority — pure polish, and the only slice that may slip past launch without blocking it.

## Phase 2 Backlog

Matchmaking/open play, staff accounts per branch, automated payouts, cancellations & self-service refunds, mobile apps, SMS reminders, promo codes, recurring bookings for leagues, multi-date booking in one reservation, favorites/saved courts, report-a-listing.
