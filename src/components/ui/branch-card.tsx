'use client'

import Link from 'next/link'
import type { BranchSummary } from '@/lib/branches/queries'
import { photoUrl } from '@/lib/photos'
import { formatPriceFrom } from '@/lib/format'
import { Rating } from '@/components/ui/rating'
import { AmenityChip } from '@/components/ui/amenity-chip'

/**
 * Ported from design/mockups/home.html's `.vcard` (and search-results.html's
 * near-identical `.court-card`): white, rounded-[20px], no border,
 * shadow-[var(--shadow-sm)]; hover lifts -4px with shadow-[var(--shadow-lg)]
 * and the cover image scales to 1.045 — all guarded by
 * motion-reduce:transform-none motion-reduce:transition-none per
 * branding.md's Motion section.
 *
 * `'use client'` lives here (and only here): onMouseEnter/onMouseLeave are
 * DOM event handler props, which only a Client Component can attach. Task 10
 * wraps a grid of these to pair card hover with a map marker; a plain Server
 * Component page can still render BranchCard directly since onHoverChange is
 * optional.
 *
 * `active` is presentational only — this component fires onHoverChange but
 * never tracks its own hover/selection state. search-results.html's
 * `.card-highlighted` (`outline: 2px solid var(--court); outline-offset:
 * 2px`) is reused here for the same "a map marker points at this card"
 * purpose, since the brief's Step 8 sample doesn't show the prop's own
 * styling.
 */
export function BranchCard({
  branch,
  showDistance = false,
  active = false,
  onHoverChange,
}: {
  branch: BranchSummary
  showDistance?: boolean
  active?: boolean
  onHoverChange?: (id: string | null) => void
}) {
  const cover = photoUrl('branch-photos', branch.coverPhotoPath)
  const hasRating = branch.ratingAvg !== null && branch.ratingCount > 0
  const distanceKm =
    showDistance && branch.distanceMeters !== null
      ? (branch.distanceMeters / 1000).toFixed(1)
      : null

  return (
    <Link
      href={`/venues/${branch.slug}`}
      data-branch-id={branch.id}
      onMouseEnter={() => onHoverChange?.(branch.id)}
      onMouseLeave={() => onHoverChange?.(null)}
      className={`group block overflow-hidden rounded-[20px] bg-[var(--panel)] text-[var(--ink)] no-underline shadow-[var(--shadow-sm)] transition-[transform,box-shadow] duration-[220ms] ease-[cubic-bezier(0.2,0.7,0.3,1)] hover:-translate-y-1 hover:shadow-[var(--shadow-lg)] motion-reduce:transform-none motion-reduce:transition-none ${
        active ? 'outline outline-2 outline-offset-2 outline-[var(--court)]' : ''
      }`}
    >
      <div className="relative aspect-[16/10] overflow-hidden">
        {cover ? (
          <img
            src={cover}
            alt={branch.name}
            className="h-full w-full object-cover transition-transform duration-500 ease-[cubic-bezier(0.2,0.7,0.3,1)] group-hover:scale-[1.045] motion-reduce:transform-none motion-reduce:transition-none"
          />
        ) : (
          <div className="h-full w-full bg-[var(--band-off)]" />
        )}
      </div>

      <div className="px-5 pt-[18px] pb-5">
        <h3 className="font-display text-lg font-bold tracking-[-0.015em]">{branch.name}</h3>

        <div className="mt-[5px] flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--ink-soft)]">
          {hasRating && (
            <>
              <Rating average={branch.ratingAvg} count={branch.ratingCount} />
              <span aria-hidden>·</span>
            </>
          )}
          <span>{branch.city}</span>
          {distanceKm !== null && (
            <>
              <span aria-hidden>·</span>
              <span>{distanceKm} km away</span>
            </>
          )}
        </div>

        <div className="mt-3.5 flex items-center gap-3.5 border-t border-[var(--hairline)] pt-3.5">
          <span className="font-mono flex-1 text-[15px] font-medium">
            {formatPriceFrom(branch.minPriceCentavos)}
          </span>
          <span className="text-xs font-semibold text-[var(--court)]">
            {branch.courtCount} {branch.courtCount === 1 ? 'court' : 'courts'}
          </span>
        </div>

        {branch.amenities.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {branch.amenities.slice(0, 3).map((amenity) => (
              <AmenityChip key={amenity} amenity={amenity} />
            ))}
          </div>
        )}
      </div>
    </Link>
  )
}
