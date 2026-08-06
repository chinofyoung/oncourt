import { expect, test } from 'vitest'
import { isActiveNavItem } from '@/lib/site/nav-active'

test('exact match is active', () => {
  expect(isActiveNavItem('/dashboard/bookings', '/dashboard/bookings')).toBe(true)
  expect(isActiveNavItem('/admin/owners', '/admin/owners')).toBe(true)
})

test('child route is active for its section href', () => {
  expect(isActiveNavItem('/dashboard/listings/abc/courts/def', '/dashboard/listings')).toBe(true)
})

test('root hrefs (/dashboard, /admin) do not bleed onto sibling sections', () => {
  // /dashboard is the Overview item's href — it must not stay lit while a
  // player is on /dashboard/bookings, or every item would appear active.
  expect(isActiveNavItem('/dashboard/bookings', '/dashboard')).toBe(false)
  // Same shape for the admin shell's root: /admin is Approvals, /admin/owners
  // is a sibling section, not a child of it.
  expect(isActiveNavItem('/admin/owners', '/admin')).toBe(false)
})

test('sibling routes that share a prefix are not falsely active', () => {
  // Without the trailing '/' in the startsWith check, "/dashboard/bookings"
  // would be treated as a prefix of "/dashboard/bookings-x", lighting up
  // Bookings while looking at an unrelated route.
  expect(isActiveNavItem('/dashboard/bookings-x', '/dashboard/bookings')).toBe(false)
})

test('identity on a nested (non-root) href', () => {
  expect(isActiveNavItem('/admin/owners', '/admin/owners')).toBe(true)
})
