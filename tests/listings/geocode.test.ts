import { expect, test, vi } from 'vitest'
import {
  createCachedGeocoder,
  createNominatimGeocoder,
  GEOCODER_USER_AGENT,
  NOMINATIM_ENDPOINT,
  type Geocoder,
} from '@/lib/geo/geocode'
import { cityCenterByName } from '@/lib/geo/cities'

/**
 * `fetch` is the second and last permitted test double in this slice, for the
 * obvious reason: Nominatim is somebody else's server with a usage policy,
 * and a test suite is not allowed to be traffic. The Nominatim call itself is
 * deliberately NOT integration-tested (the spec says so); what is tested is
 * that the request we would send is the polite, correct one and that every
 * failure shape degrades to null.
 */
function fakeFetch(response: {
  ok?: boolean
  status?: number
  body?: unknown
  throws?: boolean
}) {
  return vi.fn(async () => {
    if (response.throws) throw new Error('network down')
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body,
    } as unknown as Response
  })
}

test('the Nominatim geocoder sends a polite, one-result, PH-restricted request', async () => {
  const fetchImpl = fakeFetch({ body: [{ lat: '14.6507', lon: '121.1029' }] })
  const geocode = createNominatimGeocoder(fetchImpl as unknown as typeof fetch)

  await geocode('12 Shoe Ave, Marikina, Philippines')

  expect(fetchImpl).toHaveBeenCalledTimes(1)
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit]
  expect(String(url).startsWith(NOMINATIM_ENDPOINT)).toBe(true)
  const params = new URL(String(url)).searchParams
  expect(params.get('q')).toBe('12 Shoe Ave, Marikina, Philippines')
  expect(params.get('format')).toBe('jsonv2')
  // limit=1: one request per submit, no bulk. countrycodes=ph narrows the
  // answer to the only country this product operates in.
  expect(params.get('limit')).toBe('1')
  expect(params.get('countrycodes')).toBe('ph')
  // Nominatim's usage policy REQUIRES an identifying User-Agent. Requests
  // without one are blocked, and a generic one gets the whole app banned.
  expect((init.headers as Record<string, string>)['User-Agent']).toBe(GEOCODER_USER_AGENT)
})

test('the Nominatim geocoder returns the first result coordinates as numbers', async () => {
  // Nominatim returns lat/lon as STRINGS. Handing those to st_makepoint
  // unconverted would be a type error at best and a silent 0 at worst.
  const geocode = createNominatimGeocoder(
    fakeFetch({ body: [{ lat: '14.6507', lon: '121.1029' }] }) as unknown as typeof fetch,
  )
  expect(await geocode('Marikina')).toEqual({ lat: 14.6507, lng: 121.1029 })
})

test('the Nominatim geocoder returns null for an empty result list', async () => {
  const geocode = createNominatimGeocoder(fakeFetch({ body: [] }) as unknown as typeof fetch)
  expect(await geocode('nowhere at all')).toBeNull()
})

test('the Nominatim geocoder returns null for a non-2xx response', async () => {
  // 429 is the realistic one: Nominatim rate-limits, and being rate-limited
  // must not stop an owner from saving their branch.
  const geocode = createNominatimGeocoder(
    fakeFetch({ ok: false, status: 429, body: {} }) as unknown as typeof fetch,
  )
  expect(await geocode('Marikina')).toBeNull()
})

test('the Nominatim geocoder returns null when the network throws', async () => {
  const geocode = createNominatimGeocoder(fakeFetch({ throws: true }) as unknown as typeof fetch)
  expect(await geocode('Marikina')).toBeNull()
})

test('the Nominatim geocoder returns null when the request times out', async () => {
  // AbortSignal.timeout(GEOCODER_TIMEOUT_MS) rejects the fetch promise with a
  // TimeoutError DOMException — this pins that the same try/catch already
  // covering a dead network also covers a hung one, so a slow Nominatim
  // response can never leave "Find on map" spinning forever.
  const fetchImpl = vi.fn(async () => {
    throw new DOMException('The operation timed out.', 'TimeoutError')
  })
  const geocode = createNominatimGeocoder(fetchImpl as unknown as typeof fetch)
  expect(await geocode('Marikina')).toBeNull()
})

test('the Nominatim geocoder rejects a result outside the Philippines', async () => {
  // countrycodes=ph is a request, not a guarantee. The same bounding box the
  // form uses is applied to the geocoder's answer, so a bad result cannot
  // pre-fill a pin the form would then reject.
  const geocode = createNominatimGeocoder(
    fakeFetch({ body: [{ lat: '1.3521', lon: '103.8198' }] }) as unknown as typeof fetch,
  )
  expect(await geocode('Singapore')).toBeNull()
})

test('the Nominatim geocoder returns null for a blank query without calling the network', async () => {
  const fetchImpl = fakeFetch({ body: [] })
  const geocode = createNominatimGeocoder(fetchImpl as unknown as typeof fetch)
  expect(await geocode('   ')).toBeNull()
  expect(fetchImpl).not.toHaveBeenCalled()
})

test('the cached geocoder asks the provider once per address', async () => {
  // Nominatim's usage policy is the reason this cache exists at all: an owner
  // pressing "Find on map" repeatedly must not become repeated traffic.
  let calls = 0
  const inner: Geocoder = async () => {
    calls += 1
    return { lat: 14.6507, lng: 121.1029 }
  }
  const geocode = createCachedGeocoder(inner)

  expect(await geocode('12 Shoe Ave, Marikina')).toEqual({ lat: 14.6507, lng: 121.1029 })
  expect(await geocode('12 Shoe Ave, Marikina')).toEqual({ lat: 14.6507, lng: 121.1029 })
  expect(calls).toBe(1)
})

test('the cached geocoder normalizes case and whitespace, and caches misses too', async () => {
  // Caching the miss matters more than caching the hit: a typo'd address is
  // exactly what someone retries five times in a row.
  let calls = 0
  const inner: Geocoder = async () => {
    calls += 1
    return null
  }
  const geocode = createCachedGeocoder(inner)

  expect(await geocode('12 Shoe Ave,  Marikina')).toBeNull()
  expect(await geocode('  12 SHOE AVE, MARIKINA  ')).toBeNull()
  expect(calls).toBe(1)
})

test('cityCenterByName finds a known city and otherwise falls back to the default city', async () => {
  // The pin editor has to start somewhere when a branch has no pin yet.
  expect(cityCenterByName('Tacloban City')).toMatchObject({ slug: 'tacloban' })
  expect(cityCenterByName('  tacloban city ')).toMatchObject({ slug: 'tacloban' })
  // Cebu resolves to its own centroid now that the table carries it — the pin
  // editor opening on the city the owner actually typed is the whole point of
  // this function. Before the table grew to 15 cities this fell back to
  // tacloban simply because there was no Cebu entry to find.
  expect(cityCenterByName('Cebu City')).toMatchObject({ slug: 'cebu-city' })
  expect(cityCenterByName(null)).toMatchObject({ slug: 'tacloban' })
  // A wide-area entry is not a city anyone types into an address form, and
  // its centroid is open water in the Sibuyan Sea — a useless place to drop a
  // pin. Matching on `name` alone would return it here, so this pins that
  // `cityCenterByName` skips entries carrying their own `radiusMeters` and
  // falls back to the default city instead.
  expect(cityCenterByName('All of the Philippines')).toMatchObject({ slug: 'tacloban' })
})
