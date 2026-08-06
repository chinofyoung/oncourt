import type { Role } from '@/lib/auth/guards'

/**
 * Where "List your court" goes.
 *
 * These CTAs pointed at /login from the day the home page was built, and
 * /login was a dead end for the one person who clicked them: owner accounts
 * stopped being self-serve in the roles slice, so signing in taught a
 * would-be owner nothing. The admin promote screen (added in this slice) is
 * the screen that grants the account — and it is an ADMIN screen, so a visitor
 * must never be sent to it.
 *
 * PURE, and takes the role rather than the user, so a client component can
 * call it too and so the test needs no database.
 */
export const OWNER_CTA_ANCHOR = '/#for-owners'

export function ownerCtaHref(role: Role | null): string {
  // The same predicate requireOwner and loadDashboardAccess use for "is this
  // an owner at all" — an admin is admitted to /dashboard, where they see the
  // branches they personally own.
  if (role === 'owner' || role === 'admin') return '/dashboard/listings'
  // Signed in, but not an owner: no screen exists that would make them one, so
  // the explainer is the honest destination.
  if (role !== null) return OWNER_CTA_ANCHOR
  return `/login?next=${encodeURIComponent('/dashboard/listings')}`
}
