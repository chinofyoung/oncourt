// Shared, framework-neutral module: NOT 'use client', NOT 'server-only'.
//
// accountLinks() is called directly by the Server Component <Nav> (nav.tsx)
// and also called + rendered by the Client Component <AccountMenu>
// (account-menu.tsx). A 'use client' file's exports become client
// references — callable only as a rendered Component or a prop, never as a
// plain function — so a Server Component calling accountLinks() from
// account-menu.tsx throws at runtime even though tsc and the build stay
// clean (types are erased, so this class of bug isn't caught by either
// gate). Putting it in 'server-only' would break the opposite direction:
// account-menu.tsx imports it from the client. So this function (and the
// types it needs) can't live in either file — it lives here, owned by
// neither side.

export type AccountMenuUser = {
  email: string
  fullName: string | null
  avatarUrl: string | null
  role: 'player' | 'owner' | 'admin'
  /** Holds >= 1 branch_staff row. Only ever true for role 'player' — see <Nav>. */
  isStaff: boolean
}

export type AccountLink = { href: string; label: string }

/**
 * The ordered list of "where do I go" destinations for a signed-in user.
 * `AccountMenu` renders all of them; `Nav` (a Server Component that cannot
 * import anything reaching `@/db`, which is exactly why this stays a pure
 * function with no such import) renders only the first, as a direct link
 * beside the avatar. One function instead of two copies of this role
 * precedence rule is the point — a menu and a nav link that derived it
 * separately would eventually drift.
 *
 * An admin's list is Admin ONLY, never Owner dashboard alongside it
 * (2026-08-07 user ruling, reversing an earlier "alongside it" decision):
 * /dashboard's queries do filter on owner_id, so an admin who is also an
 * owner would technically only see their own branches there, but that
 * "technically still correct" case is not the point — the menu is answering
 * "what are you, here", and surfacing /dashboard next to /admin makes it
 * look like an admin is still acting as an owner day to day, which is not
 * the intended framing.
 *
 * Owners and admins never get "My bookings": they can never have one, and
 * /bookings redirects them straight back to /dashboard, so an item pointing
 * at a redirect is worse than no item.
 *
 * A staff player (`isStaff`) gets "Venue dashboard" listed BEFORE "My
 * bookings" (deliberately reordered from an earlier "My bookings" first) —
 * someone who works at a venue opens the dashboard daily and checks their
 * own bookings only occasionally, and since `Nav` promotes whichever entry
 * comes first, this order is also what decides which one becomes the direct
 * link.
 */
export function accountLinks(user: AccountMenuUser): AccountLink[] {
  if (user.role === 'admin') return [{ href: '/admin', label: 'Admin' }]
  if (user.role === 'owner') return [{ href: '/dashboard', label: 'Owner dashboard' }]
  if (user.isStaff) {
    return [
      { href: '/dashboard', label: 'Venue dashboard' },
      { href: '/bookings', label: 'My bookings' },
    ]
  }
  return [{ href: '/bookings', label: 'My bookings' }]
}
