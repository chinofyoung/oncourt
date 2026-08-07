'use client'

import { useState } from 'react'
import { spinePriceCentavos } from '@/lib/booking/spine-price'
import type { GridCell, GridColumn } from '@/lib/booking/availability'
import { createHoldAction } from '@/app/venues/[slug]/actions'

// Colors and control tokens reference the brand CSS variables defined in
// src/app/globals.css (which mirror design/branding.md — the design source
// of truth): --panel/--hairline/--ink/--ink-soft for the card and table
// chrome, --booked for disabled slots, --ball/--ball-ink/--ink for the
// selected-cell treatment ("lime with 1.5px ink border and court-corner tick
// marks", per branding.md's Availability grid component entry), --court for
// the light-background focus ring (branding.md's Focus rule — --ball is the
// dark-background variant), --btn-radius/--btn-h-sm/--btn-h for control
// sizing. Solid colors only, no gradients. Structure is ported from
// design/mockups/branch-page.html's `.slots` table and `.summary` bar; the
// mockup's per-row rate-band tinting on the time spine is NOT reproduced
// here because it assumes one shared band structure across every visible
// court, which the real data model does not guarantee (different courts
// can have different rate bands) — branding.md's Availability grid entry
// was updated in the same turn to describe a plain (untinted) time spine
// instead of documenting a look this component doesn't implement. See
// task-9-report.md fix round 1.
//
// `past` (past-slot booking fix): a fully-elapsed hour — its end instant is
// at or before now, mirroring src/lib/payments/webhook.ts's `ends_at <=
// now()` gate exactly, no lead-time buffer — computed by
// src/lib/booking/availability.ts's loadBranchDay from the DATABASE's
// now(), never the Node clock. Deliberately its own CellState rather than
// folding into 'closed': 'closed' means a court simply doesn't operate at
// that hour regardless of the clock, and a grid can show a legitimately-
// closed cell for one court right next to an elapsed cell for another (they
// can have different operating windows) — collapsing the two would make
// them indistinguishable. Rendered non-interactive like 'closed' but with a
// dashed border (the same "info not available" vocabulary this page's map
// empty-state already uses) and a "Past" label, so it also never reads as
// 'booked' (which means someone else holds the slot, not that time ran out).
//
// Price placement: a row whose `open` cells all quote the same price shows
// that price ONCE in the time spine (see spinePriceCentavos in
// src/lib/booking/spine-price.ts — it lives in its own import-free module
// because this is a client component and availability.ts imports server-only
// `@/db`, so value-importing from there 500s the page) and renders those
// cells blank; a row whose open cells disagree keeps a price in each cell, as
// before. Both kinds of row can appear in one grid — the decision is per row,
// never per grid. This is
// NOT a return of the per-row rate-band tinting described as dropped above:
// that asserted a shared band structure the data model does not guarantee,
// whereas this only renders a shared value after verifying the visible open
// cells actually agree. The button's aria-label always speaks the full price,
// blank cell or not.
//
// `canBook` (required, resolved by the venue page from `getOptionalUser()`)
// is false for a signed-in owner or admin session — roles are exclusive as
// of the roles-and-staff slice, and neither can ever hold a paid booking.
// Both the per-cell click handler and the summary bar honor it, folding
// `!canBook` into the same non-interactive treatment cells already have for
// booked/closed/past rather than adding yet another visual state. This is UI-only:
// the authoritative check is `requirePlayer` in
// src/app/venues/[slug]/actions.ts, which a forged form POST still has to
// pass regardless of what this component renders.

function formatPeso(centavos: number): string {
  const pesos = centavos / 100
  return `₱${pesos.toLocaleString('en-PH', {
    minimumFractionDigits: pesos % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

function formatHour(hour: number): string {
  // Wrapped mod 24 first: the summary bar's end-time label can pass 24
  // (an hour range ending at closing-time midnight, e.g. 11 PM-12 AM, per
  // hold.ts's manilaInstant docstring on why closesHour/endHour can be 24).
  // Without the wrap, hour=24 fell through as "24 % 12 === 0 -> 12" with
  // ampm computed from the unwrapped 24 (>= 12 -> 'PM'), rendering the
  // wrong "12 PM" instead of "12 AM". Every per-row cell hour is already
  // 0-23 (buildAvailabilityGrid never emits 24), so this only ever bites
  // the summary's `+ 1` end-time computation.
  const h = hour % 24
  const ampm = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12} ${ampm}`
}

type Selection = { courtId: string; hours: number[] }

export function AvailabilityGrid(props: {
  grid: GridColumn[]
  branchId: string
  slug: string
  date: string
  canBook: boolean
}) {
  const [selection, setSelection] = useState<Selection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  function toggle(courtId: string, hour: number) {
    setError(null)
    setSelection((current) => {
      // Selecting in a different column restarts the selection.
      if (!current || current.courtId !== courtId) return { courtId, hours: [hour] }
      if (current.hours.includes(hour)) {
        const hours = current.hours.filter((h) => h !== hour)
        return hours.length ? { courtId, hours } : null
      }
      // Only consecutive hours may be combined into one hold.
      const hours = [...current.hours, hour].sort((a, b) => a - b)
      const consecutive = hours.every((h, i) => i === 0 || h === hours[i - 1] + 1)
      return consecutive ? { courtId, hours } : { courtId, hours: [hour] }
    })
  }

  const hours = props.grid[0]?.cells.map((c) => c.hour) ?? []
  const column = props.grid.find((c) => c.courtId === selection?.courtId)
  const total = (selection?.hours ?? []).reduce(
    (sum, hour) => sum + (column?.cells.find((c) => c.hour === hour)?.priceCentavos ?? 0),
    0,
  )

  return (
    // No `overflow-hidden` here (a previous version had it, purely to clip
    // the table's square corners to this card's rounded ones) — an
    // `overflow-hidden` ancestor establishes its own (non-scrolling)
    // containing block for `position: sticky`, which made the summary
    // bar's `sticky bottom-0` below a no-op: it had nothing to stick
    // against, since that ancestor itself never scrolls. Removing it lets
    // the summary bar stick relative to the real scrolling ancestor (the
    // page/viewport) instead. The corner-clipping job moves to the two
    // children that actually need it: `rounded-t-[20px]` on the table
    // wrapper below (it already has non-`visible` overflow via
    // `overflow-x-auto`, which is enough to clip per the CSS Overflow
    // spec) and `rounded-b-[20px]` on the summary bar itself.
    <div className="flex flex-col rounded-[20px] bg-[var(--panel)] shadow-[0_1px_2px_rgba(12,31,22,.06),0_4px_16px_rgba(12,31,22,.05)]">
      <div className="overflow-x-auto rounded-t-[20px]">
        <table
          className="w-full border-collapse text-sm"
          // Derived from the court count rather than a fixed 640px: a one- or
          // two-court branch should never force horizontal scroll, while a
          // seven-court branch still should. The spine is shrink-to-fit and sits
          // outside this budget.
          style={{ minWidth: `${props.grid.length * 112}px` }}
        >
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 top-0 z-[3] w-px whitespace-nowrap bg-[var(--panel)] px-3 py-2 text-left align-bottom font-mono text-[11px] uppercase tracking-[.08em] text-[var(--ink-soft)]"
              >
                Time
              </th>
              {props.grid.map((court) => (
                <th
                  key={court.courtId}
                  scope="col"
                  className="sticky top-0 z-[2] bg-[var(--panel)] px-2 py-2 text-center"
                >
                  <span className="block font-semibold text-[var(--ink)]">{court.courtName}</span>
                  <span
                    className={[
                      'mt-0.5 inline-block rounded-full border px-1.5 py-0 font-mono text-[10px] uppercase tracking-[.08em] text-[var(--ink-soft)]',
                      court.environment === 'outdoor'
                        ? 'border-transparent bg-[var(--band-off)]'
                        : 'border-[var(--hairline)]',
                    ].join(' ')}
                  >
                    {court.environment}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {hours.map((hour) => {
              const rowCells: GridCell[] = props.grid.map(
                (court) => court.cells.find((c) => c.hour === hour)!,
              )
              const spinePrice = spinePriceCentavos(rowCells)
              return (
                <tr key={hour} className="border-b border-[var(--hairline)]">
                  <th
                    scope="row"
                    className="sticky left-0 z-[1] w-px whitespace-nowrap border-r border-[var(--hairline)] bg-[var(--panel)] px-3 py-0.5 text-left font-mono text-xs font-normal text-[var(--ink)]"
                  >
                    <span className="flex items-baseline gap-3">
                      <span>{formatHour(hour)}</span>
                      {spinePrice !== null && (
                        <span className="ml-auto text-[var(--ink-soft)]">{formatPeso(spinePrice)}</span>
                      )}
                    </span>
                  </th>
                  {props.grid.map((court, courtIndex) => {
                    const cell = rowCells[courtIndex]
                    const selected =
                      selection?.courtId === court.courtId && selection.hours.includes(hour)
                    return (
                      <td key={court.courtId} className="px-1 py-0.5 text-center">
                        <button
                          type="button"
                          // Not `disabled` — a disabled control drops out of
                          // the tab order entirely, so a keyboard user could
                          // never even discover a booked/closed cell exists.
                          // `aria-disabled` keeps it focusable and announced
                          // as unavailable while still non-interactive; the
                          // click handler below is the actual guard against
                          // selecting a non-open cell (previously enforced
                          // only by the native `disabled` attribute).
                          // `!canBook` folds into the same non-interactive
                          // treatment as booked/closed/past rather than getting
                          // its own visual state: to an owner, every cell is
                          // simply not theirs to click. Still focusable (not
                          // `disabled`), so a keyboard user can read the prices.
                          aria-disabled={!props.canBook || cell.state !== 'open'}
                          onClick={() => {
                            if (props.canBook && cell.state === 'open') toggle(court.courtId, hour)
                          }}
                          aria-pressed={selected}
                          aria-label={`${court.courtName} at ${formatHour(hour)}, ${
                            cell.state === 'open'
                              ? formatPeso(cell.priceCentavos)
                              : cell.state === 'booked'
                                ? 'booked'
                                : cell.state === 'past'
                                  ? 'time has passed'
                                  : 'closed'
                          }`}
                          className={[
                            // Deliberately NOT max-width capped. A cap was tried
                          // (168px, centered) and looked broken on a
                          // single-court branch: the court column absorbs all
                          // remaining table width, so the chip became a small
                          // pill floating in ~460px of blank space, once per
                          // row. Letting it fill its column keeps a wide,
                          // obvious click target instead — which is the right
                          // affordance for "this hour is available" — and the
                          // shrink-to-fit time spine is what actually fixed
                          // the wasted-width complaint.
                          'relative h-[var(--slot-h)] w-full rounded-[var(--btn-radius)] border font-mono text-[10px] font-medium transition-colors',
                            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-[3px]',
                            cell.state === 'booked'
                              ? 'cursor-default border-transparent bg-[var(--booked)] text-[var(--ink-soft)]'
                              : cell.state === 'past'
                                ? // Distinct from 'closed' (no border, opacity-50, "—") and
                                  // from 'booked' (solid fill, "Booked"): a dashed border is
                                  // the same "info not available" vocabulary the location
                                  // card's empty state already uses elsewhere on this page.
                                  'cursor-not-allowed border-dashed border-[var(--hairline)] bg-transparent text-[var(--ink-soft)] opacity-70'
                                : cell.state === 'closed'
                                  ? 'cursor-not-allowed border-transparent bg-transparent text-[var(--ink-soft)] opacity-50'
                                  : selected
                                    ? 'border-[1.5px] border-[var(--ink)] bg-[var(--ball)] font-semibold text-[var(--ball-ink)] before:absolute before:left-[3px] before:top-[3px] before:h-[7px] before:w-[7px] before:border-l-2 before:border-t-2 before:border-[var(--ball-ink)] before:content-[""] after:absolute after:bottom-[3px] after:right-[3px] after:h-[7px] after:w-[7px] after:border-b-2 after:border-r-2 after:border-[var(--ball-ink)] after:content-[""]'
                                    : 'border-[var(--hairline)] bg-[var(--surface)] text-[var(--court-deep)] hover:border-[var(--court)]',
                          ].join(' ')}
                        >
                          {cell.state === 'open'
                            ? spinePrice !== null
                              ? null
                              : formatPeso(cell.priceCentavos)
                            : cell.state === 'booked'
                              ? 'Booked'
                              : cell.state === 'past'
                                ? 'Past'
                                : '—'}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* A row whose price sits in the time spine renders its open cells blank, so
          fill and border are what distinguish the four states. This legend is what
          makes that legible; the swatches repeat each state's own treatment. */}
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-[var(--hairline)] px-4 py-2 font-mono text-[10px] uppercase tracking-[.08em] text-[var(--ink-soft)]">
        {[
          { label: 'Available', className: 'border-[var(--hairline)] bg-[var(--surface)]' },
          { label: 'Selected', className: 'border-[1.5px] border-[var(--ink)] bg-[var(--ball)]' },
          { label: 'Booked', className: 'border-transparent bg-[var(--booked)]' },
          { label: 'Past', className: 'border-dashed border-[var(--hairline)] bg-transparent' },
          { label: 'Closed', className: 'border-transparent bg-transparent opacity-50' },
        ].map((item) => (
          <li key={item.label} className="flex items-center gap-1.5">
            <span aria-hidden className={`h-3 w-5 rounded-[4px] border ${item.className}`} />
            {item.label}
          </li>
        ))}
      </ul>

      {error && (
        <p role="alert" className="border-t border-[var(--hairline)] px-5 py-3 text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="sticky bottom-0 flex flex-wrap items-center gap-4 rounded-b-[20px] border-t-2 border-[var(--ink)] bg-[var(--panel)] px-5 py-4">
        {!props.canBook ? (
          /* The server guard (requirePlayer in
             src/app/venues/[slug]/actions.ts) is the real boundary; this is
             the explanation, so an owner is not left wondering why the grid
             does not respond. */
          <span className="text-sm text-[var(--ink-soft)]">
            Owner and admin accounts can&rsquo;t book courts. To hold time on your own courts, use
            Bookings in your dashboard.
          </span>
        ) : !selection ? (
          <span className="text-sm text-[var(--ink-soft)]">
            Select open slots in one court&rsquo;s column to book.
          </span>
        ) : (
          <form
            action={async (formData) => {
              setPending(true)
              try {
                const result = await createHoldAction(formData)
                if (result?.error) setError(result.error)
              } finally {
                setPending(false)
              }
            }}
            className="flex w-full flex-wrap items-center justify-between gap-4"
          >
            <input type="hidden" name="courtId" value={selection.courtId} />
            <input type="hidden" name="branchId" value={props.branchId} />
            <input type="hidden" name="slug" value={props.slug} />
            <input type="hidden" name="date" value={props.date} />
            <input type="hidden" name="startHour" value={Math.min(...selection.hours)} />
            <input type="hidden" name="endHour" value={Math.max(...selection.hours) + 1} />
            <div className="min-w-[180px] flex-1">
              <div className="font-semibold text-[var(--ink)]">
                {column?.courtName} · {formatHour(Math.min(...selection.hours))} &ndash;{' '}
                {formatHour(Math.max(...selection.hours) + 1)}
              </div>
              <div className="text-sm text-[var(--ink-soft)]">
                {selection.hours.length} hour{selection.hours.length > 1 ? 's' : ''}
              </div>
            </div>
            <div className="text-right">
              <div className="font-mono text-xl font-semibold text-[var(--ink)]">
                {formatPeso(total)}
              </div>
              <div className="text-[11.5px] text-[var(--ink-soft)]">
                incl. all court fees · pay with GCash, Maya, or card
              </div>
            </div>
            <button
              type="submit"
              disabled={pending}
              className="inline-flex h-[var(--btn-h)] items-center rounded-[var(--btn-radius)] bg-[var(--ink)] px-8 font-bold text-[var(--ball)] transition-colors hover:bg-[var(--court-deep)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ball)] focus-visible:outline-offset-[3px]"
            >
              {pending ? 'Booking…' : 'Book now'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
