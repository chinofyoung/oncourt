import { expect, test } from 'vitest'
import { safeNextPath } from '@/lib/auth/next-path'

test('passes through a same-origin path', () => {
  expect(safeNextPath('/bookings')).toBe('/bookings')
  expect(safeNextPath('/dashboard/earnings?month=2026-08')).toBe('/dashboard/earnings?month=2026-08')
})

test('falls back to / for absent or empty input', () => {
  expect(safeNextPath(null)).toBe('/')
  expect(safeNextPath(undefined)).toBe('/')
  expect(safeNextPath('')).toBe('/')
})

test('rejects an absolute URL to another origin', () => {
  // `${origin}${next}` would concatenate into
  // "http://localhost:3000https://evil.com" — not an open redirect, but
  // NextResponse.redirect's internal validateURL throws on it, turning a
  // crafted query param into a 500 on the login path.
  expect(safeNextPath('https://evil.com')).toBe('/')
  expect(safeNextPath('http://evil.com/x')).toBe('/')
})

test('rejects a protocol-relative URL, which a leading-slash check alone accepts', () => {
  // "//evil.com" starts with "/" and IS a real cross-origin destination —
  // browsers read it as protocol-relative. This is the case a naive
  // startsWith('/') test lets through.
  expect(safeNextPath('//evil.com')).toBe('/')
  expect(safeNextPath('/\\evil.com')).toBe('/')
})

test('rejects a scheme-relative or non-path value', () => {
  expect(safeNextPath('javascript:alert(1)')).toBe('/')
  expect(safeNextPath('bookings')).toBe('/')
})

test('strips ASCII control characters (tab, CR, LF) that browsers would strip before resolving', () => {
  // Per WHATWG URL spec, browsers strip ASCII tab, CR, LF before resolving.
  // A path like `/\t/evil.com` would pass a naive check, then resolve as
  // `//evil.com` (protocol-relative) after the tab is stripped.
  expect(safeNextPath('/\t/evil.com')).toBe('/')
  expect(safeNextPath('/\r/evil.com')).toBe('/')
  expect(safeNextPath('/\n/evil.com')).toBe('/')
  // Control character embedded in a legitimate path is stripped, not carried onward.
  expect(safeNextPath('/book\tings')).toBe('/bookings')
  expect(safeNextPath('/dash\rboard')).toBe('/dashboard')
  expect(safeNextPath('/path\nto\npage')).toBe('/pathtopage')
})
