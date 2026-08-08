'use client'

import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { CITIES } from '@/lib/geo/cities'
import { manilaToday } from '@/lib/date-manila'
import { formatDateLabel, formatHour, formatHourRange } from '@/lib/format'
import { HOUR_OPTIONS, UNTIL_PARAM, endHourOptions } from '@/lib/search/hours'
import { useCardHover } from './hover-context'
import { useFilterParams } from './filter-controls'
import type { MapPin } from './search-map'

/**
 * search-results.html's `.map-hero`: a full-bleed 460px map band under the
 * solid nav, with the search fields floating full-width over it — spanning
 * the 1120px content column from its left inset to its right inset, matching
 * the home hero's search bar — and a filter-summary pill still anchored at
 * the band's top-left corner.
 *
 * The map is dynamically imported with `ssr: false` because Leaflet touches
 * `window` at module scope and would crash the server render. The loading
 * fallback keeps the band from collapsing before the map mounts.
 */
const SearchMap = dynamic(() => import('./search-map').then((m) => m.SearchMap), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-[var(--band-off)]" />,
})

/**
 * The 1120px content column's insets — branding.md, Layout. Both floating
 * overlays align to them so they line up with the results below; once they go
 * static at ≤980px the same value becomes their horizontal margin, since the
 * hero band itself stays full-bleed.
 *
 * Both `left` AND `right` are set, which is what makes the float span the full
 * column instead of shrinking to its content. Above a 1168px viewport the two
 * insets leave exactly 1120px between them; below it both clamp to 24px.
 *
 * The `max-[980px]:static` on the consumers is what keeps the `mx-` margin
 * working: a static element ignores `left`/`right` entirely, so the absolute
 * insets and the static margin cannot fight.
 */
const COLUMN_INSET =
  'left-[max(24px,calc((100vw-1120px)/2))] right-[max(24px,calc((100vw-1120px)/2))] max-[980px]:mx-[max(24px,calc((100vw-1120px)/2))]'

// `min-w-0` on the field and the control is load-bearing, not decoration:
// `truncate` sets `white-space: nowrap`, which raises the control's
// min-content width to its full text width and would otherwise refuse to
// shrink — at 480px that pushed the whole float past the viewport and made
// the page scroll sideways, which branding.md's Layout section forbids.
//
// `flex-none` / `max-[980px]:flex-auto` were dropped when the float became a
// grid: both are flex-item concepts and are inert in a grid container. The
// per-cell responsive spans live at the call sites instead, matching the home
// hero. The hover wash is the panel-skin counterpart of the hero's
// `hover:bg-white/[.07]` — `--surface` on `--panel` is the same barely-there
// shift on white that white/.07 is on glass.
const fieldClass =
  'flex h-[var(--control-h)] min-w-0 flex-col justify-center rounded-[var(--btn-radius)] px-4 transition-colors hover:bg-[var(--surface)] motion-reduce:transition-none'
// `max-[980px]:border-l-0`, not `max-[560px]`: at ≤980px the grid drops to two
// columns, so Date becomes the first cell in its row and a left border there
// would draw a line against nothing. Matches the home hero exactly.
const dividerClass = 'border-l border-[var(--hairline)] max-[980px]:border-l-0'
const labelClass = 'font-mono text-[10px] tracking-[.14em] text-[var(--ink-soft)] uppercase'
/** The label row: the label itself, plus (Where only) the location link. */
const labelRowClass = 'mb-[3px] flex items-center gap-2'
// No `outline-none`/`outline-hidden` here: both set `--tw-outline-style:
// none` unconditionally, and since that custom property's cascaded value is
// shared by every rule reading it on the element, it wins over
// `focus-visible:outline-2`'s `outline-style: var(--tw-outline-style)` even
// while focus-visible is active — confirmed via getComputedStyle, which kept
// reporting `outlineStyle: "none"` despite the right color/width/offset.
// Leaving no outline utility for the unfocused state works instead:
// `outline-style`'s own initial value is `none`, so nothing shows until
// focus-visible supplies one, free to resolve `--tw-outline-style` to its
// `solid` preflight default at that point.
const valueBase =
  'min-w-0 truncate bg-transparent text-[15.5px] font-semibold text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--court)]'
// No `max-w` cap: it held the Where/Date controls to 220px from when this
// float was a 711px shrink-to-fit flex row. Widening the float to the full
// 1120px column (branding.md, Time-range field entry) surfaced it — at
// 1309px the home hero's city select renders 312px wide while this one
// stayed capped at 220px, so the chevron sat 104px inboard on the float and
// flush on the hero in the very component that's supposed to read as one.
// Nothing depends on the cap: `rangeSelectClass` below deliberately does not
// build on `valueClass` (see its own comment), so removing it here doesn't
// touch the Time field. Don't reinstate it.
const valueClass = `w-full ${valueBase}`
/**
 * One half of the Time field. `flex-1 min-w-0` instead of `valueClass`'s
 * `w-full`: the two selects share the cell, and without `min-w-0` the
 * `truncate` on each would refuse to shrink and push the float past the
 * viewport — the same trap documented above the field classes.
 */
const rangeSelectClass = `flex-1 disabled:text-[var(--ink-soft)] ${valueBase}`

export function MapHero(props: {
  pins: MapPin[]
  citySlug: string
  date: string
  hour: number | undefined
  until: number | undefined
  usingCoords: boolean
}) {
  const { pins, citySlug, date, hour, until, usingCoords } = props
  const { activeId, setActiveId } = useCardHover()
  const { setParam, setParams, setCity, setCoords } = useFilterParams()
  const router = useRouter()

  const useMyLocation = () => {
    navigator.geolocation.getCurrentPosition(
      (position) => setCoords(position.coords.latitude, position.coords.longitude),
      // Permission denied is a no-op: the city picker stays in charge and the
      // page never depends on geolocation.
      () => {},
    )
  }

  /**
   * Moving the start forward past the current end would leave a backwards
   * span in the URL. `parseSearchParams` would drop it server-side, so the
   * results stay correct either way — but the URL is this page's shareable
   * state, and a link carrying `?hour=20&until=9` is a lie about what the
   * recipient will see. Both params therefore move in ONE write; clearing
   * the start clears the end with it, since an end with no start means
   * nothing.
   */
  const setStartHour = (value: string) => {
    if (value === '') {
      setParams({ hour: null, [UNTIL_PARAM]: null })
      return
    }
    const next = Number(value)
    const staleEnd = until !== undefined && until <= next
    setParams({ hour: value, ...(staleEnd ? { [UNTIL_PARAM]: null } : {}) })
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
        className={`font-mono absolute top-4 z-10 w-fit rounded-full bg-[var(--panel)] px-3.5 py-2 text-[12.5px] text-[var(--ink-soft)] shadow-[var(--shadow-sm)] max-[980px]:static max-[980px]:mt-3 ${COLUMN_INSET}`}
      >
        {/* `formatHourRange` (src/lib/format.ts) already renders branding.md's
            `7 – 9 AM` / `11 AM – 1 PM` convention, including collapsing a
            shared AM/PM. No second formatter here. */}
        {formatDateLabel(date)} ·{' '}
        {hour === undefined
          ? 'Any time'
          : until === undefined
            ? formatHour(hour)
            : formatHourRange(hour, until)}
      </p>

      <div
        className={`absolute bottom-6 z-10 grid grid-cols-[1.25fr_1fr_1fr_auto] items-center gap-2 rounded-[20px] bg-[var(--panel)] p-2 shadow-[var(--shadow-lg)] max-[980px]:static max-[980px]:mt-4 max-[980px]:grid-cols-2 max-[980px]:gap-1.5 max-[980px]:shadow-[var(--shadow-sm)] ${COLUMN_INSET}`}
      >
        <div className={`${fieldClass} max-[980px]:col-span-2`}>
          <div className={labelRowClass}>
            <label className={labelClass} htmlFor="search-city">
              Where
            </label>
            {/* Demoted from the button slot at the end of the float, which now
                carries this page's actual submit. Geolocation is a shortcut
                for filling in Where, so it sits with Where; as a text link it
                also stops competing with the lime Find a Court button for
                attention. Same handler, same silent no-op when permission is
                denied. */}
            <button
              type="button"
              onClick={useMyLocation}
              className="text-[10.5px] font-semibold text-[var(--court)] transition-colors hover:text-[var(--court-deep)] hover:underline motion-reduce:transition-none"
            >
              Use my location
            </button>
          </div>
          <select
            id="search-city"
            value={usingCoords ? '' : citySlug}
            onChange={(e) => setCity(e.target.value)}
            className={`select-chevron-dark ${valueClass}`}
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

        <div className={`${fieldClass} ${dividerClass} max-[560px]:col-span-2`}>
          <div className={labelRowClass}>
            <label className={labelClass} htmlFor="search-date">
              Date
            </label>
          </div>
          <input
            id="search-date"
            type="date"
            value={date}
            min={manilaToday()}
            onChange={(e) => setParam('date', e.target.value)}
            className={`${valueClass} [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100`}
          />
        </div>

        {/* One Time field, two selects, spaced EN DASH — branding.md's
            `7 – 9 AM` convention. The dash is decorative (`aria-hidden`); each
            select carries its own accessible name so a screen-reader user
            isn't handed two controls both called "Time". Unlike the home
            hero's GET form, this one is a client component, so the end list
            narrows to hours after the chosen start and goes inert when there
            is no start to be after. */}
        <div className={`${fieldClass} ${dividerClass} max-[560px]:col-span-2`}>
          <div className={labelRowClass}>
            <label className={labelClass} htmlFor="search-hour">
              Time
            </label>
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            <select
              id="search-hour"
              aria-label="Time from"
              value={hour ?? ''}
              onChange={(e) => setStartHour(e.target.value)}
              className={`select-chevron-dark ${rangeSelectClass}`}
            >
              <option value="">Any time</option>
              {HOUR_OPTIONS.map((h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
            <span aria-hidden className="text-[15.5px] text-[var(--ink-soft)]">
              &ndash;
            </span>
            <select
              id="search-until"
              aria-label="Time until"
              value={until ?? ''}
              disabled={hour === undefined}
              onChange={(e) => setParam(UNTIL_PARAM, e.target.value)}
              className={`select-chevron-dark ${rangeSelectClass}`}
            >
              <option value="">&mdash;</option>
              {endHourOptions(hour).map((h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* The mockup's lime "Update search" button, restored. Every field
            above still applies live on change, so this doesn't submit
            anything the URL doesn't already say — it re-runs the current
            query, which is the honest meaning of "Find a Court" on a page
            whose filters live in the URL: availability moves with the clock,
            so the same URL can return a different answer a minute later.
            `router.refresh()` re-fetches the server render rather than
            replaying a cached one. It is this page's only lime button (the
            filter chips and sort are neutral), so branding.md's "never two
            lime buttons in one view" holds. */}
        <button
          type="button"
          onClick={() => router.refresh()}
          className="font-display ml-2 inline-flex h-[var(--control-h)] items-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-[30px] text-[15.5px] font-bold tracking-[-0.01em] whitespace-nowrap text-[var(--ball-ink)] transition-[filter,transform] duration-150 hover:brightness-[1.06] active:scale-[.98] motion-reduce:transition-none max-[980px]:col-span-2 max-[980px]:ml-0 max-[980px]:justify-center"
        >
          Find a Court
        </button>
      </div>
    </section>
  )
}
