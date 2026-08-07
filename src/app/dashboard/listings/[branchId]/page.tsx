import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { getListingBranch } from '@/lib/listings/queries'
import { COURT_STATUS_LABELS } from '@/lib/listings/status'
import { AmenityChip } from '@/components/ui/amenity-chip'
import { EditBranchForm } from './branch-detail-forms'
import { PhotoManager } from '../photo-forms'

const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

// Declared locally, not imported from ../form-ui: that module is 'use client',
// and importing it here would pull this Server Component's chrome into the
// client bundle for no benefit — same reasoning src/app/dashboard/listings/
// page.tsx gives for its own copy of these two constants.
const BORDERED_BUTTON =
  `inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3.5 text-[13px] font-semibold whitespace-nowrap text-[var(--ink)] hover:border-[var(--court)] ${FOCUS_RING}`

// Same reasoning as BORDERED_BUTTON above, and the same duplication
// src/app/dashboard/listings/page.tsx already carries for its own "Add a
// branch" button: this is the Courts card's one primary action, so it's the
// alternative-primary token's lime counterpart, not bordered.
const LIME_BUTTON =
  `font-display inline-flex h-[var(--btn-h)] items-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-5 text-[14px] font-bold text-[var(--ball-ink)] transition-[filter] duration-150 hover:brightness-[1.06] motion-reduce:transition-none ${FOCUS_RING}`

const CARD = 'rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TABS = ['details', 'courts'] as const
type Tab = (typeof TABS)[number]

/**
 * One branch: its editable details, and every court inside it.
 *
 * notFound(), not a redirect, for a branch this session may not manage — and
 * the same answer for a malformed id, a branch that does not exist, and one
 * belonging to someone else. "That branch exists but is not yours" would
 * confirm the id to whoever typed it.
 *
 * Staff holding manage_courts reach this page and see the branch read-only
 * plus the court list; editing branch fields and adding courts are owner-only
 * (the spec's permission table), which is why both forms are behind
 * access.isOwner and both actions re-assert requireOwnerOf.
 */
export default async function BranchDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ branchId: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const { branchId } = await params
  const access = await requireDashboardPage('/dashboard/listings')

  // Shape-checked before any SQL: the id reaches a `::uuid` cast inside
  // getListingBranch, and a malformed value would raise 22P02 instead of
  // rendering a 404.
  if (!UUID_RE.test(branchId)) notFound()
  if (!branchIdsWith(access, 'manage_courts').includes(branchId)) notFound()

  const branch = await getListingBranch(branchId)
  if (!branch) notFound()

  // Tabs are URL state (?tab=), not client state — same reasoning as
  // src/app/bookings/page.tsx. This page hosts several independent Server
  // Actions (save branch, upload/reorder/delete photo, add court), each a
  // `revalidatePath` away from the current URL rather than a navigation; the
  // active tab has to already live in that URL so the right panel is still
  // selected once the refreshed RSC payload comes back, instead of every save
  // bouncing the owner back to whatever a client-side default would be.
  const { tab: rawTab } = await searchParams
  const tab: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : 'details'

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
          {branch.name}
        </h1>
        <p className="font-mono mt-1 text-[11px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
          {branch.city} &middot; /venues/{branch.slug}
        </p>
      </header>

      {/* Plain links with aria-current, not role="tab"/aria-selected: these
          navigate to a new URL rather than toggling a panel in place, so the
          link semantics are the honest ones — same call src/app/bookings/
          page.tsx makes, matched here for consistency. */}
      <nav aria-label="Branch" className="mb-6 flex gap-7 border-b border-[var(--hairline)]">
        {TABS.map((t) => {
          const active = tab === t
          const label = t === 'details' ? 'Details' : `Courts (${branch.courts.length})`
          return (
            <Link
              key={t}
              href={`/dashboard/listings/${branch.id}?tab=${t}`}
              aria-current={active ? 'page' : undefined}
              className={`font-display -mb-px border-b-2 pb-3 text-[14.5px] font-semibold whitespace-nowrap ${FOCUS_RING} ${
                active
                  ? 'border-[var(--ink)] text-[var(--ink)]'
                  : 'border-transparent text-[var(--ink-soft)] hover:text-[var(--ink)]'
              }`}
            >
              {label}
            </Link>
          )
        })}
      </nav>

      {tab === 'details' && (
        <div className="flex flex-col gap-6">
          <section aria-label="Branch details" className={CARD}>
            {access.isOwner ? (
              // EditBranchForm renders its own "Branch details" h2, paired with
              // the "Save branch" button on the same row (top-right of the
              // card), because the button needs `pending` from that client
              // component's useActionState. The read-only branch below keeps its
              // heading here instead, since it has no button to share a row with.
              <EditBranchForm
                branchId={branch.id}
                defaults={{
                  name: branch.name,
                  description: branch.description,
                  address: branch.address,
                  city: branch.city,
                  contactPhone: branch.contactPhone,
                  contactEmail: branch.contactEmail,
                  amenities: branch.amenities,
                  lat: branch.lat,
                  lng: branch.lng,
                }}
              />
            ) : (
              <>
                <h2 className="font-display mb-4 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                  Branch details
                </h2>
                <div className="flex flex-col gap-2 text-[13.5px] text-[var(--ink)]">
                  <p>{branch.address}</p>
                  {branch.description && (
                    <p className="text-[var(--ink-soft)]">{branch.description}</p>
                  )}
                  {branch.amenities.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {branch.amenities.map((amenity) => (
                        <AmenityChip key={amenity} amenity={amenity} />
                      ))}
                    </div>
                  )}
                  <p className="mt-2 text-[12.5px] text-[var(--ink-soft)]">
                    Only the venue owner can change these details.
                  </p>
                </div>
              </>
            )}
          </section>

          {/* Full-width, not the two-column pairing this used to share with
              Courts: with Courts moved to its own tab, "Branch photos" is the
              only card left down here, and half-widthing it against an empty
              right column would just waste space. */}
          <section aria-label="Branch photos" className={CARD}>
            <h2 className="font-display mb-4 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
              Branch photos
            </h2>
            {/* Branch photos are owner-only, exactly like the branch fields
                above; staff with manage_courts see the gallery read-only. */}
            <PhotoManager
              kind="branch"
              targetId={branch.id}
              photos={branch.photos}
              canManage={access.isOwner}
            />
          </section>
        </div>
      )}

      {tab === 'courts' && (
        <div className="flex flex-col gap-6">
          <section aria-label="Courts" className={CARD}>
            {/* Same header-row treatment as EditBranchForm's "Branch
                details"/"Save branch" row on the Details tab: h2 left,
                primary action top-right. "Add court" is a plain navigation
                Link rather than a form submit, so — unlike that row — it
                needs no `pending` state and this section stays a Server
                Component. */}
            <div className="mb-4 flex items-start justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
              <h2 className="font-display text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                Courts
              </h2>
              {access.isOwner && (
                <Link
                  href={`/dashboard/listings/${branch.id}/courts/new`}
                  className={`${LIME_BUTTON} max-[560px]:w-full max-[560px]:justify-center`}
                >
                  Add court
                </Link>
              )}
            </div>
            {branch.courts.length === 0 ? (
              <p className="text-[13px] text-[var(--ink-soft)]">
                No courts here yet
                {access.isOwner ? ' — add the first one above.' : '.'}
              </p>
            ) : (
              // Each court is a card, not a row: auto-fill/minmax rather than
              // a fixed column count, so the grid reflows on its own instead
              // of a hardcoded column count being cramped or wasteful at
              // different widths. The floor was 220px when this grid lived in
              // a half-width column; now that Courts is a full-width tab
              // panel, 220px would pack in enough columns to make the cards
              // (which now also carry an Edit button) feel squeezed on a wide
              // monitor, so it's raised to 260px.
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                {branch.courts.map((court) => (
                  <li key={court.id}>
                    {/* Cards nested inside the "Courts" card: branding.md's
                        card recipe (white panel, shadow-sm, hover lift) is
                        for top-level cards sitting on --surface, and a
                        shadowed card stacked on a shadowed card just reads as
                        mush. A --hairline border on the shared --btn-radius
                        token — the same treatment BORDERED_BUTTON and the
                        other bordered controls in this codebase already use —
                        reads as "nested" without inventing a second visual
                        language; hover swaps the border to --court instead of
                        lifting the card.

                        The card is now a plain <div>, not a Link: it needs an
                        independently-clickable Edit button, and nesting an
                        <a> inside an <a> is invalid HTML. Instead this
                        follows src/app/dashboard/listings/page.tsx's
                        stretched-link pattern — an `absolute inset-0` Link
                        covers the whole tile as the card-wide click target,
                        carrying an sr-only accessible name, and the Edit
                        Link below is a POSITIONED sibling (`relative z-10`)
                        that paints above it and intercepts its own clicks. */}
                    <div
                      className={`relative flex h-full flex-col gap-2 rounded-[var(--btn-radius)] border border-[var(--hairline)] p-4 transition-colors hover:border-[var(--court)]`}
                    >
                      <Link
                        href={`/dashboard/listings/${branch.id}/courts/${court.id}`}
                        className={`absolute inset-0 rounded-[var(--btn-radius)] ${FOCUS_RING}`}
                      >
                        <span className="sr-only">
                          {court.name}, {COURT_STATUS_LABELS[court.status]}
                        </span>
                      </Link>
                      <div className="min-w-0">
                        <p className="text-[14px] font-semibold text-[var(--ink)]">
                          {court.name}
                        </p>
                        <div className="font-mono mt-1 text-[10.5px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                          {court.environment}
                          {court.surface ? ` · ${court.surface}` : ''}
                        </div>
                      </div>
                      {/* self-start, not shrink-0-in-a-row: this pill is
                          today's only status signal, but courts moving to
                          branch-level approval is a live discussion, so the
                          pill stays a plain stacked child rather than
                          something the card's layout leans on structurally —
                          it can drop out later without reworking the card. */}
                      <span className="font-mono self-start rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[10.5px] tracking-[.05em] text-[var(--court-deep)] uppercase">
                        {COURT_STATUS_LABELS[court.status]}
                      </span>
                      {/* The rejection reason belongs on the list, not only on
                          the court page: it is the one thing an owner scanning
                          their branch has to act on. */}
                      {court.status === 'rejected' && court.rejectionReason && (
                        <p className="text-[12.5px] text-[var(--ink)]">
                          <span className="font-semibold">Changes needed:</span>{' '}
                          {court.rejectionReason}
                        </p>
                      )}
                      {/* Every court gets an Edit button regardless of
                          status — a rejected court is exactly the one that
                          most needs editing, so gating this on `pending`
                          would be a confusing affordance. mt-auto pins it to
                          the bottom of the card so it lands in the same place
                          whether or not a rejection reason grew the card. */}
                      <Link
                        href={`/dashboard/listings/${branch.id}/courts/${court.id}`}
                        aria-label={`Edit ${court.name}`}
                        className={`relative z-10 mt-auto self-start ${BORDERED_BUTTON}`}
                      >
                        Edit
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </>
  )
}
