import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { getListingBranches } from '@/lib/listings/queries'
import { COURT_STATUSES, COURT_STATUS_LABELS } from '@/lib/listings/status'
import { AddBranchForm } from './branch-forms'

// Declared locally, not imported from ./form-ui: that module is 'use client',
// and importing it here would pull this Server Component's chrome into the
// client bundle for no benefit.
const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

/**
 * Branches and courts.
 *
 * requireDashboardPage, NOT requireOwnerPage: staff holding `manage_courts`
 * belong here too. The scope list is branchIdsWith(access, 'manage_courts'),
 * never access.branches — a staff member with view_bookings on branch A and
 * manage_courts on branch B must see only B (see branchIdsWith's contract in
 * src/lib/staff/access.ts).
 *
 * Creating a branch is owner-only, so the form renders only for owners; the
 * action re-asserts it with requireOwner regardless.
 */
export default async function ListingsPage() {
  const access = await requireDashboardPage('/dashboard/listings')
  const branchIds = branchIdsWith(access, 'manage_courts')

  // An owner with zero branches still belongs here — the empty state below is
  // their "add your first branch" screen. A staff member with no
  // manage_courts grant anywhere has nothing to do on this page at all.
  if (!access.isOwner && branchIds.length === 0) redirect('/dashboard')

  const branches = await getListingBranches(branchIds)

  return (
    <>
      <header className="mb-8">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Branches &amp; courts
        </h1>
        <p className="mt-2 max-w-[560px] text-[15px] text-[var(--ink-soft)]">
          Every venue you run, and the courts inside it. New and edited courts go to our team for
          approval before players can book them.
        </p>
      </header>

      {branches.length === 0 ? (
        <p className={`${EMPTY_PANEL} mb-6`}>
          {access.isOwner
            ? 'No branches yet — add your first one below.'
            : 'No branches are shared with you for court management yet.'}
        </p>
      ) : (
        <ul className="mb-8 flex flex-col gap-4">
          {branches.map((branch) => (
            <li key={branch.id}>
              <Link
                href={`/dashboard/listings/${branch.id}`}
                className={`flex flex-wrap items-center justify-between gap-4 rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)] transition-[box-shadow,transform] duration-[220ms] ease-[cubic-bezier(.2,.7,.3,1)] hover:-translate-y-1 hover:shadow-[var(--shadow-lg)] motion-reduce:transform-none motion-reduce:transition-none ${FOCUS_RING}`}
              >
                <div className="min-w-0">
                  <div className="font-display text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                    {branch.name}
                  </div>
                  <div className="font-mono mt-1 text-[11px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
                    {branch.city} · {branch.photoCount}{' '}
                    {branch.photoCount === 1 ? 'photo' : 'photos'}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {COURT_STATUSES.filter((status) => branch.courtCounts[status] > 0).map(
                    (status) => (
                      <span
                        key={status}
                        className="font-mono rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[10.5px] tracking-[.05em] text-[var(--court-deep)] uppercase"
                      >
                        {branch.courtCounts[status]} {COURT_STATUS_LABELS[status]}
                      </span>
                    ),
                  )}
                  {COURT_STATUSES.every((status) => branch.courtCounts[status] === 0) && (
                    <span className="text-[12.5px] text-[var(--ink-soft)]">No courts yet</span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {access.isOwner && (
        <section
          aria-label="Add a branch"
          className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
        >
          <h2 className="font-display mb-1 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
            Add a branch
          </h2>
          <p className="mb-4 text-[12.5px] text-[var(--ink-soft)]">
            A branch is one venue. Add its courts once it exists.
          </p>
          <AddBranchForm />
        </section>
      )}
    </>
  )
}
