'use client'

import { useState } from 'react'
import { AMENITY_LABELS, AMENITY_SLUGS } from '@/components/ui/amenity-chip'
import { AMENITY_ICONS, CustomAmenityIcon } from '@/components/ui/amenity-icons'
import {
  MAX_ADDRESS,
  MAX_BRANCH_NAME,
  MAX_CITY,
  MAX_CUSTOM_AMENITIES,
  MAX_CUSTOM_AMENITY_LENGTH,
  MAX_DESCRIPTION,
  MAX_EMAIL,
  MAX_PHONE,
} from '@/lib/listings/fields'
import { BORDERED_BUTTON, CHECKBOX, CHECK_LABEL, FIELD, FOCUS_RING, LABEL, TEXTAREA } from './form-ui'
import { LocationPicker } from './location-picker'

/** Every value in AMENITY_SLUGS, for an O(1) canonical/custom split below. */
const CANONICAL_AMENITIES = new Set<string>(AMENITY_SLUGS)

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
 *
 * Owner-defined custom amenities (the "Add" button below the checkboxes) ride
 * the SAME `name="amenities"` field via one hidden `<input>` per custom
 * entry, rather than a second field the server has to merge — parseBranchFields
 * (src/lib/listings/fields.ts) treats every submitted value as either
 * canonical (in AMENITY_SLUGS) or custom (validated by shape) with no notion
 * of which UI control produced it. A branch's existing `amenities` array is
 * split client-side into "canonical" (checked box) and "custom" (chip with a
 * remove button) purely by set membership against AMENITY_SLUGS — anything
 * stored that isn't in that list, including a slug retired from the
 * checkbox vocabulary (aircon, pro-shop, night-lights — see amenity-chip.tsx),
 * shows up as a custom chip instead of silently vanishing on the next save.
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

  // Custom amenities need real React state (add/remove has to re-render the
  // chip list); the canonical checkboxes stay uncontrolled defaultChecked,
  // same as before. Computed once from the initial defaults — the lazy
  // initializer form of useState so re-renders don't re-derive it.
  const [customAmenities, setCustomAmenities] = useState<string[]>(() =>
    amenities.filter((value) => !CANONICAL_AMENITIES.has(value)),
  )
  const [newAmenity, setNewAmenity] = useState('')
  const [customAmenityError, setCustomAmenityError] = useState<string | null>(null)

  function addCustomAmenity() {
    const value = newAmenity.trim()
    if (value.length === 0) return
    if (value.length > MAX_CUSTOM_AMENITY_LENGTH) {
      setCustomAmenityError(`Keep it under ${MAX_CUSTOM_AMENITY_LENGTH} characters.`)
      return
    }
    if (customAmenities.length >= MAX_CUSTOM_AMENITIES) {
      setCustomAmenityError(`You can add up to ${MAX_CUSTOM_AMENITIES} custom amenities.`)
      return
    }
    // Courtesy check only — parseBranchFields is the real one. Case-insensitive
    // against custom entries AND the canonical vocabulary/labels, so typing
    // "Parking" here (duplicating the checkbox) is caught before submit
    // instead of surfacing as a generic server-side "invalid_amenity".
    const key = value.toLowerCase()
    const isDuplicate =
      customAmenities.some((existing) => existing.toLowerCase() === key) ||
      (AMENITY_SLUGS as readonly string[]).some((slug) => slug.toLowerCase() === key) ||
      Object.values(AMENITY_LABELS).some((label) => label.toLowerCase() === key)
    if (isDuplicate) {
      setCustomAmenityError('That amenity is already listed.')
      return
    }
    setCustomAmenities((prev) => [...prev, value])
    setNewAmenity('')
    setCustomAmenityError(null)
  }

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
          {/* Fixed 8-item vocabulary (see AMENITY_SLUGS) → a real 2-column
              grid rather than flex-wrap, so items land in aligned columns
              instead of reflowing raggedly at whatever width the last item
              on a row happens to leave. Single column under 560px
              (branding.md's tighten breakpoint) so the label isn't squeezed
              next to the icon on a phone. */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 max-[560px]:grid-cols-1">
            {AMENITY_SLUGS.map((amenity) => {
              const AmenityIcon = AMENITY_ICONS[amenity]
              return (
                <label
                  key={amenity}
                  className={`${CHECK_LABEL} whitespace-nowrap`}
                  htmlFor={`${idPrefix}-${amenity}`}
                >
                  <input
                    id={`${idPrefix}-${amenity}`}
                    type="checkbox"
                    name="amenities"
                    value={amenity}
                    defaultChecked={amenities.includes(amenity)}
                    className={CHECKBOX}
                  />
                  <AmenityIcon />
                  {AMENITY_LABELS[amenity]}
                </label>
              )
            })}
          </div>

          {/* Owner-defined amenities beyond the canonical list. Each rides
              the same `amenities` field as a hidden input — no second field
              for the server to merge — so parseBranchFields sees one flat set
              regardless of whether a value came from a checkbox or here. */}
          {customAmenities.length > 0 && (
            <ul className="mt-3 flex flex-wrap items-center gap-2">
              {customAmenities.map((amenity) => {
                const label = AMENITY_LABELS[amenity] ?? amenity
                return (
                  <li key={amenity}>
                    <input type="hidden" name="amenities" value={amenity} />
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--hairline)] bg-[var(--panel)] py-1 pr-1.5 pl-2.5 text-[12.5px] font-medium text-[var(--ink)]">
                      <CustomAmenityIcon />
                      {label}
                      <button
                        type="button"
                        onClick={() =>
                          setCustomAmenities((prev) => prev.filter((existing) => existing !== amenity))
                        }
                        aria-label={`Remove ${label}`}
                        className={`flex h-4 w-4 items-center justify-center rounded-full text-[var(--ink-soft)] hover:bg-[var(--booked)] hover:text-[var(--ink)] ${FOCUS_RING}`}
                      >
                        &times;
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className={LABEL} htmlFor={`${idPrefix}-custom-amenity`}>
                Add an amenity
              </label>
              <input
                id={`${idPrefix}-custom-amenity`}
                type="text"
                value={newAmenity}
                maxLength={MAX_CUSTOM_AMENITY_LENGTH}
                onChange={(event) => {
                  setNewAmenity(event.target.value)
                  setCustomAmenityError(null)
                }}
                onKeyDown={(event) => {
                  // Enter inside a text input submits its enclosing <form> by
                  // default — this fieldset has no <form> of its own (see the
                  // module comment; it's always rendered inside the branch
                  // form), so an unguarded Enter would submit the WHOLE
                  // branch form instead of just adding the amenity.
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addCustomAmenity()
                  }
                }}
                placeholder="e.g. Wifi"
                className={`${FIELD} w-[180px]`}
              />
            </div>
            <button type="button" onClick={addCustomAmenity} className={BORDERED_BUTTON}>
              Add
            </button>
          </div>
          {customAmenityError && (
            <p role="alert" className="mt-1.5 text-[11.5px] font-medium text-[var(--ink)]">
              {customAmenityError}
            </p>
          )}
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
