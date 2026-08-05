/**
 * Normalizes a `?next=` value to a path that is definitely on this origin.
 *
 * Consolidated from src/app/auth/callback/route.ts, which carried this rule
 * inline. Two copies of a redirect check drift apart; this one is tested.
 *
 * A leading "/" alone is NOT sufficient: "//evil.com" and "/\evil.com" both
 * start with a slash and both resolve cross-origin in a browser
 * (protocol-relative). So the second character must not be another slash or a
 * backslash.
 *
 * Additionally, per the WHATWG URL spec, browsers strip ASCII tab (`\t`), CR
 * (`\r`), and LF (`\n`) from URLs before resolving them. So `/\t/evil.com`
 * would pass a naive check but resolve as `//evil.com` in a browser — a
 * protocol-relative cross-origin destination. We strip these characters before
 * checking and return the cleaned value to prevent them being carried onward.
 * (Hardening beyond the implementation plan to close this control-character bypass.)
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return '/'
  // Strip ASCII tab, CR, LF per WHATWG URL spec (browsers strip these before resolving).
  const cleaned = raw.replace(/[\t\r\n]/g, '')
  if (!cleaned.startsWith('/')) return '/'
  if (cleaned.length > 1 && (cleaned[1] === '/' || cleaned[1] === '\\')) return '/'
  return cleaned
}
