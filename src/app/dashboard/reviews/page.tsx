import { redirect } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { getOwnerReviews, OWNER_REVIEWS_LIMIT } from '@/lib/owner/reviews'
import { formatDateLabel } from '@/lib/format'
import { Stars } from '@/components/ui/stars'

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
  const { groups } =
    scopeBranchIds.length > 0
      ? await getOwnerReviews(scopeBranchIds, { branchId })
      : { groups: [] }

  // getOwnerReviews already seeds one group per branch id it was given, zero
  // reviews included (see its module doc — the LEFT JOIN happens there, not
  // here). This page still re-keys by `branches` rather than trusting the
  // query's own row order as final: `branches` is what the filter dropdown
  // above iterates (already in name order — loadDashboardAccess orders by
  // name, and the scope filter preserves that), so walking it here is what
  // guarantees the rendered groups can never drift out of sync with the
  // dropdown's order. The `?? {...}` fallback is a defensive backstop, not
  // the seeding mechanism: every branch id in `branches` was also passed into
  // getOwnerReviews, so it should always have a group already.
  const groupByBranchId = new Map(groups.map((group) => [group.branchId, group]))
  const visibleBranches = branchId ? branches.filter((branch) => branch.id === branchId) : branches
  const reviewGroups = visibleBranches.map(
    (branch) =>
      groupByBranchId.get(branch.id) ?? {
        branchId: branch.id,
        branchName: branch.name,
        reviews: [],
        capped: false,
      },
  )

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

      {reviewGroups.length === 0 ? (
        // Only reachable with zero branches in scope at all (an owner with no
        // branches yet, per the `!access.isOwner &&` redirect above) — any
        // in-scope branch, reviewed or not, produces at least one group below.
        <p className={EMPTY_PANEL}>
          No reviews yet — players can review a court after they’ve played on it.
        </p>
      ) : (
        <div className="flex flex-col gap-10">
          {reviewGroups.map((group) => (
            <section key={group.branchId}>
              <div className="mb-4 flex items-baseline justify-between gap-3">
                <h2 className="font-display text-[19px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                  {group.branchName}
                </h2>
                <span className="font-mono text-[11px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                  {group.reviews.length} {group.reviews.length === 1 ? 'review' : 'reviews'}
                </span>
              </div>

              {group.reviews.length === 0 ? (
                // Only truthful because the cap is now per branch (see
                // src/lib/owner/reviews.ts's module doc): a global cap could
                // starve a quiet branch of its own older reviews and this
                // line would then be lying about it having none at all.
                <p className={EMPTY_PANEL}>No reviews for {group.branchName} yet.</p>
              ) : (
                <>
                  <div className="flex flex-col gap-4">
                    {group.reviews.map((review) => (
                      <article
                        key={review.id}
                        className="rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)]"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-display text-[16px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                              {review.courtName}
                            </div>
                            {/* Just the player, not `{branchName} · {playerName}`
                                — under this group's own branch heading, repeating
                                the branch name on every card would be redundant. */}
                            <div className="mt-0.5 text-[12.5px] text-[var(--ink-soft)]">
                              {review.playerName}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-mono text-[11.5px] text-[var(--ink-soft)]">
                              {formatDateLabel(review.createdOn)}
                            </div>
                            {/* The single-review mark. Uses the Stars primitive rather
                                than <Rating>, which is the AGGREGATE component
                                (average + count in parens, renders nothing at zero).
                                Both single-review surfaces — this one and the player's
                                own reviews on /bookings — used to hand-roll their own
                                copy of this markup because no primitive existed. */}
                            <div
                              role="img"
                              className="mt-1.5 flex items-center justify-end"
                              aria-label={`Rated ${review.rating} out of 5`}
                            >
                              <Stars value={review.rating} />
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

                  {group.capped && (
                    <p className="mt-5 text-[12.5px] text-[var(--ink-soft)]">
                      Showing the most recent {OWNER_REVIEWS_LIMIT} for {group.branchName}.
                    </p>
                  )}
                </>
              )}
            </section>
          ))}
        </div>
      )}
    </>
  )
}
