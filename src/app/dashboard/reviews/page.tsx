import { redirect } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { getOwnerReviews, OWNER_REVIEWS_LIMIT } from '@/lib/owner/reviews'
import { formatDateLabel } from '@/lib/format'

// Declared locally, not imported from src/app/dashboard/listings/form-ui.tsx:
// that module is 'use client', and importing it into a Server Component would
// pull it into the client bundle for a string.
const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What players said, for the people who run the courts.
 *
 * Read-only by design: replies, moderation and deletion are out of scope (they
 * need a migration). Nothing on this page is a form except the branch filter,
 * and that is a plain GET.
 *
 * Access is `view_bookings`, scoped per branch — the same permission that
 * governs /dashboard/bookings, because a review is operational feedback about
 * a specific branch's courts and belongs to whoever already sees that branch's
 * schedule. It is NOT gated on `access.can`: that is a union across every
 * branch a session can see at all, and scoping the query by it would show a
 * staff member reviews from a branch they were never granted.
 */
export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string }>
}) {
  const access = await requireDashboardPage('/dashboard/reviews')
  const { branch: rawBranch } = await searchParams

  const scopeBranchIds = branchIdsWith(access, 'view_bookings')
  // `!access.isOwner &&` deliberately, and unlike /dashboard/bookings: the
  // sidebar shows this item to every owner, including one with no branches
  // yet, so bouncing them would make the nav a liar. A staff member whose
  // grants were revoked since the nav rendered has genuinely nothing here.
  if (!access.isOwner && scopeBranchIds.length === 0) redirect('/dashboard')

  // The dropdown and the filter validation are narrowed to the view_bookings
  // branches specifically, never to every branch this session can see at all.
  const branches = access.branches.filter((branch) => scopeBranchIds.includes(branch.id))
  const branchId =
    rawBranch && UUID_RE.test(rawBranch) && branches.some((branch) => branch.id === rawBranch)
      ? rawBranch
      : undefined

  // No round trip at all for an owner with no branches: `any('{}')` would
  // return nothing anyway, and skipping it keeps the empty state free.
  const { reviews, capped } =
    scopeBranchIds.length > 0
      ? await getOwnerReviews(scopeBranchIds, { branchId })
      : { reviews: [], capped: false }

  const filteredBranchName = branchId
    ? branches.find((branch) => branch.id === branchId)?.name
    : undefined

  return (
    <>
      <header className="mb-8">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Reviews
        </h1>
        <p className="mt-2 max-w-[560px] text-[15px] text-[var(--ink-soft)]">
          What players said after playing on your courts. Newest first.
        </p>
      </header>

      {branches.length > 1 && (
        <form
          method="get"
          action="/dashboard/reviews"
          aria-label="Filter reviews by branch"
          className="mb-6 flex items-center gap-2"
        >
          <select
            name="branch"
            aria-label="Branch"
            defaultValue={branchId ?? ''}
            className={`h-[var(--btn-h-sm)] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-3 text-[13px] text-[var(--ink)] ${FOCUS_RING}`}
          >
            <option value="">All branches</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className={`inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3.5 text-[13px] font-semibold text-[var(--ink)] hover:border-[var(--court)] ${FOCUS_RING}`}
          >
            Filter
          </button>
        </form>
      )}

      {reviews.length === 0 ? (
        <p className={EMPTY_PANEL}>
          {filteredBranchName
            ? `No reviews for ${filteredBranchName} yet.`
            : 'No reviews yet — players can review a court after they’ve played on it.'}
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-4">
            {reviews.map((review) => (
              <article
                key={review.id}
                className="rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)]"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-display text-[16px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                      {review.courtName}
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-[var(--ink-soft)]">
                      {review.branchName} · {review.playerName}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[11.5px] text-[var(--ink-soft)]">
                      {formatDateLabel(review.createdOn)}
                    </div>
                    {/* branding.md's Rating mark: lime dot (7px, ink outline)
                        + bold number. Inline rather than <Rating>, which is
                        the AGGREGATE component (average + count in parens) and
                        renders nothing at all when count is 0. */}
                    <div className="mt-1.5 flex items-center justify-end gap-1.5 text-[14px] font-semibold text-[var(--ink)]">
                      <span
                        aria-hidden
                        className="h-[7px] w-[7px] rounded-full bg-[var(--ball)] outline outline-[1.5px] outline-[var(--ink)]"
                      />
                      {review.rating.toFixed(1)}
                    </div>
                  </div>
                </div>
                {/* Null body renders NOTHING — not an empty blockquote, not a
                    dash. The query already collapses a whitespace-only body to
                    null, so this one check covers both. */}
                {review.body && (
                  <p className="mt-3.5 text-[14.5px] text-[var(--ink)]">{review.body}</p>
                )}
              </article>
            ))}
          </div>

          {capped && (
            <p className="mt-5 text-[12.5px] text-[var(--ink-soft)]">
              Showing the most recent {OWNER_REVIEWS_LIMIT}.
            </p>
          )}
        </>
      )}
    </>
  )
}
