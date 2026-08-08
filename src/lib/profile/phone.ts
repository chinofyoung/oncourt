/**
 * A Philippine mobile number in one canonical form, or null.
 *
 * IMPORT-FREE ON PURPOSE. src/components/player/profile-completion-panel.tsx
 * is a client component and value-imports this; a module that transitively
 * reaches `server-only` type-checks and lints clean, then 500s the page at
 * runtime.
 *
 * Accepts the three shapes a Filipino player actually types — `09XXXXXXXXX`,
 * `+639XXXXXXXXX`, `639XXXXXXXXX` — and stores all three as `+639XXXXXXXXX`,
 * so one person's number has exactly one representation in the database.
 *
 * Mobile only, deliberately: this field exists so a court can reach a player
 * about their booking, and every PH mobile is `9`-series. A landline would
 * pass a laxer check and fail the only purpose the field has.
 */
export function normalizePhPhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-()]/g, '')
  const national = digits.startsWith('+63')
    ? digits.slice(3)
    : digits.startsWith('63')
      ? digits.slice(2)
      : digits.startsWith('0')
        ? digits.slice(1)
        : null
  if (national === null) return null
  if (!/^9\d{9}$/.test(national)) return null
  return `+63${national}`
}
