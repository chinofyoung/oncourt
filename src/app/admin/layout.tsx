import Link from 'next/link'
import { Wordmark } from '@/components/site/wordmark'
import { signOutAction } from '@/app/auth/sign-out/actions'
import { requireAdminPage } from '@/lib/auth/page-guards'
import { getPendingCourtCount } from '@/lib/admin/queries'

// Global Constraints mandate a branded focus-visible ring on every
// interactive element. Declared locally, not imported from the listings
// form-ui module: that module is 'use client', and importing it into a Server
// Component would pull this shell into the client bundle for no benefit.
const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

/**
 * Moderation shell. The guard lives in the layout so every /admin/* page is
 * gated by construction rather than by each page remembering — and every page
 * calls requireAdminPage again anyway, because App Router cannot hand a
 * layout's result to a page and a page's own data fetching must be gated by
 * the page. The same two-layer pattern /dashboard uses.
 *
 * Renders its own chrome rather than <Nav>, exactly like the dashboard shell,
 * so this sign-out form is the only one reachable from inside /admin/*.
 *
 * Two nav items, not the mockup's six: Payouts, Fee settings, Users and
 * Bookings are later slices (the spec's Out of scope), and an item pointing at
 * a 404 is worse than no item.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAdminPage('/admin')
  const pending = await getPendingCourtCount()

  const items = [
    { href: '/admin', label: 'Approvals', badge: pending },
    { href: '/admin/owners', label: 'Owners', badge: 0 },
  ]

  return (
    <div className="flex min-h-dvh max-[980px]:flex-col">
      <aside className="flex w-[248px] shrink-0 flex-col gap-8 border-r border-[var(--hairline)] bg-[var(--panel)] p-6 max-[980px]:w-full max-[980px]:border-r-0 max-[980px]:border-b">
        <div className="flex items-center gap-2">
          <Link href="/" className={`text-[20px] text-[var(--ink)] ${FOCUS_RING}`}>
            <Wordmark />
          </Link>
          {/* Non-interactive chip, so pill-shaped per branding.md. It is the
              only thing telling an admin which of the app's two shells they
              are standing in. */}
          <span className="font-mono rounded-full border border-[var(--hairline)] bg-[var(--surface)] px-2 py-0.5 text-[10px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
            admin
          </span>
        </div>

        <nav className="flex flex-col gap-1 max-[980px]:flex-row max-[980px]:overflow-x-auto">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 rounded-[10px] px-3 py-2.5 text-[13.5px] font-medium whitespace-nowrap text-[var(--ink)] hover:bg-[var(--surface)] ${FOCUS_RING}`}
            >
              {item.label}
              {item.badge > 0 && (
                <span className="font-mono ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--ink)] px-1.5 text-[11px] font-semibold text-[var(--ball)]">
                  {item.badge}
                </span>
              )}
            </Link>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-3 max-[980px]:mt-0">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-[var(--ink)]">
              {user.fullName ?? user.email}
            </div>
            <div className="font-mono text-[10px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
              {user.role}
            </div>
          </div>
          <Link
            href="/"
            className={`rounded-[10px] px-3 py-2 text-[13px] font-medium text-[var(--court)] hover:bg-[var(--surface)] ${FOCUS_RING}`}
          >
            Back to the site
          </Link>
          {/* A form POST, not a link, per signOutAction's own contract. */}
          <form action={signOutAction}>
            <button
              type="submit"
              className={`w-full rounded-[10px] border border-[var(--hairline)] px-3 py-2 text-[13px] font-medium text-[var(--ink)] hover:border-[var(--court)] ${FOCUS_RING}`}
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="min-w-0 flex-1 p-8 max-[560px]:p-5">{children}</div>
    </div>
  )
}
