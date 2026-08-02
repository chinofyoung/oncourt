/**
 * design/branding.md, Rating: lime dot (7px, ink outline) + bold number,
 * count in parens muted.
 *
 * Renders nothing at all when a branch has no reviews — a "0.0 (0)" badge
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
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span
        aria-hidden
        className="h-[7px] w-[7px] rounded-full border border-[var(--ink)] bg-[var(--ball)]"
      />
      <span className={`font-semibold ${onDark ? 'text-white' : 'text-[var(--ink)]'}`}>
        {average.toFixed(1)}
      </span>
      <span className={onDark ? 'text-white/70' : 'text-[var(--ink-soft)]'}>({count})</span>
    </span>
  )
}
