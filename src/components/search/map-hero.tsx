'use client'

import dynamic from 'next/dynamic'
import { CITIES } from '@/lib/geo/cities'
import { manilaToday } from '@/lib/date-manila'
import { formatDateLabel, formatHour } from '@/lib/format'
import { useCardHover } from './hover-context'
import { useFilterParams } from './filter-controls'
import type { MapPin } from './search-map'

/**
 * search-results.html's `.map-hero`: a full-bleed 460px map band under the
 * solid nav, with the search fields floating over its bottom-left corner on
 * the 1120px content column's left edge and a filter-summary pill at its
 * top-left.
 *
 * The map is dynamically imported with `ssr: false` because Leaflet touches
 * `window` at module scope and would crash the server render. The loading
 * fallback keeps the band from collapsing before the map mounts.
 */
const SearchMap = dynamic(() => import('./search-map').then((m) => m.SearchMap), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-[var(--band-off)]" />,
})

/** Valid start hours for a 1-hour slot (mirrors home.html's hero form). */
const HOUR_OPTIONS = Array.from({ length: 17 }, (_, i) => i + 7)

/**
 * Left edge of the 1120px content column — branding.md, Layout. Both floating
 * overlays align to it so they line up with the results below; once they go
 * static at ≤980px the same value becomes their horizontal margin, since the
 * hero band itself stays full-bleed.
 */
const COLUMN_LEFT =
  'left-[max(24px,calc((100vw-1120px)/2))] max-[980px]:mx-[max(24px,calc((100vw-1120px)/2))]'

// `min-w-0` on the field and the control is load-bearing, not decoration:
// `truncate` sets `white-space: nowrap`, which raises the control's
// min-content width to its full text width and would otherwise refuse to
// shrink — at 480px that pushed the whole float past the viewport and made
// the page scroll sideways, which branding.md's Layout section forbids.
const fieldClass =
  'flex h-[var(--control-h)] min-w-0 flex-none flex-col justify-center px-4 max-[980px]:flex-auto'
const dividerClass = 'border-l border-[var(--hairline)] max-[560px]:border-l-0'
const labelClass = 'font-mono mb-[3px] text-[10px] tracking-[.14em] text-[var(--ink-soft)] uppercase'
const valueClass =
  'w-full max-w-[220px] min-w-0 truncate bg-transparent text-[14.5px] font-semibold text-[var(--ink)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--court)]'

export function MapHero(props: {
  pins: MapPin[]
  citySlug: string
  date: string
  hour: number | undefined
  usingCoords: boolean
}) {
  const { pins, citySlug, date, hour, usingCoords } = props
  const { activeId, setActiveId } = useCardHover()
  const { setParam, setCity, setCoords } = useFilterParams()

  const useMyLocation = () => {
    navigator.geolocation.getCurrentPosition(
      (position) => setCoords(position.coords.latitude, position.coords.longitude),
      // Permission denied is a no-op: the city picker stays in charge and the
      // page never depends on geolocation.
      () => {},
    )
  }

  return (
    <section className="relative h-[460px] overflow-hidden max-[980px]:flex max-[980px]:h-auto max-[980px]:flex-col max-[980px]:overflow-visible">
      {/* `z-0` makes this a stacking context, which contains Leaflet's own
          panes (z-index 400/650) so they can't paint over the float or the
          sticky nav. The mockup instead gives `.search-float` z-index 950 —
          deliberately not copied: that number also beats the nav (z-60) and
          would let the card slide over it on scroll. */}
      <div className="absolute inset-0 z-0 max-[980px]:relative max-[980px]:h-[320px]">
        <SearchMap pins={pins} activeId={activeId} onActiveChange={setActiveId} />
      </div>

      <p
        className={`font-mono absolute top-4 z-10 w-fit rounded-full bg-[var(--panel)] px-3.5 py-2 text-[12.5px] text-[var(--ink-soft)] shadow-[var(--shadow-sm)] max-[980px]:static max-[980px]:mt-3 ${COLUMN_LEFT}`}
      >
        {formatDateLabel(date)} · {hour === undefined ? 'Any time' : formatHour(hour)}
      </p>

      <div
        className={`absolute bottom-6 z-10 flex items-stretch gap-1 rounded-[20px] bg-[var(--panel)] p-4 shadow-[var(--shadow-lg)] max-[980px]:static max-[980px]:mt-4 max-[980px]:flex-wrap max-[980px]:gap-y-2.5 max-[980px]:shadow-[var(--shadow-sm)] ${COLUMN_LEFT}`}
      >
        <div className={fieldClass}>
          <label className={labelClass} htmlFor="search-city">
            Where
          </label>
          <select
            id="search-city"
            value={usingCoords ? '' : citySlug}
            onChange={(e) => setCity(e.target.value)}
            className={valueClass}
          >
            {/* Only rendered while geolocation coords are the active filter
                point, so the dropdown doesn't falsely imply a city is
                selected — picking a real city below still works normally and
                clears lat/lng via `setCity`. */}
            {usingCoords && <option value="">Near me</option>}
            {CITIES.map((city) => (
              <option key={city.slug} value={city.slug}>
                {city.name}
              </option>
            ))}
          </select>
        </div>

        <div className={`${fieldClass} ${dividerClass}`}>
          <label className={labelClass} htmlFor="search-date">
            Date
          </label>
          <input
            id="search-date"
            type="date"
            value={date}
            min={manilaToday()}
            onChange={(e) => setParam('date', e.target.value)}
            className={valueClass}
          />
        </div>

        <div className={`${fieldClass} ${dividerClass}`}>
          <label className={labelClass} htmlFor="search-hour">
            Time
          </label>
          <select
            id="search-hour"
            value={hour ?? ''}
            onChange={(e) => setParam('hour', e.target.value)}
            className={valueClass}
          >
            <option value="">Any time</option>
            {HOUR_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {formatHour(h)}
              </option>
            ))}
          </select>
        </div>

        {/* The mockup's lime "Update search" button sits here. There's nothing
            to submit: every control above writes straight to the URL, so this
            slot carries the one action that isn't a filter. Light bordered,
            not lime — branding.md keeps lime for a view's primary action, and
            "use my location" isn't this page's primary action. */}
        <button
          type="button"
          onClick={useMyLocation}
          className="ml-2 inline-flex h-[var(--control-h)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-5 text-[13.5px] font-semibold whitespace-nowrap text-[var(--ink)] transition-colors hover:border-[var(--court)] motion-reduce:transition-none max-[980px]:ml-0 max-[980px]:basis-full max-[980px]:justify-center"
        >
          Use my location
        </button>
      </div>
    </section>
  )
}
