import Link from 'next/link'
import { Wordmark } from '@/components/site/wordmark'
import { SideNav } from '@/components/dashboard/side-nav'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { signOutAction } from '@/app/auth/sign-out/actions'
import { branchIdsWith } from '@/lib/staff/access'

// Global Constraints (this plan) mandate a branded focus-visible ring on
// every interactive element; the mockup this layout transcribes omits it.
const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

/**
 * Owner shell. The guard lives in the layout so every /dashboard/* page is
 * gated by construction rather than by each page remembering.
 *
 * Only implemented sections appear in the sidebar.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const access = await requireDashboardPage('/dashboard')
  const user = access.user

  // Only sections this session can actually use. A staff member without
  // view_earnings must not see an Earnings item that then bounces them; a
  // staff member must not see Staff at all, since staff management is
  // owner-only (requireOwnerPage guards that page, and its actions use
  // requireOwnerOf).
  //
  // Overview is unconditional: everyone admitted here has at least one
  // permission on at least one branch (branch_staff_some_permission
  // guarantees it), and the overview degrades to the empty state otherwise.
  //
  // Settings is owner-only: brand identity is not branch-shaped, so there is
  // no staff permission that opens it. The page re-asserts this inline and
  // every settings action re-asserts requireOwner.
  const items = [
    { href: '/dashboard', label: 'Overview', show: true },
    {
      href: '/dashboard/bookings',
      label: 'Bookings',
      // Matches the page's own admission test exactly (src/app/dashboard/
      // bookings/page.tsx): owners always, even with zero branches, plus
      // staff holding view_bookings OR block_slots somewhere -- a bare
      // access.can.view_bookings missed a block_slots-only front-desk grant.
      show:
        access.isOwner ||
        branchIdsWith(access, 'view_bookings').length > 0 ||
        branchIdsWith(access, 'block_slots').length > 0,
    },
    {
      href: '/dashboard/listings',
      label: 'Branches & courts',
      // Owners always — an owner with no branches yet needs this item most of
      // all, since it is where they add their first one. Staff only where a
      // manage_courts grant actually exists: access.can.manage_courts would
      // be the union across every branch they can see AT ALL, which is the
      // right test for "should this item render" only because
      // branchIdsWith is what the page then scopes its query by. Using
      // branchIdsWith here too keeps the item and the page's contents
      // answering the same question.
      show: access.isOwner || branchIdsWith(access, 'manage_courts').length > 0,
    },
    { href: '/dashboard/earnings', label: 'Earnings', show: access.can.view_earnings },
    {
      href: '/dashboard/reviews',
      label: 'Reviews',
      // Gated exactly like Branches & courts, on the same permission the
      // Bookings item uses: owners always (an owner with no branches sees the
      // empty state, which is the honest answer), staff only where a
      // view_bookings grant actually exists. branchIdsWith, not
      // access.can.view_bookings, so the item and the page's contents answer
      // the same question.
      show: access.isOwner || branchIdsWith(access, 'view_bookings').length > 0,
    },
    { href: '/dashboard/staff', label: 'Staff', show: access.isOwner },
    { href: '/dashboard/settings', label: 'Settings', show: access.isOwner },
  ].filter((item) => item.show)

  return (
    <div className="flex min-h-dvh max-[980px]:flex-col">
      <aside className="flex w-[248px] shrink-0 flex-col gap-8 border-r border-[var(--hairline)] bg-[var(--panel)] p-6 max-[980px]:w-full max-[980px]:border-r-0 max-[980px]:border-b">
        <Link href="/" className={`text-[20px] text-[var(--ink)] ${FOCUS_RING}`}>
          <Wordmark />
        </Link>
        <SideNav items={items} />
        <div className="mt-auto flex flex-col gap-3 max-[980px]:mt-0">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--court)] text-[11px] font-semibold text-white"
            >
              {(user.businessName ?? user.fullName ?? user.email).charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold text-[var(--ink)]">
                {user.businessName ?? user.fullName ?? user.email}
              </div>
              <div className="font-mono text-[10px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
                {access.isOwner ? user.role : 'Staff'}
              </div>
            </div>
          </div>
          {/* The only sign-out control reachable from inside /dashboard/*: this
              shell renders its own chrome instead of <Nav>, so the account
              menu (the app's other sign-out route) never appears here. A form
              POST, not a link, per signOutAction's own contract. */}
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
