/**
 * The city options the `/search` and home-page pickers offer, each with a
 * centroid and an optional search radius.
 *
 * A hardcoded table rather than a geocoder on purpose: no API key, no rate
 * limit, no usage policy to honor, no network failure mode, and — because the
 * table is short enough to keep honest by hand — no option in the picker that
 * returns nothing.
 *
 * Two entries, and the second one is the interesting design decision:
 *
 * - `tacloban` — the only place with real branches today, and the default, so
 *   the landing state is a live query rather than an empty one.
 * - `philippines` — the wide-area fallback, deliberately NATIONWIDE rather
 *   than regional ("All of Eastern Visayas" or similar). A regional entry
 *   would go stale the moment an owner signs up outside it: the first branch
 *   in Cebu or Manila would be unreachable from the picker entirely, since a
 *   named-city entry only exists for cities in this file. Nationwide is
 *   correct for every branch that will ever exist and needs no maintenance.
 *   The picker must never make a real branch unreachable.
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
  { slug: 'tacloban', name: 'Tacloban City', lat: 11.2444, lng: 125.0048 },
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
 * Sibuyan Sea) would be a useless place to drop a pin. Anything that isn't a
 * real city in the table — Cebu, Davao, and in practice every name but
 * Tacloban City — falls back to the default city, which is a starting view,
 * not a claim about where the branch is: the owner drags the pin from there.
 */
export function cityCenterByName(name: string | null | undefined): City {
  const normalized = (name ?? '').trim().toLowerCase()
  return (
    CITIES.find((city) => city.radiusMeters === undefined && city.name.toLowerCase() === normalized) ??
    cityBySlug(DEFAULT_CITY_SLUG)
  )
}
