'use server'

import { revalidatePath } from 'next/cache'
import { AuthError, requireAdmin } from '@/lib/auth/guards'
import {
  MODERATION_FAILURE_MESSAGES,
  SCHEDULE_BLOCK_MESSAGES,
  type CourtModerationResult,
} from '@/lib/admin/moderation'
import { findProfileByEmail, type AdminProfileLookup } from '@/lib/admin/queries'
import { approveCourt, rejectCourt, suspendCourt, unsuspendCourt } from '@/lib/admin/write'
import { parseStaffEmail, promoteToOwner } from '@/lib/staff/write'

/**
 * The admin surface's writes.
 *
 * This file exports only six async guarded actions and the two state types its
 * forms bind to — every OTHER export of a 'use server' file becomes a
 * client-invokable endpoint. All logic and all SQL live in the modules under
 * src/lib/admin/ and src/lib/staff/, where they are unit-tested.
 *
 * ONE GUARD SHAPE: requireAdmin, on all six. There is no per-branch dimension
 * to an admin's authority, and inventing one here would contradict every guard
 * in src/lib/auth/guards.ts, each of which already lets an admin through
 * unconditionally.
 *
 * A submitted id is safe to guard on because every write underneath is scoped
 * by something the caller cannot forge: the moderation writes are status-
 * scoped (`and status = 'pending'`), and promoteToOwner is role-scoped
 * (`and role = 'player'`). A wrong id matches no row and returns a friendly
 * reason.
 *
 * Every action takes useActionState's (prevState, formData) shape. The
 * previous state is unused — each submission is judged on its own input — but
 * the parameter must exist for React to bind the action to the form's state.
 */
export type AdminFormState = { ok: true; message: string } | { error: string } | null
export type OwnerLookupState = { player: AdminProfileLookup } | { error: string } | null

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOT_ADMIN = 'That action is for admins only.'
const BAD_TARGET = "That doesn't look right — reload the page and try again."

/** Shape-checked before it reaches a `::uuid` cast, which would raise 22P02. */
function idFrom(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '')
  return UUID_RE.test(value) ? value : null
}

/**
 * The guard, once. Returns the message to show, or null to proceed — every
 * action's first two lines.
 */
async function refuseUnlessAdmin(): Promise<string | null> {
  try {
    await requireAdmin()
    return null
  } catch (error) {
    if (error instanceof AuthError) return NOT_ADMIN
    throw error
  }
}

/** One sentence per failure, from the two maps in src/lib/admin/moderation.ts. */
function moderationError(result: Extract<CourtModerationResult, { ok: false }>): string {
  return result.reason === 'schedule_incomplete'
    ? SCHEDULE_BLOCK_MESSAGES[result.warning]
    : MODERATION_FAILURE_MESSAGES[result.reason]
}

/**
 * A court's status decides whether it appears on every public surface, so a
 * transition invalidates all of them — plus the owner's own listings pages,
 * where the status banner is now stale, and /admin itself.
 */
function revalidateModeration(): void {
  revalidatePath('/admin')
  revalidatePath('/dashboard/listings', 'layout')
  revalidatePath('/dashboard')
  revalidatePath('/venues', 'layout')
  revalidatePath('/search')
  revalidatePath('/')
}

export async function approveCourtAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const courtId = idFrom(formData, 'courtId')
  if (!courtId) return { error: BAD_TARGET }

  const result = await approveCourt({ courtId })
  if (!result.ok) return { error: moderationError(result) }

  revalidateModeration()
  return { ok: true, message: 'Approved. Players can book it now.' }
}

export async function rejectCourtAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const courtId = idFrom(formData, 'courtId')
  if (!courtId) return { error: BAD_TARGET }

  // Passed through untrimmed: rejectCourt() trims and is the single authority
  // on what counts as empty, so the form and the write cannot disagree.
  const result = await rejectCourt({ courtId, reason: String(formData.get('reason') ?? '') })
  if (!result.ok) return { error: moderationError(result) }

  revalidateModeration()
  return { ok: true, message: 'Rejected. The owner sees your reason on the court page.' }
}

export async function suspendCourtAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const courtId = idFrom(formData, 'courtId')
  if (!courtId) return { error: BAD_TARGET }

  const result = await suspendCourt({ courtId })
  if (!result.ok) return { error: moderationError(result) }

  revalidateModeration()
  return { ok: true, message: 'Suspended. Existing bookings are untouched.' }
}

export async function unsuspendCourtAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const courtId = idFrom(formData, 'courtId')
  if (!courtId) return { error: BAD_TARGET }

  const result = await unsuspendCourt({ courtId })
  if (!result.ok) return { error: moderationError(result) }

  revalidateModeration()
  return { ok: true, message: 'Back on the market.' }
}

/**
 * Step one of promotion: find the account.
 *
 * Returns the profile whatever its role, including owner and admin — the
 * screen shows what it found and then refuses, which is more useful than
 * "no match" for an admin who typed the right address for the wrong person.
 *
 * parseStaffEmail is reused rather than re-derived: it is the tested rule for
 * "is this even an address", and the two screens that take one must not
 * disagree.
 */
export async function lookupPlayerAction(
  _prevState: OwnerLookupState,
  formData: FormData,
): Promise<OwnerLookupState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const email = parseStaffEmail(formData)
  if (!email) return { error: 'Enter the full email address of an existing OnCourt account.' }

  const player = await findProfileByEmail(email)
  if (!player) {
    return { error: `No OnCourt account uses ${email}. Ask them to sign in once, then try again.` }
  }
  return { player }
}

/**
 * Step two: promote.
 *
 * A thin wrapper over slice A's promoteToOwner, which owns the whole rule —
 * the role flip, the business fields, and the deletion of every branch_staff
 * grant the person held, all in one transaction. Re-implementing any part of
 * that here would be the one way to end up with an owner who is still someone
 * else's staff.
 *
 * Guarding on a submitted userId is safe because promoteToOwner's WHERE clause
 * is `and role = 'player'`: a forged id belonging to an owner or an admin
 * matches nothing and comes back as `already_owner`.
 */
export async function promoteOwnerAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const userId = idFrom(formData, 'userId')
  if (!userId) return { error: BAD_TARGET }

  const result = await promoteToOwner({
    userId,
    businessName: String(formData.get('businessName') ?? ''),
    slug: String(formData.get('slug') ?? '').trim().toLowerCase(),
  })

  if (!result.ok) {
    // All four reasons the function actually returns. The spec's prose lists a
    // `not_a_player` that does not exist in the code: its role-scoped UPDATE
    // cannot tell an owner from an admin, and reports `already_owner` for
    // both. `invalid_input` is the reason the prose omits.
    return {
      error:
        result.reason === 'no_such_user'
          ? 'That account no longer exists. Search for the address again.'
          : result.reason === 'already_owner'
            ? 'That account is no longer a player — it is already an owner or an admin.'
            : result.reason === 'slug_taken'
              ? 'That web address is already taken. Try a different one.'
              : 'Enter a business name, and a web address of lowercase letters, numbers and hyphens.',
    }
  }

  revalidatePath('/admin/owners')
  revalidatePath('/dashboard')
  return {
    ok: true,
    message:
      result.revokedGrants > 0
        ? `Promoted. ${result.revokedGrants} staff ${result.revokedGrants === 1 ? 'grant was' : 'grants were'} revoked.`
        : 'Promoted. They can add branches and courts now.',
  }
}
