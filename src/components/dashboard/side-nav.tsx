'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isActiveNavItem } from '@/lib/site/nav-active'

// Global Constraints mandate a branded focus-visible ring on every
// interactive element. Kept identical to the constant each layout declares
// locally, so this shared component's inactive-state classes stay
// byte-for-byte what those layouts rendered before extraction.
const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

export interface SideNavItem {
  href: string
  label: string
  /** Admin-only. Renders a count pill; item is laid out as a flex row to
   *  place it. Omit entirely for shells (dashboard) that never badge. */
  badge?: number
}

/**
 * Shared sidebar nav for the /dashboard and /admin shells. Both layouts'
 * item classes are the same family (rounded-[10px] px-3 py-2.5 text-[13.5px]
 * font-medium whitespace-nowrap text-[var(--ink)] hover:bg-[var(--surface)]
 * + FOCUS_RING) — admin's only addition is `flex items-center gap-2`, needed
 * to lay the badge pill out at the row's end. That addition is applied only
 * when an item actually carries a `badge`, so a badge-less item (every
 * dashboard item, and admin's own "Owners" item at badge: 0 still renders the
 * flex row but that's how admin already behaved pre-extraction) keeps
 * exactly its prior classes.
 *
 * Active state (new): aria-current="page" plus the mockup's active look —
 * bg-[var(--band-off)] text-[var(--court-deep)] font-semibold — replacing
 * text-[var(--ink)] font-medium rather than layering on top of them, so
 * there's no ambiguity about which of two equal-specificity Tailwind
 * font-weight utilities wins. hover:bg-[var(--surface)] is kept on the
 * active class too (a very light wash over the tint) since the design calls
 * it harmless, not forbidden.
 */
export function SideNav({
  items,
  className = 'flex flex-col gap-1 max-[980px]:flex-row max-[980px]:overflow-x-auto',
}: {
  items: SideNavItem[]
  className?: string
}) {
  const pathname = usePathname()

  return (
    <nav className={className}>
      {items.map((item) => {
        const active = isActiveNavItem(pathname, item.href)
        const hasBadge = item.badge !== undefined
        // "flex items-center gap-2 " is admin's exact prior prefix (needed to
        // lay the badge out at the row's end); empty string for dashboard,
        // which never had it. Two full literals rather than composing
        // fragments in a different word order, so the inactive string below
        // matches what each layout rendered before extraction character for
        // character.
        const badgePrefix = hasBadge ? 'flex items-center gap-2 ' : ''
        const itemClassName = active
          ? `${badgePrefix}rounded-[10px] px-3 py-2.5 text-[13.5px] whitespace-nowrap bg-[var(--band-off)] text-[var(--court-deep)] font-semibold hover:bg-[var(--surface)] ${FOCUS_RING}`
          : `${badgePrefix}rounded-[10px] px-3 py-2.5 text-[13.5px] font-medium whitespace-nowrap text-[var(--ink)] hover:bg-[var(--surface)] ${FOCUS_RING}`

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={itemClassName}
          >
            {item.label}
            {hasBadge && item.badge! > 0 && (
              <span className="font-mono ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--ink)] px-1.5 text-[11px] font-semibold text-[var(--ball)]">
                {item.badge}
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
