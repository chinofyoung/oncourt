'use client'

import Link from 'next/link'
import { useActionState, useState } from 'react'
import { createCourtAction, type ListingFormState } from '../../../actions'
import { BORDERED_BUTTON, FOCUS_RING, FormMessage, LIME_BUTTON } from '../../../form-ui'
import {
  addBandRow,
  buildBandRows,
  CourtDetailFields,
  defaultDayRows,
  OperatingHoursFields,
  RateBandFields,
  removeBandRow,
  type BandRow,
  type DayRow,
} from '../court-schedule-fields'
import { formatHour } from '@/lib/format'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]'

/**
 * Add a court, on its own page — now the FULL court form (details, opening
 * hours, rates), submitted together as one form and written in one
 * transaction by createCourtAction / createCourtWithSchedule
 * (src/lib/listings/write.ts). Previously this page collected only name,
 * surface and environment, then sent the owner to the new court's own page to
 * add hours and rates as two more separate saves — this is the "first step"
 * shape the redesign replaces.
 *
 * PHOTOS ARE THE ONE SECTION NOT HERE. A photo upload needs an existing
 * court_id to attach to (addPhoto writes to Supabase Storage under that id),
 * so there is nothing to upload TO until the transaction below has committed.
 * Buffering the file client-side and replaying the upload after redirect
 * would add real failure modes (a court created but its buffered photo lost
 * to a closed tab, or an orphaned Storage object if the court insert then
 * failed) for very little gain. The description below says so, and the
 * post-create redirect lands the owner exactly on the court's own page, where
 * PhotoManager already lives.
 *
 * Reuses the same field markup the edit page's three separate forms use
 * (CourtDetailFields, OperatingHoursFields, RateBandFields, all in
 * ../court-schedule-fields.tsx) — there is exactly one copy of the day-row
 * and band-row JSX, not two copies that could drift apart on what a valid
 * schedule looks like. The validation RULES are shared too: this form posts
 * the identical field names parseCourtFields / parseOperatingHours /
 * parseRateBands (src/lib/listings/fields.ts, src/lib/listings/schedule.ts)
 * already read for the edit page's forms, and createCourtWithSchedule
 * re-validates with the exact same functions replaceOperatingHours /
 * replaceRateBands use.
 *
 * Layout mirrors the edit page's current arrangement (courts/[courtId]/
 * page.tsx): items-start two-column pairs that collapse to one column at
 * 980px. Court details has no natural pairing partner now that photos are
 * deferred, so it gets its own full-width row; Opening hours and Rates keep
 * the edit page's exact pairing, in the same order.
 */
export function AddCourtForm({ branchId }: { branchId: string }) {
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(
    createCourtAction,
    null,
  )

  // Sensible starting grid, not an empty one: every day open 7 AM - 10 PM,
  // and one rate band tiling that exact span with a blank price. An owner who
  // accepts both defaults only has to type one number. See defaultDayRows()
  // and buildBandRows() in ../court-schedule-fields.tsx for why 7-22 is the
  // number chosen.
  const [dayRows, setDayRows] = useState<DayRow[]>(defaultDayRows)
  const [bandRows, setBandRows] = useState<BandRow[]>(() => buildBandRows([]))

  function updateDayRow(index: number, patch: Partial<DayRow>) {
    setDayRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    )
  }

  function updateBandRow(index: number, patch: Partial<BandRow>) {
    setBandRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="branchId" value={branchId} />

      <header className="flex items-start justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
        <div>
          {/* ?tab=courts, not a bare branch link: this form was reached from
              the Courts tab, and a plain link back to the branch page would
              silently drop the visitor onto the Details tab instead. */}
          <Link
            href={`/dashboard/listings/${branchId}?tab=courts`}
            className={`font-mono mb-2 inline-block text-[11px] tracking-[.12em] text-[var(--court)] uppercase ${FOCUS_RING}`}
          >
            &larr; Courts
          </Link>
          <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
            Add a court
          </h1>
          <p className="mt-2 max-w-[560px] text-[15px] text-[var(--ink-soft)]">
            New courts start as pending, and our team reviews them once you save. Add photos on the
            court&rsquo;s own page after it&rsquo;s created.
          </p>
        </div>
        <button
          type="submit"
          disabled={pending}
          className={`${LIME_BUTTON} max-[560px]:w-full max-[560px]:justify-center`}
        >
          {pending ? 'Adding…' : 'Add court'}
        </button>
      </header>

      <FormMessage state={state} />

      <section aria-label="Court details" className={CARD}>
        <h2 className="font-display mb-4 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
          Court details
        </h2>
        <div className="flex max-w-[640px] flex-col gap-4">
          <CourtDetailFields
            idPrefix={`new-${branchId}`}
            defaults={{ name: '', environment: 'indoor', surface: null }}
          />
        </div>
      </section>

      {/* Same even fr/fr split, items-start, and 980px collapse as the
          schedule pair on the edit page, in the same order: hours, then
          rates. */}
      <div className="grid grid-cols-2 items-start gap-6 max-[980px]:grid-cols-1 max-[980px]:gap-4">
        <section aria-label="Opening hours" className={CARD}>
          <h2 className="font-display mb-1 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
            Opening hours
          </h2>
          <p className="mb-4 text-[12.5px] text-[var(--ink-soft)]">
            One window per day. Closing at {formatHour(24)} means midnight.
          </p>
          <OperatingHoursFields
            idPrefix={`new-${branchId}`}
            rows={dayRows}
            onChange={updateDayRow}
          />
        </section>

        <section aria-label="Rates" className={CARD}>
          <h2 className="font-display mb-1 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
            Rates
          </h2>
          <p className="mb-4 text-[12.5px] text-[var(--ink-soft)]">
            Bands must cover every open hour exactly once, with no gaps or overlaps. Prices are
            whole pesos per hour.
          </p>
          <RateBandFields
            idPrefix={`new-${branchId}`}
            rows={bandRows}
            onChange={updateBandRow}
            onRemove={(index) => setBandRows((current) => removeBandRow(current, index))}
          />
          <button
            type="button"
            onClick={() => setBandRows((current) => addBandRow(current))}
            className={`${BORDERED_BUTTON} mt-3`}
          >
            Add band
          </button>
        </section>
      </div>
    </form>
  )
}
