'use server'

import { revalidatePath } from 'next/cache'
import { AuthError, requireOwnerOf } from '@/lib/auth/guards'
import { parsePermissions } from '@/lib/staff/permissions'
import {
  addBranchStaff,
  parseStaffEmail,
  parseStaffId,
  revokeBranchStaff,
  updateBranchStaff,
} from '@/lib/staff/write'

/**
 * Staff management, owner-only.
 *
 * requireOwnerOf(branchId), NOT requireBranchAccess: per the spec, only the
 * branch's owner (or an admin) manages that branch's staff rows. There is no
 * `manage_staff` permission, and a staff member must not be able to widen their
 * own grant or add colleagues.
 *
 * A submitted `branchId` is safe to guard on here — unlike in the block actions,
 * where the branch had to be derived from the target row — because every write
 * below is scoped by that same branchId in its own WHERE clause (see
 * src/lib/staff/write.ts). An owner who forges a branchId either fails the guard
 * (not their branch) or passes it and then matches no row (their branch, someone
 * else's grant). Both are safe; neither leaks.
 *
 * This file exports only three async guarded actions and the `StaffFormState`
 * type they return — every OTHER export of a 'use server' file becomes a
 * client-invokable endpoint, which is why there is no fourth function here.
 * The parse rules and the SQL live in the `import 'server-only'` modules under
 * src/lib/staff/ and are unit-tested there.
 */
export type StaffFormState = { ok: true; message: string } | { error: string } | null

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOT_YOUR_BRANCH = "That branch isn't yours to manage."

/**
 * Shape-checks the branch id before it reaches requireOwnerOf, which
 * interpolates it into a `::uuid` cast — a malformed value would raise 22P02
 * and escape as an unhandled exception instead of a form error.
 */
function branchIdFrom(formData: FormData): string | null {
  const branchId = String(formData.get('branchId') ?? '')
  return UUID_RE.test(branchId) ? branchId : null
}

export async function addStaffAction(
  _prevState: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const branchId = branchIdFrom(formData)
  if (!branchId) return { error: NOT_YOUR_BRANCH }

  try {
    await requireOwnerOf(branchId)
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_YOUR_BRANCH }
    throw error
  }

  const email = parseStaffEmail(formData)
  if (!email) return { error: 'Enter the email address of an existing OnCourt account.' }

  const result = await addBranchStaff({
    branchId,
    email,
    permissions: parsePermissions(formData),
  })

  if (!result.ok) {
    return {
      error:
        result.reason === 'no_such_user'
          ? `No OnCourt account uses ${email}. Ask them to sign in once, then add them.`
          : result.reason === 'not_a_player'
            ? 'That account is a court owner or an admin, so it cannot be staff.'
            : result.reason === 'already_staff'
              ? 'That person already has access to this branch — edit their permissions below.'
              : 'Pick at least one permission.',
    }
  }

  revalidatePath('/dashboard/staff')
  return { ok: true, message: `${email} now has access to this branch.` }
}

export async function updateStaffAction(
  _prevState: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const branchId = branchIdFrom(formData)
  if (!branchId) return { error: NOT_YOUR_BRANCH }

  try {
    await requireOwnerOf(branchId)
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_YOUR_BRANCH }
    throw error
  }

  const staffId = parseStaffId(formData)
  if (!staffId) return { error: 'That staff member no longer has access to this branch.' }

  const result = await updateBranchStaff({
    staffId,
    branchId,
    permissions: parsePermissions(formData),
  })

  if (!result.ok) {
    return {
      error:
        result.reason === 'no_permission_selected'
          ? 'Pick at least one permission, or revoke their access instead.'
          : 'That staff member no longer has access to this branch.',
    }
  }

  revalidatePath('/dashboard/staff')
  return { ok: true, message: 'Permissions saved.' }
}

export async function revokeStaffAction(
  _prevState: StaffFormState,
  formData: FormData,
): Promise<StaffFormState> {
  const branchId = branchIdFrom(formData)
  if (!branchId) return { error: NOT_YOUR_BRANCH }

  try {
    await requireOwnerOf(branchId)
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_YOUR_BRANCH }
    throw error
  }

  const staffId = parseStaffId(formData)
  if (!staffId) return { error: 'That staff member no longer has access to this branch.' }

  const result = await revokeBranchStaff({ staffId, branchId })
  if (!result.ok) return { error: 'That staff member no longer has access to this branch.' }

  revalidatePath('/dashboard/staff')
  return { ok: true, message: 'Access revoked.' }
}
