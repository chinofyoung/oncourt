import { Stars } from '@/components/ui/stars'

/**
 * A branch's aggregate rating: stars, the average, and the review count.
 *
 * The stars round to the nearest half, so 4.3 and 4.7 look identical — which
 * is exactly why the number stays beside them rather than being replaced by
 * them. The database holds that precision and this surface has always shown
 * it; stars are the fast read, the number is the true one.
 *
 * Renders nothing at all when a branch has no reviews — a "0 stars (0)" row
 * reads as a bad rating rather than an absent one.
 */
export function Rating({
  average,
  count,
  onDark = false,
}: {
  average: number | null
  count: number
  onDark?: boolean
}) {
  if (average === null || count === 0) return null
  return (
    <span
      role="img"
      className="inline-flex items-center gap-1.5 text-sm"
      aria-label={`Rated ${average.toFixed(1)} out of 5 from ${count} ${count === 1 ? 'review' : 'reviews'}`}
    >
      <Stars value={average} />
      <span className={`font-semibold ${onDark ? 'text-white' : 'text-[var(--ink)]'}`}>
        {average.toFixed(1)}
      </span>
      <span className={onDark ? 'text-white/70' : 'text-[var(--ink-soft)]'}>({count})</span>
    </span>
  )
}
