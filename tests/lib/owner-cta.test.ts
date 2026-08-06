import { expect, test } from 'vitest'
import { OWNER_CTA_ANCHOR, ownerCtaHref } from '@/lib/site/owner-cta'

/**
 * Pure module: no database, no session, no fixtures. Each case is a promise
 * the public CTAs make about where they land — the reason they exist at all is
 * that they used to land, for everyone, on /login and stop there.
 */
test('an owner and an admin go straight to the screen that lists a court', () => {
  expect(ownerCtaHref('owner')).toBe('/dashboard/listings')
  expect(ownerCtaHref('admin')).toBe('/dashboard/listings')
})

test('a signed-in player goes to the explainer, not to a screen they cannot use', () => {
  // Owner accounts are admin-vetted since the roles slice: there is no
  // self-serve promotion screen to send them to, and /admin/owners is for
  // admins. The home page's owner section is the honest destination.
  expect(ownerCtaHref('player')).toBe(OWNER_CTA_ANCHOR)
  expect(OWNER_CTA_ANCHOR).toBe('/#for-owners')
})

test('a signed-out visitor is asked to sign in, and comes back to listings', () => {
  expect(ownerCtaHref(null)).toBe('/login?next=%2Fdashboard%2Flistings')
})
