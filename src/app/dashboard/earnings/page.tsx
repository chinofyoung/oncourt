import Link from 'next/link'
import { StatCard } from '@/components/dashboard/stat-card'
import { requireOwnerPage } from '@/lib/auth/page-guards'
import { getOwnerEarnings } from '@/lib/owner/queries'
import { manilaToday } from '@/lib/date-manila'
import { formatPeso } from '@/lib/format'

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const NAV_LINK =
  `inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3 text-[13px] font-semibold text-[var(--ink)] hover:border-[var(--court)] ${FOCUS_RING}`

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * Pure string/date math on `YYYY-MM` — there is no month-shift helper in
 * src/lib/date-manila.ts (and this task keeps it local rather than adding
 * one there). Careful at both year boundaries:
 * shiftMonth('2026-01', -1) -> '2025-12', shiftMonth('2026-12', 1) -> '2027-01'.
 */
function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split('-').map(Number)
  const zeroBased = mon - 1 + delta
  const newYear = year + Math.floor(zeroBased / 12)
  const newMonth = ((zeroBased % 12) + 12) % 12
  return `${newYear}-${String(newMonth + 1).padStart(2, '0')}`
}

/**
 * `August 2026` from a `YYYY-MM` string. Parses through `Date.UTC` and
 * formats with `timeZone: 'UTC'`, mirroring formatDateLabel() in
 * src/lib/format.ts, so the label reflects the string's own year/month
 * rather than shifting a day in the runtime's local timezone.
 */
function formatMonthLabel(month: string): string {
  const [year, mon] = month.split('-').map(Number)
  return new Date(Date.UTC(year, mon - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export default async function OwnerEarningsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const user = await requireOwnerPage('/dashboard/earnings')
  const { month: rawMonth } = await searchParams

  // An invalid or missing `?month=` falls back to the current Manila month
  // rather than reaching getOwnerEarnings' `::date` cast with something that
  // isn't a valid `YYYY-MM`.
  const currentMonth = manilaToday().slice(0, 7)
  const month = rawMonth && MONTH_RE.test(rawMonth) ? rawMonth : currentMonth

  const { rows, totals } = await getOwnerEarnings(user.id, month)

  return (
    <>
      <header className="mb-8">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Earnings
        </h1>
      </header>

      <div className="mb-6 flex items-center gap-3">
        <Link href={`/dashboard/earnings?month=${shiftMonth(month, -1)}`} className={NAV_LINK}>
          ← Prev
        </Link>
        <span className="font-mono text-[13.5px] font-semibold whitespace-nowrap text-[var(--ink)]">
          {formatMonthLabel(month)}
        </span>
        <Link href={`/dashboard/earnings?month=${shiftMonth(month, 1)}`} className={NAV_LINK}>
          Next →
        </Link>
      </div>

      <div className="mb-6 grid grid-cols-4 gap-4 max-[980px]:grid-cols-2">
        <StatCard kicker="Bookings" value={String(totals.bookingCount)} />
        <StatCard kicker="Gross" value={formatPeso(totals.grossCentavos)} />
        <StatCard kicker="Platform fee" value={formatPeso(totals.platformFeeCentavos)} />
        <StatCard kicker="Net" value={formatPeso(totals.netCentavos)} />
      </div>

      {/* A zero-booking month is not an error: getOwnerEarnings returns
          `rows: []` plus `totals` zeroed out (see src/lib/owner/queries.ts),
          which renders here as an empty table body under a zeroed tfoot
          totals row — an accurate "no revenue this month", not a broken
          query. No separate empty-state message is added: the StatCards
          above and the tfoot below already read as all zeros. */}
      <div className="overflow-x-auto rounded-[20px] bg-[var(--panel)] shadow-[var(--shadow-sm)]">
        <table className="w-full min-w-[560px] border-collapse text-left">
          <thead>
            <tr className="font-mono border-b border-[var(--hairline)] text-[11px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
              <th className="py-3 pr-4 pl-5 font-normal">Branch</th>
              <th className="py-3 pr-4 text-right font-normal">Bookings</th>
              <th className="py-3 pr-4 text-right font-normal">Gross</th>
              <th className="py-3 pr-4 text-right font-normal">Platform fee</th>
              <th className="py-3 pr-5 text-right font-normal">Net</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.branchId} className="border-b border-[var(--hairline)] last:border-b-0">
                <td className="py-4 pr-4 pl-5 text-[13.5px] text-[var(--ink)]">{row.branchName}</td>
                <td className="font-mono py-4 pr-4 text-right text-[13.5px] text-[var(--ink)]">
                  {row.bookingCount}
                </td>
                <td className="font-mono py-4 pr-4 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                  {formatPeso(row.grossCentavos)}
                </td>
                <td className="font-mono py-4 pr-4 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                  {formatPeso(row.platformFeeCentavos)}
                </td>
                <td className="font-mono py-4 pr-5 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                  {formatPeso(row.netCentavos)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-[var(--hairline)] font-semibold">
              <td className="py-4 pr-4 pl-5 text-[13.5px] text-[var(--ink)]">Total</td>
              <td className="font-mono py-4 pr-4 text-right text-[13.5px] text-[var(--ink)]">
                {totals.bookingCount}
              </td>
              <td className="font-mono py-4 pr-4 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                {formatPeso(totals.grossCentavos)}
              </td>
              <td className="font-mono py-4 pr-4 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                {formatPeso(totals.platformFeeCentavos)}
              </td>
              <td className="font-mono py-4 pr-5 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                {formatPeso(totals.netCentavos)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  )
}
