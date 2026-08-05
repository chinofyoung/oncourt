'use client'

import { useActionState } from 'react'
import { createReviewAction, type ReviewFormState } from './actions'

const FOCUS_RING = 'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

/**
 * The one client component on this page. It exists for a specific reason: a
 * Server Component cannot render what a Server Action returns, so a failed
 * submission (already reviewed, not yet completed, forged input) would look
 * like nothing happening. useActionState gives the returned message a home.
 *
 * On success the action calls revalidatePath('/bookings'), so this row
 * re-renders from the server as reviewed and this form disappears — no local
 * success state to manage.
 */
export function ReviewForm({ bookingId }: { bookingId: string }) {
  const [state, formAction, pending] = useActionState<ReviewFormState, FormData>(
    createReviewAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="bookingId" value={bookingId} />

      <label className="sr-only" htmlFor={`rating-${bookingId}`}>
        Rating
      </label>
      <select
        id={`rating-${bookingId}`}
        name="rating"
        defaultValue="5"
        className={`h-[var(--btn-h-sm)] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2 text-[13px] text-[var(--ink)] ${FOCUS_RING}`}
      >
        <option value="5">5 — Excellent</option>
        <option value="4">4 — Good</option>
        <option value="3">3 — Okay</option>
        <option value="2">2 — Poor</option>
        <option value="1">1 — Bad</option>
      </select>

      <label className="sr-only" htmlFor={`body-${bookingId}`}>
        Review
      </label>
      <textarea
        id={`body-${bookingId}`}
        name="body"
        rows={2}
        maxLength={2000}
        placeholder="How was the court? (optional)"
        className={`rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2.5 py-2 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-soft)] ${FOCUS_RING}`}
      />

      {/* Lime is this view's one primary action — the page's other buttons are
          bordered/neutral, so branding.md's "never two lime buttons in one
          view" holds even with several of these rows on screen, since they are
          all the same action repeated. */}
      <button
        type="submit"
        disabled={pending}
        className={`font-display inline-flex h-[var(--btn-h-sm)] items-center justify-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-3 text-[13px] font-bold text-[var(--ball-ink)] transition-[filter] duration-150 hover:brightness-[1.06] disabled:opacity-60 motion-reduce:transition-none ${FOCUS_RING}`}
      >
        {pending ? 'Saving…' : 'Leave a review'}
      </button>

      {state && 'error' in state && (
        <p role="alert" className="text-[12.5px] font-medium text-[var(--ink)]">
          {state.error}
        </p>
      )}
    </form>
  )
}
