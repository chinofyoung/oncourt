'use client'

import { useActionState } from 'react'
import { updateBranchAction, type ListingFormState } from '../actions'
import { BranchFieldset, type BranchDefaults } from '../branch-fieldset'
import { DARK_BUTTON, FormMessage } from '../form-ui'

/**
 * The branch page's own owner-only form.
 *
 * A client component for the same reason as every other form in this slice: a
 * Server Component cannot render what a Server Action returned, so a
 * validation failure would look like nothing happening.
 *
 * It submits a hidden `branchId`. That is safe to guard on because
 * updateBranch also scopes its write by the same id — see the header comment
 * in src/app/dashboard/listings/actions.ts. It is NOT the pattern the court
 * forms use, and the difference is deliberate.
 *
 * AddCourtForm used to live here too, back when "Add a court" was an inline
 * card on this page. It now has its own route
 * (courts/new/add-court-form.tsx) — this file's name was chosen for the
 * branch-detail page, and a court form that no longer renders on that page
 * doesn't belong in it.
 */
export function EditBranchForm({
  branchId,
  defaults,
}: {
  branchId: string
  defaults: BranchDefaults
}) {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    updateBranchAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="branchId" value={branchId} />
      <div className="flex items-start justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <h2 className="font-display text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
          Branch details
        </h2>
        {/* branding.md's alternative primary, not lime: the Courts tab on
            this same page has its own lime "Add court" button (in the Courts
            card header), and two lime buttons in one view is forbidden. */}
        <button
          type="submit"
          disabled={pending}
          className={`${DARK_BUTTON} max-[560px]:w-full max-[560px]:justify-center`}
        >
          {pending ? 'Saving…' : 'Save branch'}
        </button>
      </div>
      <FormMessage state={state} />
      <BranchFieldset idPrefix={`branch-${branchId}`} defaults={defaults} />
    </form>
  )
}
