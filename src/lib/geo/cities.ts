/**
 * The city options the `/search` and home-page pickers offer, each with a
 * centroid and an optional search radius.
 *
 * A hardcoded table rather than a geocoder on purpose: no API key, no rate
 * limit, no usage policy to honor, and no network failure mode.
 *
 * The list is NO LONGER short enough to guarantee every option returns
 * results, and that is deliberate. It grew from two entries to fifteen when
 * players gained a home-city field (profiles.city_slug): a player has to be
 * able to name where they actually live, and "Tacloban or nationwide" could
 * not do that. With one live branch today, most of these cities return zero
 * courts — that is the correct, honest answer for a city with no courts yet,
 * not a bug to hide by shortening the list.
 *
 * What has NOT changed: the picker must never make a real branch unreachable.
 * `philippines` — the wide-area fallback — is deliberately NATIONWIDE rather
 * than regional ("All of Eastern Visayas" or similar). A regional entry would
 * go stale the moment an owner signs up outside it: the first branch in a
 * city with no named entry would be unreachable from the picker entirely,
 * since a named-city entry only exists for cities in this file. Nationwide is
 * correct for every branch that will ever exist and needs no maintenance.
 *
 * A branch in a city with no named entry is therefore always findable through
 * "All of the Philippines", through geolocation, and through its own URL.
 */

export type City = {
  slug: string
  name: string
  lat: number
  lng: number
  /**
   * Search radius for this entry, overriding `CITY_SEARCH_RADIUS_METERS`.
   * Set only on wide-area entries; a real city omits it and gets the shared
   * 12 km city radius.
   */
  radiusMeters?: number
}

/** The city the pickers land on, and the fallback for an unknown slug. */
export const DEFAULT_CITY_SLUG = 'tacloban'

/**
 * Radius (in meters) that counts as "being in" a named city — the radius for
 * every entry that does not carry its own `radiusMeters`. Must stay in sync
 * between `getHomeData` (src/lib/branches/queries.ts), which uses it to
 * compute the home page's per-city chip counts, and `parseSearchParams`
 * (src/lib/search/params.ts), which uses it as `/search`'s actual query radius
 * for a named-city (non-geolocated) search — otherwise the chip counts and the
 * search results they link to will silently disagree.
 */
export const CITY_SEARCH_RADIUS_METERS = 12_000

export const CITIES: readonly City[] = [
  { slug: 'quezon-city', name: 'Quezon City', lat: 14.676, lng: 121.0437 },
  { slug: 'manila', name: 'Manila', lat: 14.5995, lng: 120.9842 },
  { slug: 'makati', name: 'Makati', lat: 14.5547, lng: 121.0244 },
  { slug: 'pasig', name: 'Pasig', lat: 14.5764, lng: 121.0851 },
  { slug: 'taguig', name: 'Taguig', lat: 14.5176, lng: 121.0509 },
  { slug: 'baguio', name: 'Baguio', lat: 16.4023, lng: 120.596 },
  { slug: 'iloilo-city', name: 'Iloilo City', lat: 10.7202, lng: 122.5621 },
  { slug: 'bacolod', name: 'Bacolod', lat: 10.6407, lng: 122.9689 },
  { slug: 'cebu-city', name: 'Cebu City', lat: 10.3157, lng: 123.8854 },
  { slug: 'tacloban', name: 'Tacloban City', lat: 11.2444, lng: 125.0048 },
  { slug: 'cagayan-de-oro', name: 'Cagayan de Oro', lat: 8.4542, lng: 124.6319 },
  { slug: 'zamboanga-city', name: 'Zamboanga City', lat: 6.9214, lng: 122.079 },
  { slug: 'davao-city', name: 'Davao City', lat: 7.1907, lng: 125.4553 },
  { slug: 'general-santos', name: 'General Santos', lat: 6.1164, lng: 125.1716 },
  {
    slug: 'philippines',
    name: 'All of the Philippines',
    lat: 12.8797,
    lng: 121.774,
    radiusMeters: 1_500_000,
  },
] as const

/** Falls back to the default city for an unknown or missing slug. */
export function cityBySlug(slug: string | null | undefined): City {
  return (
    CITIES.find((city) => city.slug === slug) ??
    CITIES.find((city) => city.slug === DEFAULT_CITY_SLUG)!
  )
}

/**
 * A city centroid looked up by its display NAME rather than its slug —
 * `branches.city` is free text typed by an owner, not a slug.
 *
 * Used only to decide where the map pin editor opens when a branch has no pin
 * yet. Wide-area entries are skipped: "All of the Philippines" is not a city
 * anyone types into an address form, and its centroid (open water in the
 * Sibuyan Sea) would be a useless place to drop a pin. A name absent from the
 * table altogether — "Intramuros", a district, never a name in this table —
 * falls back to the default city the same way, which is a starting view, not
 * a claim about where the branch is: the owner drags the pin from there.
 */
export function cityCenterByName(name: string | null | undefined): City {
  const normalized = (name ?? '').trim().toLowerCase()
  return (
    CITIES.find((city) => city.radiusMeters === undefined && city.name.toLowerCase() === normalized) ??
    cityBySlug(DEFAULT_CITY_SLUG)
  )
}
