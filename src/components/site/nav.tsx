import Link from 'next/link'
import { Wordmark } from '@/components/site/wordmark'
import { AccountMenu } from '@/components/site/account-menu'
import { accountLinks } from '@/components/site/account-links'
import { getOptionalUser } from '@/lib/auth/guards'
import { hasAnyStaffGrant } from '@/lib/staff/access'

/**
 * design/branding.md, Nav: floating over heroes (absolute, transparent,
 * white text + glass pill) or solid --surface with a hairline border on
 * utility pages. Right side, signed in: a role link (the first entry of
 * `accountLinks()`) beside the 36px avatar / account menu; signed out: a
 * plain "Sign in" link.
 *
 * Glass surfaces are for use over photos ONLY:
 * rgba(255,255,255,.09) bg + rgba(255,255,255,.18) 1px border + blur(22px).
 *
 * Session state is read via getOptionalUser(), which itself reads
 * supabase.auth.getClaims() — never getSession() — through the same shared
 * path requireUser() uses (see src/lib/auth/guards.ts).
 *
 * The signed-in branch renders the AccountMenu (src/components/site/account-menu.tsx).
 */
export async function Nav({ variant = 'solid' }: { variant?: 'overlay' | 'solid' }) {
  const user = await getOptionalUser()
  const onDark = variant === 'overlay'

  // Only asked for players: an owner or admin already gets the dashboard item
  // from their role. promoteToOwner() deletes a promoted user's grants inside
  // the same transaction as the role flip, and addBranchStaff's `for update`
  // lock closes the race the other way (see src/lib/staff/write.ts) — together
  // that is what makes "a non-player can never hold one" actually true, not
  // just true absent concurrency. One indexed lookup on branch_staff
  // (user_id), and only for a signed-in player.
  const isStaff = user?.role === 'player' ? await hasAnyStaffGrant(user.id) : false

  const accountMenuUser = user
    ? {
        email: user.email,
        fullName: user.fullName ?? null,
        avatarUrl: user.avatarUrl,
        role: user.role,
        isStaff,
      }
    : null
  // The nav's one-click shortcut: the first entry of the same ordered list
  // AccountMenu renders in full, so the two can never disagree about which
  // destination is "the" role link. Only ever empty if accountLinks() itself
  // returned nothing, which no role currently does.
  const roleLink = accountMenuUser ? accountLinks(accountMenuUser)[0] : undefined

  return (
    <header
      className={
        onDark
          ? 'absolute inset-x-0 top-0 z-20 px-[max(24px,calc((100vw-1120px)/2))] py-5'
          : 'border-b border-[var(--hairline)] bg-[var(--surface)] px-[max(24px,calc((100vw-1120px)/2))] py-4'
      }
    >
      <nav className="flex items-center justify-between gap-4">
        <Link href="/" className={onDark ? 'text-white' : 'text-[var(--ink)]'}>
          <Wordmark onDark={onDark} className="text-[22px]" />
        </Link>

        {/* Center links are hidden below 980px per branding.md's breakpoints. */}
        <div
          className={`hidden items-center gap-7 text-sm font-medium min-[980px]:flex ${
            onDark ? 'text-white/85' : 'text-[var(--ink-soft)]'
          }`}
        >
          <Link href="/search">Find courts</Link>
          <Link href="/search?sort=rating">Top rated</Link>
        </div>

        <div className="flex items-center gap-3">
          {accountMenuUser ? (
            <>
              {roleLink && (
                // Hidden at <=980px like the center links above — the
                // dropdown still carries every destination there, so nothing
                // is lost. No outline-none: Tailwind v4 resolves
                // --tw-outline-style through one shared custom property, so
                // pairing it with focus-visible:outline-2 would leave the
                // ring permanently suppressed even while focused (see
                // src/app/page.tsx:100-115).
                <Link
                  href={roleLink.href}
                  className={`hidden text-sm font-semibold rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 min-[980px]:inline-block ${
                    onDark
                      ? 'text-white/85 hover:text-white focus-visible:outline-[var(--ball)]'
                      : 'text-[var(--ink-soft)] hover:text-[var(--ink)] focus-visible:outline-[var(--court)]'
                  }`}
                >
                  {roleLink.label}
                </Link>
              )}
              <AccountMenu user={accountMenuUser} onDark={onDark} />
            </>
          ) : (
            <Link
              href="/login"
              className={`text-sm font-semibold ${onDark ? 'text-white' : 'text-[var(--ink)]'}`}
            >
              Sign in
            </Link>
          )}
        </div>
      </nav>
    </header>
  )
}
