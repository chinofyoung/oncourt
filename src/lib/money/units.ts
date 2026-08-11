/**
 * Conversions between what a person types into a form and what the database
 * stores: integer centavos for money, integer basis points for percentages.
 *
 * Deliberately IMPORT-FREE. The admin fee form is a client component, and a
 * module it reaches that transitively imports `@/db` or `server-only` compiles
 * and lints clean, then 500s at runtime. Nothing here touches a database, a
 * session, or the filesystem — it is arithmetic over strings and integers.
 *
 * These format functions are NOT formatPeso. formatPeso renders money for a
 * human to read (`₱1,022.90`); these render a value for an <input> to hold and
 * round-trip. A ₱ or a thousands separator in an input's value comes straight
 * back as unparseable on the next submit.
 */

export const PESOS_TO_CENTAVOS = 100
export const BPS = 10_000

/** Two decimal places at most, no sign, no exponent, no separators. */
const DECIMAL_RE = /^\d+(\.\d{1,2})?$/

/**
 * Every column these values reach is a Postgres `integer` (int4), so this is
 * the real ceiling — above it a value either loses precision in IEEE-754 or
 * overflows the column with a raw 22003 the admin cannot act on. The shape
 * regex admits arbitrarily long digit strings, so the bound has to be here.
 */
const MAX_INT4 = 2_147_483_647

/**
 * The regex runs BEFORE any arithmetic so '10.555' is rejected rather than
 * silently rounded to 1056 — a fee the admin never typed.
 *
 * Math.round is load-bearing: 10.55 * 100 is 1054.9999999999999 in IEEE-754,
 * and a truncating cast would store 1054.
 *
 * Number.isSafeInteger guards the other side of that same coin: past
 * Number.MAX_SAFE_INTEGER, `Number(trimmed) * 100` silently loses precision
 * and Math.round returns a WRONG integer rather than failing loudly — the one
 * thing this module's "null if unusable" contract must never do. MAX_INT4
 * catches everything below that threshold but still too big for the int4
 * columns every consumer writes to.
 */
function parseToHundredths(raw: string): number | null {
  const trimmed = raw.trim()
  if (!DECIMAL_RE.test(trimmed)) return null
  const value = Math.round(Number(trimmed) * 100)
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4 ? value : null
}

/** '10' | '10.5' | '10%' → 1000 | 1050 | 1000. Null if unusable. */
export function parsePercentToBps(raw: string): number | null {
  const withoutSign = raw.trim().replace(/\s*%$/, '')
  const bps = parseToHundredths(withoutSign)
  if (bps === null) return null
  // Mirrors platform_settings_percentage_ceiling / profiles_fee_percentage_ceiling.
  return bps <= BPS ? bps : null
}

/** '250' | '250.50' → 25000 | 25050. Null if unusable. No ceiling here. */
export function parsePesosToCentavos(raw: string): number | null {
  return parseToHundredths(raw)
}

/**
 * String(bps / 100) rather than toFixed: JavaScript prints the shortest
 * representation that round-trips, so 1050 → '10.5' and 1055 → '10.55' with no
 * trailing-zero trimming to get wrong. Exponent notation cannot appear because
 * bps is bounded to [1, 10000] → [0.01, 100].
 */
export function formatBpsAsPercent(bps: number): string {
  return String(bps / 100)
}

/**
 * Pesos pad to two decimals when there is a fractional part and to none when
 * there is not — the same "never a trailing .00" rule formatPeso follows.
 */
export function formatCentavosAsPesos(centavos: number): string {
  return centavos % PESOS_TO_CENTAVOS === 0
    ? String(centavos / PESOS_TO_CENTAVOS)
    : (centavos / PESOS_TO_CENTAVOS).toFixed(2)
}
