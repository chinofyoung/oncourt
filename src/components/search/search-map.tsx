'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { formatPeso } from '@/lib/format'
import {
  addDuotoneTileLayer,
  DuotoneFilterDefs,
  MAP_DUOTONE_STYLE,
  MAP_SCOPE_CLASS,
} from '@/components/map/map-base'

/**
 * design/branding.md, "Maps". The CARTO tile layer, the duotone filter, and
 * the CSS rule that applies it now live in `src/components/map/map-base.tsx`
 * — the single shared definition for every Leaflet map in this codebase (see
 * that file's header comment for the full rationale and the exact
 * transcribed values). This file only contains what's genuinely specific to
 * a multi-pin, hover/click-to-navigate results map: per-pin price markers,
 * `activeId` hover sync, click-to-navigate, and `fitBounds`.
 */
export type MapPin = {
  id: string
  name: string
  slug: string
  lat: number
  lng: number
  priceCentavos: number
}

/** Metro Manila — used only as a pre-pins default view so the map is never blank. */
const DEFAULT_CENTER: L.LatLngTuple = [14.6, 121.0]
const DEFAULT_ZOOM = 12

/**
 * Minimal HTML-escape for the strings we interpolate into `L.divIcon`'s
 * `html:` (which Leaflet injects via innerHTML). Today `pin.id` (a Postgres
 * `uuid`) and `formatPeso(...)`'s output (digits/currency symbol only) never
 * contain any of these characters — but escaping is applied unconditionally
 * so this call site stays safe if it's ever extended to interpolate a
 * free-text field (e.g. `pin.name`, which is owner-supplied).
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Toggle the `.active` class on the marker matching `id` (clearing every
 * other marker). Shared by the pins-rebuild effect and the activeId effect
 * so a pins rebuild always re-applies the current hover state instead of
 * dropping it — see the task-10 fix-round report for the desync bug this
 * fixes.
 */
function syncActiveClass(markers: Map<string, L.Marker>, id: string | null) {
  for (const [markerId, marker] of markers) {
    const el = marker.getElement()?.querySelector('.price-pin')
    if (!el) continue
    el.classList.toggle('active', markerId === id)
  }
}

export function SearchMap(props: {
  pins: MapPin[]
  activeId: string | null
  onActiveChange: (id: string | null) => void
}) {
  const { pins, activeId, onActiveChange } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markersRef = useRef<Map<string, L.Marker>>(new Map())
  const layerGroupRef = useRef<L.LayerGroup | null>(null)
  const router = useRouter()

  // Create the map exactly once. React 19 StrictMode double-invokes effects
  // in dev, so the cleanup below (map.remove()) is load-bearing — without it
  // the second mount throws "Map container is already initialized."
  useEffect(() => {
    if (!containerRef.current) return
    const map = L.map(containerRef.current, { zoomControl: false, scrollWheelZoom: false }).setView(
      DEFAULT_CENTER,
      DEFAULT_ZOOM,
    )
    addDuotoneTileLayer(map, L)
    mapRef.current = map

    // Same mid-layout risk the pins-effect guards against below (see its
    // comment): this component is swapped in by `next/dynamic({ssr:false})`
    // for a loading fallback, so the container can still be mid-layout the
    // instant `L.map()`/`setView()` run, leaving Leaflet's cached size wrong
    // for the initial view too. A synchronous call here is cheap, correct
    // defensive insurance — tested live (see the task-10 fix-round report):
    // removing it entirely produced no observable difference in this
    // codebase today, because the pins-effect below always runs in the same
    // initial-mount commit, right after this one, and unconditionally
    // re-measures before the browser paints. No `requestAnimationFrame`
    // fallback is used — it added no measurable benefit in testing and
    // would only delay a correction that already happens synchronously.
    map.invalidateSize()

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Rebuild the marker layer whenever the pin set changes. Deliberately not
  // keyed on activeId — hover must never trigger a rebuild. `onActiveChange`
  // and `router` are also safe to omit: `onActiveChange` is the `setActiveId`
  // setter passed down from the parent's `useState`, and `router` comes from
  // `useRouter()` — both are referentially stable across renders (React
  // guarantees `useState` setters never change identity, and Next.js App
  // Router's `useRouter()` returns the same object on every render), so
  // omitting them from the deps array changes nothing about correctness.
  // `activeId` IS read in this effect's body below (via `syncActiveClass`)
  // so that a pins rebuild re-applies whichever marker is currently active
  // instead of silently dropping the `.active` class — see the desync bug
  // this fixes in the task-10 fix-round report. It is deliberately still
  // NOT in the deps array: this effect must only rebuild markers on
  // `[pins]`, never on a hover change.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    // Call unconditionally (not just when `pins.length > 0`) so the
    // zero-pins path also gets a correctly measured container. This map is
    // mounted by `next/dynamic` with a loading fallback swapped in, so the
    // container can still be mid-layout the instant this effect runs.
    // Leaflet caches the container size at the point you call it, and
    // `fitBounds`'s zoom-level math (below) uses that cached size — if it
    // read a zero/stale size, it computes the wrong (often max) zoom with
    // the markers scattered far off screen. `invalidateSize()` forces
    // Leaflet to re-measure the real, laid-out container size first.
    map.invalidateSize()

    if (layerGroupRef.current) {
      layerGroupRef.current.remove()
      layerGroupRef.current = null
    }
    markersRef.current.clear()

    const group = L.layerGroup()
    for (const pin of pins) {
      const icon = L.divIcon({
        className: 'price-pin-icon',
        html: `<span class="price-pin" data-pin-id="${escapeHtml(pin.id)}">${escapeHtml(formatPeso(pin.priceCentavos))}</span>`,
        iconSize: undefined,
      })
      const marker = L.marker([pin.lat, pin.lng], { icon })
      marker.on('mouseover', () => onActiveChange(pin.id))
      marker.on('mouseout', () => onActiveChange(null))
      marker.on('click', () => router.push(`/venues/${pin.slug}`))
      marker.addTo(group)
      markersRef.current.set(pin.id, marker)
    }
    group.addTo(map)
    layerGroupRef.current = group

    // Re-apply whichever marker is currently active — see the effect
    // comment above for why this is required here.
    syncActiveClass(markersRef.current, activeId)

    // Leaflet throws on empty bounds — only fit when there's something to fit.
    if (pins.length > 0) {
      map.fitBounds(
        L.latLngBounds(pins.map((p) => [p.lat, p.lng] as L.LatLngTuple)),
        { padding: [56, 56] },
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins])

  // Toggle only the `.active` class on the relevant marker DOM elements —
  // never rebuild the marker layer here.
  useEffect(() => {
    syncActiveClass(markersRef.current, activeId)
  }, [activeId])

  return (
    <>
      <DuotoneFilterDefs />

      <style>{`
        ${MAP_DUOTONE_STYLE}
        .oncourt-search-map .price-pin-icon { background: transparent; border: none; }
        .oncourt-search-map .price-pin {
          display: inline-flex; align-items: center; white-space: nowrap;
          background: var(--panel); color: var(--ink);
          font-family: var(--mono); font-size: 12px;
          padding: 6px 12px; border-radius: 999px; box-shadow: var(--shadow-sm);
          border: 1.5px solid transparent;
          transition: background .15s, border-color .15s, color .15s;
        }
        .oncourt-search-map .price-pin.active { background: var(--ball); color: var(--ball-ink); border-color: var(--ink); }
      `}</style>

      <div
        ref={containerRef}
        role="region"
        aria-label="Map of court venues"
        // Radius/overflow belong to whatever mounts this: the search page's
        // map-hero band is full-bleed and square-cornered.
        className={`${MAP_SCOPE_CLASS} oncourt-search-map h-full w-full`}
      />
    </>
  )
}
