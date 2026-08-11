# Admin Owners Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/admin/owners` from a promote-a-player form into a directory of every owner, their branches, and the staff granted access to each branch.

**Architecture:** One new server-only read module (`src/lib/admin/owners.ts`) running three queries and stitching them by id in TypeScript. The page is a Server Component rendering one card per owner with branches nested inside, and staff nested inside those. The existing promote screen moves to its own route, unchanged.

**Tech Stack:** Next.js App Router (TypeScript), Postgres via `db.execute(sql\`...\`)`, Tailwind CSS v4, Vitest against a hosted Supabase database.

**Spec:** `docs/superpowers/specs/2026-08-09-admin-owners-directory-design.md`

## Global Constraints

- Data access is **server-only**. Every read/write goes through a Server Component, Server Action or Route Handler guarded by `requireAdmin` / `requireAdminPage`. TypeScript is the security boundary.
- SQL is written by hand and executed with `db.execute(sql\`...\`)`. **Never** the Drizzle query builder. Never import `src/db/schema.ts`.
- Read design rules from `design/branding.md` before writing any markup, and follow them (colors, type, control tokens, radius, layout column, no gradients).
- **Never** use the Tailwind class `outline-none` or `outline-hidden`. In Tailwind v4 it compiles to an ungated `--tw-outline-style: none` that `focus-visible:outline-*` reads back through `var()`, silently killing the focus ring. Write `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--court)]` with no `outline-none` alongside it.
- All user-facing copy is **English only**. No Taglish. Currency is PHP (₱).
- Money is integer centavos; percentages integer basis points. Never floats.
- Tests run against a **hosted, shared, persistent** database via `DATABASE_URL` in `.env.local`. There is no reset between runs: tests must pass on repeated runs, must not mutate seeded singleton rows, and any assertion about a global count must be a **delta**, never an absolute.
- Run vitest in the **foreground** only. Never with `run_in_background`.
- **Three test files already fail** for pre-existing, unrelated reasons and must be left exactly as they are: `tests/schema/settings.test.ts`, `tests/booking/hold.test.ts`, `tests/listings/write.test.ts`.
- Verification baseline: `npx tsc --noEmit` clean, `npx eslint .` → **9 warnings, 0 errors**.
- `/admin/**` is behind auth and **cannot be browser-verified** — this project has no dev login. Never claim a visual check that did not happen; report it as unverified instead.
- Do NOT run any state-changing git command (commit, branch, checkout, stash, reset, …). The user commits. Where a plan step says "commit", stop and report instead.

---

### Task 1: The owners query

**Files:**
- Create: `src/lib/admin/owners.ts`
- Test: `tests/admin/owners.test.ts`

**Interfaces:**
- Consumes: `StaffPermissions`, `STAFF_PERMISSIONS`, `noPermissions` from `@/lib/staff/permissions`; `db` from `@/db`; `sql` from `drizzle-orm`.
- Produces: `getAdminOwners()`, `AdminOwnerRow`, `AdminOwnerBranchRow`, `AdminOwnerStaffRow` — Task 3 renders exactly these.

- [ ] **Step 1: Write the failing tests**

Create `tests/admin/owners.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { getAdminOwners } from '@/lib/admin/owners'
import {
  seedAdmin,
  seedBranchWithCourts,
  seedPlayer,
  seedStaffGrant,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

/** A second branch for an owner seedBranchWithCourts() already created. */
async function addBranch(ownerId: string, name: string): Promise<string> {
  const slug = 'fixture-' + crypto.randomUUID()
  const result = await db.execute(sql`
    insert into branches (owner_id, name, slug, address, city, location)
    values (${ownerId}::uuid, ${name}, ${slug}, '2 Fixture Ave', 'Pasig',
            st_setsrid(st_makepoint(121.0851, 14.5764), 4326)::geography)
    returning id
  `)
  return result.rows[0].id as string
}

async function setCourtStatus(courtId: string, status: string): Promise<void> {
  await db.execute(sql`update courts set status = ${status}::court_status where id = ${courtId}::uuid`)
}

test('an owner appears with branches nested, and staff nested inside branches', async () => {
  const { ownerId, branchId } = await seedBranchWithCourts(2)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, viewBookings: true })

  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  expect(owner).toBeDefined()
  expect(owner!.role).toBe('owner')
  expect(owner!.branches).toHaveLength(1)

  const branch = owner!.branches[0]
  expect(branch.id).toBe(branchId)
  expect(branch.name).toBe('Fixture Branch')
  expect(branch.city).toBe('Marikina')
  expect(branch.staff).toHaveLength(1)
  expect(branch.staff[0].userId).toBe(staffId)
  expect(owner!.staffCount).toBe(1)
})

test('permissions are folded exactly, not merged or widened', async () => {
  const { ownerId, branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, viewBookings: true })

  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  expect(owner!.branches[0].staff[0].permissions).toEqual({
    view_bookings: true,
    block_slots: false,
    manage_courts: false,
    view_earnings: false,
  })
})

test('one person staffing two branches appears under each, with that branch permissions', async () => {
  const { ownerId, branchId } = await seedBranchWithCourts(1)
  const secondBranchId = await addBranch(ownerId, 'Fixture Branch Two')
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, viewBookings: true })
  await seedStaffGrant({ branchId: secondBranchId, userId: staffId, viewEarnings: true })

  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  expect(owner!.branches).toHaveLength(2)
  expect(owner!.staffCount).toBe(2)

  const first = owner!.branches.find((b) => b.id === branchId)!
  const second = owner!.branches.find((b) => b.id === secondBranchId)!
  expect(first.staff[0].permissions.view_bookings).toBe(true)
  expect(first.staff[0].permissions.view_earnings).toBe(false)
  expect(second.staff[0].permissions.view_earnings).toBe(true)
  expect(second.staff[0].permissions.view_bookings).toBe(false)
})

test('courtCount counts every status, pendingCourtCount only pending', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(2)
  await setCourtStatus(courtIds[0], 'pending')

  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  const branch = owner!.branches.find((b) => b.id === branchId)!
  expect(branch.courtCount).toBe(2)
  expect(branch.pendingCourtCount).toBe(1)
})

test('a branch with no courts reports zero, not one', async () => {
  // count(c.id) vs count(*): count(*) returns 1 for the left join's null row.
  const { ownerId } = await seedBranchWithCourts(1)
  const emptyBranchId = await addBranch(ownerId, 'Fixture Empty Branch')

  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  const branch = owner!.branches.find((b) => b.id === emptyBranchId)!
  expect(branch.courtCount).toBe(0)
  expect(branch.pendingCourtCount).toBe(0)
  expect(branch.staff).toEqual([])
})

test('an owner with no branches still appears', async () => {
  const ownerId = await seedPlayer()
  await db.execute(sql`update profiles set role = 'owner' where id = ${ownerId}::uuid`)

  const owner = (await getAdminOwners()).find((row) => row.id === ownerId)
  expect(owner).toBeDefined()
  expect(owner!.branches).toEqual([])
  expect(owner!.staffCount).toBe(0)
})

test("one owner's branches and staff never appear under another", async () => {
  const first = await seedBranchWithCourts(1)
  const second = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId: second.branchId, userId: staffId, viewBookings: true })

  const owners = await getAdminOwners()
  const a = owners.find((row) => row.id === first.ownerId)!
  const b = owners.find((row) => row.id === second.ownerId)!

  expect(a.branches.map((branch) => branch.id)).toEqual([first.branchId])
  expect(b.branches.map((branch) => branch.id)).toEqual([second.branchId])
  expect(a.branches.flatMap((branch) => branch.staff)).toEqual([])
  expect(b.branches[0].staff.map((s) => s.userId)).toEqual([staffId])
})

test('a player is never an owner, even holding a staff grant', async () => {
  const { branchId } = await seedBranchWithCourts(1)
  const staffId = await seedPlayer()
  await seedStaffGrant({ branchId, userId: staffId, manageCourts: true })

  const owners = await getAdminOwners()
  expect(owners.find((row) => row.id === staffId)).toBeUndefined()
})

test('an admin is listed only once they own a branch', async () => {
  const adminId = await seedAdmin()
  expect((await getAdminOwners()).find((row) => row.id === adminId)).toBeUndefined()

  const branchId = await addBranch(adminId, 'Fixture Admin Branch')
  const listed = (await getAdminOwners()).find((row) => row.id === adminId)
  expect(listed).toBeDefined()
  expect(listed!.role).toBe('admin')
  expect(listed!.branches.map((branch) => branch.id)).toEqual([branchId])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/admin/owners.test.ts`
Expected: FAIL — cannot resolve `@/lib/admin/owners`.

- [ ] **Step 3: Write the module**

Create `src/lib/admin/owners.ts`:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { noPermissions, STAFF_PERMISSIONS, type StaffPermissions } from '@/lib/staff/permissions'

export type AdminOwnerStaffRow = {
  staffId: string
  userId: string
  email: string
  fullName: string | null
  permissions: StaffPermissions
  /** A Manila calendar date (`YYYY-MM-DD`), ready for formatDateLabel(). */
  grantedOn: string
}

export type AdminOwnerBranchRow = {
  id: string
  name: string
  city: string
  slug: string
  /** Every court, any status — including ones that render nowhere public. */
  courtCount: number
  pendingCourtCount: number
  staff: AdminOwnerStaffRow[]
}

export type AdminOwnerRow = {
  id: string
  email: string
  fullName: string | null
  businessName: string | null
  /** The public address at /owners/<slug>. Null until promotion sets it. */
  slug: string | null
  role: 'owner' | 'admin'
  joinedOn: string
  branches: AdminOwnerBranchRow[]
  /** Total grants across every branch — a person staffing two counts twice. */
  staffCount: number
}

/**
 * Every owner, with their branches and each branch's staff.
 *
 * Three queries stitched by id rather than one join: a single join across
 * profiles → branches → courts → branch_staff multiplies rows (3 branches × 4
 * courts × 2 staff = 24 rows to de-duplicate), and the court counts would need
 * count(distinct) to survive the staff join. Each query here returns exactly
 * the rows it describes. Same shape as getAdminCourts' follow-up queries.
 *
 * Staff nest inside BRANCHES, not beside the owner: a branch_staff row grants
 * permissions on one branch, and the same person can hold different
 * permissions on two branches of the same owner. Flattening to the owner would
 * have to invent a union — a lie about what they can do where.
 *
 * No pagination, matching every other admin and dashboard list. If this ever
 * outgrows one page, that is a real change, not a tweak.
 */
export async function getAdminOwners(): Promise<AdminOwnerRow[]> {
  // role = 'owner' unconditionally, plus an admin who actually holds branches.
  // branches.owner_id has no role constraint and getOwnerProfile already
  // renders `role in ('owner','admin')` publicly, so an admin with branches is
  // a real owner of record. An admin with none is just an admin.
  const ownerRows = await db.execute(sql`
    select p.id, p.email, p.full_name, p.business_name, p.slug, p.role::text as role,
           to_char(p.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as joined_on
    from profiles p
    where p.role = 'owner'
       or (p.role = 'admin' and exists (select 1 from branches b where b.owner_id = p.id))
    order by coalesce(p.business_name, p.email), p.id
  `)

  const owners: AdminOwnerRow[] = ownerRows.rows.map((row) => ({
    id: row.id as string,
    email: row.email as string,
    fullName: (row.full_name as string | null) ?? null,
    businessName: (row.business_name as string | null) ?? null,
    slug: (row.slug as string | null) ?? null,
    role: row.role as 'owner' | 'admin',
    joinedOn: row.joined_on as string,
    branches: [],
    staffCount: 0,
  }))

  if (owners.length === 0) return []

  const byOwner = new Map(owners.map((owner) => [owner.id, owner]))
  const ownerIds = owners.map((owner) => owner.id)

  // left join + count(c.id): count(*) would return 1 for the no-courts row.
  const branchRows = await db.execute(sql`
    select b.id, b.owner_id, b.name, b.city, b.slug,
           count(c.id) as court_count,
           count(c.id) filter (where c.status = 'pending') as pending_court_count
    from branches b
    left join courts c on c.branch_id = b.id
    where b.owner_id = any (${sql.param(ownerIds)}::uuid[])
    group by b.id
    order by b.name, b.id
  `)

  const byBranch = new Map<string, AdminOwnerBranchRow>()
  for (const row of branchRows.rows) {
    const branch: AdminOwnerBranchRow = {
      id: row.id as string,
      name: row.name as string,
      city: row.city as string,
      slug: row.slug as string,
      courtCount: Number(row.court_count),
      pendingCourtCount: Number(row.pending_court_count),
      staff: [],
    }
    byBranch.set(branch.id, branch)
    byOwner.get(row.owner_id as string)?.branches.push(branch)
  }

  const branchIds = [...byBranch.keys()]
  if (branchIds.length === 0) return owners

  // An inner join, unlike getBranchStaffForOwner's left join: that function
  // must return every branch so each gets an "add staff" form. Here the
  // branches already exist from the query above, so this only needs the grants.
  const staffRows = await db.execute(sql`
    select s.id as staff_id, s.branch_id, s.user_id, p.email, p.full_name,
           s.view_bookings, s.block_slots, s.manage_courts, s.view_earnings,
           to_char(s.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as granted_on
    from branch_staff s
    join profiles p on p.id = s.user_id
    where s.branch_id = any (${sql.param(branchIds)}::uuid[])
    order by p.email, s.id
  `)

  const ownerOfBranch = new Map<string, string>()
  for (const row of branchRows.rows) ownerOfBranch.set(row.id as string, row.owner_id as string)

  for (const row of staffRows.rows) {
    const permissions = noPermissions()
    for (const permission of STAFF_PERMISSIONS) {
      permissions[permission] = row[permission] === true
    }

    const branchId = row.branch_id as string
    byBranch.get(branchId)?.staff.push({
      staffId: row.staff_id as string,
      userId: row.user_id as string,
      email: row.email as string,
      fullName: (row.full_name as string | null) ?? null,
      permissions,
      grantedOn: row.granted_on as string,
    })

    const ownerId = ownerOfBranch.get(branchId)
    if (ownerId) {
      const owner = byOwner.get(ownerId)
      if (owner) owner.staffCount += 1
    }
  }

  return owners
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/admin/owners.test.ts`
Expected: PASS, 9 tests.

If `count(c.id)` comes back as a string rather than a number, that is why `Number(...)` wraps it — `bigint` from Postgres arrives as a string in some drivers. Do not remove those wrappers.

- [ ] **Step 5: Verify nothing else moved**

Run: `npx tsc --noEmit` — expect clean.
Run: `npx eslint .` — expect 9 warnings, 0 errors.
Run: `npx vitest run tests/admin` — expect all four admin files passing.

- [ ] **Step 6: Report (do not commit — the user commits)**

---

### Task 2: Move the promote screen to its own route

**Files:**
- Create: `src/app/admin/owners/promote/page.tsx`
- Create: `src/app/admin/owners/promote/promote-form.tsx` (moved)
- Delete: `src/app/admin/owners/promote-form.tsx`
- Modify: `src/app/admin/owners/page.tsx` (temporarily — Task 3 replaces it)
- Modify: `src/app/admin/actions.ts` (one added `revalidatePath`)

**Interfaces:**
- Consumes: `PromoteOwnerForm` (unchanged), `requireAdminPage`, `lookupPlayerAction` / `promoteOwnerAction` from `@/app/admin/actions`.
- Produces: the route `/admin/owners/promote`, which Task 3 links to.

**This task moves code. It must not rewrite it.** The consequences panel's wording, the form's fields, and the action wiring all stay byte-identical; only the file location and import paths change.

- [ ] **Step 1: Move the form component**

Move `src/app/admin/owners/promote-form.tsx` to `src/app/admin/owners/promote/promote-form.tsx` with its contents unchanged. Its import of `@/app/admin/actions` is an alias path and does **not** change. Its import of `@/app/dashboard/listings/form-ui` does not change either.

- [ ] **Step 2: Create the promote page**

Create `src/app/admin/owners/promote/page.tsx`. Take the entire current body of `src/app/admin/owners/page.tsx` — header, the "Before you promote" section, the card wrapping `<PromoteOwnerForm />` — and move it here verbatim, with three changes: the guard path, a back link, and the local import.

```tsx
import Link from 'next/link'
import { requireAdminPage } from '@/lib/auth/page-guards'
import { PromoteOwnerForm } from './promote-form'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)] max-[560px]:p-5'
const BACK_LINK =
  'text-[13px] font-medium text-[var(--court)] hover:text-[var(--court-deep)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--court)]'

/**
 * Promote a player into a vetted owner.
 *
 * Split out of /admin/owners when that route became the owners directory. The
 * "Before you promote" panel is right for a page an admin navigates to
 * deliberately and wrong stacked above a directory they open to look something
 * up — so promotion got its own route rather than sharing one.
 *
 * Self-serve promotion does not exist any more (the roles slice removed it),
 * so this screen is the ONLY way an owner account comes into being outside of
 * hand-run SQL. requireAdminPage again on top of the layout's — the two-layer
 * pattern.
 *
 * The consequences panel is not decoration. promoteToOwner deletes every
 * branch_staff grant the person holds, in the same transaction as the role
 * flip, and an owner account can never hold a paid booking again because roles
 * are exclusive (requirePlayer rejects owners and admins). The admin is doing
 * that to someone else's account, so both facts are stated before the button
 * rather than discovered after it.
 */
export default async function AdminPromoteOwnerPage() {
  await requireAdminPage('/admin/owners/promote')

  return (
    <>
      <header className="mb-6">
        <Link href="/admin/owners" className={BACK_LINK}>
          &larr; All owners
        </Link>
        <h1 className="font-display mt-2 text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Promote a player
        </h1>
        <p className="mt-2 max-w-[620px] text-[15px] text-[var(--ink-soft)]">
          Turn an existing player account into a court owner. They have to have signed in at least
          once — this creates no account, it only changes one.
        </p>
      </header>

      <section
        aria-label="What promotion does"
        className="mb-6 rounded-[20px] bg-[var(--band-off)] px-5 py-4"
      >
        <h2 className="font-mono text-[11px] tracking-[.14em] text-[var(--court-deep)] uppercase">
          Before you promote
        </h2>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] text-[var(--ink)]">
          <li>
            Every staff access they hold at other venues is revoked. An account is never both an
            owner and someone else&rsquo;s staff.
          </li>
          <li>
            They stop being able to book courts — anywhere, including their own. An owner account
            is a business account.
          </li>
          <li>
            Their bookings so far are untouched, and the web address you choose is public at
            /owners/&lt;address&gt;.
          </li>
          <li>This cannot be undone from this screen.</li>
        </ul>
      </section>

      <section aria-label="Promote a player" className={CARD}>
        <PromoteOwnerForm />
      </section>
    </>
  )
}
```

- [ ] **Step 3: Point the old page at the new one**

`src/app/admin/owners/page.tsx` still exists and still imports `./promote-form`, which no longer exists there. Replace its import with a redirect so the app builds while Task 3 is pending:

```tsx
import { redirect } from 'next/navigation'
import { requireAdminPage } from '@/lib/auth/page-guards'

export default async function AdminOwnersPage() {
  await requireAdminPage('/admin/owners')
  redirect('/admin/owners/promote')
}
```

Task 3 replaces this file entirely. It exists in this state only so the tree type-checks between tasks.

- [ ] **Step 4: Revalidate the promote route too**

In `src/app/admin/actions.ts`, `promoteOwnerAction` already calls
`revalidatePath('/admin/owners')` and `revalidatePath('/dashboard')`. Add the promote route beside them, so its own render is not served stale after a promotion:

```ts
  revalidatePath('/admin/owners')
  revalidatePath('/admin/owners/promote')
  revalidatePath('/dashboard')
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` — expect clean. A stale import of the old `./promote-form` path is exactly what this catches.
Run: `npx eslint .` — expect 9 warnings, 0 errors.
Run: `grep -rn "owners/promote-form" src/` — expect no output.
Run: `npx vitest run tests/admin` — expect pass.

- [ ] **Step 6: Report (do not commit)**

State explicitly that the promote screen could not be exercised in a browser (no dev login) and that the move was verified by type-check and grep only.

---

### Task 3: The directory page

**Files:**
- Modify: `src/app/admin/owners/page.tsx` (replace the redirect stub with the directory)

**Interfaces:**
- Consumes: `getAdminOwners`, `AdminOwnerRow`, `AdminOwnerBranchRow` from `@/lib/admin/owners` (Task 1); `STAFF_PERMISSION_LABELS` from `@/lib/staff/permissions`; `formatDateLabel` from `@/lib/format`; `requireAdminPage`.
- Produces: the rendered directory. The sibling fee-settings plan adds a form to each owner card here.

Read `design/branding.md` before writing this markup.

- [ ] **Step 1: Write the page**

Replace `src/app/admin/owners/page.tsx` entirely:

```tsx
import Link from 'next/link'
import { requireAdminPage } from '@/lib/auth/page-guards'
import { getAdminOwners, type AdminOwnerBranchRow, type AdminOwnerRow } from '@/lib/admin/owners'
import { STAFF_PERMISSION_LABELS, STAFF_PERMISSIONS } from '@/lib/staff/permissions'
import { formatDateLabel } from '@/lib/format'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)] max-[560px]:p-5'
const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--court)]'
const CHIP =
  'font-mono rounded-full border border-[var(--hairline)] bg-[var(--surface)] px-2 py-0.5 text-[10px] tracking-[.1em] text-[var(--ink-soft)] uppercase'
const EMPTY = 'text-[13px] text-[var(--ink-soft)]'

/** Business name, then real name, then the address they signed up with. */
function displayName(owner: AdminOwnerRow): string {
  return owner.businessName ?? owner.fullName ?? owner.email
}

function BranchRow({ branch }: { branch: AdminOwnerBranchRow }) {
  return (
    <li className="border-t border-[var(--hairline)] px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[14px] font-semibold text-[var(--ink)]">{branch.name}</span>
        <span className="text-[13px] text-[var(--ink-soft)]">{branch.city}</span>
        <span className="font-mono text-[11.5px] text-[var(--ink-soft)]">
          {branch.courtCount} {branch.courtCount === 1 ? 'court' : 'courts'}
        </span>
        {branch.pendingCourtCount > 0 && (
          <Link href="/admin" className={`font-mono text-[11.5px] text-[var(--court-deep)] underline ${FOCUS_RING}`}>
            {branch.pendingCourtCount} pending
          </Link>
        )}
      </div>

      {branch.staff.length === 0 ? (
        <p className={`mt-2 ${EMPTY}`}>No staff.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {branch.staff.map((person) => (
            <li key={person.staffId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-[13px] text-[var(--ink)]">{person.email}</span>
              {person.fullName && (
                <span className="text-[12.5px] text-[var(--ink-soft)]">{person.fullName}</span>
              )}
              {STAFF_PERMISSIONS.filter((permission) => person.permissions[permission]).map(
                (permission) => (
                  <span key={permission} className={CHIP}>
                    {STAFF_PERMISSION_LABELS[permission]}
                  </span>
                ),
              )}
              <span className="font-mono text-[11px] text-[var(--ink-soft)]">
                since {formatDateLabel(person.grantedOn)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * Every owner, their branches, and who staffs each branch.
 *
 * Cards rather than a table: the content is two levels of nesting with
 * variable-length badge lists, which a table cannot express without colspan
 * tricks. This follows /dashboard/staff, the codebase's existing
 * entity-with-nested-detail shape.
 *
 * Read-only. Promotion lives at /admin/owners/promote.
 */
export default async function AdminOwnersPage() {
  await requireAdminPage('/admin/owners')
  const owners = await getAdminOwners()

  return (
    <>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
            Owners
          </h1>
          <p className="mt-2 text-[15px] text-[var(--ink-soft)]">
            {owners.length === 1 ? '1 owner' : `${owners.length} owners`}, their branches, and who
            has staff access to each.
          </p>
        </div>
        <Link
          href="/admin/owners/promote"
          className={`rounded-[var(--btn-radius)] bg-[var(--ink)] px-4 py-2.5 text-[13.5px] font-semibold text-[var(--panel)] hover:bg-[var(--court-deep)] ${FOCUS_RING}`}
        >
          Promote a player
        </Link>
      </header>

      {owners.length === 0 ? (
        <section className={CARD}>
          <p className={EMPTY}>No owners yet. Promote a player to create the first one.</p>
        </section>
      ) : (
        <ul className="flex flex-col gap-4">
          {owners.map((owner) => (
            <li key={owner.id}>
              <section aria-label={displayName(owner)} className={CARD}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="font-display text-[18px] font-bold text-[var(--ink)]">
                    {displayName(owner)}
                  </h2>
                  <span className={CHIP}>{owner.role}</span>
                </div>

                <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-[var(--ink-soft)]">
                  <span>{owner.email}</span>
                  {owner.slug && (
                    <Link href={`/owners/${owner.slug}`} className={`text-[var(--court)] underline ${FOCUS_RING}`}>
                      /owners/{owner.slug}
                    </Link>
                  )}
                  <span className="font-mono text-[11.5px]">
                    joined {formatDateLabel(owner.joinedOn)}
                  </span>
                </div>

                <p className="font-mono mt-3 text-[11.5px] tracking-[.06em] text-[var(--ink-soft)]">
                  {owner.branches.length} {owner.branches.length === 1 ? 'branch' : 'branches'} ·{' '}
                  {owner.branches.reduce((total, branch) => total + branch.courtCount, 0)} courts ·{' '}
                  {owner.staffCount} staff
                </p>

                {owner.branches.length === 0 ? (
                  <p className={`mt-3 ${EMPTY}`}>No branches yet.</p>
                ) : (
                  <ul className="mt-3 rounded-[14px] border border-[var(--hairline)]">
                    {owner.branches.map((branch) => (
                      <BranchRow key={branch.id} branch={branch} />
                    ))}
                  </ul>
                )}
              </section>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
```

- [ ] **Step 2: Check every token against branding.md**

Confirm each CSS variable used (`--panel`, `--surface`, `--hairline`, `--ink`, `--ink-soft`, `--court`, `--court-deep`, `--band-off`, `--shadow-sm`, `--btn-radius`) is defined in `design/branding.md`. If one is not, replace it with the documented equivalent rather than inventing a value. Report any substitution made.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` — expect clean.
Run: `npx eslint .` — expect 9 warnings, 0 errors.
Run: `grep -rn "outline-none\|outline-hidden" src/app/admin/owners/` — expect no output.
Run: `npx vitest run` (foreground, whole suite) — expect exactly the three known pre-existing failures and nothing else.

- [ ] **Step 4: Report (do not commit)**

Report the full-suite numbers, and state plainly that the page was **not** seen rendered because `/admin` requires a signed-in admin and this project has no dev login.

---

## Notes for the reviewer

- Task 2 is a **move**, not a rewrite. Diff the promote page's copy against git history; any reworded bullet is a defect.
- The `role = 'admin' and exists(…)` predicate in Task 1 is the one rule the types cannot express. It has a dedicated test; check that test actually flips both ways.
- `count(c.id)` is deliberate. `count(*)` would report 1 court for a branch with none.
- Nothing in this plan writes to the database.
