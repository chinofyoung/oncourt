# Owner Reviews View & Settings — Design (Slice D)

**Date:** 2026-08-06
**Status:** approved — proceed to plan
**Parent specs:** `2026-07-31-pickleball-court-booking-platform-design.md`,
`2026-08-05-roles-and-staff-design.md` (permission flags),
`2026-08-06-listings-and-admin-design.md` (photo machinery, page conventions)
**Sequencing:** the last of the four owner-functionality slices. No migrations —
every table, column, and bucket already exists.

## Problem

The dashboard mockup lists Reviews and Settings nav items that earlier slices
deliberately omitted. Owners can't see the reviews players leave on their
courts without visiting each public branch page, and can't change their
business name or logo at all (both were set — or left null — at promotion).

## Decisions (rulings from brainstorming, 2026-08-06)

| Question | Ruling |
|---|---|
| Reviews access | **Owner + `view_bookings` staff** (operational feedback, branch-scoped). |
| Replies | **Out of scope** (needs a migration; future slice). |
| Settings fields | **business_name editable, logo upload/replace, slug READ-ONLY** with "set by our team — contact us to change it". |
| Settings access | **Owner only** (brand identity; staff never see it). |

## Reviews view (`/dashboard/reviews`)

- Sidebar item gated exactly like Bookings: owners always; staff via
  `branchIdsWith(access, 'view_bookings')` non-empty. Page inside the
  dashboard shell; entry redirect to `/dashboard` when the scope is empty and
  the session isn't an owner (the established pattern).
- Read-only list, newest first, scoped by `branch_id = any($branchIds)` in
  SQL: rating (branding's lime-dot mark + bold number), body (null bodies
  render nothing, not an empty quote), court name (reviews carry no
  `court_id` — join through `booking_id → bookings → courts`), branch name,
  player display name (`coalesce(full_name, split_part(email,'@',1))` — the
  owner-grid convention, consistent with public rendering), and the review's
  date (Manila-rendered).
- Branch filter as URL state (`?branch=<uuid>`, validated by UUID shape and
  membership in the accessible set — the `/dashboard/bookings` pattern),
  preserved across navigation. Empty states for "no reviews yet" and for a
  filtered branch with none.
- No pagination this slice: cap the query (`limit 100`, newest first) with a
  muted "showing the most recent 100" line when the cap is hit.

## Settings (`/dashboard/settings`)

- Owner-only: the page resolves `requireDashboardPage` like its siblings and
  then gates inline — `if (!access.isOwner) redirect('/dashboard')` — the
  same pattern the listings pages use for empty scopes. (NOT
  `requireOwnerPage`, whose 403 target is `/bookings`: a staff member poking
  at Settings belongs back on `/dashboard`, not bounced off the dashboard
  entirely.) Sidebar item `show: access.isOwner`.
- **Business name:** text field, trimmed, non-empty, capped by the same
  `MAX_BUSINESS_NAME_LENGTH` that governs `promoteToOwner` (one authority —
  import it, don't restate). Write: `update profiles set business_name = $
  where id = $ and role = 'owner'` (zero rows = friendly stale/role message).
- **Logo:** upload/replace reusing slice B's photo machinery — the same
  server-side type (jpeg/png/webp) and ≤5MB size validation constants from
  `src/lib/photos.ts`, the same storage-client boundary, object-first-then-row
  ordering (here "row" = the `profiles.business_logo_path` update), and
  best-effort removal of the REPLACED object after the path update commits
  (a dangling old object beats a broken logo — same asymmetry rationale as
  slice B, documented at the call site). A "remove logo" action nulls the
  path then best-effort-removes the object. Path convention: a `logos/`
  prefix keyed by owner id in the existing photo bucket (the plan verifies
  the exact bucket layout against `scripts/seed-photos.ts` and the storage
  migration before choosing).
- **Slug:** displayed read-only (mono, with the public URL preview
  `/owners/<slug>`), with the exact line: "Your brand link is set by our
  team — contact us to change it." Null slug (possible for a promoted owner
  whose slug was cleared, or legacy rows) renders the same line with an
  em-dash instead of a URL.
- The brand page (`/owners/[slug]`) does NOT yet render
  `business_logo_path` (it shows an initial badge behind a stale "no bucket
  exists" comment — corrected 2026-08-06; the plan writer verified). This
  slice makes it render the logo when the path is set, falling back to the
  initial badge. `revalidatePath` covers the brand page and the dashboard
  after writes. (The venues page carries the same stale comment but belongs
  to concurrently-modified files — flagged as a follow-up, untouched here.)

## Enforcement summary

- Reviews query: server-only module, scoped by the caller's accessible branch
  ids only (never `access.can`); no new guards needed.
- Settings actions: thin `'use server'` actions guarded `requireOwner`; logic
  in a server-only lib; every failure reason a typed variant with a rendered
  message; the actions file satisfies the action-coverage test genuinely.
- No migrations. No new permission flags.

## Testing

Hosted-DB discipline (self-seeded, id-tracked teardown, repeat-run safe,
foreground, 20s timeout now in the config):

- **Reviews query:** returns only the scoped branches' reviews (cross-owner
  exclusion pinned); branch filter narrows; court name resolves through the
  booking join; null body and null full_name rows render-safe (query-level
  coalesce/typing asserted); newest-first ordering with id tiebreak; the
  100-row cap.
- **Settings writes:** owner-only matrix (owner passes; staff/player/admin-
  target semantics per the guard; signed-out 401); name validation (empty,
  whitespace, over-cap); logo path update with the storage fake asserting
  bucket/path; replace removes the old object best-effort; remove nulls the
  path; zero-row stale path.
- No DOM tests; the manual-verification checklist is the plan's final task
  (expected cut per standing ruling — the user verifies after committing).

## Out of scope

- Review replies, moderation, or deletion.
- Slug editing (admin authority; a future admin screen could offer it with
  redirects).
- Notification emails.
- Aggregate rating widgets on the dashboard (the overview already has what it
  needs; public pages already aggregate).
