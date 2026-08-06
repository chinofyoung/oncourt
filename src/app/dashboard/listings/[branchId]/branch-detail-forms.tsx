'use client'

import { useActionState } from 'react'
import { createCourtAction, updateBranchAction, type ListingFormState } from '../actions'
import { BranchFieldset, type BranchDefaults } from '../branch-fieldset'
import {
  BORDERED_BUTTON,
  CHECK_LABEL,
  DARK_BUTTON,
  FIELD,
  FOCUS_RING,
  FormMessage,
  LABEL,
} from '../form-ui'
import {
  COURT_ENVIRONMENT_LABELS,
  COURT_ENVIRONMENTS,
  MAX_COURT_NAME,
  MAX_SURFACE,
} from '@/lib/listings/fields'

const RADIO = `h-4 w-4 shrink-0 accent-[var(--court)] ${FOCUS_RING}`

/**
 * The two owner-only forms on the branch page.
 *
 * Client components for the same reason as every other form in this slice: a
 * Server Component cannot render what a Server Action returned, so a
 * validation failure would look like nothing happening.
 *
 * Both submit a hidden `branchId`. That is safe to guard on because
 * updateBranch/createCourt also scope their writes by the same id — see the
 * header comment in src/app/dashboard/listings/actions.ts. It is NOT the
 * pattern the court forms use, and the difference is deliberate.
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
      <BranchFieldset idPrefix={`branch-${branchId}`} defaults={defaults} />
      <div>
        {/* branding.md's alternative primary, not lime: this page also
            renders an "Add court" submit, and two lime buttons in one view
            is forbidden. */}
        <button type="submit" disabled={pending} className={DARK_BUTTON}>
          {pending ? 'Saving…' : 'Save branch'}
        </button>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function AddCourtForm({ branchId }: { branchId: string }) {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    createCourtAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="branchId" value={branchId} />

      <div className="flex flex-wrap items-end gap-3">
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
        <button type="submit" disabled={pending} className={BORDERED_BUTTON}>
          {pending ? 'Adding…' : 'Add court'}
        </button>
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

      <p className="text-[12px] text-[var(--ink-soft)]">
        New courts start as pending. Add opening hours and rates on the court&rsquo;s own page, then
        our team reviews it.
      </p>
      <FormMessage state={state} />
    </form>
  )
}
