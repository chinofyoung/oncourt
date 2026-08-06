import 'server-only'
import { isInPhilippines } from '@/lib/listings/fields'

/**
 * Address -> coordinates, behind a provider-swappable function type.
 *
 * Nominatim (OpenStreetMap) today: no API key, and this product's volume is
 * one request per branch form submit. `Geocoder` is a plain function type so
 * swapping in Google later is a one-line change at the bottom of this file
 * and nothing else moves.
 *
 * NON-BLOCKING BY CONSTRUCTION. Every failure — no result, a rate-limit, a
 * dead network, a result in the wrong country — returns null, and null means
 * "the owner places the pin by hand". Geocoding is a convenience; the drag is
 * the precision tool and the only one that is guaranteed to work.
 */
export type GeocodeResult = { lat: number; lng: number }
export type Geocoder = (query: string) => Promise<GeocodeResult | null>

export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search'

/**
 * Nominatim's usage policy REQUIRES an identifying User-Agent with a way to
 * reach the operator. Requests without one are blocked outright, and sharing
 * a generic one is how an application gets banned for someone else's traffic.
 * Update the URL if the deployed domain changes.
 */
export const GEOCODER_USER_AGENT = 'OnCourt/1.0 (+https://oncourt.ph; listings geocoder)'

/**
 * Without a bound, a hung upstream response would leave `geocodeAddressAction`
 * — and the "Find on map" button awaiting it — pending indefinitely, with no
 * recourse but a reload. 8s is generous for a single lookup call while still
 * failing well within a request's lifetime.
 */
export const GEOCODER_TIMEOUT_MS = 8000

export function createNominatimGeocoder(fetchImpl: typeof fetch = fetch): Geocoder {
  return async (query: string) => {
    const trimmed = query.trim()
    if (trimmed.length === 0) return null

    const url = new URL(NOMINATIM_ENDPOINT)
    url.searchParams.set('q', trimmed)
    url.searchParams.set('format', 'jsonv2')
    // ONE result, ONE request per submit — no bulk geocoding, per the usage
    // policy and per the spec's "low volume; the pin drag is the precision
    // tool".
    url.searchParams.set('limit', '1')
    url.searchParams.set('countrycodes', 'ph')

    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': GEOCODER_USER_AGENT, 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(GEOCODER_TIMEOUT_MS),
      })
      if (!response.ok) return null

      const body = (await response.json()) as unknown
      if (!Array.isArray(body) || body.length === 0) return null

      // Nominatim returns lat/lon as strings, and calls longitude "lon".
      const first = body[0] as { lat?: string; lon?: string }
      const lat = Number(first.lat)
      const lng = Number(first.lon)

      // countrycodes=ph is a request, not a guarantee — and the form applies
      // the same box, so letting a foreign result through would only pre-fill
      // a pin that then fails validation.
      if (!isInPhilippines(lat, lng)) return null
      return { lat, lng }
    } catch {
      // A dead network must not stop someone saving their branch.
      return null
    }
  }
}

/** Entries kept before the oldest is evicted. Small on purpose: this is a courtesy cache. */
const CACHE_LIMIT = 200

/**
 * Memoizes per address string, misses included.
 *
 * Caching the misses is the more valuable half: a typo'd address is exactly
 * what somebody retries five times in a row, and each retry would otherwise
 * be a request to somebody else's server.
 *
 * In-memory and per-process, so it does not survive a deploy or span
 * instances. That is fine — it exists to be polite, not to be a datastore.
 */
export function createCachedGeocoder(geocoder: Geocoder): Geocoder {
  const cache = new Map<string, GeocodeResult | null>()

  return async (query: string) => {
    const key = query.trim().toLowerCase().replace(/\s+/g, ' ')
    if (cache.has(key)) return cache.get(key) ?? null

    const result = await geocoder(query)
    // Map iterates in insertion order, so the first key is the oldest.
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
    cache.set(key, result)
    return result
  }
}

/** The one the app uses. Swap the inner factory to change providers. */
export const geocodeAddress: Geocoder = createCachedGeocoder(createNominatimGeocoder())
