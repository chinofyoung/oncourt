'use client'

import { useActionState } from 'react'
import { createReviewAction, type ReviewFormState } from './actions'

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

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

      <fieldset className="flex flex-col gap-1">
        <legend className="sr-only">Rating</legend>
        {/* Radios, not click handlers on spans. A radio group is arrow-key
            navigable, announced as a grouped choice, and submits without JS —
            all three of which a div-with-onClick star picker silently loses.
            The stars are drawn from :checked in CSS, so there is no state to
            manage here at all.

            Rendered in natural DOM order (1 first). `:has(~ label input:checked)`
            looks forward through later siblings, so star 1 fills when star 1
            itself is checked or any later star (2–5) is checked, star 2 fills
            when 3–5 is checked, and so on — every star up to and including the
            checked one lights up. */}
        <div className="flex justify-end gap-0.5">
          {[
            { value: '1', label: '1 — Bad' },
            { value: '2', label: '2 — Poor' },
            { value: '3', label: '3 — Okay' },
            { value: '4', label: '4 — Good' },
            { value: '5', label: '5 — Excellent' },
          ].map((option) => (
            <label
              key={option.value}
              className="cursor-pointer p-0.5 text-[18px] leading-none text-[var(--hairline)] transition-colors has-[:checked]:text-[var(--court)] hover:text-[var(--court)] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[3px] has-[:focus-visible]:outline-[var(--court)] motion-reduce:transition-none [&:has(~label:hover)]:text-[var(--court)] [&:has(~label_input:checked)]:text-[var(--court)]"
            >
              <input
                type="radio"
                name="rating"
                value={option.value}
                defaultChecked={option.value === '5'}
                className="sr-only"
              />
              <span aria-hidden>★</span>
              <span className="sr-only">{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

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
