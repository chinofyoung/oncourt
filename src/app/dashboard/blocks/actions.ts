'use server'

import { revalidatePath } from 'next/cache'
import { AuthError, requireBranchAccess, requireUser } from '@/lib/auth/guards'
import { branchIdOfCourt } from '@/lib/courts/lookup'
import {
  branchIdOfBlock,
  createBlock,
  deleteBlock,
  parseBlockId,
  parseBlockInput,
} from '@/lib/blocks/write'

/**
 * Blocks are created and removed from /dashboard/bookings.
 *
 * This file exports nothing but two async guarded actions and the
 * `BlockFormState` type they return — every OTHER export of a 'use server'
 * file becomes a client-invokable endpoint, which is why there is no third
 * function here. The parse rules and the SQL live in src/lib/blocks/write.ts
 * (an `import 'server-only'` module) and are unit-tested there — the same
 * split as src/lib/bookings/review-write.ts.
 *
 * Both actions take useActionState's (prevState, formData) shape. The previous
 * state is unused — each submission is judged on its own input — but the
 * parameter must exist for React to bind the action to the form's state, and
 * returning state is what lets the form render "that slot was just taken"
 * instead of appearing to do nothing.
 *
 * NEITHER ACTION TRUSTS A SUBMITTED branchId. Each resolves the target's real
 * branch from the database first and guards against that, so the branch the
 * permission check uses and the branch the write touches are always the same
 * one. requireBranchAccess(branchId, 'block_slots') then admits the branch's
 * owner, an admin, or a staff member holding block_slots on that branch.
 */
export type BlockFormState = { ok: true } | { error: string } | null

const NO_ACCESS = "You don't have permission to block slots at that branch."
const BAD_INPUT = "That block doesn't look right. Check the court, date, and hours and try again."

export async function createBlockAction(
  _prevState: BlockFormState,
  formData: FormData,
): Promise<BlockFormState> {
  // requireUser() first, before any DB lookup derived from the submitted
  // input. Without this, an unauthenticated POST would still run
  // branchIdOfCourt(input.courtId) and learn from the response whether that
  // court id exists at all — a row-existence oracle open to anyone, signed in
  // or not. requireBranchAccess below remains the real permission boundary;
  // this only moves "is anyone signed in" ahead of the DB round trip.
  try {
    await requireUser()
  } catch (error) {
    if (error instanceof AuthError) return { error: NO_ACCESS }
    throw error
  }

  const input = parseBlockInput(formData)
  if (!input) return { error: BAD_INPUT }

  const branchId = await branchIdOfCourt(input.courtId)
  // Same message as a parse failure: whether the court does not exist or the
  // id was forged, the caller learns only that the request was wrong. Telling
  // a stranger "that court exists but is not yours" would confirm the id.
  if (!branchId) return { error: BAD_INPUT }

  let user
  try {
    user = await requireBranchAccess(branchId, 'block_slots')
  } catch (error) {
    if (error instanceof AuthError) return { error: NO_ACCESS }
    throw error
  }

  const result = await createBlock({ ...input, branchId, createdBy: user.id })

  if (!result.ok) {
    return {
      error:
        result.reason === 'slot_taken'
          ? 'Those hours are already taken by a booking, a hold, or another block.'
          : result.reason === 'court_unavailable'
            ? 'That court is not approved yet, so it cannot be blocked.'
            : BAD_INPUT,
    }
  }

  // The block changes the owner day grid, the bookings list, the public
  // availability grid, and search's "open now" counts.
  revalidatePath('/dashboard')
  revalidatePath('/dashboard/bookings')
  revalidatePath('/venues', 'layout')
  return { ok: true }
}

export async function deleteBlockAction(
  _prevState: BlockFormState,
  formData: FormData,
): Promise<BlockFormState> {
  // Same reasoning as createBlockAction: requireUser() ahead of
  // branchIdOfBlock's DB lookup, so a signed-out caller cannot use this
  // action's response to probe whether a given block id exists.
  try {
    await requireUser()
  } catch (error) {
    if (error instanceof AuthError) return { error: NO_ACCESS }
    throw error
  }

  const blockId = parseBlockId(formData)
  if (!blockId) return { error: BAD_INPUT }

  // Resolves only `blocked` rows, so a forged id pointing at a paid booking
  // never reaches the guard, let alone the delete.
  const branchId = await branchIdOfBlock(blockId)
  if (!branchId) return { error: 'That block no longer exists.' }

  try {
    await requireBranchAccess(branchId, 'block_slots')
  } catch (error) {
    if (error instanceof AuthError) return { error: NO_ACCESS }
    throw error
  }

  const result = await deleteBlock(blockId)
  if (!result.ok) return { error: 'That block no longer exists.' }

  revalidatePath('/dashboard')
  revalidatePath('/dashboard/bookings')
  revalidatePath('/venues', 'layout')
  return { ok: true }
}
