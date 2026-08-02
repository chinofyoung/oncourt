'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { CITIES } from '@/lib/geo/cities'
import { manilaToday } from '@/lib/date-manila'
import { formatHour, formatPeso } from '@/lib/format'
import { AMENITY_LABELS, AMENITY_SLUGS } from '@/components/ui/amenity-chip'
import type { SearchFilters } from '@/lib/branches/queries'

/**
 * Same vocabulary as `AMENITY_VOCAB` in `src/app/search/page.tsx` — both
 * import `AMENITY_SLUGS` from `amenity-chip.tsx`, the single source of
 * truth, so the server-side enforcement list and this client-side display
 * order can't drift apart.
 */
const AMENITIES = AMENITY_SLUGS

/** Valid start hours for a 1-hour slot (mirrors home.html's hero form). */
const HOUR_OPTIONS = Array.from({ length: 17 }, (_, i) => i + 7)

const MAX_PRICE_OPTIONS = [20_000, 30_000, 50_000]

type FilterBarProps = {
  filters: SearchFilters
  citySlug: string
  date: string
  hour: number | undefined
  environment: 'indoor' | 'outdoor' | undefined
  maxPriceCentavos: number | undefined
  amenities: string[]
  sort: 'distance' | 'price' | 'rating'
  usingCoords: boolean
}

const selectClass =
  'h-[var(--btn-h-sm)] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-3 text-[13.5px] font-medium text-[var(--ink)] outline-none transition-colors focus:border-[var(--court)] motion-reduce:transition-none'

const toggleBase =
  'h-[var(--btn-h-sm)] inline-flex items-center rounded-[var(--btn-radius)] border px-4 text-[13.5px] font-semibold whitespace-nowrap transition-colors motion-reduce:transition-none'
const toggleActive = 'border-[var(--ink)] bg-[var(--ink)] text-white'
const toggleInactive =
  'border-[var(--hairline)] bg-[var(--panel)] text-[var(--ink-soft)] hover:border-[var(--court)] hover:text-[var(--ink)]'

/**
 * `'use client'`, writes to the URL only — no local result state, no
 * fetching. The URL (via `useSearchParams`) is the single source of truth,
 * which is what makes browser back/forward work correctly: every control's
 * `value`/`defaultValue` reads from props (derived server-side from the URL
 * on the last render), not from any state this component owns.
 *
 * `setParam` treats an empty string the same as `null` (delete the param)
 * everywhere, on purpose — this is the client-side twin of the `hour=""` fix
 * in `page.tsx`'s parser: it guarantees this component can never itself
 * re-introduce a `?hour=` (or any other) empty-value param into the URL.
 */
export function FilterBar({
  citySlug,
  date,
  hour,
  environment,
  maxPriceCentavos,
  amenities,
  sort,
  usingCoords,
}: FilterBarProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams.toString())
    if (value === null || value === '') {
      next.delete(key)
    } else {
      next.set(key, value)
    }
    router.push(`${pathname}?${next.toString()}`)
  }

  const onCityChange = (value: string) => {
    // Choosing a city explicitly takes precedence over a previously-set
    // geolocation — otherwise lat/lng would silently keep overriding the
    // newly picked city.
    const next = new URLSearchParams(searchParams.toString())
    next.set('city', value)
    next.delete('lat')
    next.delete('lng')
    router.push(`${pathname}?${next.toString()}`)
  }

  const toggleEnvironment = (env: 'indoor' | 'outdoor') => {
    setParam('env', environment === env ? null : env)
  }

  const toggleAmenity = (amenity: string) => {
    const set = new Set(amenities)
    if (set.has(amenity)) {
      set.delete(amenity)
    } else {
      set.add(amenity)
    }
    setParam('amenities', Array.from(set).join(',') || null)
  }

  const useMyLocation = () => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next = new URLSearchParams(searchParams.toString())
        next.set('lat', position.coords.latitude.toFixed(5))
        next.set('lng', position.coords.longitude.toFixed(5))
        next.delete('city')
        router.push(`${pathname}?${next.toString()}`)
      },
      // Permission denied is a no-op: the city picker stays in charge and
      // the page never depends on geolocation.
      () => {},
    )
  }

  return (
    <div className="rounded-[20px] border border-[var(--hairline)] bg-[var(--panel)] p-4 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="filter-city">
          City
        </label>
        <select
          id="filter-city"
          value={usingCoords ? '' : citySlug}
          onChange={(e) => onCityChange(e.target.value)}
          className={selectClass}
        >
          {/* Only rendered while geolocation coords are the active filter
              point, so the dropdown doesn't falsely imply a city is
              selected — picking a real city below still works normally and
              clears lat/lng via `onCityChange`. */}
          {usingCoords && <option value="">Near me</option>}
          {CITIES.map((city) => (
            <option key={city.slug} value={city.slug}>
              {city.name}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor="filter-date">
          Date
        </label>
        <input
          id="filter-date"
          type="date"
          value={date}
          min={manilaToday()}
          onChange={(e) => setParam('date', e.target.value)}
          className={selectClass}
        />

        <label className="sr-only" htmlFor="filter-hour">
          Time
        </label>
        <select
          id="filter-hour"
          value={hour ?? ''}
          onChange={(e) => setParam('hour', e.target.value)}
          className={selectClass}
        >
          <option value="">Any time</option>
          {HOUR_OPTIONS.map((h) => (
            <option key={h} value={h}>
              {formatHour(h)}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={useMyLocation}
          className="h-[var(--btn-h-sm)] inline-flex items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-4 text-[13.5px] font-semibold whitespace-nowrap text-[var(--ink)] transition-colors hover:border-[var(--court)]"
        >
          Use my location
        </button>

        <label className="sr-only" htmlFor="filter-sort">
          Sort
        </label>
        <select
          id="filter-sort"
          value={sort}
          onChange={(e) => setParam('sort', e.target.value)}
          className={`${selectClass} ml-auto`}
        >
          <option value="distance">Sort: Distance</option>
          <option value="price">Sort: Price</option>
          <option value="rating">Sort: Rating</option>
        </select>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--hairline)] pt-3">
        <div role="group" aria-label="Environment" className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => toggleEnvironment('indoor')}
            aria-pressed={environment === 'indoor'}
            className={`${toggleBase} ${environment === 'indoor' ? toggleActive : toggleInactive}`}
          >
            Indoor
          </button>
          <button
            type="button"
            onClick={() => toggleEnvironment('outdoor')}
            aria-pressed={environment === 'outdoor'}
            className={`${toggleBase} ${environment === 'outdoor' ? toggleActive : toggleInactive}`}
          >
            Outdoor
          </button>
        </div>

        <label className="sr-only" htmlFor="filter-max-price">
          Max price
        </label>
        <select
          id="filter-max-price"
          value={maxPriceCentavos ?? ''}
          onChange={(e) => setParam('max', e.target.value)}
          className={selectClass}
        >
          <option value="">Any price</option>
          {MAX_PRICE_OPTIONS.map((centavos) => (
            <option key={centavos} value={centavos}>
              ≤ {formatPeso(centavos)}/hr
            </option>
          ))}
        </select>

        <span aria-hidden className="mx-1 h-5 w-px bg-[var(--hairline)]" />

        <div role="group" aria-label="Amenities" className="flex flex-wrap items-center gap-2">
          {AMENITIES.map((amenity) => (
            <button
              key={amenity}
              type="button"
              onClick={() => toggleAmenity(amenity)}
              aria-pressed={amenities.includes(amenity)}
              className={`${toggleBase} ${amenities.includes(amenity) ? toggleActive : toggleInactive}`}
            >
              {AMENITY_LABELS[amenity] ?? amenity}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
