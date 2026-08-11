/**
 * Five stars, filled to the nearest half. The only place star geometry lives.
 *
 * ONE MECHANISM, NOT THREE GLYPHS: a muted row of five stars with a clipped
 * overlay of filled ones on top. Half-stars fall out of the clip width, so
 * there is no separate half-star asset to keep in sync, and the same code
 * would render any fraction if the rounding rule ever changed.
 *
 * Colour: filled `--court`, empty `--hairline`. Deliberately NOT `--ball` —
 * branding.md reserves lime as THE accent, "use sparingly", and the mark this
 * replaces was a single 7px dot. Five lime glyphs on every card in a search
 * grid is the opposite of sparing, and lime on white needs an outline to be
 * legible at all (which is why that dot had one).
 *
 * `aria-hidden` on the whole row, on purpose: the caller owns the accessible
 * name, because only the caller knows whether it is announcing "rated 4.3 out
 * of 5 from 12 reviews" or "you rated this 5 out of 5". A star row that named
 * itself would make every caller announce twice.
 *
 * Dependency-free so both Server and Client Components can use it.
 */
const STAR_PATH =
  'M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z'

/** Nearest half star, clamped to 0–5. Exported for its own unit test. */
export function starFill(value: number): number {
  if (!Number.isFinite(value)) return 0
  const clamped = Math.min(5, Math.max(0, value))
  return Math.round(clamped * 2) / 2
}

function Row({ color, size }: { color: string; size: number }) {
  return (
    <span className="flex shrink-0" style={{ gap: size * 0.15 }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <svg
          key={i}
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill={color}
          aria-hidden
          // Row is a flex container, so without shrink-0 these SVGs are flex
          // items with the default shrink-1 — inside the clipped overlay's
          // width-constrained wrapper they'd shrink to fit rather than
          // overflow into its overflow-hidden, and nothing would ever clip.
          className="shrink-0"
        >
          <path d={STAR_PATH} />
        </svg>
      ))}
    </span>
  )
}

export function Stars({ value, size = 14 }: { value: number; size?: number }) {
  const filled = starFill(value)
  return (
    <span aria-hidden className="relative inline-flex w-fit align-middle">
      <Row color="var(--hairline)" size={size} />
      <span
        className="absolute top-0 left-0 overflow-hidden"
        style={{ width: `${(filled / 5) * 100}%` }}
      >
        <Row color="var(--court)" size={size} />
      </span>
    </span>
  )
}
