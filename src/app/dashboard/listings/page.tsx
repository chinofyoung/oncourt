import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { getListingBranches } from '@/lib/listings/queries'
import { COURT_STATUSES, COURT_STATUS_LABELS } from '@/lib/listings/status'
import { photoUrl } from '@/lib/photos'

// Declared locally, not imported from ./form-ui: that module is 'use client',
// and importing it here would pull this Server Component's chrome into the
// client bundle for no benefit. Same FOCUS_RING/BORDERED_BUTTON/LIME_BUTTON
// duplication pattern form-ui.tsx documents on itself.
const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const BORDERED_BUTTON =
  `inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3.5 text-[13px] font-semibold whitespace-nowrap text-[var(--ink)] hover:border-[var(--court)] disabled:opacity-60 ${FOCUS_RING}`

// The only lime control on this page: the cards' Edit buttons are bordered,
// and this is the page's one primary action.
const LIME_BUTTON =
  `font-display inline-flex h-[var(--btn-h)] items-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-5 text-[14px] font-bold text-[var(--ball-ink)] transition-[filter] duration-150 hover:brightness-[1.06] disabled:opacity-60 motion-reduce:transition-none ${FOCUS_RING}`

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
 * Creating a branch is owner-only, so the "Add a branch" button (which links
 * to /dashboard/listings/new) renders only for owners; that page re-asserts
 * it inline and the action re-asserts it with requireOwner regardless.
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
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
            Branches &amp; courts
          </h1>
          <p className="mt-2 max-w-[560px] text-[15px] text-[var(--ink-soft)]">
            Every venue you run, and the courts inside it. New and edited courts go to our team for
            approval before players can book them.
          </p>
        </div>
        {access.isOwner && (
          <Link href="/dashboard/listings/new" className={LIME_BUTTON}>
            Add a branch
          </Link>
        )}
      </header>

      {branches.length === 0 ? (
        <p className={`${EMPTY_PANEL} mb-6`}>
          {access.isOwner
            ? 'No branches yet — add your first one.'
            : 'No branches are shared with you for court management yet.'}
        </p>
      ) : (
        // auto-fill/minmax instead of a fixed column count or a new
        // max-[…] breakpoint: the dashboard content column is fluid (248px
        // sidebar + flexible remainder, see src/app/dashboard/layout.tsx),
        // so a hardcoded column count would be right for one viewport and
        // wrong for the rest. 280px keeps 3 columns down through the
        // 980px sidebar-stack point, landing each card within a few px of
        // branch-card.tsx's ~359px rendered width in results-grid.tsx's
        // 1120px-capped, 3-column public grid — the "regular card" size
        // this page is matching — while still packing more columns in on
        // wide monitors instead of stretching cards further.
        <ul className="mb-8 grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
          {branches.map((branch) => {
            const cover = photoUrl('branch-photos', branch.coverPhotoPath)
            const hasCourts = COURT_STATUSES.some((status) => branch.courtCounts[status] > 0)

            return (
              <li key={branch.id}>
                {/*
                  The card link stretches over the whole tile (absolute
                  inset-0, default z-index/stacking layer) so the card reads
                  as one clickable unit, same as the row it replaces. The Edit
                  button below is a POSITIONED sibling with an explicit
                  z-index, which paints above the stretched link in the same
                  stacking context — that ordering (not pointer-events) is
                  what lets the button intercept its own clicks. Nesting an
                  <a> inside an <a> is invalid HTML, so the two links are
                  siblings under a plain <div>, never nested.
                */}
                <div
                  className={`group relative overflow-hidden rounded-[20px] bg-[var(--panel)] shadow-[var(--shadow-sm)] transition-[box-shadow,transform] duration-[220ms] ease-[cubic-bezier(.2,.7,.3,1)] hover:-translate-y-1 hover:shadow-[var(--shadow-lg)] motion-reduce:transform-none motion-reduce:transition-none`}
                >
                  <Link
                    href={`/dashboard/listings/${branch.id}`}
                    className={`absolute inset-0 ${FOCUS_RING}`}
                  >
                    <span className="sr-only">
                      {branch.name}, {branch.city}
                    </span>
                  </Link>

                  {/*
                    No `relative` here: a positioned sibling AFTER the
                    stretched link paints above it in tree order (positioned
                    elements with z-index auto/0 paint above earlier
                    non-positioned or z-index:auto siblings in DOM order), so
                    a positioned cover wrapper would create a dead click zone
                    over the whole photo — the stretched link underneath
                    would never receive the click. `overflow-hidden` alone
                    clips the img/fallback fine without positioning this box.
                  */}
                  <div className="aspect-[16/10] overflow-hidden">
                    {cover ? (
                      /* eslint-disable-next-line @next/next/no-img-element -- the
                         bucket is public and this is an already-sized upload;
                         next/image would add a loader round trip for a
                         dashboard card. */
                      <img
                        src={cover}
                        alt=""
                        className="h-full w-full object-cover transition-transform duration-500 ease-[cubic-bezier(0.2,0.7,0.3,1)] group-hover:scale-[1.045] motion-reduce:transform-none motion-reduce:transition-none"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-[var(--band-off)]">
                        <span
                          aria-hidden
                          className="font-display text-[40px] font-bold text-[var(--court-deep)]"
                        >
                          {branch.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                    )}
                  </div>

                  {/*
                    Proportions match branch-card.tsx's body (px-5 pt-[18px]
                    pb-5, text-lg title, text-[13px] meta) now that this card
                    renders at roughly the same width — the old p-5 +
                    horizontal title/Edit pairing was sized for the wide
                    two-per-row layout this replaces. The Edit button moves
                    below the meta/status row instead of sitting beside it;
                    at this width there's no longer room for both without
                    wrapping.
                  */}
                  <div className="px-5 pt-[18px] pb-5">
                    <div className="min-w-0">
                      <div className="font-display text-lg font-bold tracking-[-0.015em] text-[var(--ink)]">
                        {branch.name}
                      </div>
                      <div className="mt-[5px] text-[13px] text-[var(--ink-soft)]">
                        {branch.city} · {branch.photoCount}{' '}
                        {branch.photoCount === 1 ? 'photo' : 'photos'}
                      </div>
                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
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
                        {!hasCourts && (
                          <span className="text-[12.5px] text-[var(--ink-soft)]">
                            No courts yet
                          </span>
                        )}
                      </div>
                    </div>

                    <Link
                      href={`/dashboard/listings/${branch.id}`}
                      aria-label={`Edit ${branch.name}`}
                      className={`relative z-10 mt-3.5 ${BORDERED_BUTTON}`}
                    >
                      Edit
                    </Link>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
