import Link from 'next/link'
import type { OwnerCalendarDay } from '@/lib/owner/queries'
import { formatDateLabel, formatPeso } from '@/lib/format'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * Monday-first is a DISPLAY concern only. Postgres's extract(dow) and
 * court_operating_hours.day_of_week are both 0=Sunday..6=Saturday, and the
 * capacity join in getOwnerMonthCalendar depends on that — this conversion
 * exists solely to place a date in a column. Never push it into SQL: doing so
 * shifts every day's capacity by one weekday, which looks like plausible data
 * rather than an error.
 */
function mondayIndex(weekday: number): number {
  return (weekday + 6) % 7
}

export function MonthCalendar({
  days,
  month,
  branchId,
  today,
  selectedDay,
  weekdayOfFirst,
  showEarnings,
}: {
  days: OwnerCalendarDay[]
  month: string
  branchId?: string
  today: string
  selectedDay?: string
  weekdayOfFirst: number
  /**
   * Whether this viewer's view_earnings scope covers every branch currently
   * in view (see the `showEarnings` computation in
   * src/app/dashboard/bookings/page.tsx). `grossCentavos` is already 0 for
   * an out-of-scope branch (getOwnerMonthCalendar redacts at the query), but
   * 0-because-redacted and 0-because-nothing-happened are different facts —
   * this flag is what keeps the cell from asserting the wrong one. False
   * hides the money line entirely rather than printing a ₱0 that isn't real.
   */
  showEarnings: boolean
}) {
  const lead = mondayIndex(weekdayOfFirst)
  const href = (day: string) =>
    `/dashboard/bookings?tab=calendar&month=${month}${branchId ? `&branch=${branchId}` : ''}&day=${day}`

  // Defensive on the component's own terms: today the page only ever passes
  // an empty `days` array when `getOwnerMonthCalendar` returned early for an
  // empty branch scope (it routes that case to its own empty-state message
  // instead of rendering this component at all), so this is inert in
  // practice — but a component shouldn't rely on its caller to keep it safe.
  // Without this, an empty array renders the weekday header, `lead` leading
  // blank cells, and then nothing else: not a crash, but a grid that looks
  // broken rather than empty.
  if (days.length === 0) {
    return (
      <p className="rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]">
        Nothing to show for this month.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        <div className="mb-1 grid grid-cols-7 gap-1.5">
          {WEEKDAYS.map((label) => (
            <div
              key={label}
              className="font-mono px-1 text-[10px] tracking-[.14em] text-[var(--ink-soft)] uppercase"
            >
              {label}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1.5">
          {Array.from({ length: lead }, (_, i) => (
            <div key={`lead-${i}`} aria-hidden />
          ))}
          {days.map((day) => {
            // occupancyPct is null exactly when capacityHours is 0 — but zero
            // capacity does not imply nothing happened: a maintenance block is
            // precisely the thing scheduled on a day the owner has closed, and
            // last week's confirmed bookings survive an operating-hours edit
            // that closes today's weekday going forward. `closed` (the
            // non-clickable, count-free cell) is reserved for the case where
            // there is truly nothing to show; a zero-capacity day carrying real
            // rows instead falls through to the normal clickable cell below,
            // with a "Closed" marker layered on top and the occupancy tint
            // left off (there is nothing to divide by).
            const zeroCapacity = day.occupancyPct === null
            const closed = zeroCapacity && day.bookingCount === 0 && day.blockCount === 0
            const isToday = day.date === today
            const isSelected = day.date === selectedDay
            const dayNumber = Number(day.date.slice(8, 10))
            const cell = (
              <>
                <span className="font-display text-[13px] font-bold">{dayNumber}</span>
                {closed ? (
                  <span className="font-mono mt-1 block text-[10px] text-[var(--slot-off-ink)] uppercase">
                    Closed
                  </span>
                ) : (
                  <>
                    {zeroCapacity && (
                      <span className="font-mono mt-1 block text-[10px] text-[var(--slot-off-ink)] uppercase">
                        Closed
                      </span>
                    )}
                    <span className="mt-1 block text-[11.5px] text-[var(--ink)]">
                      {day.bookingCount} {day.bookingCount === 1 ? 'booking' : 'bookings'}
                    </span>
                    {showEarnings && (
                      <span className="font-mono block text-[11px] text-[var(--ink-soft)]">
                        {formatPeso(day.grossCentavos)}
                      </span>
                    )}
                    {day.blockCount > 0 && (
                      <span className="font-mono block text-[10px] text-[var(--ink-soft)]">
                        {day.blockCount} blocked
                      </span>
                    )}
                  </>
                )}
              </>
            )
            const base = `relative block min-h-[86px] rounded-[10px] border p-2 text-left ${
              isSelected ? 'border-[var(--ink)] border-[1.5px]' : 'border-[var(--hairline)]'
            } ${isToday ? 'ring-1 ring-[var(--court)]' : ''}`
            if (closed) {
              // Same fill+ink pairing branding.md already defines for the
              // availability grid's own "Closed" state (~5.41:1) — reused
              // here rather than a faded `--surface`, which under the
              // `opacity-70` this replaced measured only ~2.89:1, below both
              // the 4.5:1 normal-text and 3:1 large-text AA floors.
              return (
                <div key={day.date} className={`${base} bg-[var(--slot-off)]`}>
                  {cell}
                </div>
              )
            }
            const blockedLabel = day.blockCount > 0 ? `, ${day.blockCount} blocked` : ''
            const earningsLabel = showEarnings ? `, ${formatPeso(day.grossCentavos)}` : ''
            // `occupancyPct` is null on a zero-capacity day, which must not
            // render as the literal string "null% booked" — say "closed"
            // instead, matching the "Closed" marker `cell` shows for the same
            // case.
            const occupancyLabel =
              day.occupancyPct === null ? ', closed' : `, ${day.occupancyPct}% booked`
            const ariaLabel = `${formatDateLabel(day.date)}, ${day.bookingCount} ${
              day.bookingCount === 1 ? 'booking' : 'bookings'
            }${earningsLabel}${blockedLabel}${occupancyLabel}`
            return (
              <Link
                key={day.date}
                href={href(day.date)}
                aria-label={ariaLabel}
                className={`${base} bg-[var(--panel)] transition-colors hover:border-[var(--court)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--court)] motion-reduce:transition-none`}
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-[10px] bg-[var(--court)]"
                  // Occupancy can exceed 100% when a booking sits outside
                  // operating hours (e.g. an hours edit narrowed the window
                  // after the booking was made) — clamp so the tint never
                  // overshoots full opacity.
                  style={{ opacity: (Math.min(day.occupancyPct ?? 0, 100)) / 100 * 0.18 }}
                />
                <span className="relative">{cell}</span>
              </Link>
            )
          })}
        </div>
      </div>
    </div>
  )
}
