/**
 * Display formatting for money, times and dates.
 *
 * Per design/branding.md, "Currency & data formatting": peso amounts render
 * in mono at the call site (`₱300`, `₱1,022.90`), times as `6 AM` / `7 – 9 AM`
 * (spaced EN DASH, U+2013), dates as `Fri, Aug 1`.
 *
 * Everything here takes integer centavos or integer hours. No float money
 * ever enters or leaves this module — the division by 100 happens at this
 * edge and nowhere else.
 */

const EN_DASH = '–'

/**
 * `₱300` for whole pesos, `₱1,022.90` when there are centavos. Never renders
 * a trailing `.00`, because branding.md's examples don't.
 */
export function formatPeso(centavos: number): string {
  const hasFraction = centavos % 100 !== 0
  return (
    '₱' +
    (centavos / 100).toLocaleString('en-US', {
      minimumFractionDigits: hasFraction ? 2 : 0,
      maximumFractionDigits: 2,
    })
  )
}

/** branding.md's price-from pattern: `from ₱200/hr`. */
export function formatPriceFrom(centavos: number): string {
  return `from ${formatPeso(centavos)}/hr`
}

/**
 * `₱300/hr` for a single rate, `₱300 – ₱450/hr` for a range (spaced EN DASH,
 * same convention as formatHourRange). Both arguments equal collapses to the
 * single-rate form rather than printing a zero-width range.
 */
export function formatPriceRange(minCentavos: number, maxCentavos: number): string {
  return minCentavos === maxCentavos
    ? `${formatPeso(minCentavos)}/hr`
    : `${formatPeso(minCentavos)} ${EN_DASH} ${formatPeso(maxCentavos)}/hr`
}

/**
 * 24h integer hour to a 12h label. Accepts 24, which
 * `court_operating_hours.closes_hour` permits and the fixtures use — it is
 * midnight, and rendering it as `24 AM` was a real bug.
 */
export function formatHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24
  const period = h < 12 ? 'AM' : 'PM'
  const display = h % 12 === 0 ? 12 : h % 12
  return `${display} ${period}`
}

/**
 * `7 – 9 AM` when both ends share a period, `11 AM – 1 PM` when they don't.
 */
export function formatHourRange(start: number, end: number): string {
  const startText = formatHour(start)
  const endText = formatHour(end)
  const [startNumber, startPeriod] = startText.split(' ')
  const endPeriod = endText.split(' ')[1]
  return startPeriod === endPeriod
    ? `${startNumber} ${EN_DASH} ${endText}`
    : `${startText} ${EN_DASH} ${endText}`
}

/**
 * `Fri, Aug 1` from a `YYYY-MM-DD` calendar date.
 *
 * Parses through `Date.UTC` and formats with `timeZone: 'UTC'` so the label
 * is the date's own components — formatting in the runtime's local zone
 * would render the previous day for anyone west of UTC.
 */
export function formatDateLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}
