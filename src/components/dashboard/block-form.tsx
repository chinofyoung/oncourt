'use client'

import { useActionState } from 'react'
import { createBlockAction, type BlockFormState } from '@/app/dashboard/blocks/actions'
import { formatHour } from '@/lib/format'
import type { OwnerGridCourt } from '@/lib/owner/queries'

const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const FIELD =
  `h-[var(--btn-h-sm)] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2.5 text-[13px] text-[var(--ink)] ${FOCUS_RING}`

const LABEL = 'font-mono mb-1 block text-[10.5px] tracking-[.12em] text-[var(--ink-soft)] uppercase'

/**
 * Whole hours 0..24. The endHour list starts at 1 and includes 24, because a
 * block running to closing-time midnight legitimately ends at hour 24 — see
 * src/lib/booking/hold.ts's manilaInstant docstring, and
 * court_operating_hours.closes_hour, which the fixtures set to 24.
 *
 * The full 0..24 range is offered rather than the court's operating window on
 * purpose: maintenance happens when the venue is shut, and createBlock
 * deliberately does not apply an operating-hours check. The server still
 * rejects endHour <= startHour, so a nonsense pair is a form error, not a crash.
 */
const START_HOURS = Array.from({ length: 24 }, (_, i) => i)
const END_HOURS = Array.from({ length: 24 }, (_, i) => i + 1)

/**
 * Takes a slot off the market. Lives on /dashboard/bookings rather than beside
 * the overview's day grid: this page owns the day navigation, so a block can be
 * placed on any date, and a 30px grid cell has no room for a control.
 *
 * A client component because a Server Component cannot render what a Server
 * Action returns — a refused block ("those hours are already taken") would
 * otherwise look like nothing happening. On success the action revalidates
 * /dashboard/bookings, so the table below re-renders from the server with the
 * new row and no local success state is needed beyond the status line.
 *
 * `branchId` is deliberately NOT a field here: the action reads the court's
 * real branch from the database and guards against that, so there is nothing
 * for a forged branch id to confuse. Only `courtId` is submitted.
 */
export function BlockForm({ day, courts }: { day: string; courts: OwnerGridCourt[] }) {
  const [state, formAction, pending] = useActionState<BlockFormState, FormData>(
    createBlockAction,
    null,
  )

  if (courts.length === 0) {
    return (
      <p className="text-[13px] text-[var(--ink-soft)]">
        No approved courts yet — once a court is approved you can block time on it here.
      </p>
    )
  }

  // Group into optgroups so a multi-branch owner can tell two "Court 1"s apart.
  const branchNames = [...new Set(courts.map((court) => court.branchName))]

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      {/* The day comes from the page's own prev/next navigation, so the form
          carries it rather than duplicating a date picker that could disagree
          with the table underneath it. */}
      <input type="hidden" name="date" value={day} />

      <div className="min-w-[190px]">
        <label className={LABEL} htmlFor="block-court">
          Court
        </label>
        <select id="block-court" name="courtId" required className={`${FIELD} w-full`}>
          {branchNames.map((branchName) => (
            <optgroup key={branchName} label={branchName}>
              {courts
                .filter((court) => court.branchName === branchName)
                .map((court) => (
                  <option key={court.courtId} value={court.courtId}>
                    {court.courtName}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div>
        <label className={LABEL} htmlFor="block-start">
          From
        </label>
        <select id="block-start" name="startHour" defaultValue="7" className={FIELD}>
          {START_HOURS.map((hour) => (
            <option key={hour} value={hour}>
              {formatHour(hour)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={LABEL} htmlFor="block-end">
          To
        </label>
        <select id="block-end" name="endHour" defaultValue="8" className={FIELD}>
          {END_HOURS.map((hour) => (
            <option key={hour} value={hour}>
              {formatHour(hour)}
            </option>
          ))}
        </select>
      </div>

      <div className="min-w-[200px] flex-1">
        <label className={LABEL} htmlFor="block-note">
          Note (optional)
        </label>
        <input
          id="block-note"
          name="note"
          type="text"
          maxLength={200}
          placeholder="Resurfacing, walk-in, private game…"
          className={`${FIELD} w-full placeholder:text-[var(--ink-soft)]`}
        />
      </div>

      {/* The one lime button in this view — every other control on
          /dashboard/bookings is bordered/neutral, so branding.md's "never two
          lime buttons in one view" holds. The Unblock buttons in the table are
          deliberately bordered, not lime, for the same reason. */}
      <button
        type="submit"
        disabled={pending}
        className={`font-display inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-4 text-[13px] font-bold text-[var(--ball-ink)] transition-[filter] duration-150 hover:brightness-[1.06] disabled:opacity-60 motion-reduce:transition-none ${FOCUS_RING}`}
      >
        {pending ? 'Blocking…' : 'Block slot'}
      </button>

      {state && 'error' in state && (
        <p role="alert" className="w-full text-[12.5px] font-medium text-[var(--ink)]">
          {state.error}
        </p>
      )}
      {state && 'ok' in state && (
        <p role="status" className="w-full text-[12.5px] font-medium text-[var(--court)]">
          Slot blocked.
        </p>
      )}
    </form>
  )
}
