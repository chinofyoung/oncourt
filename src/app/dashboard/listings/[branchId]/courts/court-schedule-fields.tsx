'use client'

import {
  BORDERED_BUTTON,
  CHECKBOX,
  CHECK_LABEL,
  FIELD,
  FOCUS_RING,
  LABEL,
} from '../../form-ui'
import { PESOS_TO_CENTAVOS, WEEKDAY_LABELS, type OperatingHoursDay, type RateBand } from '@/lib/listings/schedule'
import { formatHour } from '@/lib/format'
import {
  COURT_ENVIRONMENT_LABELS,
  COURT_ENVIRONMENTS,
  MAX_COURT_NAME,
  MAX_SURFACE,
  type CourtEnvironment,
} from '@/lib/listings/fields'

/**
 * The day-row and band-row field markup, shared between the court edit page
 * (courts/[courtId]/court-forms.tsx, three separate <form>s, each with its
 * own useActionState) and the add-court page (courts/new/add-court-form.tsx,
 * one combined <form> submitted all together).
 *
 * Lives at courts/ — a sibling of both [courtId]/ and new/ — rather than
 * inside either route folder, so neither page's directory "owns" the other's
 * import. Only the ROWS (the <ul> of checkboxes/selects, or start/end/price
 * inputs) are shared; each caller keeps its own <form> tag, submit button,
 * and FormMessage, because those differ between "save this one section" and
 * "submit everything together".
 *
 * PURE presentational components plus small pure row-builders — no
 * useActionState, no hidden courtId input — so a caller with no court yet
 * (the create page) can render them exactly like a caller with one.
 */

const RADIO = `h-4 w-4 shrink-0 accent-[var(--court)] ${FOCUS_RING}`
// Written out rather than composed from FIELD: FIELD carries `w-full`, and
// appending `w-[104px]` after it would leave two conflicting width utilities
// in one class list, where which one wins depends on Tailwind's generated
// stylesheet order rather than on the order written here.
const SELECT = `font-mono h-[var(--btn-h-sm)] w-[104px] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2 text-[13px] text-[var(--ink)] ${FOCUS_RING}`

/**
 * Hours are chosen from selects rather than typed into number inputs: the
 * legal values are the 25 integers 0..24 (24 being local midnight, which
 * court_operating_hours.closes_hour permits), and formatHour renders each one
 * the way the rest of the app does.
 */
export function HourSelect({
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

// ---------------------------------------------------------- operating hours

export type DayRow = { open: boolean; opensHour: number; closesHour: number }

/**
 * All seven rows always exist in state, open or not, because the submitted
 * set IS the new week: a day whose checkbox is unchecked submits nothing and
 * is therefore closed.
 *
 * For a court that already has stored hours (the edit page), a day that has
 * never been open defaults to closed with a plausible 7 AM - 10 PM in
 * reserve, so checking the box is enough. For a brand-new court (the create
 * page), use defaultDayRows() below instead — an all-closed grid is not a
 * "sensible default", it is an empty one.
 */
export function buildDayRows(days: OperatingHoursDay[]): DayRow[] {
  return WEEKDAY_LABELS.map((_, dayOfWeek) => {
    const stored = days.find((day) => day.dayOfWeek === dayOfWeek)
    return {
      open: stored !== undefined,
      opensHour: stored?.opensHour ?? 7,
      closesHour: stored?.closesHour ?? 22,
    }
  })
}

/**
 * The create page's starting grid: every day open 7 AM - 10 PM. Chosen
 * because those are the exact same two fallback numbers buildDayRows() (and
 * RateBandsForm's own single-band default below) already use elsewhere in
 * this file for "a plausible day" — one convention, not a second one invented
 * for this page — and because a new owner is far more likely to be trimming a
 * too-generous week down than building one up from nothing.
 */
export function defaultDayRows(): DayRow[] {
  return WEEKDAY_LABELS.map(() => ({ open: true, opensHour: 7, closesHour: 22 }))
}

/**
 * The day-row `<ul>` only — no `<form>`, no hidden courtId, no submit. Each
 * caller wraps this in its own form and posts `open-<n>` / `opens-<n>` /
 * `closes-<n>`, exactly what parseOperatingHours() (src/lib/listings/
 * schedule.ts) reads.
 *
 * `idPrefix` only needs to be unique WITHIN the page (there is one hours grid
 * per court, and the create page has exactly one court), so the edit page
 * passes its courtId and the create page can pass any fixed string.
 */
export function OperatingHoursFields({
  idPrefix,
  rows,
  onChange,
}: {
  idPrefix: string
  rows: DayRow[]
  onChange: (index: number, patch: Partial<DayRow>) => void
}) {
  return (
    <ul className="flex flex-col">
      {rows.map((row, dayOfWeek) => (
        <li
          key={WEEKDAY_LABELS[dayOfWeek]}
          className={`flex flex-wrap items-center gap-3 py-2.5 ${
            dayOfWeek > 0 ? 'border-t border-[var(--hairline)]' : ''
          }`}
        >
          <label className={`${CHECK_LABEL} w-[128px]`} htmlFor={`open-${dayOfWeek}-${idPrefix}`}>
            <input
              id={`open-${dayOfWeek}-${idPrefix}`}
              type="checkbox"
              name={`open-${dayOfWeek}`}
              checked={row.open}
              onChange={(event) => onChange(dayOfWeek, { open: event.target.checked })}
              className={CHECKBOX}
            />
            {WEEKDAY_LABELS[dayOfWeek]}
          </label>

          {row.open ? (
            <div className="flex flex-wrap items-center gap-2">
              <HourSelect
                id={`opens-${dayOfWeek}-${idPrefix}`}
                name={`opens-${dayOfWeek}`}
                value={row.opensHour}
                onChange={(opensHour) => onChange(dayOfWeek, { opensHour })}
                min={0}
                max={23}
              />
              <span aria-hidden className="text-[13px] text-[var(--ink-soft)]">
                &ndash;
              </span>
              <HourSelect
                id={`closes-${dayOfWeek}-${idPrefix}`}
                name={`closes-${dayOfWeek}`}
                value={row.closesHour}
                onChange={(closesHour) => onChange(dayOfWeek, { closesHour })}
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
  )
}

// -------------------------------------------------------------- rate bands

export type BandRow = { key: string; startHour: number; endHour: number; pesos: string }

/**
 * Pesos, not centavos, because that is what an owner types; the write layer
 * multiplies by 100. A stored price with odd centavos would show as a decimal
 * here and be rejected on save, which is correct: this product prices courts
 * in whole pesos.
 *
 * An empty `bands` list (a brand-new court, on either page) becomes one row
 * spanning 7 AM - 10 PM with a blank price — the same span defaultDayRows()
 * opens every day with, so the two default grids tile each other exactly and
 * an owner who accepts both defaults only has to type one price.
 */
export function buildBandRows(bands: RateBand[]): BandRow[] {
  return bands.length > 0
    ? bands.map((band) => ({
        key: `${band.startHour}-${band.endHour}`,
        startHour: band.startHour,
        endHour: band.endHour,
        pesos: String(band.priceCentavos / PESOS_TO_CENTAVOS),
      }))
    : [{ key: 'first', startHour: 7, endHour: 22, pesos: '' }]
}

/** A new band starts where the last one ended, which is the only place it can legally start. */
export function addBandRow(rows: BandRow[]): BandRow[] {
  const last = rows[rows.length - 1]
  const startHour = last ? last.endHour : 7
  return [
    ...rows,
    { key: `row-${Date.now()}`, startHour: Math.min(startHour, 23), endHour: 24, pesos: '' },
  ]
}

export function removeBandRow(rows: BandRow[], index: number): BandRow[] {
  return rows.filter((_, rowIndex) => rowIndex !== index)
}

/**
 * The band-row `<ul>` only — no `<form>`, no hidden courtId, no buttons. Each
 * caller wraps this in its own form, adds its own "Add band" button (using
 * addBandRow() above) alongside its own submit button, and posts the three
 * parallel `bandStart` / `bandEnd` / `bandPrice` lists parseRateBands()
 * (src/lib/listings/schedule.ts) reads.
 */
export function RateBandFields({
  idPrefix,
  rows,
  onChange,
  onRemove,
}: {
  idPrefix: string
  rows: BandRow[]
  onChange: (index: number, patch: Partial<BandRow>) => void
  onRemove: (index: number) => void
}) {
  return (
    <ul className="flex flex-col">
      {rows.map((row, index) => (
        <li
          key={row.key}
          className={`flex flex-wrap items-start gap-3 py-2.5 ${
            index > 0 ? 'border-t border-[var(--hairline)]' : ''
          }`}
        >
          {/* From + Until grouped into one flex item so a narrow container
              wraps as two clean sub-groups instead of breaking apart
              mid-pair. */}
          <div className="flex items-end gap-3">
            <div>
              <label className={LABEL} htmlFor={`band-start-${index}-${idPrefix}`}>
                From
              </label>
              <HourSelect
                id={`band-start-${index}-${idPrefix}`}
                name="bandStart"
                value={row.startHour}
                onChange={(startHour) => onChange(index, { startHour })}
                min={0}
                max={23}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor={`band-end-${index}-${idPrefix}`}>
                Until
              </label>
              <HourSelect
                id={`band-end-${index}-${idPrefix}`}
                name="bandEnd"
                value={row.endHour}
                onChange={(endHour) => onChange(index, { endHour })}
                min={1}
                max={24}
              />
            </div>
          </div>
          <div className="flex items-end gap-3">
            <div className="w-[132px]">
              <label className={LABEL} htmlFor={`band-price-${index}-${idPrefix}`}>
                Price per hour
              </label>
              <input
                id={`band-price-${index}-${idPrefix}`}
                name="bandPrice"
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                required
                value={row.pesos}
                onChange={(event) => onChange(index, { pesos: event.target.value })}
                placeholder="265"
                className={`font-mono ${FIELD}`}
              />
            </div>
            <button
              type="button"
              onClick={() => onRemove(index)}
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
  )
}

// ----------------------------------------------------------------- details

/**
 * Name, surface, and environment — no `<form>`, no hidden courtId, no submit.
 * Shared between CourtFieldsForm (the edit page, which wraps this in its own
 * form and appends the "changing the environment re-queues" note below it)
 * and the create page (which renders this inside the one combined form and
 * has no such note — a brand-new court has no approval status yet to
 * re-queue out of).
 */
export function CourtDetailFields({
  idPrefix,
  defaults,
}: {
  idPrefix: string
  defaults: { name: string; environment: CourtEnvironment; surface: string | null }
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
        <div>
          <label className={LABEL} htmlFor={`court-name-${idPrefix}`}>
            Court name
          </label>
          <input
            id={`court-name-${idPrefix}`}
            name="name"
            required
            maxLength={MAX_COURT_NAME}
            defaultValue={defaults.name}
            placeholder="Court 1"
            className={FIELD}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor={`court-surface-${idPrefix}`}>
            Surface (optional)
          </label>
          <input
            id={`court-surface-${idPrefix}`}
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
            htmlFor={`court-${environment}-${idPrefix}`}
          >
            <input
              id={`court-${environment}-${idPrefix}`}
              type="radio"
              name="environment"
              value={environment}
              defaultChecked={defaults.environment === environment}
              className={RADIO}
            />
            {COURT_ENVIRONMENT_LABELS[environment]}
          </label>
        ))}
      </fieldset>
    </>
  )
}
