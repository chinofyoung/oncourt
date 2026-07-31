# Pickleball Court Booking Platform — Design Spec

**Date:** 2026-07-31
**Status:** Approved design, pending implementation plan
**Market:** Philippines

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

- **Auth:** Convex Auth with Google as the only provider. No passwords, no signup forms. Name, email, and avatar come from the Google profile. Owners are prompted for a phone number when creating their first listing.
- Owners are also players — they can book other owners' courts with the same account.

## Architecture & Stack

- **Frontend:** Next.js (App Router, TypeScript), Tailwind CSS + shadcn/ui. Single app with three route groups:
  - Public/player: `/`, `/search`, `/venues/[slug]` (branch page), `/owners/[slug]` (brand/owner profile), `/bookings` (my bookings)
  - Owner: `/dashboard/*`
  - Admin: `/admin/*`
- **Backend:** Convex (database, functions, scheduler, file storage for photos). Every query/mutation enforces role checks server-side; route groups are UI organization only, not the security boundary.
- **Geo search:** Convex geospatial component (`@convex-dev/geospatial`) indexing branch lat/lng.
- **Email:** Resend via the Convex Resend component.
- **Payments:** `PaymentProvider` interface with PayMongo as the first adapter (GCash, Maya, cards). Provider is swappable (e.g., Xendit) without touching booking logic.

## Data Model

Hierarchy: **Owner (user) → Branches → Courts**. An owner may have many branches (e.g., Smash Zone with 8 locations); each branch has many individually listed courts.

### Tables

- **users** — name, email, image (from Google), role (`player | owner | admin`), phone?, businessName?, businessLogo? (storage id), slug (for brand page), feeConfig? (per-owner override of the platform defaults, set by admin only)
- **branches** — ownerId, name (e.g., "Smash Zone – Marikina"), slug, description, address, city, lat/lng (geospatially indexed), photos[], amenities[] (parking, showers, rentals, …), contact info
- **courts** — branchId, name (e.g., "Court 1"), rateBands[] (time-of-day pricing, see below), environment (`indoor | outdoor`), surface?, photos[], weekly operating hours (per-day open/close), status (`pending | approved | rejected | suspended`), rejectionReason?
- **bookings** — courtId, branchId (denormalized), playerId, date, startHour, endHour, courtFee (sum of rate-band prices), transactionFee (processor fee line charged to player; 0 unless bearer is `player`), totalCharged (courtFee + transactionFee), platformFee, processorFee (actual), ownerNet, feeConfigSnapshot (the config used), status (`pending_payment | confirmed | completed | expired | refunded_manual`), createdAt
- **platformSettings** — singleton: default fee config (see Fee Configuration), processor fee rate table per payment method (admin-editable so processor rate changes don't need a deploy)
- **payments** — bookingId, provider (`paymongo`), providerRef, amount, status, rawPayload (audit trail)
- **reviews** — bookingId (unique), courtId, branchId, playerId, rating (1–5), comment?; aggregate rating rolls up to branch and to owner/brand
- **payouts** — ownerId, periodStart/End, grossAmount, feeAmount, netAmount, status (`pending | paid`), paidAt?, note (admin records manual GCash/bank payout)

### Modeling decisions

- **Slot granularity:** hourly. A booking spans one or more consecutive hours on one court on one date. Capacity per court per hour is 1.
- **Time-of-day pricing (rate bands):** a court's price is a list of bands, e.g. `[{11:00–15:00, ₱265}, {15:00–17:00, ₱315}, {17:00–24:00, ₱365}]`. Bands must fully cover the court's operating hours with no overlaps (validated on save). A booking's amount is the sum of the band price for each booked hour. A court with uniform pricing is simply one band.
- **Per-court everything:** rate bands, indoor/outdoor, hours, photos, and approval status live on the court, because real facilities price courts differently.
- **Branch visibility:** a branch appears publicly (search + pages) once it has ≥ 1 approved court.
- **Price changes** affect new bookings only; a booking snapshots its amount at creation.

## Key Flows

### Owner onboarding & listing

1. Sign in with Google → "List your court" → create first branch (address with map-pin placement, photos, amenities) → add courts under it (rate bands, indoor/outdoor, hours, photos) → submit. The rate-band editor validates full coverage of operating hours with no overlaps.
2. Each court enters `pending`. Admin approves or rejects with a reason (owner notified by email).
3. Editing a court's key fields (rate bands, hours, environment) re-queues only that court to `pending`; other courts and branches are unaffected. Non-key edits (photos, description) do not re-queue.
4. Owners can add branches and courts anytime; owner role is granted on first submission.

### Search

1. Player enters date, time range, and location (browser geolocation, or city/area picker fallback).
2. Query: geospatial lookup of branches within radius → filter to branches with ≥ 1 approved court open during that window with the slot(s) unbooked → sort by distance.
3. Result cards: branch name, distance, rating, price range, indoor/outdoor mix, next available slots.
4. Filters: indoor/outdoor, max price. Convex reactive queries keep availability live — a slot booked by someone else disappears without refresh.

### Booking & payment

1. On a branch page, player picks a court, date, and consecutive hour slots → mutation validates availability (`no confirmed/pending booking overlaps`) and creates a `pending_payment` booking. Convex mutations are serializable transactions — double-booking races are impossible.
2. The pending booking holds the slot for **15 minutes**. A review step shows the price breakdown; if the owner's fee config sets the processor-fee bearer to `player`, the player picks a payment method here and the exact grossed-up transaction fee appears as a line item. Server creates a PayMongo checkout session (restricted to the chosen method in that case); player is redirected to pay (GCash/Maya/card).
3. A scheduled function expires unpaid bookings at the 15-minute mark, releasing the slot.
4. The PayMongo **webhook** (`payment.paid`) is the source of truth: it flips the booking to `confirmed` and triggers confirmation emails to player and owner. The browser redirect alone never confirms a booking.
5. After the slot's end time passes, a scheduled function marks confirmed bookings `completed` (making them reviewable).
6. **No cancellations in MVP.** Disputes go to the owner/admin; admin performs refunds manually in the provider dashboard and records the booking as `refunded_manual`.

### Fee configuration (global default + per-owner override)

Two independent knobs, stored as a global default in `platformSettings` and overridable **per owner** by admin (`users.feeConfig`):

1. **Platform fee:** `percentage` of courtFee (default **10%**) **or** `flat` amount per booking (e.g., ₱50).
2. **Processor fee bearer:** who absorbs the payment processor's fee — `player`, `owner`, or `platform` (default).

How each bearer works (₱1,000 GCash booking, 10% platform fee, GCash rate 2.23%):

- **`platform` (default):** player pays ₱1,000; owner is credited ₱900; the processor's ₱22.30 comes out of the platform's ₱100 fee, leaving a ₱77.70 margin.
- **`owner`:** player pays ₱1,000; owner is credited ₱1,000 − ₱100 − ₱22.30 = ₱877.70; platform keeps the full ₱100.
- **`player`:** player first selects a payment method on our checkout page (GCash / Maya / card), because the processor fee differs per method. We compute the exact fee, **grossed-up** so the platform is made whole (the processor also takes its percentage of the fee line itself: `total = (courtFee + fixedFee) / (1 − rate)`), and show it as a "Transaction fee" line item. The PayMongo checkout session is restricted to the chosen method so the shown fee is always the charged fee. Owner gets ₱900; platform keeps ₱100.

Every booking snapshots the resolved fee config and all computed amounts (`feeConfigSnapshot`, `processorFee`, `ownerNet`), so later config changes never rewrite history. Processor rates per method live in an admin-editable rate table in `platformSettings`.

### Payouts (manual in MVP)

- The platform account collects all payments. Each booking records the owner's net per the fee configuration above.
- Admin panel maintains a per-owner ledger: gross bookings, fees, net owed, minus recorded payouts.
- Admin pays owners weekly via bank transfer/GCash and records the payout. Automation is Phase 2.
- **Phase 2 path — PayMongo Platforms:** onboard each owner as a child merchant (sub-account); payment splitting routes the platform fee to the parent account and the owner's share to their sub-account wallet automatically, with PayMongo handling disbursement. Requires per-owner KYC and custom pricing (from ₱75/month per activated sub-account), so MVP launches with the manual ledger and migrates when volume justifies it.

### Reviews

- A player may leave one review per `completed` booking: 1–5 stars + optional comment.
- Ratings aggregate at branch level (shown in search/branch page) and roll up to the owner/brand page.

### Notifications (email, via Resend)

| Event | Recipient |
|---|---|
| Booking confirmed + receipt | Player |
| New booking | Owner |
| Day-of reminder | Player |
| Court approved / rejected (with reason) | Owner |
| Booking refund recorded | Player |

## Pages

### Public / Player
- **Home** — value prop, search entry, featured branches
- **Search results** — list + map toggle, filters
- **Branch page** (`/venues/[slug]`) — two-column layout. Left: photo gallery, name, address, rates summary, amenities, map, reviews. Right: the **availability grid** — the primary booking UI:
  - Date navigator: prev/next day arrows, date picker, "Today" badge
  - A rates strip summarizing the day's bands (e.g. "₱265 11 AM–3 PM · ₱315 3–5 PM · ₱365 5 PM–12 AM")
  - Grid with **time rows** (hourly, grouped Morning / Afternoon / Evening, each row showing that hour's price) × **court columns** (court name + indoor/outdoor label); booked cells greyed out and disabled, open cells clickable
  - Player selects consecutive open cells in one court's column → running total → "Book" proceeds to payment
  - Convex reactivity keeps the grid live: cells flip to Booked in real time as others book
- **Owner/brand profile** (`/owners/[slug]`) — brand header (logo, business name, overall rating), then one section per branch with address and its courts. Single-branch owners see one section. This is the user-friendly grouped view requested.
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

- **Webhook after hold expiry:** if payment lands after the booking expired, re-confirm if the slot is still free; otherwise alert admin for a manual refund (rare; logged).
- **Duplicate webhooks:** idempotent by provider reference — replays are no-ops.
- **Suspension with future bookings:** confirmed bookings stay honored; the court/branch just leaves search. Admin handles case-by-case.
- **Overlapping hold spam:** a player may hold at most 3 pending bookings at a time.
- **Geolocation denied:** fall back to city/area picker; search still works.
- **Payment provider outage:** if the checkout session can't be created, the just-created pending booking is deleted immediately and the player sees a retry message — no orphaned holds.

## Testing

- **Unit (convex-test):** slot availability/overlap logic, 15-minute hold expiry, webhook idempotency and out-of-order handling, role checks on every mutation, rate-band coverage validation and booking-amount calculation across bands, fee resolution (global default vs per-owner override) and math for all three processor-fee bearers including gross-up rounding, review eligibility.
- **Payment adapter:** integration tests against PayMongo test mode; webhook signature verification.
- **E2E (Playwright):** one happy path — search → pick court → book → mock payment → confirmed booking appears in "My bookings" and owner calendar.

## Open Items (decided defaults)

- **Platform fee:** default **10% percentage**, processor fee borne by **platform**; both overridable globally and per owner by admin.
- **Payment provider:** PayMongo first; interface keeps Xendit possible.
- **Hold duration:** 15 minutes.

## Phase 2 Backlog

Matchmaking/open play, staff accounts per branch, automated payouts, cancellations & self-service refunds, mobile apps, SMS reminders, promo codes, recurring bookings for leagues, multi-date booking in one reservation, favorites/saved courts, report-a-listing.
