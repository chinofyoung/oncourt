import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { getListingBranch } from '@/lib/listings/queries'
import { COURT_STATUS_LABELS } from '@/lib/listings/status'
import { AmenityChip } from '@/components/ui/amenity-chip'
import { AddCourtForm, EditBranchForm } from './branch-detail-forms'
import { PhotoManager } from '../photo-forms'

const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
}: {
  params: Promise<{ branchId: string }>
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

      <section aria-label="Branch details" className={`${CARD} mb-6`}>
        <h2 className="font-display mb-4 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
          Branch details
        </h2>
        {access.isOwner ? (
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
          <div className="flex flex-col gap-2 text-[13.5px] text-[var(--ink)]">
            <p>{branch.address}</p>
            {branch.description && <p className="text-[var(--ink-soft)]">{branch.description}</p>}
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
        )}
      </section>

      <section aria-label="Branch photos" className={`${CARD} mb-6`}>
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

      <section aria-label="Courts" className={`${CARD} mb-6`}>
        <h2 className="font-display mb-4 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
          Courts
        </h2>
        {branch.courts.length === 0 ? (
          <p className="text-[13px] text-[var(--ink-soft)]">
            No courts here yet
            {access.isOwner ? ' — add the first one below.' : '.'}
          </p>
        ) : (
          <ul className="flex flex-col">
            {branch.courts.map((court, index) => (
              <li
                key={court.id}
                className={`py-4 ${index > 0 ? 'border-t border-[var(--hairline)]' : 'pt-0'}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/dashboard/listings/${branch.id}/courts/${court.id}`}
                      className={`text-[14px] font-semibold text-[var(--ink)] hover:text-[var(--court)] ${FOCUS_RING}`}
                    >
                      {court.name}
                    </Link>
                    <div className="font-mono mt-1 text-[10.5px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                      {court.environment}
                      {court.surface ? ` · ${court.surface}` : ''}
                    </div>
                  </div>
                  <span className="font-mono shrink-0 rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[10.5px] tracking-[.05em] text-[var(--court-deep)] uppercase">
                    {COURT_STATUS_LABELS[court.status]}
                  </span>
                </div>
                {/* The rejection reason belongs on the list, not only on the
                    court page: it is the one thing an owner scanning their
                    branch has to act on. */}
                {court.status === 'rejected' && court.rejectionReason && (
                  <p className="mt-2 text-[12.5px] text-[var(--ink)]">
                    <span className="font-semibold">Changes needed:</span> {court.rejectionReason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {access.isOwner && (
        <section aria-label="Add a court" className={CARD}>
          <h2 className="font-display mb-4 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
            Add a court
          </h2>
          <AddCourtForm branchId={branch.id} />
        </section>
      )}
    </>
  )
}
