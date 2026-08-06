# Listings Management & Admin Surface — Design

**Date:** 2026-08-06
**Status:** approved — Slice B plan first, then Slice C
**Parent specs:** `2026-07-31-pickleball-court-booking-platform-design.md` (listing flow, approval rules),
`2026-08-05-roles-and-staff-design.md` (vetted owners, `manage_courts` staff permission)
**Sequencing:** two implementation plans — **Slice B (listings)** first, then
**Slice C (admin)**. B's tests flip court statuses via SQL fixtures, so B does
not depend on C's queue to be testable. Slice D (owner reviews view + settings)
remains a later, separate design.

## Problem

Owners have no way to create or edit listings — every branch and court in the
database was seeded by SQL. The "List your court" CTAs dead-end at `/login`.
The `manage_courts` staff permission stores a grant that nothing honors yet.
And courts enter `pending` with no admin surface to approve them, so even a
built listing flow would dead-end at moderation. The roles slice's
promote-to-owner function has no screen either — vetted owners can only be
created by hand-run SQL.

## Decisions (rulings from brainstorming, 2026-08-06)

| Question | Ruling |
|---|---|
| Listing UX shape | **Full management pages** under `/dashboard` — no separate wizard; first listing is the empty state of the same pages. |
| Map location | **Address + draggable pin.** Geocode the typed address, owner fine-tunes by dragging. |
| Geocoder | **Nominatim (OSM)** behind a provider-swappable server helper. Low volume; the pin drag is the precision tool. Google later if needed. |
| Photos | **In scope, basic:** upload, reorder (`sort_order`), delete. Branch and court photos. No cropping/editing. |
| Slice C scope | **Approval queue + promote-to-owner screen + suspend/unsuspend.** |
| Email notifications | **Out of scope** — the parent spec's Resend approve/reject emails land in a later slice. |

## Slice B — Listings management

### Pages (all inside the `/dashboard` shell)

- **`/dashboard/listings`** — branch list (name, city, court counts by status),
  "Add branch" (owner only). The sidebar gains a "Branches & courts" item;
  visibility mirrors the staff-page pattern: owners always; staff only if they
  hold `manage_courts` somewhere (`branchIdsWith(access, 'manage_courts')`).
- **`/dashboard/listings/[branchId]`** — branch detail: edit branch fields
  (name, description, address, city, contact phone/email, amenities), the map
  pin editor, branch photos, court list with statuses (incl. `rejection_reason`
  when rejected), "Add court" (owner only).
- **`/dashboard/listings/[branchId]/courts/[courtId]`** — court detail: edit
  name/environment/surface, weekly operating hours (7 weekday rows), rate
  bands, court photos. Status banner: pending ("awaiting approval"), rejected
  (reason + what to do), suspended (contact support copy), approved.

### Permissions

- **Create branch / create court / edit branch fields / manage branch
  photos: owner only** (`requireOwnerOf`; branch creation `requireOwner`).
  Staff never create branches or courts.
- **Edit court fields (name, environment, surface, hours, rate bands, court
  photos incl. reorder/delete): owner, or staff with `manage_courts` on that
  branch**
  (`requireBranchAccess(branchId, 'manage_courts')`), branch resolved
  server-side from the court — never from the form (the blocks pattern).
- The staff form's "arrives with the listings update" hint sentence is
  removed in this slice — the permission is now real.
- Branch **deletion is out of scope** (cascades would eat courts with booking
  history; `bookings.branch_id` is RESTRICT so the DB refuses anyway — the UI
  simply doesn't offer it). Court deletion likewise out — status is the
  lifecycle tool.

### Approval lifecycle (parent spec's rules, made precise)

- A new court inserts as `pending`.
- **Key-field edits re-queue** that court to `pending` and clear
  `rejection_reason`: rate bands, operating hours, `environment`. Name,
  `surface`, photos, and all branch-level edits do **not** re-queue.
- A `rejected` court re-queues to `pending` on ANY key-field edit (that is the
  owner's "fix and resubmit" path — no separate resubmit button).
- Public surfaces already filter to `approved` everywhere; a court leaving
  `approved` disappears from search/venue pages. Its existing bookings remain
  in the owner's bookings list (branch-scoped), while the day grid — scoped
  to approved courts — hides them: the roles slice's documented behavior,
  unchanged here.

### Validation (server-only lib, TDD'd — the heart of the slice)

- **Operating hours:** per weekday, either closed (no row) or one window
  `0 ≤ opens < closes ≤ 24`, integer hours. At least one open weekday.
- **Rate bands:** integer hours, `price_centavos > 0` integer, bands must
  **exactly tile `[min(opens_hour), max(closes_hour)]` across the week** —
  contiguous, no gaps, no overlaps (matches how the seeded data is shaped and
  how `priceForHour` resolves). Stored atomically: replace-all in one
  transaction (delete + insert), never partial.
- **Branch fields:** name/address/city non-empty; contact email shape-checked;
  amenities from a fixed vocabulary (the one the search filters already use);
  location must be a valid lat/lng within a Philippines bounding box (sanity
  check against a mis-dragged pin at 0,0).
- All money integer centavos; all writes `db.execute(sql\`...\`)`; every
  friendly failure a typed reason rendered by the form (the staff-page
  pattern).

### Map pin + geocoding

- Client: a small Leaflet client component (dynamic-imported like
  `branch-map-dynamic.tsx`) with a draggable marker and hidden lat/lng inputs.
- Server: a server action (`geocodeAddressAction`, guarded `requireOwner`)
  calling **Nominatim** — one request per submit, proper `User-Agent`, results cached
  per address string in-memory; provider behind a
  `geocodeAddress(q): Promise<{lat,lng} | null>` interface so Google can swap
  in. Geocode failure is non-blocking: the owner can always place the pin by
  hand (default center: the branch's city, else Metro Manila).

### Photos

- Server action receives `FormData` file(s); validates type
  (jpeg/png/webp) and size (≤ 5 MB) server-side; uploads via the service-role
  storage client to the existing `branch-photos` bucket paths
  (`branches/<id>/…`, `courts/<id>/…`); inserts the row with the next
  `sort_order`. Reorder = swap `sort_order` values; delete removes the storage
  object **and** the row (row first would orphan the object on failure —
  object first, then row, with the mismatch direction documented).
- Photo edits never re-queue a court.

## Slice C — Admin surface

### Shell and guard

- **`/admin`** route group with its own layout (sidebar: Approvals, Owners),
  guarded once by a new **`requireAdminPage`** (redirect flavor: 401 → login
  with `next`, non-admin → `/`) plus per-page re-assertion, mirroring
  `/dashboard`'s two-layer pattern. Admin identity remains `profiles.role =
  'admin'` via the `ADMIN_EMAILS` callback promotion — unchanged.
- Nav/account menu: admins get an "Admin" item (they already get the owner
  dashboard link; admin link sits beside it).

### Approval queue (`/admin` home)

- Lists `pending` courts across all owners: court name, environment, branch,
  owner business name, submitted date, quick facts (hours summary, band count,
  photo count) — enough to moderate without leaving the page; link to the
  public branch preview.
- **Approve** → `approved` (idempotent; friendly reason if the court moved
  states meanwhile). **Reject** → requires a non-empty reason →
  `rejected` + `rejection_reason`.
- **Suspend/unsuspend** on a second tab listing `approved` courts (and
  `suspended` ones to reverse). Suspending never touches bookings; the roles
  slice already defined how suspended courts render on the owner dashboard.
- Reject and suspend are single-statement status-scoped UPDATEs (the blocks
  pattern): zero rows = friendly stale-state message, no read-then-write race.
  **Amended during execution (2026-08-06, user ruling):** approve and
  unsuspend — the two transitions that put a court on the market — are
  instead `for update`-locked transactions that re-evaluate
  `courtScheduleWarning` and refuse (`schedule_incomplete`) while the stored
  rate bands don't tile the stored hours, so a court can never go live
  unpriceable. Their status UPDATEs remain status-scoped inside the
  transaction.

### Promote-to-owner (`/admin/owners`)

- Email lookup (exact, case-insensitive — slice A's deterministic rule),
  showing the matched player; inputs for business name + slug (slug
  shape-checked client-side, uniqueness by the DB); calls slice A's
  `promoteToOwner` and renders its typed reasons (`no_such_user`,
  `not_a_player`, `already_owner`, `slug_taken`).
- Reminder rendered on the page: promotion revokes the player's staff grants
  and ends their ability to book (the exclusivity rules) — admin sees what
  they're about to do.

## Enforcement summary

- New guards: `requireAdminPage` (page flavor of the existing `requireAdmin`).
- Actions: listings writes behind `requireOwnerOf` /
  `requireBranchAccess(branchId,'manage_courts')` per the table above; admin
  actions behind `requireAdmin`. Every new `'use server'` file: thin guarded
  async actions only; logic in server-only libs; `GUARDS` list already covers
  all names used.
- No migrations. Every table, column, enum, index, and bucket already exists.

## Testing

Hosted-DB discipline as always (self-seeded, id-tracked teardown, repeat-run
safe, foreground runs):

- **Validation lib:** hours windows (bad ranges, all-closed), band tiling
  (gap, overlap, wrong span, non-integer, zero price), PH bounding box.
- **Write paths:** create branch/court (statuses, defaults); key-field edit
  re-queues + clears reason, non-key edit doesn't; rejected → edit → pending;
  staff `manage_courts` matrix (granted branch passes, other branch/no-flag
  rejected, owner passes, create refused for staff); photo row lifecycle +
  sort order (storage calls faked at the client boundary — the one permitted
  test double, since the bucket is shared).
- **Admin:** status transitions (approve/reject/suspend) incl. stale-state
  zero-row paths; reject requires reason; promote screen's action wraps the
  already-tested `promoteToOwner` (action-coverage test extends to any new
  guard names automatically — verify).
- **Geocoder:** the provider helper unit-tested against a faked fetch (the
  second permitted double — external HTTP); the Nominatim call itself is not
  integration-tested.

## Out of scope

- Approve/reject email notifications (Resend) — later slice, noted in the
  parent spec's flow.
- First-listing wizard UX, photo cropping/editing, bulk operations.
- Branch/court deletion (status lifecycle covers moderation needs).
- Admin payout ledger, fee-override editing, review moderation — the rest of
  the admin panel.
- Slice D (owner reviews view + settings page).
