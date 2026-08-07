'use client'

import { useActionState, useState } from 'react'
import {
  updateCourtAction,
  updateOperatingHoursAction,
  updateRateBandsAction,
  type ListingFormState,
} from '../../../actions'
import {
  BORDERED_BUTTON,
  CHECKBOX,
  CHECK_LABEL,
  DARK_BUTTON,
  FIELD,
  FOCUS_RING,
  FormMessage,
  LABEL,
  LIME_BUTTON,
} from '../../../form-ui'
import {
  COURT_ENVIRONMENT_LABELS,
  COURT_ENVIRONMENTS,
  MAX_COURT_NAME,
  MAX_SURFACE,
  type CourtEnvironment,
} from '@/lib/listings/fields'
import {
  PESOS_TO_CENTAVOS,
  WEEKDAY_LABELS,
  type OperatingHoursDay,
  type RateBand,
} from '@/lib/listings/schedule'
import { formatHour } from '@/lib/format'

const RADIO = `h-4 w-4 shrink-0 accent-[var(--court)] ${FOCUS_RING}`
// Written out rather than composed from FIELD: FIELD carries `w-full`, and
// appending `w-[104px]` after it would leave two conflicting width utilities
// in one class list, where which one wins depends on Tailwind's generated
// stylesheet order rather than on the order written here.
const SELECT = `font-mono h-[var(--btn-h-sm)] w-[104px] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2 text-[13px] text-[var(--ink)] ${FOCUS_RING}`

/**
 * The three court forms.
 *
 * Each posts only a hidden `courtId` — never a branchId. The action resolves
 * the branch from the court row and guards
 * requireBranchAccess(branchId, 'manage_courts') against THAT, which is what
 * makes a forged id useless rather than a confused deputy. Do not add a
 * branchId field here "for convenience".
 *
 * Hours are chosen from selects rather than typed into number inputs: the
 * legal values are the 25 integers 0..24 (24 being local midnight, which
 * court_operating_hours.closes_hour permits), and formatHour renders each one
 * the way the rest of the app does.
 */
function HourSelect({
  name,
  id,
  value,
  onChange,
  min,
  max,
}: {
  name: string
  id: string
  value: number
  onChange: (value: number) => void
  min: number
  max: number
}) {
  const hours: number[] = []
  for (let hour = min; hour <= max; hour++) hours.push(hour)

  return (
    <select
      id={id}
      name={name}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className={SELECT}
    >
      {hours.map((hour) => (
        <option key={hour} value={hour}>
          {formatHour(hour)}
        </option>
      ))}
    </select>
  )
}

export function CourtFieldsForm({
  courtId,
  defaults,
}: {
  courtId: string
  defaults: { name: string; environment: CourtEnvironment; surface: string | null }
}) {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    updateCourtAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="courtId" value={courtId} />

      <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
        <div>
          <label className={LABEL} htmlFor={`court-name-${courtId}`}>
            Court name
          </label>
          <input
            id={`court-name-${courtId}`}
            name="name"
            required
            maxLength={MAX_COURT_NAME}
            defaultValue={defaults.name}
            className={FIELD}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor={`court-surface-${courtId}`}>
            Surface (optional)
          </label>
          <input
            id={`court-surface-${courtId}`}
            name="surface"
            maxLength={MAX_SURFACE}
            defaultValue={defaults.surface ?? ''}
            placeholder="Acrylic"
            className={FIELD}
          />
        </div>
      </div>

      <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <legend className={LABEL}>Environment</legend>
        {COURT_ENVIRONMENTS.map((environment) => (
          <label
            key={environment}
            className={CHECK_LABEL}
            htmlFor={`court-${environment}-${courtId}`}
          >
            <input
              id={`court-${environment}-${courtId}`}
              type="radio"
              name="environment"
              value={environment}
              defaultChecked={defaults.environment === environment}
              className={RADIO}
            />
            {COURT_ENVIRONMENT_LABELS[environment]}
          </label>
        ))}
        {/* Named as a key field so the re-queue is never a surprise. Name and
            surface are on the same form and do NOT re-queue — the action
            re-queues only when the environment actually changed. */}
        <p className="w-full basis-full text-[11.5px] text-[var(--ink-soft)]">
          Changing the environment sends this court back for approval. Renaming it does not.
        </p>
      </fieldset>

      <div>
        <button type="submit" disabled={pending} className={DARK_BUTTON}>
          {pending ? 'Saving…' : 'Save court'}
        </button>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

type DayRow = { open: boolean; opensHour: number; closesHour: number }

export function OperatingHoursForm({
  courtId,
  days,
}: {
  courtId: string
  days: OperatingHoursDay[]
}) {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    updateOperatingHoursAction,
    null,
  )

  // All seven rows always exist in state, open or not, because the submitted
  // set IS the new week: a day whose checkbox is unchecked submits nothing
  // and is therefore closed. Defaults for a day that has never been open are
  // a plausible 7 AM - 10 PM rather than 0-0, so checking the box is enough.
  const [rows, setRows] = useState<DayRow[]>(() =>
    WEEKDAY_LABELS.map((_, dayOfWeek) => {
      const stored = days.find((day) => day.dayOfWeek === dayOfWeek)
      return {
        open: stored !== undefined,
        opensHour: stored?.opensHour ?? 7,
        closesHour: stored?.closesHour ?? 22,
      }
    }),
  )

  function updateRow(index: number, patch: Partial<DayRow>) {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="courtId" value={courtId} />

      <ul className="flex flex-col">
        {rows.map((row, dayOfWeek) => (
          <li
            key={WEEKDAY_LABELS[dayOfWeek]}
            className={`flex flex-wrap items-center gap-3 py-2.5 ${
              dayOfWeek > 0 ? 'border-t border-[var(--hairline)]' : ''
            }`}
          >
            <label className={`${CHECK_LABEL} w-[128px]`} htmlFor={`open-${dayOfWeek}-${courtId}`}>
              <input
                id={`open-${dayOfWeek}-${courtId}`}
                type="checkbox"
                name={`open-${dayOfWeek}`}
                checked={row.open}
                onChange={(event) => updateRow(dayOfWeek, { open: event.target.checked })}
                className={CHECKBOX}
              />
              {WEEKDAY_LABELS[dayOfWeek]}
            </label>

            {row.open ? (
              <div className="flex flex-wrap items-center gap-2">
                <HourSelect
                  id={`opens-${dayOfWeek}-${courtId}`}
                  name={`opens-${dayOfWeek}`}
                  value={row.opensHour}
                  onChange={(opensHour) => updateRow(dayOfWeek, { opensHour })}
                  min={0}
                  max={23}
                />
                <span aria-hidden className="text-[13px] text-[var(--ink-soft)]">
                  &ndash;
                </span>
                <HourSelect
                  id={`closes-${dayOfWeek}-${courtId}`}
                  name={`closes-${dayOfWeek}`}
                  value={row.closesHour}
                  onChange={(closesHour) => updateRow(dayOfWeek, { closesHour })}
                  min={1}
                  max={24}
                />
              </div>
            ) : (
              <span className="text-[12.5px] text-[var(--ink-soft)]">Closed</span>
            )}
          </li>
        ))}
      </ul>

      <div>
        <button type="submit" disabled={pending} className={DARK_BUTTON}>
          {pending ? 'Saving…' : 'Save hours'}
        </button>
        <FormMessage state={state} />
      </div>
      <p className="text-[11.5px] text-[var(--ink-soft)]">
        Saving new hours sends this court back for approval. If your rate bands no longer cover the
        new hours, update them next.
      </p>
    </form>
  )
}

type BandRow = { key: string; startHour: number; endHour: number; pesos: string }

export function RateBandsForm({ courtId, bands }: { courtId: string; bands: RateBand[] }) {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    updateRateBandsAction,
    null,
  )

  // Pesos, not centavos, because that is what an owner types; the action
  // multiplies by 100. A stored price with odd centavos would show as a
  // decimal here and be rejected on save, which is correct: this product
  // prices courts in whole pesos.
  const [rows, setRows] = useState<BandRow[]>(() =>
    bands.length > 0
      ? bands.map((band) => ({
          key: `${band.startHour}-${band.endHour}`,
          startHour: band.startHour,
          endHour: band.endHour,
          pesos: String(band.priceCentavos / PESOS_TO_CENTAVOS),
        }))
      : [{ key: 'first', startHour: 7, endHour: 22, pesos: '' }],
  )

  function updateRow(index: number, patch: Partial<BandRow>) {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    )
  }

  function addRow() {
    setRows((current) => {
      const last = current[current.length - 1]
      // A new band starts where the last one ended, which is the only place
      // it can legally start — the bands must tile with no gap.
      const startHour = last ? last.endHour : 7
      return [
        ...current,
        {
          key: `row-${Date.now()}`,
          startHour: Math.min(startHour, 23),
          endHour: 24,
          pesos: '',
        },
      ]
    })
  }

  function removeRow(index: number) {
    setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="courtId" value={courtId} />

      <ul className="flex flex-col">
        {rows.map((row, index) => (
          <li
            key={row.key}
            className={`flex flex-wrap items-start gap-3 py-2.5 ${
              index > 0 ? 'border-t border-[var(--hairline)]' : ''
            }`}
          >
            {/* From + Until grouped into one flex item (was two loose items in
                the row's own flex-wrap) so a narrow container — this row now
                also renders inside the half-width "Rates" column beside
                Opening hours — wraps as two clean sub-groups instead of
                breaking apart mid-pair. Ungrouped, the four controls wrapped
                one at a time and could strand "Until" alone between "From"
                and the price field. */}
            <div className="flex items-end gap-3">
              <div>
                <label className={LABEL} htmlFor={`band-start-${index}-${courtId}`}>
                  From
                </label>
                <HourSelect
                  id={`band-start-${index}-${courtId}`}
                  name="bandStart"
                  value={row.startHour}
                  onChange={(startHour) => updateRow(index, { startHour })}
                  min={0}
                  max={23}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor={`band-end-${index}-${courtId}`}>
                  Until
                </label>
                <HourSelect
                  id={`band-end-${index}-${courtId}`}
                  name="bandEnd"
                  value={row.endHour}
                  onChange={(endHour) => updateRow(index, { endHour })}
                  min={1}
                  max={24}
                />
              </div>
            </div>
            <div className="flex items-end gap-3">
              <div className="w-[132px]">
                <label className={LABEL} htmlFor={`band-price-${index}-${courtId}`}>
                  Price per hour
                </label>
                <input
                  id={`band-price-${index}-${courtId}`}
                  name="bandPrice"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  required
                  value={row.pesos}
                  onChange={(event) => updateRow(index, { pesos: event.target.value })}
                  placeholder="265"
                  className={`font-mono ${FIELD}`}
                />
              </div>
              <button
                type="button"
                onClick={() => removeRow(index)}
                disabled={rows.length === 1}
                aria-label={`Remove the band starting at ${formatHour(row.startHour)}`}
                className={BORDERED_BUTTON}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={addRow} className={BORDERED_BUTTON}>
          Add band
        </button>
        {/* The one lime button on this page: pricing is the action that
            actually gets a court approved. */}
        <button type="submit" disabled={pending} className={LIME_BUTTON}>
          {pending ? 'Saving…' : 'Save rates'}
        </button>
      </div>
      <FormMessage state={state} />
      <p className="text-[11.5px] text-[var(--ink-soft)]">
        Bands must cover every open hour exactly once, with no gaps or overlaps. Prices are whole
        pesos per hour. Saving new rates sends this court back for approval.
      </p>
    </form>
  )
}
