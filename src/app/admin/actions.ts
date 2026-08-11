'use server'

import { revalidatePath } from 'next/cache'
import { refuseUnlessAdmin } from '@/lib/admin/guard'
import {
  MODERATION_FAILURE_MESSAGES,
  SCHEDULE_BLOCK_MESSAGES,
  type CourtModerationResult,
} from '@/lib/admin/moderation'
import { findProfileByEmail, type AdminProfileLookup } from '@/lib/admin/queries'
import { approveCourt, rejectCourt, suspendCourt, unsuspendCourt } from '@/lib/admin/write'
import {
  updateOwnerFeeOverride,
  type FeeMode,
  type ProcessorFeeBearer,
} from '@/lib/admin/settings'
import { formatPeso } from '@/lib/format'
import { parsePercentToBps, parsePesosToCentavos } from '@/lib/money/units'
import { parseStaffEmail, promoteToOwner } from '@/lib/staff/write'

/**
 * The admin surface's writes.
 *
 * This file exports only seven async guarded actions (approveCourtAction,
 * rejectCourtAction, suspendCourtAction, unsuspendCourtAction,
 * lookupPlayerAction, promoteOwnerAction, updateOwnerFeeOverrideAction) and
 * the two state types its forms bind to — every OTHER export of a 'use
 * server' file becomes a client-invokable endpoint. All logic and all SQL
 * live in the modules under src/lib/admin/ and src/lib/staff/, where they are
 * unit-tested.
 *
 * ONE GUARD SHAPE: requireAdmin, on all seven, via `refuseUnlessAdmin` in
 * src/lib/admin/guard.ts — moved there rather than defined and exported
 * locally, so the guard src/app/admin/settings/actions.ts also needs is
 * imported, not duplicated, without adding a second published endpoint to
 * this file. There is no per-branch dimension to an admin's authority, and
 * inventing one here would contradict every guard in src/lib/auth/guards.ts,
 * each of which already lets an admin through unconditionally.
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
const BAD_TARGET = "That doesn't look right — reload the page and try again."

/** Shape-checked before it reaches a `::uuid` cast, which would raise 22P02. */
function idFrom(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '')
  return UUID_RE.test(value) ? value : null
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
  revalidatePath('/admin/owners/promote')
  revalidatePath('/dashboard')
  return {
    ok: true,
    message:
      result.revokedGrants > 0
        ? `Promoted. ${result.revokedGrants} staff ${result.revokedGrants === 1 ? 'grant was' : 'grants were'} revoked.`
        : 'Promoted. They can add branches and courts now.',
  }
}

/**
 * A per-owner fee override, from the Owners directory.
 *
 * `platform_fee_value` is dual-unit — basis points under 'percentage',
 * centavos under 'flat' — exactly like default_platform_fee_value on
 * platform_settings, so this reads ONLY the field matching the submitted
 * choice, never falling back to the other unit's field when the first is
 * empty. 'inherit' is a third, explicit state distinct from an empty field:
 * it clears both columns together, which is what profiles_fee_override_pair
 * requires (both null or both set). processorFeeBearer is independently
 * nullable, so it gets its own 'inherit' option and an owner can override the
 * bearer without overriding the fee, or vice versa.
 */
export async function updateOwnerFeeOverrideAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const ownerId = idFrom(formData, 'ownerId')
  if (!ownerId) return { error: BAD_TARGET }

  const choice = String(formData.get('feeChoice') ?? '')
  let feeMode: FeeMode | null = null
  let feeValue: number | null = null

  if (choice === 'percentage') {
    feeMode = 'percentage'
    feeValue = parsePercentToBps(String(formData.get('feePercent') ?? ''))
    if (feeValue === null) {
      // Same parser, same message, as /admin/settings' identical field — the
      // two forms disagreed on the "with at most two decimals" clause even
      // though parsePercentToBps enforces it identically for both.
      return { error: 'Enter a fee percentage above 0 and no more than 100, with at most two decimals.' }
    }
  } else if (choice === 'flat') {
    feeMode = 'flat'
    feeValue = parsePesosToCentavos(String(formData.get('feePesos') ?? ''))
    if (feeValue === null) {
      return { error: 'Enter a flat fee above ₱0, with at most two decimals.' }
    }
  } else if (choice !== 'inherit') {
    return { error: BAD_TARGET }
  }

  const bearerRaw = String(formData.get('processorFeeBearer') ?? 'inherit')
  const bearers = ['player', 'owner', 'platform']
  if (bearerRaw !== 'inherit' && !bearers.includes(bearerRaw)) return { error: BAD_TARGET }
  const processorFeeBearer = bearerRaw === 'inherit' ? null : (bearerRaw as ProcessorFeeBearer)

  const result = await updateOwnerFeeOverride(ownerId, { feeMode, feeValue, processorFeeBearer })
  if (!result.ok) {
    return {
      error:
        result.reason === 'no_such_owner'
          ? 'That account is no longer an owner. Reload the page.'
          : result.reason === 'flat_fee_exceeds_cheapest_rate'
            ? // feeValue is only null on the 'inherit' branch above, which can
              // never produce this reason (updateOwnerFeeOverride only checks
              // it for a non-null flat feeValue) — the `?? 0` is unreachable,
              // not a real fallback.
              `A flat fee of ${formatPeso(feeValue ?? 0)} is more than the cheapest rate at this owner's own courts (${formatPeso(result.cheapestRateCentavos)}). That booking would pay the owner nothing.`
            : 'That fee is out of range.',
    }
  }

  revalidatePath('/admin/owners')
  return { ok: true, message: 'Saved. New bookings for this owner use these terms.' }
}
