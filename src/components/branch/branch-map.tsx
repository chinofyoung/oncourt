'use client'

import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  addDuotoneTileLayer,
  DuotoneFilterDefs,
  MAP_DUOTONE_STYLE,
  MAP_SCOPE_CLASS,
} from '@/components/map/map-base'

/**
 * Single-pin, read-only map for a branch's location, rendered beside the
 * venue identity/About column on `src/app/venues/[slug]/page.tsx` (there is
 * no standalone "Where to find us" card anymore — that section's card chrome
 * was dropped when the identity column and this map became one plain band;
 * see that file's header comment). Uses the same CARTO duotone tile layer
 * and filter as `SearchMap` — both import them from
 * `src/components/map/map-base.tsx` rather than each defining their own
 * copy (see that file's header comment for why).
 *
 * Deliberately NOT a reuse of `SearchMap`/`MapPin`: this map is read-only —
 * no hover state, no `activeId`, no click-to-navigate, no per-pin
 * `priceCentavos`, no `fitBounds` (a single point is centered directly with
 * `setView`, not fit to bounds).
 *
 * Always mounted with real, non-null lat/lng — the caller in page.tsx only
 * renders this when `detail.lat`/`detail.lng` are both non-null, falling
 * back to the flat `--band-off` "Map location not available yet." block
 * otherwise. So there's no "default center" fallback here, unlike
 * `SearchMap`'s pre-pins Metro Manila default.
 *
 * The container is `h-full w-full`, not a fixed pixel height — this makes
 * the component depend on its caller providing a definite height. page.tsx
 * wraps this in a `h-full max-[980px]:aspect-square` div, which is itself
 * the sole child of a CSS Grid item ("Location") that carries no height/
 * aspect-ratio utility of its own:
 *
 * - At `>=980px`, "Location" sits beside the identity/About column in a
 *   two-column grid row, so the grid's default `align-items: stretch`
 *   gives it the row's full height — matching whatever the sibling column
 *   needs — and the wrapper's `h-full` resolves against THAT, passing it
 *   down to this component's own `h-full w-full`.
 * - Below `980px` the columns stack, so "Location" is alone in its own
 *   auto-sized grid row with no sibling to stretch against; `h-full` on
 *   the wrapper resolves to `auto` there (nothing definite to be a
 *   percentage of), so `max-[980px]:aspect-square` takes over instead,
 *   deriving a height from the wrapper's own definite width.
 *
 * This used to be an unconditional `aspect-square` wrapper (making the map
 * literally square at every width), until the `>=980px` behavior was
 * dropped by explicit user instruction: a box with a preferred aspect
 * ratio does not receive Grid's stretch alignment in Chrome, so the square
 * held at a fixed size even when the sibling column grew taller, leaving
 * dead space. Dropping `aspect-square` everywhere (not just `>=980px`) was
 * tried first and broke the `<980px` stacked case — "Location" has no row
 * to stretch against there, so the map collapsed to 0px height with
 * nothing else giving it a size. Scoping `aspect-square` to
 * `max-[980px]:` restores the original mobile square while still letting
 * `>=980px` stretch to match. A caller providing neither a stretched grid
 * row nor an aspect ratio would give Leaflet a 0px-tall container either
 * way. `map.invalidateSize()` below (already called for the next/dynamic
 * loading-fallback-swap reason noted there) doubles as what makes Leaflet
 * re-measure and fill whatever height the container resolves to.
 */
const ZOOM = 15

export function BranchMap({ lat, lng, name }: { lat: number; lng: number; name: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)

  // Create the map exactly once. React 19 StrictMode double-invokes effects
  // in dev, so the cleanup below (map.remove()) is load-bearing — without
  // it the second mount throws "Map container is already initialized." Same
  // reasoning as the identical comment in search-map.tsx.
  useEffect(() => {
    if (!containerRef.current) return
    const map = L.map(containerRef.current, { zoomControl: false, scrollWheelZoom: false })
    addDuotoneTileLayer(map, L)

    // This component is swapped in by `next/dynamic({ssr:false})` for a
    // loading fallback, so the container can still be mid-layout the
    // instant `L.map()` runs here, leaving Leaflet's cached size wrong.
    // `invalidateSize()` before `setView` forces a re-measure first — same
    // reasoning as search-map.tsx's identical call.
    map.invalidateSize()
    map.setView([lat, lng], ZOOM)

    const icon = L.divIcon({
      className: 'branch-pin-icon',
      html: '<span class="branch-pin"></span>',
      iconSize: undefined,
    })
    L.marker([lat, lng], { icon }).addTo(map)

    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
    // Deliberately `[]`: this map is created once for the lat/lng/name it's
    // first mounted with. Unlike SearchMap's pin set, a branch page's
    // coordinates don't change without a full page navigation (a new
    // `slug`), which remounts this component fresh anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <DuotoneFilterDefs />

      <style>{`
        ${MAP_DUOTONE_STYLE}
        .oncourt-branch-map .branch-pin-icon { background: transparent; border: none; }
        .oncourt-branch-map .branch-pin {
          display: block;
          width: 14px; height: 14px;
          border-radius: 50% 50% 50% 0;
          transform: rotate(-45deg);
          background: var(--court-deep);
          border: 2px solid white;
          box-shadow: 0 2px 6px rgba(14, 42, 31, .35);
        }
      `}</style>

      <div
        ref={containerRef}
        role="region"
        aria-label={`Map showing ${name}'s location`}
        className={`${MAP_SCOPE_CLASS} oncourt-branch-map h-full w-full overflow-hidden rounded-[10px]`}
      />
    </>
  )
}
