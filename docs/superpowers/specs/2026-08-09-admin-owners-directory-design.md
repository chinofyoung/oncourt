# Admin owners directory

**Date:** 2026-08-09
**Status:** approved, ready for implementation
**Sibling spec:** `2026-08-09-admin-fee-settings-design.md` builds on this one. Build this first.

## Problem

`/admin/owners` is named "Owners" and listed in the admin sidebar as "Owners",
but it does not list owners. It is a single-purpose utility: type a player's
email, look them up, promote them. Once promoted, that person vanishes from
every admin surface — there is no screen anywhere in the app that answers "who
are our owners?", "what branches does this one run?", or "who has staff access
to what?".

The data exists. `profiles`, `branches`, `branch_staff` and `courts` are all
joinable, and `getBranchStaffForOwner` already performs the exact two-hop join
for a *single* owner. Nothing generalises it across owners.

An admin today answers those questions with hand-run SQL.

## Decisions

| Question | Decision |
|---|---|
| Route | `/admin/owners` becomes the directory |
| Promotion | Moves to `/admin/owners/promote`, unchanged, reached by a button |
| Structure | Owner → branches → staff, one nesting, matching the data |
| Who is an owner | `role = 'owner'`, plus `role = 'admin'` **only if they own ≥1 branch** |
| Query shape | Three queries stitched in TypeScript by owner id |
| Pagination | None, matching every other admin and dashboard list |
| Writes | None. This spec adds no mutation |

### Why promotion moves rather than sharing the page

The promote screen carries a four-bullet "Before you promote" panel explaining
that promotion revokes every staff grant the person holds and permanently stops
them booking courts. That panel is correct for a page an admin navigates to
deliberately, and wrong stacked above a directory they open to look something
up. Splitting them costs one route and keeps both pages honest about their
purpose.

The promote page's contents — `PromoteOwnerForm`, the consequences panel, the
header copy — move **verbatim**. This spec changes where that screen lives, not
what it does or says.

### Why staff nests inside branches

A `branch_staff` row grants permissions on **one branch**. The same person can
staff two of an owner's branches with different permissions on each — that is
the model, not an edge case. Listing staff as a flat set under the owner would
have to either invent a union (a lie about what they can do where) or show the
same name twice with no indication of why.

Nesting them under the branch they were granted on is the honest structure, and
it is the structure `/dashboard/staff` already renders for the owner's own view
of the same rows.

### Why an admin who owns branches is listed

`role` is exclusive: `'player' | 'owner' | 'admin'`. An admin is not an owner.
But `branches.owner_id` is a plain FK to `profiles` with no role constraint, and
`getOwnerProfile` in `src/lib/branches/queries.ts` already accepts
`role in ('owner', 'admin')` for the public owner page — so an admin holding
branches is a state the app already renders publicly.

Listing every admin would fill the directory with accounts that own nothing.
Hiding an admin who genuinely holds branches would make a directory of "who owns
what" omit an owner. So: `role = 'owner'` unconditionally, plus `role = 'admin'`
when a branch points at them. Role renders as a badge, so the distinction is
visible rather than silently flattened.

### Why three queries, not one join

One join across `profiles → branches → courts → branch_staff → profiles` would
multiply rows: an owner with 3 branches × 4 courts × 2 staff yields 24 rows to
de-duplicate in TypeScript, and the court count would need `count(distinct)`
gymnastics to survive the staff join.

Three queries — owners, then branches-with-court-counts for those owners, then
staff for those branches — each return exactly the rows they describe, and
stitch by id. This is the pattern `getAdminCourts` already uses for
`court_operating_hours` and `court_rate_bands`.

## Design

### 1. The queries — `src/lib/admin/owners.ts` (new file)

A new module beside the existing `src/lib/admin/queries.ts` and
`src/lib/admin/write.ts`, rather than more exports on `queries.ts`: this is a
self-contained read with three types of its own, and `queries.ts` is already the
moderation queue's home.

```ts
import 'server-only'

export type AdminOwnerStaffRow = {
  staffId: string
  userId: string
  email: string
  fullName: string | null
  permissions: StaffPermissions   // from '@/lib/staff/permissions'
  grantedOn: string               // 'YYYY-MM-DD', Manila
}

export type AdminOwnerBranchRow = {
  id: string
  name: string
  city: string
  slug: string
  courtCount: number              // every court, any status
  pendingCourtCount: number       // status = 'pending'
  staff: AdminOwnerStaffRow[]
}

export type AdminOwnerRow = {
  id: string
  email: string
  fullName: string | null
  businessName: string | null
  slug: string | null             // public address at /owners/<slug>
  role: 'owner' | 'admin'
  joinedOn: string                // 'YYYY-MM-DD', Manila
  branches: AdminOwnerBranchRow[]
  staffCount: number              // total grants across all branches
}

export async function getAdminOwners(): Promise<AdminOwnerRow[]>
```

**Query 1 — the owners.**

```sql
select p.id, p.email, p.full_name, p.business_name, p.slug, p.role::text as role,
       to_char(p.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as joined_on
from profiles p
where p.role = 'owner'
   or (p.role = 'admin' and exists (select 1 from branches b where b.owner_id = p.id))
order by coalesce(p.business_name, p.email), p.id
```

`order by coalesce(business_name, email)` sorts a not-yet-configured owner by
the only name they have, rather than dumping every unconfigured owner in one
`null` clump. `p.id` is the tiebreaker so the order is total and stable across
runs — two owners can share a business name.

**Query 2 — branches with court counts**, for the owner ids from query 1:

```sql
select b.id, b.owner_id, b.name, b.city, b.slug,
       count(c.id) as court_count,
       count(c.id) filter (where c.status = 'pending') as pending_court_count
from branches b
left join courts c on c.branch_id = b.id
where b.owner_id = any (${sql.param(ownerIds)}::uuid[])
group by b.id
order by b.name, b.id
```

`left join` so a branch with no courts still appears with a count of 0 — a
branch that renders nowhere is exactly what an admin needs to see. `count(c.id)`
rather than `count(*)`, which would return 1 for the no-courts row.

**Query 3 — staff**, for the branch ids from query 2, reusing the
`getBranchStaffForOwner` join shape but keyed by branch id:

```sql
select s.id as staff_id, s.branch_id, s.user_id, p.email, p.full_name,
       s.view_bookings, s.block_slots, s.manage_courts, s.view_earnings,
       to_char(s.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as granted_on
from branch_staff s
join profiles p on p.id = s.user_id
where s.branch_id = any (${sql.param(branchIds)}::uuid[])
order by p.email, s.id
```

An inner join here, not the left join `getBranchStaffForOwner` uses: that
function left-joins from `branches` because it must return every branch (each
needs an "add staff" form). Here branches already come from query 2, so this
query only needs the grants that exist.

**Stitching.** Build a `Map<ownerId, AdminOwnerRow>`, then a
`Map<branchId, AdminOwnerBranchRow>`, then push staff into their branch.
`permissions` is folded from the four booleans with the same loop
`getBranchStaffForOwner` uses (`noPermissions()` then set each key), so the
shape is identical to what `STAFF_PERMISSION_LABELS` expects.

**Empty-input guard:** if query 1 returns no owners, return `[]` without running
queries 2 and 3 — `= any ('{}'::uuid[])` is valid but pointless, and the same
guard is needed anyway before `sql.param([])`.

### 2. The page — `src/app/admin/owners/page.tsx` (rewritten)

`requireAdminPage('/admin/owners')`, then `getAdminOwners()`.

Header: "Owners", a one-line count (`14 owners`, singular at 1), and a
**"Promote a player"** link-button to `/admin/owners/promote` on the right.

Body: one `<section>` card per owner, following the `/dashboard/staff` shape —
the closest existing precedent for entity-with-nested-detail. Per owner:

- **Name line:** `business_name`, falling back to `full_name`, falling back to
  `email`. Beside it, the role badge (`owner` / `admin`) as the same pill-shaped
  `font-mono` uppercase chip the admin layout uses for its "admin" chip.
- **Sub-line:** email, `/owners/<slug>` as a link when `slug` is set, joined date
  via `formatDateLabel`.
- **Counts:** branches, courts, staff — plain text, `font-mono` for the numerals
  per `branding.md`'s numeral rule.
- **Branches:** a `<ul>`. Each branch shows name, city, court count, and
  `N pending` in the warning tone when `pendingCourtCount > 0` (this is the one
  number an admin acts on — it links to the moderation queue's own job).
  Under each branch, its staff as a nested `<ul>`: email, full name, permission
  badges from `STAFF_PERMISSION_LABELS`, granted date.
- **Empty states, all three distinct:** an owner with no branches reads "No
  branches yet."; a branch with no courts reads "No courts yet."; a branch with
  no staff reads "No staff." A promoted-but-unconfigured owner is normal and
  must not look like an error.

No `<table>`: the content is two levels of nesting with variable-length badge
lists, which a table cannot express without colspan tricks. The card-per-entity
shape is the right precedent.

### 3. The promote page — `src/app/admin/owners/promote/page.tsx` (new)

The current `src/app/admin/owners/page.tsx` body moves here whole: the header,
the "Before you promote" panel, and `<PromoteOwnerForm />`. Add a back-link to
`/admin/owners`. `requireAdminPage('/admin/owners/promote')`.

`promote-form.tsx` moves to `src/app/admin/owners/promote/promote-form.tsx`
alongside it. `src/app/admin/actions.ts` is **not** moved — the actions stay
where they are and the import path in the form updates.

One line in `src/app/admin/actions.ts` changes: `promoteOwnerAction` calls
`revalidatePath('/admin/owners')`, which is now the directory. That path is
still correct and must stay — a promotion adds a row to the directory. Add
`revalidatePath('/admin/owners/promote')` beside it so the promote screen's own
render is not served stale.

### 4. Navigation — `src/app/admin/layout.tsx`

Unchanged. The existing `{ href: '/admin/owners', label: 'Owners', badge: 0 }`
item now points at a page that is actually a list of owners. No new nav item:
`/admin/owners/promote` is reached from the directory, not the sidebar.

## Testing

`tests/admin/owners.test.ts`, against the hosted database, in the foreground,
using `tests/helpers/fixtures.ts` (`seedOwner`, `seedPlayer`,
`seedBranchWithCourts`, `seedStaffGrant`) and `afterAll(teardownFixtures)`.

The database is shared and persistent and already holds other owners, so every
cross-owner assertion is a **delta or a lookup of a known id** — never an
absolute count and never an index into the array.

- A seeded owner appears in the result, found by id, with their branches nested
  and their staff nested inside those branches.
- A staff member granted on two of one owner's branches appears **twice**, once
  under each branch, with the permissions granted on that branch — not merged.
- Permission folding is exact: a grant with only `view_bookings` yields
  `{view_bookings: true, block_slots: false, manage_courts: false,
  view_earnings: false}`.
- `courtCount` counts every court regardless of status; `pendingCourtCount`
  counts only `pending`. Seed a branch with a pending and an approved court and
  assert 2 and 1.
- A branch with no courts appears with `courtCount === 0` — proving the
  `left join` and that `count(c.id)` was used rather than `count(*)`.
- An owner with no branches appears with `branches: []`.
- **Isolation:** a second seeded owner's branches and staff never appear under
  the first. Assert by id, both directions.
- A seeded `role = 'player'` profile never appears, even when they hold a staff
  grant. Staff are not owners.
- A seeded `role = 'admin'` with no branches never appears; give that same admin
  a branch and they do. This is the one rule a reviewer cannot infer from the
  types, so it gets a test of its own.
- `getAdminOwners()` on an empty owner set is not testable against a shared
  database that already has owners — the empty-input guard is covered by the
  branch/staff level instead: an owner with no branches exercises the
  `branchIds.length === 0` path for query 3.

Existing suites must pass unchanged. `tests/admin/queries.test.ts`,
`tests/admin/write.test.ts` and `tests/admin/permissions.test.ts` touch none of
this and a diff to any of them signals the change escaped its scope.

## Verification

- `npx tsc --noEmit` and `npx eslint` clean. Baseline: **9 warnings, 0 errors**.
- `/admin/**` is **behind auth and cannot be browser-verified by an agent** —
  this project has no dev login. Do not claim a visual check that did not
  happen. The nesting, the empty states and the permission badges must be
  confirmed by the user or left explicitly unverified.
- The moved promote screen is the regression risk: confirm by reading that the
  form, the consequences panel and the action wiring arrived intact, and that no
  import still points at the old path.

## Out of scope

- Editing anything on this page. It is read-only; the sibling fee spec adds the
  single write.
- Admin revocation of staff grants, and demoting an owner back to player.
  Demotion in particular orphans branches and courts and needs its own design.
- Search, filtering, sorting controls, or pagination.
- Owner-level activity, revenue or booking figures.
- Any change to `/dashboard/staff`, `getBranchStaffForOwner`, or the promotion
  logic in `src/lib/admin/write.ts`.
