import 'server-only'
import { redirect } from 'next/navigation'
import {
  AuthError,
  requireAdmin,
  requireOwner,
  requirePlayer,
  requireUser,
  type SessionUser,
} from '@/lib/auth/guards'
import { loadDashboardAccess, type DashboardAccess } from '@/lib/staff/access'
import { safeNextPath } from './next-path'

/**
 * Page-flavored guards. The guards in ./guards.ts throw AuthError, which is
 * right for a Server Action returning a result to a form. A Server Component
 * has no such channel — an uncaught throw renders the error boundary, which is
 * a worse answer than "sign in first". These redirect instead.
 *
 * `next` is the path to come back to after sign-in. It is a literal path from
 * the calling page, never user input, but it still goes through the same
 * same-origin check the callback applies (see src/lib/auth/next-path.ts, added
 * in Task 2) so there is exactly one definition of an acceptable `next`.
 */
export async function requireUserPage(next: string): Promise<SessionUser> {
  try {
    return await requireUser()
  } catch (error) {
    if (error instanceof AuthError) redirect(`/login?next=${encodeURIComponent(safeNextPath(next))}`)
    throw error
  }
}

/**
 * Owner pages. A signed-out visitor goes to login; a signed-in PLAYER goes to
 * /bookings rather than an error page — that is where their dashboard actually
 * is, and telling them "403" when a correct destination exists is unhelpful.
 */
export async function requireOwnerPage(next: string): Promise<SessionUser> {
  try {
    return await requireOwner()
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.status === 401) redirect(`/login?next=${encodeURIComponent(safeNextPath(next))}`)
      redirect('/bookings')
    }
    throw error
  }
}

/**
 * Player pages. A signed-out visitor goes to login; a signed-in OWNER or ADMIN
 * goes to /dashboard rather than an error page — owners can never have
 * bookings, so /bookings has nothing to render for them, and their real
 * destination exists.
 *
 * This cannot ping-pong with requireDashboardPage's "no role, no grants ->
 * /bookings" redirect: that guard's `isOwner` is the same
 * `role === 'owner' || role === 'admin'` predicate requireOwner uses, so
 * everyone this function sends to /dashboard is admitted there.
 */
export async function requirePlayerPage(next: string): Promise<SessionUser> {
  try {
    return await requirePlayer()
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.status === 401) redirect(`/login?next=${encodeURIComponent(safeNextPath(next))}`)
      redirect('/dashboard')
    }
    throw error
  }
}

/**
 * The /dashboard/* gate, and the one guard that admits staff.
 *
 * "Owner, or holds at least one branch_staff row." A signed-out visitor goes
 * to login (via requireUserPage, so the same-origin `next` rule is shared); a
 * signed-in player with no grants goes to /bookings, which is their actual
 * home.
 *
 * Returns the resolved access rather than just the user: the layout needs it
 * for the sidebar, and every page needs its `branches` list to scope queries.
 * App Router cannot pass a value from a layout to a page, so each page calls
 * this again — a claims read, one indexed profile lookup, and one indexed
 * branch/grant query. That is the same cost the previous slice already paid
 * calling requireOwnerPage per page.
 */
export async function requireDashboardPage(next: string): Promise<DashboardAccess> {
  const user = await requireUserPage(next)
  const access = await loadDashboardAccess(user)
  if (!access.isOwner && access.branches.length === 0) redirect('/bookings')
  return access
}

/**
 * The /admin/* gate.
 *
 * A signed-out visitor goes to login carrying the path back; ANY signed-in
 * non-admin goes to `/`. Not /dashboard and not /bookings: unlike the owner
 * and player guards, there is no role-appropriate equivalent of this page to
 * send someone to, and answering every wrong role identically keeps the
 * redirect from telling an owner something a player is not told.
 *
 * The layout calls this once so every /admin/* page is gated by construction,
 * and every page calls it again — the same two-layer pattern /dashboard uses.
 * App Router cannot pass a value from a layout to a page, so the second call
 * is what makes each page's own data fetching gated rather than gated-by-
 * assumption. The cost is a claims read and one indexed profile lookup.
 */
export async function requireAdminPage(next: string): Promise<SessionUser> {
  try {
    return await requireAdmin()
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.status === 401) redirect(`/login?next=${encodeURIComponent(safeNextPath(next))}`)
      redirect('/')
    }
    throw error
  }
}
