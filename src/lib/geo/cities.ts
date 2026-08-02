/**
 * The cities the seed actually places branches in, each with a centroid.
 *
 * A hardcoded table rather than a geocoder on purpose: no API key, no rate
 * limit, no usage policy to honor, no network failure mode, and — because
 * every entry corresponds to real seeded branches — no option in the picker
 * that returns nothing. If a branch is ever created in a city not listed
 * here, the city picker simply will not offer it; the branch is still
 * reachable through the region-wide default and through its own URL.
 */

export type City = { slug: string; name: string; lat: number; lng: number }

/** Region-wide default. Roughly the geographic middle of Metro Manila. */
export const DEFAULT_CITY_SLUG = 'metro-manila'

export const CITIES: readonly City[] = [
  { slug: 'metro-manila', name: 'All of Metro Manila', lat: 14.5995, lng: 121.0359 },
  { slug: 'quezon-city', name: 'Quezon City', lat: 14.676, lng: 121.0437 },
  { slug: 'makati', name: 'Makati', lat: 14.5547, lng: 121.0244 },
  { slug: 'pasig', name: 'Pasig', lat: 14.5764, lng: 121.0851 },
  { slug: 'taguig', name: 'Taguig', lat: 14.5176, lng: 121.0509 },
  { slug: 'mandaluyong', name: 'Mandaluyong', lat: 14.5794, lng: 121.0359 },
  { slug: 'san-juan', name: 'San Juan', lat: 14.6019, lng: 121.0355 },
  { slug: 'marikina', name: 'Marikina', lat: 14.6507, lng: 121.1029 },
  { slug: 'paranaque', name: 'Parañaque', lat: 14.4793, lng: 121.0198 },
  { slug: 'caloocan', name: 'Caloocan', lat: 14.6507, lng: 120.9676 },
] as const

/** Falls back to the region-wide default for an unknown or missing slug. */
export function cityBySlug(slug: string | null | undefined): City {
  return (
    CITIES.find((city) => city.slug === slug) ??
    CITIES.find((city) => city.slug === DEFAULT_CITY_SLUG)!
  )
}
