import Link from 'next/link'
import { requireOwnerPage } from '@/lib/auth/page-guards'
import { getOwnerBookings, getOwnerBranches } from '@/lib/owner/queries'
import { isValidCalendarDate, manilaToday, shiftDay } from '@/lib/date-manila'
import { formatDateLabel, formatHourRange, formatPeso } from '@/lib/format'

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

const NAV_LINK =
  `inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3 text-[13px] font-semibold text-[var(--ink)] hover:border-[var(--court)] ${FOCUS_RING}`

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `getOwnerBookings` now filters to REAL_BOOKING (`confirmed` | `completed`)
 * — see src/lib/owner/queries.ts — so this list never renders a
 * `pending_payment` hold or an underscored status like `refunded_manual`
 * that would need splitting into words. Both remaining statuses are single
 * words, so a plain capitalize is enough.
 */
function humanizeStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

/**
 * Filters are URL state (`?day=&branch=`), not client state — a fresh server
 * render per navigation, linkable, and off the client bundle entirely.
 */
export default async function OwnerBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; branch?: string }>
}) {
  const user = await requireOwnerPage('/dashboard/bookings')
  const { day: rawDay, branch: rawBranch } = await searchParams

  // An invalid or nonexistent date (?day=2026-02-30) falls back to today
  // rather than reaching a ::date cast and raising 22008.
  const day = rawDay && isValidCalendarDate(rawDay) ? rawDay : manilaToday()
  const branchId = rawBranch && UUID_RE.test(rawBranch) ? rawBranch : undefined
  const today = manilaToday()

  const [branches, rows] = await Promise.all([
    getOwnerBranches(user.id),
    getOwnerBookings(user.id, { day, branchId }),
  ])

  // Only a *validated* branch filter is echoed back into prev/next/Today
  // links — an invalid or absent `branch` param is dropped, not reflected.
  const branchQuery = branchId ? `&branch=${branchId}` : ''

  return (
    <>
      <header className="mb-8">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Bookings
        </h1>
      </header>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link href={`/dashboard/bookings?day=${shiftDay(day, -1)}${branchQuery}`} className={NAV_LINK}>
            ← Prev
          </Link>
          <span className="font-mono text-[13.5px] font-semibold whitespace-nowrap text-[var(--ink)]">
            {formatDateLabel(day)}
          </span>
          <Link href={`/dashboard/bookings?day=${shiftDay(day, 1)}${branchQuery}`} className={NAV_LINK}>
            Next →
          </Link>
          {day !== today && (
            <Link
              href={`/dashboard/bookings?day=${today}${branchQuery}`}
              className={`text-[13px] font-semibold text-[var(--court)] hover:text-[var(--court-deep)] ${FOCUS_RING}`}
            >
              Today
            </Link>
          )}
        </div>

        <form
          method="get"
          action="/dashboard/bookings"
          aria-label="Filter bookings by branch"
          className="flex items-center gap-2"
        >
          {/* Preserves the day filter across a branch-form submit — the day
              picker is a separate set of prev/next/Today links, not part of
              this form, so it has to be carried along explicitly. */}
          <input type="hidden" name="day" defaultValue={day} />
          <select
            name="branch"
            aria-label="Branch"
            defaultValue={branchId ?? ''}
            className={`h-[var(--btn-h-sm)] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-3 text-[13px] text-[var(--ink)] ${FOCUS_RING}`}
          >
            <option value="">All branches</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className={`inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3.5 text-[13px] font-semibold text-[var(--ink)] hover:border-[var(--court)] ${FOCUS_RING}`}
          >
            Filter
          </button>
        </form>
      </div>

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-[20px] bg-[var(--panel)] shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="font-mono border-b border-[var(--hairline)] text-[11px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                <th className="py-3 pr-4 pl-5 font-normal">Time</th>
                <th className="py-3 pr-4 font-normal">Branch</th>
                <th className="py-3 pr-4 font-normal">Court</th>
                <th className="py-3 pr-4 font-normal">Player</th>
                <th className="py-3 pr-4 font-normal">Status</th>
                <th className="py-3 pr-4 text-right font-normal">Amount</th>
                <th className="py-3 pr-5 text-right font-normal">Your net</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.bookingId} className="border-b border-[var(--hairline)] last:border-b-0">
                  <td className="font-mono py-4 pr-4 pl-5 text-[12.5px] whitespace-nowrap text-[var(--ink-soft)]">
                    {formatHourRange(row.startHour, row.endHour)}
                  </td>
                  <td className="py-4 pr-4 text-[13.5px] text-[var(--ink)]">{row.branchName}</td>
                  <td className="py-4 pr-4 text-[13.5px] text-[var(--ink)]">{row.courtName}</td>
                  <td className="py-4 pr-4 text-[13.5px] text-[var(--ink)]">{row.playerName}</td>
                  <td className="py-4 pr-4">
                    <span className="rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap text-[var(--court-deep)]">
                      {humanizeStatus(row.status)}
                    </span>
                  </td>
                  <td className="font-mono py-4 pr-4 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                    {formatPeso(row.totalChargedCentavos)}
                  </td>
                  <td className="font-mono py-4 pr-5 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                    {formatPeso(row.ownerNetCentavos)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={EMPTY_PANEL}>No bookings on this day.</p>
      )}
    </>
  )
}
