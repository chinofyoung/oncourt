'use client'

import { useActionState } from 'react'
import { createBranchAction, type ListingFormState } from './actions'
import { BranchFieldset } from './branch-fieldset'
import { FormMessage, LIME_BUTTON } from './form-ui'

/**
 * A client component for one reason: a Server Component cannot render what a
 * Server Action returned, so "that contact email doesn't look right" would
 * look like nothing happening. Same pattern as
 * src/app/dashboard/staff/staff-forms.tsx.
 *
 * There is no success state to render — createBranchAction redirects to the
 * new branch's page — so FormMessage only ever shows a failure here.
 */
export function AddBranchForm() {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    createBranchAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <BranchFieldset idPrefix="add-branch" />
      <div>
        {/* The only lime button on this page: the branch rows are links and
            the page has no other primary. */}
        <button type="submit" disabled={pending} className={LIME_BUTTON}>
          {pending ? 'Adding…' : 'Add branch'}
        </button>
        <FormMessage state={state} />
      </div>
    </form>
  )
}
