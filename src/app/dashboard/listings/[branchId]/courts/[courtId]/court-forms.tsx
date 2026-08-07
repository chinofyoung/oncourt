'use client'

import { useActionState, useState } from 'react'
import {
  updateCourtAction,
  updateOperatingHoursAction,
  updateRateBandsAction,
  type ListingFormState,
} from '../../../actions'
import { BORDERED_BUTTON, DARK_BUTTON, FormMessage, LIME_BUTTON } from '../../../form-ui'
import type { CourtEnvironment } from '@/lib/listings/fields'
import type { OperatingHoursDay, RateBand } from '@/lib/listings/schedule'
import {
  addBandRow,
  buildBandRows,
  buildDayRows,
  CourtDetailFields,
  OperatingHoursFields,
  RateBandFields,
  removeBandRow,
  type BandRow,
  type DayRow,
} from '../court-schedule-fields'

/**
 * The three court forms.
 *
 * Each posts only a hidden `courtId` — never a branchId. The action resolves
 * the branch from the court row and guards
 * requireBranchAccess(branchId, 'manage_courts') against THAT, which is what
 * makes a forged id useless rather than a confused deputy. Do not add a
 * branchId field here "for convenience".
 *
 * The field markup itself (name/surface/environment, the day-row grid, the
 * band-row list) lives in ../court-schedule-fields.tsx, shared with the
 * create page's single combined form — these three components each just add
 * the `<form>`, the hidden courtId, the submit button, and FormMessage around
 * that shared markup.
 */

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

      <CourtDetailFields idPrefix={courtId} defaults={defaults} />
      {/* Named as a key field so the re-queue is never a surprise. Name and
          surface are on the same form and do NOT re-queue — the action
          re-queues only when the environment actually changed. */}
      <p className="text-[11.5px] text-[var(--ink-soft)]">
        Changing the environment sends this court back for approval. Renaming it does not.
      </p>

      <div>
        <button type="submit" disabled={pending} className={DARK_BUTTON}>
          {pending ? 'Saving…' : 'Save court'}
        </button>
        <FormMessage state={state} />
      </div>
    </form>
  )
}

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
  const [rows, setRows] = useState<DayRow[]>(() => buildDayRows(days))

  function updateRow(index: number, patch: Partial<DayRow>) {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="courtId" value={courtId} />

      <OperatingHoursFields idPrefix={courtId} rows={rows} onChange={updateRow} />

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

export function RateBandsForm({ courtId, bands }: { courtId: string; bands: RateBand[] }) {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    updateRateBandsAction,
    null,
  )
  const [rows, setRows] = useState<BandRow[]>(() => buildBandRows(bands))

  function updateRow(index: number, patch: Partial<BandRow>) {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="courtId" value={courtId} />

      <RateBandFields
        idPrefix={courtId}
        rows={rows}
        onChange={updateRow}
        onRemove={(index) => setRows((current) => removeBandRow(current, index))}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setRows((current) => addBandRow(current))}
          className={BORDERED_BUTTON}
        >
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
