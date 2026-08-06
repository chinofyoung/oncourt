import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { noPermissions, STAFF_PERMISSIONS, type StaffPermissions } from '@/lib/staff/permissions'

export type BranchStaffRow = {
  staffId: string
  userId: string
  email: string
  fullName: string | null
  permissions: StaffPermissions
  /**
   * A Manila calendar date (`YYYY-MM-DD`), not a raw instant — matching this
   * project's other read modules (see OwnerPendingCourt.createdAt) so callers
   * feed it straight into formatDateLabel() with no second conversion.
   */
  createdAt: string
}

export type BranchStaffGroup = { branchId: string; branchName: string; staff: BranchStaffRow[] }

/**
 * Every branch the owner has, each with its staff.
 *
 * A branch with no staff still gets a group with an empty `staff` array: the
 * page renders one "add staff" form per branch, so a branch missing from this
 * list would be permanently unstaffable — the reason this is a LEFT join from
 * branches rather than a query over branch_staff.
 *
 * Owner-scoped, not branch-id-scoped like src/lib/owner/queries.ts: staff
 * management is owner-only (the page uses requireOwnerPage and the actions
 * requireOwnerOf), so there is no staff-visible variant of this read to
 * generalize for.
 *
 * The email is shown in full, deliberately: it is the identifier the owner
 * typed to add the person, and the only way to tell two colleagues with the
 * same display name apart.
 */
export async function getBranchStaffForOwner(ownerId: string): Promise<BranchStaffGroup[]> {
  const result = await db.execute(sql`
    select
      b.id as branch_id, b.name as branch_name,
      s.id as staff_id, s.user_id,
      p.email, p.full_name,
      s.view_bookings, s.block_slots, s.manage_courts, s.view_earnings,
      to_char(s.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as created_at
    from branches b
    left join branch_staff s on s.branch_id = b.id
    left join profiles p     on p.id = s.user_id
    where b.owner_id = ${ownerId}::uuid
    order by b.name, p.email
  `)

  const groups = new Map<string, BranchStaffGroup>()
  for (const row of result.rows) {
    const branchId = row.branch_id as string
    let group = groups.get(branchId)
    if (!group) {
      group = { branchId, branchName: row.branch_name as string, staff: [] }
      groups.set(branchId, group)
    }
    // A null staff_id is the LEFT join's "this branch has no staff" row.
    if (row.staff_id === null) continue

    const permissions = noPermissions()
    for (const permission of STAFF_PERMISSIONS) {
      permissions[permission] = row[permission] === true
    }

    group.staff.push({
      staffId: row.staff_id as string,
      userId: row.user_id as string,
      email: row.email as string,
      fullName: (row.full_name as string | null) ?? null,
      permissions,
      createdAt: row.created_at as string,
    })
  }

  return [...groups.values()]
}
