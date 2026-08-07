'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { createCourtAction, type ListingFormState } from '../../../actions'
import {
  CHECK_LABEL,
  FIELD,
  FOCUS_RING,
  FormMessage,
  LABEL,
  LIME_BUTTON,
} from '../../../form-ui'
import {
  COURT_ENVIRONMENT_LABELS,
  COURT_ENVIRONMENTS,
  MAX_COURT_NAME,
  MAX_SURFACE,
} from '@/lib/listings/fields'

const RADIO = `h-4 w-4 shrink-0 accent-[var(--court)] ${FOCUS_RING}`

/**
 * Add a court, on its own page — moved here from the branch page's
 * branch-detail-forms.tsx, which is now named for (and only hosts) the forms
 * that live directly on the branch page. Co-located with courts/new/page.tsx
 * the same way court-forms.tsx sits next to courts/[courtId]/page.tsx.
 *
 * The header (back-link, h1, description) and the "Add court" submit both
 * live here, not in the page: the button sits top-right of the header and
 * needs `pending` from useActionState, which only exists in this client
 * component. Mirrors AddBranchForm's split with listings/new/page.tsx.
 *
 * createCourtAction redirects to the new court's own page on success, so
 * there is no success state to render here — FormMessage only ever shows a
 * failure.
 */
export function AddCourtForm({ branchId }: { branchId: string }) {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    createCourtAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="branchId" value={branchId} />

      <header className="mb-4 flex items-start justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div>
          {/* ?tab=courts, not a bare branch link: this form was reached from
              the Courts tab, and a plain link back to the branch page would
              silently drop the visitor onto the Details tab instead. */}
          <Link
            href={`/dashboard/listings/${branchId}?tab=courts`}
            className={`font-mono mb-2 inline-block text-[11px] tracking-[.12em] text-[var(--court)] uppercase ${FOCUS_RING}`}
          >
            &larr; Courts
          </Link>
          <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
            Add a court
          </h1>
          <p className="mt-2 max-w-[560px] text-[15px] text-[var(--ink-soft)]">
            New courts start as pending. Add opening hours and rates on the court&rsquo;s own page,
            then our team reviews it.
          </p>
        </div>
        {/* Lime, not bordered: on the shared branch page this button sat
            alongside "Save branch" (DARK_BUTTON) and had to avoid a second
            lime control in the same view. On its own page it is the only
            primary action, same reasoning as AddBranchForm's submit. */}
        <button
          type="submit"
          disabled={pending}
          className={`${LIME_BUTTON} max-[560px]:w-full max-[560px]:justify-center`}
        >
          {pending ? 'Adding…' : 'Add court'}
        </button>
      </header>

      <FormMessage state={state} />

      <section
        aria-label="Add a court"
        className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
      >
        {/* max-w constrains the fields, not the card: the card stays
            full-width to match the add-branch page's treatment, but two text
            inputs and a radio group stretching to a wide dashboard monitor's
            full content width would read as sparse and make "Court name" an
            oddly long single-line field. 640px keeps both fields at a
            comfortable reading width while still giving each room to grow
            past its min-w on narrow screens. */}
        <div className="flex max-w-[640px] flex-col gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-[180px] flex-1">
              <label className={LABEL} htmlFor={`add-court-name-${branchId}`}>
                Court name
              </label>
              <input
                id={`add-court-name-${branchId}`}
                name="name"
                required
                maxLength={MAX_COURT_NAME}
                placeholder="Court 1"
                className={FIELD}
              />
            </div>
            <div className="min-w-[180px] flex-1">
              <label className={LABEL} htmlFor={`add-court-surface-${branchId}`}>
                Surface (optional)
              </label>
              <input
                id={`add-court-surface-${branchId}`}
                name="surface"
                maxLength={MAX_SURFACE}
                placeholder="Acrylic"
                className={FIELD}
              />
            </div>
          </div>

          <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <legend className={LABEL}>Environment</legend>
            {COURT_ENVIRONMENTS.map((environment, index) => (
              <label
                key={environment}
                className={CHECK_LABEL}
                htmlFor={`add-court-${environment}-${branchId}`}
              >
                <input
                  id={`add-court-${environment}-${branchId}`}
                  type="radio"
                  name="environment"
                  value={environment}
                  defaultChecked={index === 0}
                  className={RADIO}
                />
                {COURT_ENVIRONMENT_LABELS[environment]}
              </label>
            ))}
          </fieldset>
        </div>
      </section>
    </form>
  )
}
