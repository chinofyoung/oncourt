import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { SCHEDULE_BLOCK_MESSAGES } from '@/lib/admin/moderation'
import { formatPriceRange } from '@/lib/format'
import { getListingBranch, type ListingCourtSummary } from '@/lib/listings/queries'
import { COURT_STATUS_LABELS } from '@/lib/listings/status'
import { AmenityChip } from '@/components/ui/amenity-chip'
import { photoUrl } from '@/lib/photos'
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

// Only the Courts tab's empty state uses this now that the court grid sits
// directly on --surface instead of inside a CARD-classed section — matches
// src/app/dashboard/listings/page.tsx's own EMPTY_PANEL for the mirror-image
// "no branches yet" case, and src/components/search/results-grid.tsx's "no
// courts here yet" panel.
const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

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
        // No CARD wrapper here: branding.md's entity-card standard says a
        // card grid sits directly on --surface, never nested inside another
        // card's padding/shadow (a shadowed tile inside a shadowed panel
        // reads as mush — the exact problem the old --hairline "nested card"
        // treatment was papering over). The "Courts" h2 and "Add court"
        // button move up to a plain header row instead of a card header.
        <section aria-label="Courts" className="flex flex-col gap-4">
          {/* Same header-row treatment as EditBranchForm's "Branch
              details"/"Save branch" row on the Details tab: h2 left,
              primary action top-right. "Add court" is a plain navigation
              Link rather than a form submit, so — unlike that row — it
              needs no `pending` state and this section stays a Server
              Component. */}
          <div className="flex items-start justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
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
            <p className={EMPTY_PANEL}>
              No courts here yet
              {access.isOwner ? ' — add the first one above.' : '.'}
            </p>
          ) : (
            // auto-fill/minmax, floor 280px: same reasoning and same value as
            // src/app/dashboard/listings/page.tsx's branch grid, which this
            // court grid is now sized to match — the "regular card" size the
            // entity-card standard uses everywhere else on this page.
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
              {branch.courts.map((court) => (
                <li key={court.id}>
                  <CourtCard court={court} branchId={branch.id} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  )
}

/**
 * One court, per branding.md's entity-card standard: cover photo, title,
 * meta line, status pill, whole-card stretched link, Edit button as a
 * positioned sibling. Mirrors src/app/dashboard/listings/page.tsx's branch
 * card structure exactly, now that both live directly on --surface.
 */
function CourtCard({ court, branchId }: { court: ListingCourtSummary; branchId: string }) {
  const cover = photoUrl('court-photos', court.coverPhotoPath)
  // A pending court legitimately has no bands yet — scheduleWarning already
  // flags that further down, so this just needs to not print a broken
  // "₱NaN – ₱NaN/hr". Same wording as src/app/admin/page.tsx so the two
  // surfaces agree.
  const priceLabel =
    court.minPriceCentavos === null
      ? 'No rates set'
      : formatPriceRange(court.minPriceCentavos, court.maxPriceCentavos!)
  // The identical rule approveCourt() refuses on, reused verbatim from the
  // admin queue's copy (src/lib/admin/moderation.ts): its phrasing is a plain
  // factual statement ("This court has no rates yet, so it can't go live.")
  // rather than an instruction aimed at the admin, so it reads fine to the
  // owner too — no separate owner-facing copy needed.
  const scheduleMessage =
    court.scheduleWarning === null ? null : SCHEDULE_BLOCK_MESSAGES[court.scheduleWarning]

  return (
    <div className="group relative overflow-hidden rounded-[20px] bg-[var(--panel)] shadow-[var(--shadow-sm)] transition-[transform,box-shadow] duration-[220ms] ease-[cubic-bezier(0.2,0.7,0.3,1)] hover:-translate-y-1 hover:shadow-[var(--shadow-lg)] motion-reduce:transform-none motion-reduce:transition-none">
      <Link
        href={`/dashboard/listings/${branchId}/courts/${court.id}`}
        className={`absolute inset-0 ${FOCUS_RING}`}
      >
        <span className="sr-only">
          {court.name}, {COURT_STATUS_LABELS[court.status]}
        </span>
      </Link>

      {/* No `relative` here, same reasoning as the branch card's cover
          wrapper: a positioned sibling AFTER the stretched link paints above
          it in DOM order, so a positioned cover would create a dead click
          zone over the whole photo. */}
      <div className="aspect-[16/10] overflow-hidden">
        {cover ? (
          /* eslint-disable-next-line @next/next/no-img-element -- the bucket
             is public and this is an already-sized upload; next/image would
             add a loader round trip for a dashboard card. */
          <img
            src={cover}
            alt=""
            className="h-full w-full object-cover transition-transform duration-500 ease-[cubic-bezier(0.2,0.7,0.3,1)] group-hover:scale-[1.045] motion-reduce:transform-none motion-reduce:transition-none"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[var(--band-off)]">
            <span aria-hidden className="font-display text-[40px] font-bold text-[var(--court-deep)]">
              {court.name.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
      </div>

      <div className="px-5 pt-[18px] pb-5">
        <div className="min-w-0">
          <div className="font-display text-lg font-bold tracking-[-0.015em] text-[var(--ink)]">
            {court.name}
          </div>
          <div className="font-mono mt-[5px] text-[10.5px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
            {court.environment}
            {court.surface ? ` · ${court.surface}` : ''}
          </div>
          {/* Price + hours in one mono line — the two facts an owner scans
              for, kept to the single line branding.md's mono treatment for
              prices/times calls for rather than a two-row fact list. */}
          <div className="font-mono mt-2 text-[12.5px] text-[var(--ink)]">
            {priceLabel} · {court.hoursSummary}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="font-mono rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[10.5px] tracking-[.05em] text-[var(--court-deep)] uppercase">
              {COURT_STATUS_LABELS[court.status]}
            </span>
          </div>
          {/* The readiness signal — the exact rule approveCourt() refuses on
              — gets its own boxed callout rather than sitting inside the
              plain fact lines above: it is the one fact on this card that is
              actionable ("fix this or it can never go live"), so it needs to
              read as distinct from the descriptive ones, not buried among
              them. `--booked` is a neutral, already-defined token (no
              dedicated alert color exists in branding.md), so this reads as a
              flagged block without introducing a new hue. */}
          {scheduleMessage && (
            <p className="mt-2.5 rounded-[10px] bg-[var(--booked)] px-2.5 py-2 text-[12px] font-semibold text-[var(--ink)]">
              {scheduleMessage}
            </p>
          )}
          {/* The rejection reason belongs on the list, not only on the court
              page: it is the one thing an owner scanning their branch has to
              act on. */}
          {court.status === 'rejected' && court.rejectionReason && (
            <p className="mt-2.5 text-[12.5px] text-[var(--ink)]">
              <span className="font-semibold">Changes needed:</span> {court.rejectionReason}
            </p>
          )}
        </div>

        {/* Every court gets an Edit button regardless of status — a rejected
            court is exactly the one that most needs editing, so gating this
            on status would be a confusing affordance. */}
        <Link
          href={`/dashboard/listings/${branchId}/courts/${court.id}`}
          aria-label={`Edit ${court.name}`}
          className={`relative z-10 mt-3.5 ${BORDERED_BUTTON}`}
        >
          Edit
        </Link>
      </div>
    </div>
  )
}
