import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { noPermissions, STAFF_PERMISSIONS, type StaffPermissions } from '@/lib/staff/permissions'
import type { FeeMode, ProcessorFeeBearer } from '@/lib/admin/settings'

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
  /** The owner's override. All three null means "inherit the platform default". */
  feeMode: FeeMode | null
  feeValue: number | null
  processorFeeBearer: ProcessorFeeBearer | null
  /** Which rail this owner's bookings settle through. Never null -- unlike
   * feeMode/feeValue, there is no "inherit the default" state for this. */
  paymentMode: 'automated' | 'manual'
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
           to_char(p.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as joined_on,
           p.platform_fee_mode::text as fee_mode, p.platform_fee_value as fee_value,
           p.processor_fee_bearer::text as fee_bearer, p.payment_mode::text as payment_mode
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
    feeMode: (row.fee_mode as FeeMode | null) ?? null,
    // Number(null) is 0 — a bare cast would render "no override" as a real
    // zero-peso fee, so null is preserved explicitly rather than coerced.
    feeValue: row.fee_value === null ? null : Number(row.fee_value),
    processorFeeBearer: (row.fee_bearer as ProcessorFeeBearer | null) ?? null,
    paymentMode: row.payment_mode as 'automated' | 'manual',
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
