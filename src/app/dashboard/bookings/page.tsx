import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { BlockForm } from '@/components/dashboard/block-form'
import { UnblockButton } from '@/components/dashboard/unblock-button'
import { getOwnerBookings, getScheduleCourts } from '@/lib/owner/queries'
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
 * `getOwnerBookings` now filters to SCHEDULE_ROW (`confirmed` | `completed` |
 * `blocked`) — see src/lib/owner/queries.ts — so this list never renders a
 * `pending_payment` hold or an underscored status like `refunded_manual`
 * that would need splitting into words. All three remaining statuses are
 * single words, so a plain capitalize is enough.
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
  const access = await requireDashboardPage('/dashboard/bookings')
  const { day: rawDay, branch: rawBranch } = await searchParams

  // Two independent scopes govern this page: view_bookings for the day's
  // table (and the branch filter that narrows it), block_slots for the block
  // form below it. A session with EITHER non-empty has real business here —
  // a block_slots-only front-desk grant used to be dead entirely, because the
  // old redirect below only ever checked view_bookings. Only a session with
  // BOTH empty is turned away, same as before.
  const scheduleBranchIds = branchIdsWith(access, 'view_bookings')
  const blockBranchIds = branchIdsWith(access, 'block_slots')
  // `!access.isOwner &&` deliberately, same reasoning as the reviews page: an
  // owner with zero branches still sees this page's own empty states.
  if (!access.isOwner && scheduleBranchIds.length === 0 && blockBranchIds.length === 0) {
    redirect('/dashboard')
  }

  // An invalid or nonexistent date (?day=2026-02-30) falls back to today
  // rather than reaching a ::date cast and raising 22008.
  const day = rawDay && isValidCalendarDate(rawDay) ? rawDay : manilaToday()
  const today = manilaToday()

  // The dropdown and the branch-filter validation are narrowed to
  // scheduleBranchIds specifically, not every branch this session can see at
  // all (access.branches) — a person with, say, manage_courts on a branch but
  // not view_bookings there must never have that branch's bookings show up
  // just because they can see SOMETHING on /dashboard for it.
  const branches = access.branches.filter((branch) => scheduleBranchIds.includes(branch.id))
  const branchId =
    rawBranch && UUID_RE.test(rawBranch) && branches.some((branch) => branch.id === rawBranch)
      ? rawBranch
      : undefined

  // Rows and courts each skip their query entirely when their own scope is
  // empty — a view-only staff member never pays for the courts round trip,
  // and a block_slots-only one never pays for the bookings round trip.
  // Courts are scoped to blockBranchIds specifically: it is the block form's
  // own dropdown, not the bookings table, so it must offer exactly the
  // branches this session can block on, which is not necessarily the same
  // set as scheduleBranchIds.
  const [rows, courts] = await Promise.all([
    scheduleBranchIds.length > 0
      ? getOwnerBookings(scheduleBranchIds, { day, branchId })
      : Promise.resolve([]),
    blockBranchIds.length > 0 ? getScheduleCourts(blockBranchIds) : Promise.resolve([]),
  ])

  // Per-row money visibility, now that OwnerBookingRow carries a branch id
  // (src/lib/owner/queries.ts): a row's Amount/Your-net cell shows real money
  // only when THIS row's branch is in the view_earnings scope, an em dash
  // otherwise — never an all-or-nothing gate across every row on the page.
  const earningsBranchIds = branchIdsWith(access, 'view_earnings')

  // Only a *validated* branch filter is echoed back into prev/next/Today
  // links — an invalid, foreign, or absent `branch` param is dropped.
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

      {blockBranchIds.length > 0 && (
        <section
          aria-label="Block a slot"
          className="mb-6 rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
        >
          <h2 className="font-display mb-1 text-[15px] font-bold tracking-[-0.01em] text-[var(--ink)]">
            Block a slot
          </h2>
          <p className="mb-4 text-[13px] text-[var(--ink-soft)]">
            Takes court time off the market on {formatDateLabel(day)} — for maintenance, a walk-in,
            or your own game. No payment, and it never counts towards earnings.
          </p>
          <BlockForm day={day} courts={courts} />
        </section>
      )}

      {scheduleBranchIds.length === 0 ? (
        // A block_slots-only session (no view_bookings anywhere): the block
        // section above is this page's entire purpose for them, and there is
        // no bookings scope to fetch a table or an empty state for.
        <p className={EMPTY_PANEL}>You can block time on your branches&rsquo; courts below.</p>
      ) : rows.length > 0 ? (
        <div className="overflow-x-auto rounded-[20px] bg-[var(--panel)] shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead>
              <tr className="font-mono border-b border-[var(--hairline)] text-[11px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                <th className="py-3 pr-4 pl-5 font-normal">Time</th>
                <th className="py-3 pr-4 font-normal">Branch</th>
                <th className="py-3 pr-4 font-normal">Court</th>
                <th className="py-3 pr-4 font-normal">Player / block</th>
                <th className="py-3 pr-4 font-normal">Status</th>
                <th className="py-3 pr-4 text-right font-normal">Amount</th>
                <th className="py-3 pr-5 text-right font-normal">Your net</th>
                <th className="py-3 pr-5 text-right font-normal">
                  <span className="sr-only">Actions</span>
                </th>
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
                  <td className="py-4 pr-4 text-[13.5px] text-[var(--ink)]">{row.label}</td>
                  <td className="py-4 pr-4">
                    {/* A block is not a booking status a player would ever
                        see, so it is tagged distinctly: --booked (branding.md's
                        flat disabled tone) rather than the --band-off pill that
                        means "confirmed / completed". */}
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap ${
                        row.isBlock
                          ? 'bg-[var(--booked)] text-[var(--ink-soft)]'
                          : 'bg-[var(--band-off)] text-[var(--court-deep)]'
                      }`}
                    >
                      {humanizeStatus(row.status)}
                    </span>
                  </td>
                  <td className="font-mono py-4 pr-4 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                    {/* An em dash, not ₱0: a block never had a price (and a
                        rendered ₱0 reads as a booking that earned nothing),
                        and the same dash covers a row whose OWN branch this
                        session cannot see the money for — per-row, via
                        earningsBranchIds, never all-or-nothing across the
                        whole page. */}
                    {row.isBlock || !earningsBranchIds.includes(row.branchId)
                      ? '—'
                      : formatPeso(row.totalChargedCentavos)}
                  </td>
                  <td className="font-mono py-4 pr-5 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                    {row.isBlock || !earningsBranchIds.includes(row.branchId)
                      ? '—'
                      : formatPeso(row.ownerNetCentavos)}
                  </td>
                  <td className="py-4 pr-5 text-right">
                    {/* Only blocks are removable, and only by someone holding
                        block_slots on THIS row's branch specifically — a
                        mixed-grant session must not see Unblock on a row from
                        a branch they only view_bookings on. A paid booking has
                        no delete at all — it is a financial record, and
                        deleteBlock's WHERE clause refuses one even if this
                        cell were forged. */}
                    {row.isBlock && blockBranchIds.includes(row.branchId) && (
                      <UnblockButton blockId={row.bookingId} label={row.label} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={EMPTY_PANEL}>No bookings or blocks on this day.</p>
      )}
    </>
  )
}
