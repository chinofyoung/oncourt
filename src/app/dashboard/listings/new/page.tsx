import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { AddBranchForm } from '../branch-forms'

// Declared locally, not imported from ../form-ui: that module is 'use client',
// and importing it here would pull this Server Component's chrome into the
// client bundle for no benefit. Same FOCUS_RING duplication pattern
// form-ui.tsx documents on itself.
const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

/**
 * Add a branch, on its own page.
 *
 * requireDashboardPage, NOT requireOwnerPage: a staff member can reach
 * /dashboard/listings (the manage_courts grant admits them there), so a
 * direct hit on this URL must land them somewhere sane rather than an error
 * page. Creating a branch is owner-only per the spec's permission table, so
 * they are bounced back to the cards — the same page requireOwnerPage would
 * have sent them to (/dashboard/listings has been their branches home all
 * along), just without the extra hop through /bookings for someone who was
 * never a player. createBranchAction re-asserts requireOwner regardless.
 */
export default async function NewBranchPage() {
  const access = await requireDashboardPage('/dashboard/listings')
  if (!access.isOwner) redirect('/dashboard/listings')

  return (
    <>
      <header className="mb-8">
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
      </header>

      <section
        aria-label="Add a branch"
        className="max-w-[560px] rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
      >
        <AddBranchForm />
      </section>
    </>
  )
}
