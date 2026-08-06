/**
 * Shared active-link rule for the dashboard and admin sidebars. Pure and
 * dependency-free (no 'server-only', no 'use client') so both the layout
 * Server Components (for anything that ever needs it server-side) and the
 * client-only <SideNav> can import it without pulling in Next.js internals.
 *
 * `/dashboard` and `/admin` are each a section root AND another item's
 * literal href ("Overview" / "Approvals") — without an exact-match carve-out
 * every other item's route (e.g. /dashboard/bookings) would also satisfy a
 * naive startsWith('/dashboard') and light up two items at once. Every other
 * href is a real subtree, so it's active on itself and on any child route.
 */
export function isActiveNavItem(pathname: string, href: string): boolean {
  if (href === '/dashboard' || href === '/admin') {
    return pathname === href
  }
  return pathname === href || pathname.startsWith(href + '/')
}
