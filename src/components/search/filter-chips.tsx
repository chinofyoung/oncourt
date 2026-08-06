'use client'

import { formatPeso } from '@/lib/format'
import { COURT_ENVIRONMENT_LABELS } from '@/lib/listings/fields'
import { AMENITY_LABELS, AMENITY_SLUGS } from '@/components/ui/amenity-chip'
import { selectClass, toggleActive, toggleBase, toggleInactive, useFilterParams } from './filter-controls'

/**
 * search-results.html's `.chip-row`, directly under the section head: the
 * filters that narrow an already-framed search (environment, price ceiling,
 * amenities). Where/date/time live in the map hero's float instead.
 *
 * Same vocabulary as the server-side enforcement list in
 * `src/lib/search/params.ts` — both import `AMENITY_SLUGS` from
 * `amenity-chip.tsx`, the single source of truth, so the allowed list and
 * this display order can't drift apart.
 */
const MAX_PRICE_OPTIONS = [20_000, 30_000, 50_000]

export function FilterChips(props: {
  environment: 'indoor' | 'outdoor' | undefined
  maxPriceCentavos: number | undefined
  amenities: string[]
}) {
  const { environment, maxPriceCentavos, amenities } = props
  const { setParam, toggleInList } = useFilterParams()

  return (
    <div className="mb-7 flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Environment" className="flex items-center gap-2">
        {(['indoor', 'outdoor'] as const).map((env) => (
          <button
            key={env}
            type="button"
            onClick={() => setParam('env', environment === env ? null : env)}
            aria-pressed={environment === env}
            className={`${toggleBase} ${environment === env ? toggleActive : toggleInactive}`}
          >
            {COURT_ENVIRONMENT_LABELS[env]}
          </button>
        ))}
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
        {AMENITY_SLUGS.map((amenity) => (
          <button
            key={amenity}
            type="button"
            onClick={() => toggleInList('amenities', amenities, amenity)}
            aria-pressed={amenities.includes(amenity)}
            className={`${toggleBase} ${amenities.includes(amenity) ? toggleActive : toggleInactive}`}
          >
            {AMENITY_LABELS[amenity] ?? amenity}
          </button>
        ))}
      </div>
    </div>
  )
}
