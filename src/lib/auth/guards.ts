import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import type { StaffPermission } from '@/lib/staff/permissions'

export type Role = 'player' | 'owner' | 'admin'
export type SessionUser = {
  id: string
  email: string
  role: Role
  fullName: string | null
  avatarUrl: string | null
  businessName: string | null
}

export class AuthError extends Error {
  constructor(readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * Resolves the current session down to a `SessionUser`, or `null` if there is
 * none — either no `sub` claim at all, or a claim with no matching `profiles`
 * row. `requireUser()` and `getOptionalUser()` both call this single path so
 * the claims/profile-lookup logic is never duplicated; they only differ in
 * what they do with a `null` result (throw vs. return it).
 */
async function loadSessionUser(): Promise<SessionUser | null> {
  const supabase = await createServerSupabaseClient()
  const { data } = await supabase.auth.getClaims()

  const userId = data?.claims?.sub as string | undefined
  if (!userId) return null

  // Role comes from our own table, never from JWT metadata, which is
  // user-editable and therefore unsafe for authorization.
  const result = await db.execute(sql`
    select id, email, role, avatar_url, full_name, business_name from profiles where id = ${userId}::uuid
  `)
  const profile = result.rows[0]
  if (!profile) return null

  return {
    id: profile.id as string,
    email: profile.email as string,
    role: profile.role as Role,
    fullName: (profile.full_name as string | null) ?? null,
    avatarUrl: (profile.avatar_url as string | null) ?? null,
    businessName: (profile.business_name as string | null) ?? null,
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await loadSessionUser()
  if (!user) throw new AuthError(401, 'Not signed in')
  return user
}

/**
 * The current user, or null when signed out. Unlike requireUser(), this
 * never throws or redirects — the public pages render for anonymous
 * visitors, and the nav only needs to know which of two states to draw.
 */
export async function getOptionalUser(): Promise<SessionUser | null> {
  return loadSessionUser()
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role !== 'admin') throw new AuthError(403, 'Admin only')
  return user
}

/**
 * Players only — the gate on every paid write.
 *
 * Roles are exclusive as of the roles-and-staff slice: an owner account is a
 * business account and can never hold a paid booking, on its own courts or
 * anyone else's. Its only slot writes are `blocked` rows on its own courts,
 * which go through requireBranchAccess instead. Admins are rejected too:
 * moderation is not a shopping account.
 *
 * The review action needs no equivalent change — review eligibility derives
 * from owning a `completed` booking, and only a player can have one.
 */
export async function requirePlayer(): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role !== 'player') throw new AuthError(403, 'Players only')
  return user
}

/**
 * Role-level owner gate: "is this person an owner at all", as opposed to
 * requireOwnerOf(branchId)'s "does this person own THAT branch". The owner
 * dashboard needs this one — it has no single branch id to check against, and
 * its queries scope themselves by owner_id in SQL.
 *
 * Admins pass. They are not granted other owners' data by passing: every owner
 * query filters on owner_id, so an admin here sees only what they own. Viewing
 * across owners is /admin/*'s job.
 */
export async function requireOwner(): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role !== 'owner' && user.role !== 'admin') throw new AuthError(403, 'Owners only')
  return user
}

export async function requireOwnerOf(branchId: string): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role === 'admin') return user

  const result = await db.execute(sql`
    select 1 from branches where id = ${branchId}::uuid and owner_id = ${user.id}::uuid
  `)
  if (result.rows.length === 0) throw new AuthError(403, 'Not your branch')
  return user
}

/**
 * Per-branch, per-permission access: passes for the branch's owner, for any
 * admin, or for a user holding a branch_staff row on THAT branch with THAT
 * flag true. This is the guard for surfaces staff share with owners (block
 * writes, schedule reads). `requireOwnerOf` stays the guard for owner-only
 * surfaces — staff management, listings, fee-sensitive pages.
 *
 * The owner short-circuits before the grant is consulted, so an owner passes
 * every permission on their own branches without needing a self-grant.
 *
 * `branchId` must be UUID-shaped: it reaches a `::uuid` cast, and a malformed
 * value raises 22P02 rather than a clean 403. Every caller validates the
 * shape first (or takes the id from the database, which is stronger — see
 * src/lib/blocks/write.ts's branchIdOfCourt).
 *
 * One round trip. The permission is read out of a `to_jsonb(s)` row object in
 * TypeScript rather than interpolated as a column name: `permission` is
 * type-constrained to the four literals, but building SQL identifiers from a
 * variable is a habit worth not forming, and `sql.raw` would be the only way
 * to do it.
 */
export async function requireBranchAccess(
  branchId: string,
  permission: StaffPermission,
): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role === 'admin') return user

  const result = await db.execute(sql`
    select
      exists (
        select 1 from branches b
        where b.id = ${branchId}::uuid and b.owner_id = ${user.id}::uuid
      ) as is_owner,
      (
        select to_jsonb(s) from branch_staff s
        where s.branch_id = ${branchId}::uuid and s.user_id = ${user.id}::uuid
      ) as staff_grant
  `)
  const row = result.rows[0]
  if (row.is_owner === true) return user

  // Aliased `staff_grant`, not `grant`: GRANT is a reserved keyword in
  // Postgres and `as grant` is a syntax error.
  const staffGrant = row.staff_grant as Record<string, unknown> | null
  if (staffGrant && staffGrant[permission] === true) return user

  throw new AuthError(403, 'No access to that branch')
}
