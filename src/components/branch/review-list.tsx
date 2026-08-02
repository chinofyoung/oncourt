import { Rating } from '@/components/ui/rating'
import type { BranchReview } from '@/lib/branches/queries'
import { formatDateLabel } from '@/lib/format'

const FILLED_STAR = '●'
const EMPTY_STAR = '○'

/**
 * Ported from design/mockups/branch-page.html's `.review` row (one row only
 * there, a "latest review" teaser) — this renders the full `reviews` list
 * `getBranchDetail` returns (up to its own REVIEW_LIMIT), not just the first.
 *
 * `authorAvatarUrl` is rendered directly as an <img src>, the same pattern
 * `Nav` uses for the signed-in user's avatar (it's a plain profile URL, not a
 * Supabase Storage path — unlike `photoPaths`, it never goes through
 * `photoUrl()`). A null avatar falls back to an initial-letter badge, same
 * reasoning as Nav's: an empty `src` would request the current page URL.
 */
export function ReviewList({
  reviews,
  ratingAvg,
  ratingCount,
}: {
  reviews: BranchReview[]
  ratingAvg: number | null
  ratingCount: number
}) {
  return (
    <section
      aria-label="Reviews"
      className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[17px] font-bold text-[var(--ink)]">Reviews</h2>
        <Rating average={ratingAvg} count={ratingCount} />
      </div>

      {reviews.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--ink-soft)]">No reviews yet.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-5">
          {reviews.map((review) => (
            <li key={review.id} className="flex gap-3">
              {review.authorAvatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={review.authorAvatarUrl}
                  alt=""
                  className="h-10 w-10 flex-none rounded-full border border-[var(--hairline)] object-cover"
                />
              ) : (
                <span
                  aria-hidden
                  className="flex h-10 w-10 flex-none items-center justify-center rounded-full border border-[var(--hairline)] bg-[var(--court-deep)] text-sm font-semibold text-white"
                >
                  {(review.authorName ?? '?').charAt(0).toUpperCase()}
                </span>
              )}
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[13.5px] font-semibold text-[var(--ink)]">
                    {review.authorName ?? 'Player'}
                  </span>
                  <span
                    aria-label={`${review.rating} out of 5`}
                    className="font-mono text-[11px] tracking-[.1em] text-[var(--court)]"
                  >
                    {FILLED_STAR.repeat(review.rating)}
                    {EMPTY_STAR.repeat(Math.max(5 - review.rating, 0))}
                  </span>
                  <span className="text-xs text-[var(--ink-soft)]">
                    {formatDateLabel(review.createdAt.slice(0, 10))}
                  </span>
                </div>
                {review.body && (
                  <p className="mt-1 text-sm text-[var(--ink-soft)]">{review.body}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
