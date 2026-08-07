'use client'

import { useState } from 'react'
import { AMENITY_LABELS, AMENITY_SLUGS } from '@/components/ui/amenity-chip'
import {
  MAX_ADDRESS,
  MAX_BRANCH_NAME,
  MAX_CITY,
  MAX_DESCRIPTION,
  MAX_EMAIL,
  MAX_PHONE,
} from '@/lib/listings/fields'
import { CHECKBOX, CHECK_LABEL, FIELD, LABEL, TEXTAREA } from './form-ui'
import { LocationPicker } from './location-picker'

/**
 * Every editable branch field, shared by the add form and the edit form.
 *
 * One component rather than two near-identical blocks: the two forms differ
 * only in their action, their button, and whether `defaults` is supplied.
 * Splitting them would guarantee that a field added to one gets forgotten in
 * the other — and `parseBranchFields` reads by NAME, so a forgotten field is
 * silently cleared on save, not merely missing from the form.
 *
 * `maxLength` mirrors the limits in src/lib/listings/fields.ts so the browser
 * stops the user before the server has to. The server check remains the real
 * one; this is only courtesy.
 *
 * The amenity checkboxes are ALL rendered, always. An unchecked HTML checkbox
 * submits nothing, so the submitted set IS the new set — a partial form would
 * silently drop the amenities it omitted, exactly as the staff permission
 * checkboxes document.
 */
export type BranchDefaults = {
  name?: string
  description?: string | null
  address?: string
  city?: string
  contactPhone?: string | null
  contactEmail?: string | null
  amenities?: string[]
  lat?: number | null
  lng?: number | null
}

export function BranchFieldset({
  idPrefix,
  defaults,
}: {
  idPrefix: string
  defaults?: BranchDefaults
}) {
  const amenities = defaults?.amenities ?? []

  // Controlled ONLY for these two: LocationPicker needs their live values to
  // build its query, and reading them back out of the DOM by id would be a
  // second source of truth for the same field.
  const [address, setAddress] = useState(defaults?.address ?? '')
  const [city, setCity] = useState(defaults?.city ?? '')

  return (
    // Two columns above 980px: fields on the left, the map on its own sticky
    // column on the right so pinning a location doesn't require scrolling
    // away from the map. The dashboard content column is fluid (no max-width
    // — see new/page.tsx and [branchId]/page.tsx, both full-width), so an
    // fr/fr split would let the map balloon to hundreds of extra pixels on a
    // wide monitor for no benefit. Instead the right column is capped
    // (`minmax(360px,480px)`) and the left column absorbs whatever width is
    // left — the fields get the room to breathe, the map stays a comfortably
    // large square-ish target for pinning without growing pointlessly.
    // `items-start` plus the right column's own `self-start` keep that
    // column sized to its content rather than stretched to the (taller) left
    // column's height, which is what lets `sticky` actually have room to
    // move as the page scrolls. Below 980px (branding.md's stack breakpoint)
    // it collapses to one column with the map back in normal flow —
    // LocationPicker itself drops the map back to a short height at that
    // width via --pin-map-h.
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(360px,480px)] items-start gap-8 max-[980px]:grid-cols-1 max-[980px]:gap-4">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
          <div>
            <label className={LABEL} htmlFor={`${idPrefix}-name`}>
              Branch name
            </label>
            <input
              id={`${idPrefix}-name`}
              name="name"
              required
              maxLength={MAX_BRANCH_NAME}
              defaultValue={defaults?.name ?? ''}
              placeholder="Smash Zone Marikina"
              className={FIELD}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor={`${idPrefix}-city`}>
              City
            </label>
            <input
              id={`${idPrefix}-city`}
              name="city"
              required
              maxLength={MAX_CITY}
              value={city}
              onChange={(event) => setCity(event.target.value)}
              placeholder="Marikina"
              className={FIELD}
            />
          </div>
        </div>

        <div>
          <label className={LABEL} htmlFor={`${idPrefix}-address`}>
            Street address
          </label>
          <input
            id={`${idPrefix}-address`}
            name="address"
            required
            maxLength={MAX_ADDRESS}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="12 Shoe Ave, Barangay Sto. Niño"
            className={FIELD}
          />
        </div>

        <div>
          <label className={LABEL} htmlFor={`${idPrefix}-description`}>
            Description
          </label>
          <textarea
            id={`${idPrefix}-description`}
            name="description"
            rows={3}
            maxLength={MAX_DESCRIPTION}
            defaultValue={defaults?.description ?? ''}
            placeholder="What players should know before they arrive."
            className={TEXTAREA}
          />
        </div>

        <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
          <div>
            <label className={LABEL} htmlFor={`${idPrefix}-phone`}>
              Contact phone
            </label>
            <input
              id={`${idPrefix}-phone`}
              name="contactPhone"
              maxLength={MAX_PHONE}
              defaultValue={defaults?.contactPhone ?? ''}
              placeholder="0917 000 0000"
              className={FIELD}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor={`${idPrefix}-email`}>
              Contact email
            </label>
            <input
              id={`${idPrefix}-email`}
              name="contactEmail"
              type="email"
              maxLength={MAX_EMAIL}
              defaultValue={defaults?.contactEmail ?? ''}
              placeholder="desk@example.com"
              className={FIELD}
            />
          </div>
        </div>

        <fieldset>
          <legend className={LABEL}>Amenities</legend>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {AMENITY_SLUGS.map((amenity) => (
              <label key={amenity} className={CHECK_LABEL} htmlFor={`${idPrefix}-${amenity}`}>
                <input
                  id={`${idPrefix}-${amenity}`}
                  type="checkbox"
                  name="amenities"
                  value={amenity}
                  defaultChecked={amenities.includes(amenity)}
                  className={CHECKBOX}
                />
                {AMENITY_LABELS[amenity]}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="sticky top-8 self-start max-[980px]:static">
        <LocationPicker
          idPrefix={idPrefix}
          address={address}
          city={city}
          lat={defaults?.lat ?? null}
          lng={defaults?.lng ?? null}
        />
      </div>
    </div>
  )
}
