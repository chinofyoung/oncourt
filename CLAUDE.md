# Piko — Pickleball Court Booking Platform (Philippines)

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

- Stack (planned): Next.js (App Router, TS) + Convex; Convex Auth (Google only);
  PayMongo behind a `PaymentProvider` interface; Resend for email.
- Currency is PHP (₱); market is the Philippines. Copy may use light Taglish.
- Brand name "piko" is a placeholder — keep it easily swappable.
