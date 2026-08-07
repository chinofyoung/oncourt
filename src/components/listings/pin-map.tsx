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
 * A single DRAGGABLE pin, for the branch form.
 *
 * Deliberately not a reuse of BranchMap (src/components/branch/branch-map.tsx):
 * that one is read-only, has no drag handler, and never moves after mount.
 * This one has to follow a geocode result AND report the owner's drag back
 * up. What the two do share — the CARTO duotone tile layer and its filter —
 * comes from map-base, as it does for SearchMap, rather than being copied a
 * third time.
 *
 * `hasPin` only changes how the marker looks: an unset pin renders hollow so
 * "the map is showing my city" cannot be mistaken for "my venue is here".
 * Dragging it is what sets it, which is why the marker exists either way.
 */
const ZOOM = 16

export function PinMap({
  lat,
  lng,
  hasPin,
  onMove,
}: {
  lat: number
  lng: number
  hasPin: boolean
  onMove: (lat: number, lng: number) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)
  // The drag handler is registered once, at mount, but must always call the
  // CURRENT onMove — a stale closure would report the drag to a dead setter.
  // Assigned inside an effect (not during render) per react-hooks/refs: the
  // effect below runs after every render, well before a user's first drag.
  const onMoveRef = useRef(onMove)
  useEffect(() => {
    onMoveRef.current = onMove
  })

  useEffect(() => {
    if (!containerRef.current) return
    const map = L.map(containerRef.current, { zoomControl: true, scrollWheelZoom: false })
    addDuotoneTileLayer(map, L)
    // The container can still be mid-layout when next/dynamic swaps this in,
    // leaving Leaflet's cached size wrong — same reasoning as branch-map.tsx.
    map.invalidateSize()
    map.setView([lat, lng], ZOOM)

    const marker = L.marker([lat, lng], {
      draggable: true,
      icon: L.divIcon({ className: 'pin-editor-icon', html: '<span class="pin-editor"></span>' }),
    }).addTo(map)
    marker.on('dragend', () => {
      const position = marker.getLatLng()
      onMoveRef.current(position.lat, position.lng)
    })

    mapRef.current = map
    markerRef.current = marker

    // React 19 StrictMode double-invokes effects in dev, so this cleanup is
    // load-bearing: without it the second mount throws "Map container is
    // already initialized."
    return () => {
      map.remove()
      mapRef.current = null
      markerRef.current = null
    }
    // Created once; the effect below follows later lat/lng changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follows a geocode result (or a re-render after a drag) without tearing
  // the map down and rebuilding it.
  useEffect(() => {
    if (!mapRef.current || !markerRef.current) return
    markerRef.current.setLatLng([lat, lng])
    mapRef.current.setView([lat, lng], mapRef.current.getZoom())
  }, [lat, lng])

  return (
    <>
      <DuotoneFilterDefs />
      <style>{`
        ${MAP_DUOTONE_STYLE}
        .oncourt-pin-map .pin-editor-icon { background: transparent; border: none; }
        .oncourt-pin-map .pin-editor {
          display: block;
          width: 18px; height: 18px;
          border-radius: 50% 50% 50% 0;
          transform: rotate(-45deg);
          background: ${hasPin ? 'var(--court-deep)' : 'transparent'};
          border: 2px solid ${hasPin ? 'white' : 'var(--court-deep)'};
          box-shadow: 0 2px 6px rgba(14, 42, 31, .35);
          cursor: grab;
        }
      `}</style>
      <div
        ref={containerRef}
        role="region"
        aria-label="Drag the marker to your venue's location"
        className={`${MAP_SCOPE_CLASS} oncourt-pin-map h-[var(--pin-map-h,_240px)] w-full overflow-hidden rounded-[10px]`}
      />
    </>
  )
}
