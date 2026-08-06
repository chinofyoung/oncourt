import { formatHour } from '@/lib/format'
import type { OwnerGridBooking, OwnerGridCourt } from '@/lib/owner/queries'

/**
 * Today's bookings as time rows × court columns.
 *
 * Deliberately NOT a reuse of src/components/availability-grid.tsx. The two
 * look alike and mean different things: that grid shows prices and is
 * clickable to book, this one shows who booked and is not interactive.
 * Overloading one component with both would tangle the booking path with a
 * reporting view.
 *
 * Also renders `blocked` rows alongside bookings — a maintenance block or
 * walk-in occupies a slot exactly like a booking does, and the grid would
 * lie about what's free if it dropped them. Distinguished from a real
 * booking by `isBlock`. Deliberately read-only: the unblock control lives on
 * /dashboard/bookings, where a table row has room for it.
 *
 * Per branding.md's mobile rule, the table scrolls inside its own container
 * with a sticky first column; the page itself never scrolls sideways.
 */
export function OwnerDayGrid({
  courts,
  openHour,
  closeHour,
  bookings,
}: {
  courts: OwnerGridCourt[]
  openHour: number
  closeHour: number
  bookings: OwnerGridBooking[]
}) {
  if (courts.length === 0) {
    return (
      <p className="rounded-[14px] border border-dashed border-[var(--hairline)] px-5 py-10 text-center text-sm text-[var(--ink-soft)]">
        No courts yet. Once your courts are approved, the day&apos;s bookings show up here.
      </p>
    )
  }

  const hours = Array.from({ length: Math.max(closeHour - openHour, 0) }, (_, i) => openHour + i)

  // One lookup per (courtId, hour) rather than scanning `bookings` inside the
  // render loop: a booking spans startHour..endHour, so every covered hour
  // gets an entry pointing at the same booking.
  const byCell = new Map<string, OwnerGridBooking>()
  for (const booking of bookings) {
    for (let hour = booking.startHour; hour < booking.endHour; hour++) {
      byCell.set(`${booking.courtId}:${hour}`, booking)
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-left">
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-[1] bg-[var(--panel)]" />
            {courts.map((court) => (
              <th key={court.courtId} scope="col" className="px-3 pb-3 align-bottom">
                <span className="block text-[13px] font-semibold text-[var(--ink)]">
                  {court.branchName}
                </span>
                <span className="font-mono block text-[10.5px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                  {court.courtName}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {hours.map((hour) => (
            <tr key={hour}>
              <td className="font-mono sticky left-0 z-[1] bg-[var(--panel)] pr-4 py-1 text-[11.5px] whitespace-nowrap text-[var(--ink-soft)]">
                {formatHour(hour)}
              </td>
              {courts.map((court) => {
                const booking = byCell.get(`${court.courtId}:${hour}`)
                return (
                  <td key={court.courtId} className="px-1.5 py-1">
                    {booking ? (
                      /* Blocks read differently from bookings on purpose: a
                         soft --band-off chip (the mockup's .cell-fill look)
                         versus a solid --court-deep block. Same information
                         density, immediately distinguishable at a glance, and
                         no color outside branding.md's palette. Read-only —
                         the unblock control lives on /dashboard/bookings,
                         where a table row has room for it and a 30px grid
                         cell does not. */
                      <div
                        title={booking.isBlock ? `Blocked — ${booking.label}` : booking.label}
                        className={`truncate rounded-[8px] px-2.5 py-1.5 text-[12px] font-semibold ${
                          booking.isBlock
                            ? 'font-mono bg-[var(--band-off)] text-[var(--court-deep)]'
                            : 'bg-[var(--court-deep)] text-white'
                        }`}
                      >
                        {booking.label}
                      </div>
                    ) : (
                      <div className="h-[30px] rounded-[8px] bg-[var(--surface)]" />
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
