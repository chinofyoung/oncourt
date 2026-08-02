/**
 * design/branding.md, Controls: "Non-interactive chips/badges stay
 * pill-shaped (border-radius: 999px) to distinguish them from buttons."
 *
 * Maps the seeded amenity slugs (supabase/migrations — branches.amenities is
 * a text[]) to display labels. An unknown slug still renders — falls back to
 * the slug itself with hyphens replaced by spaces — rather than disappearing
 * silently, since a slug reaching this component at all means some branch
 * actually lists it.
 */
export const AMENITY_LABELS: Record<string, string> = {
  parking: 'Parking',
  showers: 'Showers',
  rentals: 'Paddle rentals',
  aircon: 'Aircon',
  'pro-shop': 'Pro shop',
  cafe: 'Café',
  lockers: 'Lockers',
  'night-lights': 'Night lights',
}

/**
 * Single source of truth for the amenity slug vocabulary. Shared by the
 * server-side query-param validator (`src/app/search/page.tsx`, which
 * whitelists the `?amenities=` param against this list) and the client-side
 * filter toggles (`src/components/search/filter-bar.tsx`, which renders one
 * button per slug in this order) so the enforcement path and the display
 * path cannot drift apart into two hand-maintained copies.
 */
export const AMENITY_SLUGS = [
  'parking',
  'showers',
  'rentals',
  'aircon',
  'pro-shop',
  'cafe',
  'lockers',
  'night-lights',
] as const

export function AmenityChip({ amenity }: { amenity: string }) {
  const label = AMENITY_LABELS[amenity] ?? amenity.replaceAll('-', ' ')
  return (
    <span className="inline-flex items-center rounded-full border border-[var(--hairline)] bg-[var(--panel)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--ink-soft)]">
      {label}
    </span>
  )
}
