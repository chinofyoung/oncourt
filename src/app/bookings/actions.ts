'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { AuthError, requirePlayer } from '@/lib/auth/guards'
import { parseReviewInput, insertReviewIfEligible } from '@/lib/bookings/review-write'

export type ReviewFormState = { ok: true } | { error: string } | null

/**
 * useActionState's signature: (prevState, formData) => nextState. The previous
 * state is unused — each submission is judged on its own input — but the
 * parameter must exist for React to bind the action to the form's state.
 *
 * Returning state rather than only redirecting is what lets ReviewForm render
 * "You've already reviewed this booking" instead of appearing to do nothing.
 *
 * requirePlayer, not requireUser: roles are exclusive as of the roles-and-staff
 * slice, so review eligibility deriving from "owns a completed booking" is no
 * longer a safe stand-in for "is a player" — an owner keeps whatever completed
 * bookings they made before being promoted, and insertReviewIfEligible's
 * ownership check alone would still let them write a review through this
 * action. The 401/403 split mirrors createHoldAction: signed-out goes to
 * login, signed-in-but-not-a-player gets an explanation instead.
 */
export async function createReviewAction(
  _prevState: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  let user
  try {
    user = await requirePlayer()
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.status === 401) redirect('/login?next=%2Fbookings%3Ftab%3Dpast')
      return { error: 'Only players can review courts.' }
    }
    throw error
  }

  const input = parseReviewInput(formData)
  if (!input) {
    return { error: "That review doesn't look right. Pick a rating from 1 to 5 and try again." }
  }

  const result = await insertReviewIfEligible({ ...input, playerId: user.id })

  if (!result.ok) {
    return {
      error:
        result.reason === 'already_reviewed'
          ? "You've already reviewed this booking."
          : 'You can only review a court after your booking is completed.',
    }
  }

  revalidatePath('/bookings')
  return { ok: true }
}
