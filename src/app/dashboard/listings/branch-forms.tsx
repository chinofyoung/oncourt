'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { createBranchAction, type ListingFormState } from './actions'
import { BranchFieldset } from './branch-fieldset'
import { FOCUS_RING, FormMessage, LIME_BUTTON } from './form-ui'

/**
 * A client component for one reason: a Server Component cannot render what a
 * Server Action returned, so "that contact email doesn't look right" would
 * look like nothing happening. Same pattern as
 * src/app/dashboard/staff/staff-forms.tsx.
 *
 * There is no success state to render — createBranchAction redirects to the
 * new branch's page — so FormMessage only ever shows a failure here.
 *
 * The page header (back-link, h1, description) lives in this component too,
 * not in the Server Component page that renders it. The submit button sits
 * top-right of that header, and it needs `pending` from useActionState below
 * to show "Adding…" — state that only exists inside this client component.
 * The heading text is static, so nothing server-only is lost by moving it;
 * see new/page.tsx, which now does only the auth guard and renders this.
 */
export function AddBranchForm() {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    createBranchAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <header className="mb-4 flex items-start justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div>
          <Link
            href="/dashboard/listings"
            className={`font-mono mb-2 inline-block text-[11px] tracking-[.12em] text-[var(--court)] uppercase ${FOCUS_RING}`}
          >
            &larr; Branches &amp; courts
          </Link>
          <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
            Add a branch
          </h1>
          <p className="mt-2 max-w-[560px] text-[15px] text-[var(--ink-soft)]">
            A branch is one venue. Add its courts once it exists.
          </p>
        </div>
        {/* The only lime button on this page: the branch rows are links and
            the page has no other primary. */}
        <button
          type="submit"
          disabled={pending}
          className={`${LIME_BUTTON} max-[560px]:w-full max-[560px]:justify-center`}
        >
          {pending ? 'Adding…' : 'Add branch'}
        </button>
      </header>

      <FormMessage state={state} />

      <section
        aria-label="Add a branch"
        className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
      >
        <BranchFieldset idPrefix="add-branch" />
      </section>
    </form>
  )
}
