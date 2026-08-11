'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { OwnerBookingRow } from '@/lib/owner/queries'
import { formatDateLabel, formatPeso, formatHourRange } from '@/lib/format'

/**
 * The dialog's own row shape: identical to `OwnerBookingRow` except its two
 * money fields are `number | null`, `null` meaning "redacted" — distinct from
 * a real `0`. Defined here, not as an inline prop type, so
 * src/app/dashboard/bookings/page.tsx can build exactly this shape and the
 * two stay in sync.
 *
 * This type exists for a reason stronger than convenience: this component is
 * a Client Component ('use client'), so whatever it receives as props is
 * serialized into the page's own RSC flight payload regardless of what JSX
 * ends up rendering. An earlier version of this file received full
 * `OwnerBookingRow`s (real totalChargedCentavos/ownerNetCentavos for every
 * row in the bookings scope) plus an `earningsBranchIds` list, and redacted
 * only when rendering — which hid the money in the DOM while leaving it
 * sitting in view-source and the network payload for a `view_bookings`
 * session without `view_earnings`. The Schedule tab's table doesn't have
 * this problem because it is a Server Component: a value it declines to
 * render never leaves the server. A client component can't offer that
 * guarantee for anything in its props, so the page now redacts BEFORE
 * building this array — this component only ever holds `null` for a value it
 * has no business seeing, never the real centavos plus a flag saying not to
 * print it.
 */
export type DayDialogRow = Omit<OwnerBookingRow, 'totalChargedCentavos' | 'ownerNetCentavos'> & {
  totalChargedCentavos: number | null
  ownerNetCentavos: number | null
}

/**
 * The project's first modal. A native <dialog> opened with showModal(),
 * deliberately: it gives focus trapping, Esc-to-close, and an inert
 * background for free. A hand-rolled <div> overlay silently provides none of
 * those, and they are exactly what a keyboard or screen-reader user needs.
 *
 * Open/closed state is the URL (?day=), not React state — the same rule this
 * page already follows for its filters. Closing navigates to closeHref, so
 * the back button works and the day is linkable.
 */
export function DayBookingsDialog({
  day,
  rows,
  closeHref,
}: {
  day: string
  rows: DayDialogRow[]
  closeHref: string
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const router = useRouter()
  const [openRow, setOpenRow] = useState<string | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="day-dialog-heading"
      onClose={() => router.replace(closeHref)}
      className="m-auto w-[min(560px,92vw)] rounded-[20px] bg-[var(--panel)] p-0 shadow-[var(--shadow-sm)] backdrop:bg-[rgba(6,20,13,.45)]"
    >
      <div className="flex items-center justify-between border-b border-[var(--hairline)] px-5 py-3.5">
        <h2 id="day-dialog-heading" className="font-display text-[17px] font-bold">
          {formatDateLabel(day)}
        </h2>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          className="rounded-[var(--btn-radius)] px-2 py-1 text-[13px] font-semibold text-[var(--court)] hover:text-[var(--court-deep)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--court)]"
        >
          Close
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-[var(--ink-soft)]">
          Nothing booked on this day.
        </p>
      ) : (
        <ul className="max-h-[60vh] divide-y divide-[var(--hairline)] overflow-y-auto">
          {rows.map((row) => {
            const detailId = `day-dialog-detail-${row.bookingId}`
            return (
              <li key={row.bookingId}>
                <button
                  type="button"
                  aria-expanded={openRow === row.bookingId}
                  aria-controls={detailId}
                  onClick={() => setOpenRow(openRow === row.bookingId ? null : row.bookingId)}
                  className="flex w-full items-baseline gap-3 px-5 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--court)]"
                >
                  <span className="font-mono text-[11.5px] text-[var(--ink-soft)]">
                    {formatHourRange(row.startHour, row.endHour)}
                  </span>
                  <span className="flex-1 text-[13.5px] font-semibold text-[var(--ink)]">
                    {row.label}
                  </span>
                  <span className="font-mono text-[11.5px] text-[var(--ink-soft)]">
                    {/* `null` means the page already redacted this value —
                        a block (never had a price) or a row whose OWN branch
                        is outside this viewer's view_earnings scope. This
                        component only ever decides '—' vs the number; it
                        never decides WHETHER to redact — see DayDialogRow's
                        doc comment above for why that decision had to move
                        server-side. */}
                    {row.totalChargedCentavos === null
                      ? '—'
                      : formatPeso(row.totalChargedCentavos)}
                  </span>
                </button>
                {openRow === row.bookingId && (
                  <dl
                    id={detailId}
                    className="grid grid-cols-2 gap-1 px-5 pb-3 text-[12.5px] text-[var(--ink-soft)]"
                  >
                    <dt>Branch</dt>
                    <dd className="text-[var(--ink)]">{row.branchName}</dd>
                    <dt>Court</dt>
                    <dd className="text-[var(--ink)]">{row.courtName}</dd>
                    <dt>Status</dt>
                    <dd className="text-[var(--ink)]">{row.status}</dd>
                    {!row.isBlock && (
                      <>
                        <dt>Charged</dt>
                        <dd className="font-mono text-[var(--ink)]">
                          {row.totalChargedCentavos === null
                            ? '—'
                            : formatPeso(row.totalChargedCentavos)}
                        </dd>
                        <dt>Your net</dt>
                        <dd className="font-mono text-[var(--ink)]">
                          {row.ownerNetCentavos === null
                            ? '—'
                            : formatPeso(row.ownerNetCentavos)}
                        </dd>
                      </>
                    )}
                    {row.note && (
                      <>
                        <dt>Note</dt>
                        <dd className="text-[var(--ink)]">{row.note}</dd>
                      </>
                    )}
                  </dl>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </dialog>
  )
}
