# Exclusive Roles, Vetted Owners, and Branch Staff — Design

**Date:** 2026-08-05
**Status:** approved, ready for implementation planning (after the dashboards slice)
**Parent spec:** `docs/superpowers/specs/2026-07-31-pickleball-court-booking-platform-design.md`
**Sequencing:** implemented **after** the in-flight dashboards slice
(`2026-08-02-dashboards-and-account-menu-design.md`) completes. Nothing that
slice builds is discarded; this slice generalizes its guards and reuses its
owner dashboard.

## Problem

The parent spec treats roles as an escalation ladder: everyone signs up as a
player, anyone becomes an owner by submitting a listing, and "owners are also
players — they can book other owners' courts with the same account." Product
direction has changed:

1. **A user is either a player or a court owner, never both.** Owner accounts
   are business accounts.
2. **Owner accounts are vetted.** Self-serve promotion via first listing is
   removed; an admin creates/approves owner accounts.
3. **Owners need to delegate.** A front-desk person at one branch should see
   that branch's schedule without holding the owner's account — so owners can
   grant users **staff** access, per branch, with per-staff permissions.

## Decisions (rulings from brainstorming, 2026-08-05)

| Question | Ruling |
|---|---|
| Can owners book courts? | **Own courts only**, as unpaid blocks/walk-ins. Never other venues. |
| How does one become an owner? | **Vetted**: admin promotes a player account. Promote-on-first-listing is removed. |
| Staff scope | **Specific branches** (one or more per staff member). |
| Staff permissions | **Per-staff checkboxes**: `view_bookings`, `block_slots`, `manage_courts`, `view_earnings`. |
| Staff identity | **Staff = player + grant.** `profiles.role` stays `player`; staff-ness lives in a separate table. |
| Adding staff | **Existing accounts only**, by exact email. No pending-invite state. |
| Owner-side bookings | **Blocks + walk-ins, no payment.** Excluded from platform earnings. No cash bookkeeping. |
| Sequencing | **After** the dashboards slice finishes. |

## Role model

`user_role` stays `('player', 'owner', 'admin')` — a single enum value is
already exclusive; no enum migration. What changes is acquisition and
capability:

- **Signup is unchanged:** the `auth.users` trigger creates every profile as
  `player`; the auth callback still promotes `ADMIN_EMAILS` matches to
  `admin`.
- **Owner creation is an admin act:** flip `role` to `'owner'` and set
  `business_name` + `slug`. The promotion **deletes any `branch_staff` rows
  the user holds** — a user is never simultaneously an owner and someone's
  staff. (Building the admin screen for this is out of scope here; the
  promotion is specified so the rule and its grant-revocation side effect are
  pinned by a test.)
- **Players:** book courts, leave reviews — unchanged.
- **Owners:** manage listings, branches, dashboards. **Cannot create paid
  bookings anywhere** and cannot review. Their only slot writes are blocks on
  their own courts.
- **Admins:** moderation, unchanged. Admins do not book.

## Staff grants

New table, following every project convention (RLS enabled zero policies,
snake_case, indexed FKs, server-only access):

```sql
create table if not exists branch_staff (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  view_bookings boolean not null default false,
  block_slots boolean not null default false,
  manage_courts boolean not null default false,
  view_earnings boolean not null default false,
  created_at timestamptz not null default now(),
  constraint branch_staff_unique unique (branch_id, user_id),
  constraint branch_staff_some_permission check (
    view_bookings or block_slots or manage_courts or view_earnings
  )
);
create index if not exists branch_staff_user_id_idx on branch_staff (user_id);
-- branch_id is covered by the unique constraint's index.
```

Rules enforced in the server actions (TypeScript is the security boundary,
per parent spec):

- Only the branch's owner (or admin) manages that branch's staff rows.
- The target must be an **existing** account (looked up by exact
  `profiles.email`) with `role = 'player'`. Owners and admins cannot be
  staffed. No cross-table DB constraint — profile role can change later; the
  promotion path above owns that edge.
- Owner UI: a staff page under `/dashboard` — list staff per branch, add by
  email with permission checkboxes, edit permissions, revoke. Same person may
  be staffed at several branches with different permissions (one row each).

## Blocks and walk-ins

A block is a `bookings` row with new status `blocked`. Rationale: the
`bookings_no_overlap` exclusion constraint is the double-booking guarantee
and only sees `bookings` rows — a separate table would need hand-rolled
cross-table overlap enforcement, recreating the exact bug class the
constraint kills.

Schema changes:

- `alter type booking_status add value if not exists 'blocked'` — in **its
  own migration file**: a value added to an enum cannot be used in the same
  transaction, and `db push` wraps each file in one.
- `player_id` becomes **nullable** with
  `check (status = 'blocked' or player_id is not null)` — blocks have no
  player. `fee_config_snapshot` likewise nullable with the same-shaped check
  (an empty-object snapshot would be a lie).
- Money columns stay `not null`; blocked rows write `0` everywhere.
- New columns: `created_by uuid references profiles (id)` (audit: which
  owner/staff user created the block; check: required on `blocked` rows,
  null otherwise — paid bookings' creator is `player_id`) and `note text`
  (optional label: "maintenance", "walk-in Juan"; null on paid bookings).
  Index `created_by` (FK rule).
- **Rebuild `bookings_no_overlap`** — exclusion constraints can't be
  altered, so drop and re-add with `blocked` added to the predicate:
  `where (status in ('pending_payment', 'confirmed', 'completed', 'blocked'))`.
  Keep the existing guarded-DO idempotency pattern (conrelid-qualified).

Semantics:

- Blocks occupy the slot (search/availability already treat the constraint's
  predicate statuses as taken — verify the availability query's status list
  and add `blocked` if it enumerates).
- **Earnings:** excluded automatically — all earnings math keys on
  `confirmed`/`completed`. Pinned by test.
- **`complete_past_bookings()`:** already filters `status = 'confirmed'`, so
  blocks never flip to `completed`. Pinned by regression test, not code
  change.
- **Player dashboard:** already filters to `confirmed`/`completed`; blocks
  never appear. `expire_stale_holds()` keys on `pending_payment`; untouched.
- Blocks are deletable by anyone holding `block_slots` on the branch (or the
  owner) — deleting a block frees the slot; unlike paid bookings there is no
  audit-trail reason to keep it. (Parent spec's "no DELETE on bookings"
  grant-hardening note is amended to carve out `blocked` rows.)

## Enforcement

Guard additions to `src/lib/auth/guards.ts` (throwing) and
`src/lib/auth/page-guards.ts` (redirecting), matching existing shapes:

- **`requirePlayer()`** — session user with `role = 'player'`. Applied to
  paid-booking hold creation and any future player-only write. The review
  action needs no change: review eligibility derives from owning a completed
  booking, which only players can have.
- **`requireBranchAccess(branchId, permission)`** — passes when the user is
  the branch's owner, an admin, or holds a `branch_staff` row for the branch
  with that permission flag true. Used by block create/delete and staff-
  visible dashboard reads. `requireOwnerOf` stays for owner-only surfaces
  (staff management, listings, fee-sensitive pages).

Surface changes:

- **`/dashboard` admits staff.** Layout guard becomes "owner, or has ≥1
  `branch_staff` row"; branch pickers show only granted branches; sections
  respect flags (no earnings without `view_earnings`, no court editing
  without `manage_courts`, etc.). Owners see everything they own, unchanged.
- **`/bookings` redirects owners to `/dashboard`** — owners can never have
  bookings. Players (staff included) keep `/bookings` as home.
- **Nav account menu:** "Owner dashboard" item becomes visible to staff too
  (label "Venue dashboard" for staff); booking CTAs hidden from owners, with
  the server guard as the real boundary.
- **Booking UI for owners:** venue pages hide "Book" CTAs for owner
  sessions; `requirePlayer` rejects direct action calls.

## Testing

Hosted-DB discipline unchanged (Supavisor 5432, self-seeded rows, repeat-run
safe, no singleton mutation):

- **Migration:** applies twice cleanly. A `blocked` row excludes an
  overlapping paid hold and vice versa (23P01 both directions). Check
  constraints: non-blocked row with null `player_id` rejected; blocked row
  with `created_by` null rejected; `branch_staff` with all-false permissions
  rejected; duplicate (branch, user) rejected.
- **Functions:** `complete_past_bookings()` leaves a past-dated `blocked`
  row untouched.
- **Guards:** `requirePlayer` rejects owner/admin; `requireBranchAccess`
  matrix — owner passes all flags, staff passes only granted flags on
  granted branches, other-branch staff and plain players rejected.
- **Actions:** staff add/edit/revoke (wrong-owner rejected, non-player
  target rejected, unknown email rejected, re-add after revoke works); block
  create/delete permission matrix; earnings queries ignore `blocked` rows.
- **Promotion rule:** promoting a staffed player to owner deletes their
  `branch_staff` rows.

## Out of scope

- Admin UI for vetting/promoting owners (the promotion action's rule is
  specified above; the screen belongs to the admin-panel slice).
- Inviting emails that have no account (no pending-invite state).
- Cash-revenue bookkeeping for walk-ins (blocks carry a note, not money).
- Payout implications (blocks carry no money).
- Custom staff roles beyond the four flags.

## Parent-spec amendments (applied 2026-08-05)

- **"Owners are also players" (Users & Auth)** — replaced: roles are
  exclusive; owners never book other venues.
- **"Owner role is granted on first submission" (listing flow)** — replaced:
  listing requires an existing vetted owner account.
- **`booking_status` enum (data model)** — gains `blocked`.
- **"No DELETE on bookings" (grants note)** — carve-out for `blocked` rows.
