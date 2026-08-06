'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { signOutAction } from '@/app/auth/sign-out/actions'

export type AccountMenuUser = {
  email: string
  fullName: string | null
  avatarUrl: string | null
  role: 'player' | 'owner' | 'admin'
  /** Holds >= 1 branch_staff row. Only ever true for role 'player' — see <Nav>. */
  isStaff: boolean
}

// One definition instead of the three identical copies this file carried.
// Branded focus-visible ring on every interactive element — Global Constraints.
const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

/**
 * The nav's signed-in control. Replaces a bare avatar badge that was not a
 * link and had no menu, which left a signed-in user with no route to their
 * dashboard and no way to sign out at all.
 *
 * Client component because it owns disclosure state. Deliberately NOT using
 * roving arrow-key focus or role="menu"/role="menuitem": this is a short list
 * of links and one submit button, native Tab order already works, and
 * role="menu" would promise arrow-key semantics that then have to be built and
 * maintained. It is a disclosure (aria-expanded) over ordinary links.
 *
 * An admin gets an Admin item ALONGSIDE the owner dashboard link, not instead
 * of it: the two answer different questions ("my own branches" vs "everyone
 * else's courts"), and /dashboard genuinely works for an admin — its queries
 * filter on owner_id, so they see only what they own there.
 *
 * Item visibility is role-derived: an owner (or admin) loses "My bookings"
 * (they can never have one), and a player holding >= 1 branch_staff grant
 * gains "Venue dashboard" alongside it. `isStaff` is resolved server-side in
 * <Nav> — a client component like this one cannot query the database.
 */
export function AccountMenu({ user, onDark }: { user: AccountMenuUser; onDark: boolean }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Escape closes and returns focus to the trigger; a click outside closes.
  // Both listeners are only attached while open, so a closed menu costs nothing.
  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }

    function onPointerDown(event: PointerEvent) {
      if (containerRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  const isOwner = user.role === 'owner' || user.role === 'admin'
  // Owners can never have bookings, so "My bookings" would always be empty for
  // them and /bookings redirects them away anyway.
  const showBookings = !isOwner
  // Staff get the same dashboard, under a name that describes what they are
  // seeing: they do not own the venue, they work at it. Null means no
  // dashboard item at all — a plain player has no dashboard to go to, and an
  // item pointing somewhere that redirects straight back is worse than none.
  const dashboardLabel = isOwner ? 'Owner dashboard' : user.isStaff ? 'Venue dashboard' : null
  const isAdmin = user.role === 'admin'
  const label = user.fullName ?? user.email
  const initial = (user.fullName ?? user.email).charAt(0).toUpperCase()

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="account-menu-panel"
        aria-label={`Account menu for ${label}`}
        className={`flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border outline-none transition-[filter] duration-150 hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
          onDark
            ? 'border-white/[.28] focus-visible:outline-[var(--ball)]'
            : 'border-[var(--hairline)] focus-visible:outline-[var(--court)]'
        }`}
      >
        {/* A null avatarUrl falls back to an initial badge rather than
            <img src="">, which the browser would request as the current page
            URL. Same reasoning as the badge this menu replaces. */}
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span
            aria-hidden
            className="flex h-full w-full items-center justify-center bg-[var(--court)] text-xs font-semibold text-white"
          >
            {initial}
          </span>
        )}
      </button>

      {open && (
        <div
          id="account-menu-panel"
          className="absolute right-0 top-[calc(100%+10px)] z-30 w-[232px] rounded-[20px] border border-[var(--hairline)] bg-[var(--panel)] p-2 shadow-[var(--shadow-lg)]"
        >
          <div className="border-b border-[var(--hairline)] px-3 pb-3 pt-2">
            <div className="truncate text-sm font-semibold text-[var(--ink)]">{label}</div>
            <div className="truncate text-[12.5px] text-[var(--ink-soft)]">{user.email}</div>
          </div>

          {showBookings && (
            <Link
              href="/bookings"
              onClick={() => setOpen(false)}
              className={`mt-2 block rounded-[10px] px-3 py-2.5 text-[13.5px] font-medium text-[var(--ink)] ${FOCUS_RING} hover:bg-[var(--surface)]`}
            >
              My bookings
            </Link>
          )}

          {dashboardLabel && (
            <Link
              href="/dashboard"
              onClick={() => setOpen(false)}
              className={`${showBookings ? '' : 'mt-2 '}block rounded-[10px] px-3 py-2.5 text-[13.5px] font-medium text-[var(--ink)] ${FOCUS_RING} hover:bg-[var(--surface)]`}
            >
              {dashboardLabel}
            </Link>
          )}

          {isAdmin && (
            <Link
              href="/admin"
              onClick={() => setOpen(false)}
              className={`block rounded-[10px] px-3 py-2.5 text-[13.5px] font-medium text-[var(--ink)] ${FOCUS_RING} hover:bg-[var(--surface)]`}
            >
              Admin
            </Link>
          )}

          {/* A form POST, not an onClick fetch: sign-out is a state change and
              must not be reachable by a GET that a prefetch could fire. */}
          <form action={signOutAction} className="mt-1 border-t border-[var(--hairline)] pt-1">
            <button
              type="submit"
              className={`block w-full rounded-[10px] px-3 py-2.5 text-left text-[13.5px] font-medium text-[var(--ink)] ${FOCUS_RING} hover:bg-[var(--surface)]`}
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
