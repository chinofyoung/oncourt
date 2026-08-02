/**
 * design/branding.md, Brand: "oncourt" in display font weight 800, followed
 * by a small lime square (8x8px, 2px radius, --ball fill). On light
 * backgrounds add a 1.5px solid var(--ink) border so the square keeps
 * contrast; on dark/photo backgrounds no border. Same rule at footer size.
 *
 * Always lowercase in the wordmark. The brand name is a placeholder — it is
 * only written here, so swapping it is a one-line change. Anything elsewhere
 * that needs the brand name in text (e.g. Footer's copyright line) imports
 * `BRAND_NAME` rather than re-typing the literal.
 */
export const BRAND_NAME = 'oncourt'

export function Wordmark({
  onDark = false,
  className = '',
}: {
  onDark?: boolean
  className?: string
}) {
  return (
    <span
      className={`font-display inline-flex items-baseline gap-1.5 font-extrabold tracking-[-0.03em] ${className}`}
    >
      {BRAND_NAME}
      <span
        aria-hidden
        className={`h-2 w-2 self-center rounded-[2px] bg-[var(--ball)] ${
          onDark ? '' : 'border-[1.5px] border-[var(--ink)]'
        }`}
      />
    </span>
  )
}
