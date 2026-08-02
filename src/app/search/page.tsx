import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { FilterBar } from '@/components/search/filter-bar'
import { SearchResults } from '@/components/search/search-results'
import { searchBranches, type SearchFilters } from '@/lib/branches/queries'
import { isValidCalendarDate, manilaToday } from '@/lib/date-manila'
import { CITIES, DEFAULT_CITY_SLUG, cityBySlug } from '@/lib/geo/cities'
import { AMENITY_SLUGS } from '@/components/ui/amenity-chip'

/**
 * `AMENITY_SLUGS` is the single source of truth (see
 * `src/components/ui/amenity-chip.tsx`), shared with the client-side toggle
 * buttons in `filter-bar.tsx` so the enforcement (here) and display (there)
 * vocabularies cannot drift apart.
 */
const AMENITY_VOCAB = new Set<string>(AMENITY_SLUGS)

/**
 * Parses/validates every `/search` query param into a `SearchFilters` the DB
 * layer can consume, with a safe, in-range fallback for anything malformed —
 * this function must never throw, since a garbage URL (hand-edited, an old
 * bookmark, a bad link) has to render the default view, not a 500.
 *
 * BUG FIXED vs. the brief's starting code: `Number('')` evaluates to `0` in
 * JavaScript, not `NaN`. The home page's hero form has an `hour` <select>
 * whose "Any time" option has `value=""`; submitting it produces
 * `/search?...&hour=` (the param present, empty). With a naive
 * `Number(one('hour'))`, `one('hour')` returns `''`, `Number('')` is `0`,
 * `Number.isInteger(0)` is `true`, and `0` is in the valid `0..23` range — so
 * "Any time" would silently become "hour = midnight (0)", filtering results
 * down to whatever's open at midnight. Fixed by treating an empty/missing
 * string as absent *before* the `Number()` conversion (`hourStr === '' ?
 * NaN : Number(hourStr)`), for every numeric param (`hour`, `lat`, `lng`,
 * `max`) for the same reason — e.g. a hand-edited `?lat=&lng=` must not
 * resolve to `hasCoords: true` at (0, 0), which is off the coast of Africa,
 * not the Philippines.
 *
 * `hour` reaching `searchBranches` without a `date` is impossible by
 * construction: `date` below is unconditionally assigned the parsed value,
 * which itself always falls back to `manilaToday()` when missing/invalid —
 * so `filters.date` is always a truthy, valid string. `searchBranches`'s
 * internal guard (`filters.hour !== undefined && filters.date`) is therefore
 * automatically satisfied whenever `hour` is defined; no extra guard is
 * needed at this call site.
 */
function parseSearchParams(params: Record<string, string | string[] | undefined>) {
  const one = (key: string) => {
    const value = params[key]
    return Array.isArray(value) ? value[0] : value
  }

  /** Empty/missing string treated as absent BEFORE the Number() conversion. */
  const numberOrNaN = (raw: string | undefined) => (raw === undefined || raw === '' ? NaN : Number(raw))

  const citySlug = CITIES.some((c) => c.slug === one('city')) ? one('city')! : DEFAULT_CITY_SLUG
  const city = cityBySlug(citySlug)

  const latRaw = numberOrNaN(one('lat'))
  const lngRaw = numberOrNaN(one('lng'))
  const hasCoords =
    Number.isFinite(latRaw) &&
    Number.isFinite(lngRaw) &&
    latRaw >= -90 &&
    latRaw <= 90 &&
    lngRaw >= -180 &&
    lngRaw <= 180

  const dateRaw = one('date')
  const date = dateRaw && isValidCalendarDate(dateRaw) ? dateRaw : manilaToday()

  const hourRaw = numberOrNaN(one('hour'))
  const hour = Number.isInteger(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? hourRaw : undefined

  const envRaw = one('env')
  const environment: 'indoor' | 'outdoor' | undefined =
    envRaw === 'indoor' || envRaw === 'outdoor' ? envRaw : undefined

  const maxRaw = numberOrNaN(one('max'))
  const maxPriceCentavos = Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : undefined

  const amenities = (one('amenities') ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => AMENITY_VOCAB.has(a))

  const sortRaw = one('sort')
  const sort: 'distance' | 'price' | 'rating' =
    sortRaw === 'price' || sortRaw === 'rating' || sortRaw === 'distance' ? sortRaw : 'distance'

  const filters: SearchFilters = {
    lat: hasCoords ? latRaw : city.lat,
    lng: hasCoords ? lngRaw : city.lng,
    radiusMeters: hasCoords ? 15_000 : citySlug === DEFAULT_CITY_SLUG ? 30_000 : 12_000,
    date,
    hour,
    environment,
    maxPriceCentavos,
    amenities: amenities.length > 0 ? amenities : undefined,
    sort,
  }

  return {
    filters,
    citySlug,
    date,
    hour,
    environment,
    maxPriceCentavos,
    amenities,
    sort,
    usingCoords: hasCoords,
  }
}

/**
 * Ported from design/mockups/search-results.html's results grid and filter
 * chip row — NOT its `.map-hero` section. That mockup renders a full-bleed
 * Leaflet map above the results as a hero; this page instead uses a
 * side-by-side two-column layout (results list + a sticky map column), owned
 * end-to-end by `<SearchResults>` (`src/components/search/search-results.tsx`)
 * — that component renders both columns, the empty state, and mounts the
 * real Leaflet map (`search-map.tsx`) into the right column. Below 980px the
 * map column is hidden entirely (`max-[980px]:hidden`).
 */
export default async function SearchPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const parsed = parseSearchParams(await props.searchParams)
  const results = await searchBranches(parsed.filters)

  return (
    <>
      <Nav variant="solid" />

      <main className="px-[max(24px,calc((100vw-1120px)/2))] pt-8 pb-[72px]">
        <div className="mb-5">
          <FilterBar {...parsed} />
        </div>

        {/* `router.push` from FilterBar is a client-side RSC re-render, not a
            full page load, so this text updates silently for a screen-reader
            user unless announced explicitly. This wrapper is a stable node —
            no `key`, not inside any conditional — so React updates the text
            in place instead of unmounting/remounting the live region (an
            unmount/remount may not get announced by screen readers).
            `aria-atomic` re-reads the whole phrase instead of just the
            changed digit. */}
        <div aria-live="polite" aria-atomic="true">
          <p className="font-mono mb-4 text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
            {results.length} court {results.length === 1 ? 'venue' : 'venues'}
          </p>
        </div>

        <SearchResults
          branches={results}
          pins={results
            .filter((b) => b.lat !== null && b.lng !== null)
            .map((b) => ({
              id: b.id,
              name: b.name,
              slug: b.slug,
              lat: b.lat!,
              lng: b.lng!,
              priceCentavos: b.minPriceCentavos,
            }))}
        />
      </main>

      <Footer />
    </>
  )
}
