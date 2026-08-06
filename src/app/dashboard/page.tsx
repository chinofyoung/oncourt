import { StatCard } from '@/components/dashboard/stat-card'
import { OwnerDayGrid } from '@/components/dashboard/owner-day-grid'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { getOwnerOverview } from '@/lib/owner/queries'
import { manilaToday } from '@/lib/date-manila'
import { formatDateLabel, formatPeso } from '@/lib/format'

const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

/**
 * `activity.at` is a full ISO instant (see src/lib/owner/queries.ts), not a
 * plain calendar date — formatDateLabel() in src/lib/format.ts only accepts
 * `YYYY-MM-DD`, so a date-plus-time label needs its own formatting here
 * rather than a reused helper. Manila-zoned so a booking made right around
 * local midnight doesn't read as the wrong day.
 */
function formatActivityTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default async function DashboardOverviewPage() {
  const access = await requireDashboardPage('/dashboard')
  const day = manilaToday()

  // Two independent scopes, per branchIdsWith's contract (src/lib/staff/
  // access.ts): view_bookings governs the schedule (day grid,
  // todaysBookings); view_earnings governs money (gross, net). access.can is
  // a UNION across branches and only says whether a section belongs on the
  // page AT ALL — the actual rows/numbers must come from the narrower
  // per-branch list, or a staff member with view_earnings on branch A but not
  // B would see B's money rolled into the stat row.
  const scheduleBranchIds = branchIdsWith(access, 'view_bookings')
  const earningsBranchIds = branchIdsWith(access, 'view_earnings')

  // The top-level empty state is about whether this session has ANY
  // dashboard access at all, not about either narrower scope — someone
  // granted only view_earnings (no view_bookings anywhere) still has a real
  // dashboard (at least the money row) and must not see "no branches shared".
  const branchCount = access.branches.length

  const { stats, courts, openHour, closeHour, todaysBookings, pendingCourts, activity } =
    await getOwnerOverview(scheduleBranchIds, day)

  // Gross/net specifically need the earnings scope: getOwnerOverview has no
  // narrower entry point for just the money row, so — per the existing query
  // signatures — a second, smaller-scoped call is what's available short of
  // changing queries.ts. Skipped entirely (null) when the scope is empty: no
  // query, and the two money StatCards don't render at all.
  const earningsStats =
    earningsBranchIds.length > 0 ? (await getOwnerOverview(earningsBranchIds, day)).stats : null

  return (
    <>
      <header className="mb-8">
        <span className="font-mono mb-2 block text-[11px] tracking-[.14em] text-[var(--ink-soft)] uppercase">
          {formatDateLabel(day)}
        </span>
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Overview
        </h1>
      </header>

      {branchCount === 0 ? (
        <p className={EMPTY_PANEL}>
          {access.isOwner
            ? "No branches yet — once you add a branch and your courts are approved, this is where the day's bookings appear."
            : 'No branches are shared with you yet. Ask the venue owner to grant you access.'}
        </p>
      ) : (
        <>
          {/* Gross and net are earnings data, scoped to earningsStats (the
              earnings-scoped call) rather than the schedule-scoped `stats`
              above: a front-desk staff member without view_earnings on ANY
              branch sees the schedule columns only, and one with it on only
              some of their branches sees numbers computed from exactly
              those branches, never their full branch list. Bookings this
              week/Occupancy mirror the same rule for the schedule scope: a
              staff member with view_earnings but no view_bookings anywhere
              must not see "0 bookings this week" — that reads as a real,
              scoped answer instead of "not visible to you" — so those two
              cards are gated on scheduleBranchIds exactly like the money
              cards are gated on earningsStats. The grid narrows to however
              many cards actually render rather than leaving holes. */}
          {(scheduleBranchIds.length > 0 || earningsStats) && (
            <div
              className={`mb-6 grid gap-4 max-[980px]:grid-cols-2 ${
                scheduleBranchIds.length > 0 && earningsStats ? 'grid-cols-4' : 'grid-cols-2'
              }`}
            >
              {scheduleBranchIds.length > 0 && (
                <>
                  <StatCard kicker="Bookings this week" value={String(stats.bookingsThisWeek)} />
                  <StatCard
                    kicker="Occupancy"
                    value={stats.occupancyPct === null ? '—' : `${stats.occupancyPct}%`}
                  />
                </>
              )}
              {earningsStats && (
                <>
                  <StatCard kicker="Gross revenue" value={formatPeso(earningsStats.grossCentavos)} />
                  <StatCard kicker="Net after fees" value={formatPeso(earningsStats.netCentavos)} />
                </>
              )}
            </div>
          )}

          <div
            className={`mb-6 grid gap-6 max-[980px]:grid-cols-1 ${
              scheduleBranchIds.length > 0 ? 'grid-cols-[1.6fr_1fr]' : 'grid-cols-1'
            }`}
          >
            {/* Staff with no view_bookings grant anywhere get no schedule
                section at all — not an empty/misleading grid — since
                todaysBookings above is itself scoped to scheduleBranchIds and
                would otherwise render a grid with no columns. */}
            {scheduleBranchIds.length > 0 && (
              <section
                aria-label="Today's bookings"
                className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
              >
                <h2 className="font-display mb-3.5 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                  Today&apos;s bookings
                </h2>
                <OwnerDayGrid
                  courts={courts}
                  openHour={openHour}
                  closeHour={closeHour}
                  bookings={todaysBookings}
                />
              </section>
            )}

            <section
              aria-label="Pending approval"
              className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
            >
              <h2 className="font-display mb-3.5 text-[15px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                Pending approval
              </h2>
              {pendingCourts.length > 0 ? (
                <ul className="flex flex-col gap-3.5">
                  {pendingCourts.map((court) => (
                    <li key={court.id} className="flex items-center justify-between gap-3">
                      <div className="text-[13.5px] text-[var(--ink)]">
                        {court.name} – {court.branchName}
                        <span className="mt-0.5 block text-[12px] text-[var(--ink-soft)]">
                          Submitted {formatDateLabel(court.createdAt)}
                        </span>
                      </div>
                      <span className="font-mono shrink-0 rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[10.5px] tracking-[.05em] text-[var(--court-deep)] uppercase">
                        Pending
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-[var(--ink-soft)]">No courts awaiting approval.</p>
              )}
            </section>
          </div>

          <section
            aria-label="Recent activity"
            className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
          >
            <h2 className="font-display mb-1 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
              Recent activity
            </h2>
            {activity.length > 0 ? (
              <ul className="flex flex-col">
                {activity.map((item, i) => (
                  <li
                    key={i}
                    className={`flex items-center gap-3 py-3 ${
                      i > 0 ? 'border-t border-[var(--hairline)]' : ''
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        item.kind === 'review'
                          ? 'border border-[var(--ink)] bg-[var(--ball)]'
                          : 'bg-[var(--court)]'
                      }`}
                    />
                    <time className="font-mono w-[104px] shrink-0 text-[11.5px] text-[var(--ink-soft)]">
                      {formatActivityTimestamp(item.at)}
                    </time>
                    <p className="min-w-0 text-[13.5px] text-[var(--ink)]">{item.text}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-[var(--ink-soft)]">No recent activity yet.</p>
            )}
          </section>
        </>
      )}
    </>
  )
}
