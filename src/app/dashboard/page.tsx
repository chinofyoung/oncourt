import { StatCard } from '@/components/dashboard/stat-card'
import { OwnerDayGrid } from '@/components/dashboard/owner-day-grid'
import { requireOwnerPage } from '@/lib/auth/page-guards'
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
  const user = await requireOwnerPage('/dashboard')
  const day = manilaToday()
  const { branchCount, stats, courts, openHour, closeHour, todaysBookings, pendingCourts, activity } =
    await getOwnerOverview(user.id, day)

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
          No branches yet — once you add a branch and your courts are approved, this is where the
          day&apos;s bookings appear.
        </p>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-4 gap-4 max-[980px]:grid-cols-2">
            <StatCard kicker="Bookings this week" value={String(stats.bookingsThisWeek)} />
            <StatCard
              kicker="Occupancy"
              value={stats.occupancyPct === null ? '—' : `${stats.occupancyPct}%`}
            />
            <StatCard kicker="Gross revenue" value={formatPeso(stats.grossCentavos)} />
            <StatCard kicker="Net after fees" value={formatPeso(stats.netCentavos)} />
          </div>

          <div className="mb-6 grid grid-cols-[1.6fr_1fr] gap-6 max-[980px]:grid-cols-1">
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
