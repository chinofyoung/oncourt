import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { SessionUser } from '@/lib/auth/guards'
import {
  allPermissions,
  noPermissions,
  STAFF_PERMISSIONS,
  unionPermissions,
  type StaffPermission,
  type StaffPermissions,
} from '@/lib/staff/permissions'

export type DashboardBranch = { id: string; name: string; permissions: StaffPermissions }

export type DashboardAccess = {
  user: SessionUser
  isOwner: boolean
  branches: DashboardBranch[]
  can: StaffPermissions
}

/**
 * Resolves one session into "which branches may this person see in
 * /dashboard, and what may they do in each".
 *
 * This is the module that admits staff to the owner dashboard. Every
 * /dashboard query in the previous slice was scoped by a single `ownerId`,
 * which structurally cannot include a staff member — they are not the owner.
 * Scoping instead by the branch-id list resolved here works for both, and the
 * resolution happens once per request rather than per query.
 *
 * `isOwner` is `role === 'owner' || role === 'admin'`, the exact predicate
 * requireOwner uses. Keeping it identical is what makes requirePlayerPage's
 * "non-player -> /dashboard" and requireDashboardPage's "no role, no grants ->
 * /bookings" redirects unable to ping-pong. Do not narrow one without the
 * other.
 *
 * An owner's `can` is all-true even with zero branches: capability comes from
 * the role, not from owning something. The empty `branches` list is what makes
 * their queries return nothing, and the dashboard renders its empty state.
 */
export async function loadDashboardAccess(user: SessionUser): Promise<DashboardAccess> {
  const isOwner = user.role === 'owner' || user.role === 'admin'

  if (isOwner) {
    const result = await db.execute(sql`
      select id, name from branches where owner_id = ${user.id}::uuid order by name
    `)
    return {
      user,
      isOwner: true,
      // allPermissions() is a factory, not a shared constant, so each branch
      // gets its own object — a shared one handed out by reference would let
      // any mutation change every branch at once.
      branches: result.rows.map((row) => ({
        id: row.id as string,
        name: row.name as string,
        permissions: allPermissions(),
      })),
      can: allPermissions(),
    }
  }

  const result = await db.execute(sql`
    select b.id, b.name,
      s.view_bookings, s.block_slots, s.manage_courts, s.view_earnings
    from branch_staff s
    join branches b on b.id = s.branch_id
    where s.user_id = ${user.id}::uuid
    order by b.name
  `)

  const branches: DashboardBranch[] = result.rows.map((row) => {
    const permissions = noPermissions()
    for (const permission of STAFF_PERMISSIONS) {
      permissions[permission] = row[permission] === true
    }
    return { id: row.id as string, name: row.name as string, permissions }
  })

  return {
    user,
    isOwner: false,
    branches,
    can: unionPermissions(branches.map((branch) => branch.permissions)),
  }
}

/**
 * Branch ids where this session actually holds ONE specific permission.
 *
 * The permission model is per-branch flags (`DashboardBranch.permissions`),
 * not `access.can` — `can` is a UNION across every branch this session sees,
 * and exists only to decide whether a nav item / page section should render
 * AT ALL. A query's scope list must never be built from `can` or from the
 * full `access.branches` id list: a staff member with `view_earnings` on
 * branch A but not branch B passes `can.view_earnings` (true because of A),
 * and scoping a money query by every branch they can see at all would fold
 * B's revenue into a stat row for someone who was never granted it — the
 * exact cross-branch leak this function exists to prevent.
 *
 * An owner holds every permission on every branch by construction (see
 * `loadDashboardAccess`), so this short-circuits to every branch id without
 * consulting `permissions` per branch — same result, and it stays correct
 * even if an owner's `branches` list is ever built without eagerly filling in
 * `allPermissions()` for some reason.
 */
export function branchIdsWith(access: DashboardAccess, permission: StaffPermission): string[] {
  if (access.isOwner) return access.branches.map((branch) => branch.id)
  return access.branches
    .filter((branch) => branch.permissions[permission])
    .map((branch) => branch.id)
}

/**
 * "Is this person staff anywhere?" — one indexed lookup on
 * branch_staff (user_id), which is why <Nav> can afford to call it on every
 * request for a signed-in player. It exists separately from
 * loadDashboardAccess because the nav only needs the boolean, not the branch
 * list and permission union.
 */
export async function hasAnyStaffGrant(userId: string): Promise<boolean> {
  const result = await db.execute(sql`
    select 1 from branch_staff where user_id = ${userId}::uuid limit 1
  `)
  return result.rows.length > 0
}
