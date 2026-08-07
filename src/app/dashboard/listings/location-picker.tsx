'use client'

import { useState, useTransition } from 'react'
import { geocodeAddressAction } from './actions'
import { BORDERED_BUTTON, LABEL } from './form-ui'
import { PinMap } from '@/components/listings/pin-map-dynamic'
import { cityCenterByName } from '@/lib/geo/cities'

/**
 * Address + draggable pin, exactly as the spec rules it: geocode what was
 * typed, then let the owner fine-tune by dragging.
 *
 * The pin's value reaches the server through two HIDDEN inputs named `lat`
 * and `lng` — the same field names the plain number inputs used before this
 * component existed, which is why parseBranchFields needed no change.
 *
 * geocodeAddressAction is called IMPERATIVELY inside a transition rather than
 * through a nested form: this component lives inside the branch form, and
 * HTML forbids a form inside a form. A `formAction` button would submit the
 * branch instead.
 *
 * Failure is never blocking. A null result sets a message and leaves the map
 * exactly where it was, because dragging always works.
 */
export function LocationPicker({
  idPrefix,
  address,
  city,
  lat,
  lng,
}: {
  idPrefix: string
  address: string
  city: string
  lat: number | null
  lng: number | null
}) {
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(
    lat !== null && lng !== null ? { lat, lng } : null,
  )
  const [message, setMessage] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // With no pin, the map opens on the typed city — a starting view, not a
  // claim. An unrecognized city falls back to Metro Manila.
  const fallback = cityCenterByName(city)
  const center = pin ?? { lat: fallback.lat, lng: fallback.lng }

  function findOnMap() {
    const query = [address, city, 'Philippines'].filter((part) => part.trim().length > 0).join(', ')
    startTransition(async () => {
      const result = await geocodeAddressAction(query)
      if (!result) {
        setMessage("We couldn't find that address. Drag the pin to place it yourself.")
        return
      }
      setPin(result)
      setMessage('Found it — drag the pin if it is not exactly right.')
    })
  }

  return (
    // --pin-map-h is the single source of truth for PinMap's height (read via
    // h-[var(--pin-map-h,_240px)] in pin-map.tsx and pin-map-dynamic.tsx, so
    // the live map and its loading skeleton can never drift apart). Tall here
    // because BranchFieldset gives this fieldset a whole sticky column to
    // fill; short again once max-[980px] collapses that column back under
    // the fields, matching branding.md's stack breakpoint.
    <fieldset className="flex flex-col gap-2 [--pin-map-h:520px] max-[980px]:[--pin-map-h:240px]">
      <legend className={LABEL}>Map location</legend>

      <input type="hidden" name="lat" value={pin === null ? '' : String(pin.lat)} />
      <input type="hidden" name="lng" value={pin === null ? '' : String(pin.lng)} />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={findOnMap}
          disabled={pending || address.trim().length === 0}
          className={BORDERED_BUTTON}
          id={`${idPrefix}-geocode`}
        >
          {pending ? 'Searching…' : 'Find on map'}
        </button>
        {pin !== null && (
          <>
            <span className="font-mono text-[11.5px] text-[var(--ink-soft)]">
              {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
            </span>
            <button
              type="button"
              onClick={() => {
                setPin(null)
                setMessage(null)
              }}
              className={BORDERED_BUTTON}
            >
              Clear pin
            </button>
          </>
        )}
      </div>

      <PinMap
        lat={center.lat}
        lng={center.lng}
        hasPin={pin !== null}
        onMove={(nextLat, nextLng) => {
          setPin({ lat: nextLat, lng: nextLng })
          setMessage(null)
        }}
      />

      <p role="status" className="text-[11.5px] text-[var(--ink-soft)]">
        {message ??
          (pin === null
            ? 'No pin set yet — drag the marker onto your venue, or use Find on map. A branch with no pin will not appear in map or distance searches.'
            : 'Drag the marker to fine-tune the exact spot.')}
      </p>
    </fieldset>
  )
}
