import 'server-only'
import { redirect } from 'next/navigation'
import {
  AuthError,
  requireOwner,
  requirePlayer,
  requireUser,
  type SessionUser,
} from '@/lib/auth/guards'
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
