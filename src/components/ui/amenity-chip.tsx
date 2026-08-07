import { AMENITY_ICONS, CustomAmenityIcon } from './amenity-icons'

/**
 * design/branding.md, Controls: "Non-interactive chips/badges stay
 * pill-shaped (border-radius: 999px) to distinguish them from buttons."
 *
 * Maps amenity values (branches.amenities is a bare `text[]`, no DB
 * constraint) to display labels. An unknown value still renders — falls back
 * to the raw value with hyphens replaced by spaces — rather than
 * disappearing silently, since a value reaching this component at all means
 * some branch actually lists it. That fallback is what keeps three kinds of
 * entry readable: a genuinely unrecognized value, an owner-typed custom
 * amenity with no canned label, and a RETIRED slug (see below).
 *
 * `aircon`, `pro-shop`, and `night-lights` were canonical checkbox amenities
 * before 2026-08-07 and were retired from AMENITY_SLUGS in favor of the
 * vocabulary below, but their labels are kept here on purpose: any branch
 * that already stored one of them keeps rendering a proper label (and the
 * owner's custom-amenity list in branch-fieldset.tsx shows the same label)
 * instead of silently losing it or falling back to a hyphen-stripped raw
 * slug. They are deliberately absent from AMENITY_SLUGS — that list is the
 * checkbox/search vocabulary, not "every label this component knows".
 */
export const AMENITY_LABELS: Record<string, string> = {
  parking: 'Parking',
  showers: 'Showers',
  lockers: 'Lockers',
  rentals: 'Paddle rentals',
  'ball-rentals': 'Ball rentals',
  'ball-machine-rentals': 'Ball machine rentals',
  cafe: 'Café',
  snacks: 'Snacks',
  // Retired canonical slugs — see the block comment above.
  aircon: 'Aircon',
  'pro-shop': 'Pro shop',
  'night-lights': 'Night lights',
}

/**
 * Single source of truth for the CANONICAL amenity slug vocabulary — the
 * checkbox list an owner picks from and the only values `?amenities=` search
 * filtering accepts. Shared by the server-side query-param validator
 * (`src/lib/search/params.ts`, which whitelists the `?amenities=` param
 * against this list), the client-side filter toggles
 * (`src/components/search/filter-chips.tsx`, which renders one button per
 * slug in this order), and the owner's checkbox fieldset
 * (`src/app/dashboard/listings/branch-fieldset.tsx`) so the enforcement path
 * and the display path cannot drift apart into hand-maintained copies.
 *
 * This is NOT the full set of values `branches.amenities` can hold — owners
 * can also add free-text custom amenities (validated by shape, not by
 * vocabulary, in `parseBranchFields`); anything in a branch's stored array
 * that isn't in this list is treated as custom. Search filtering stays
 * canonical-only on purpose: a per-branch free-text amenity is not a shared
 * filter facet.
 */
export const AMENITY_SLUGS = [
  'parking',
  'showers',
  'lockers',
  'rentals',
  'ball-rentals',
  'ball-machine-rentals',
  'cafe',
  'snacks',
] as const

export function AmenityChip({ amenity }: { amenity: string }) {
  const label = AMENITY_LABELS[amenity] ?? amenity.replaceAll('-', ' ')
  const AmenityIcon = AMENITY_ICONS[amenity] ?? CustomAmenityIcon
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--hairline)] bg-[var(--panel)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--ink-soft)]">
      <AmenityIcon />
      {label}
    </span>
  )
}
