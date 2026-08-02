import Link from 'next/link'
import { Wordmark } from '@/components/site/wordmark'
import { getOptionalUser } from '@/lib/auth/guards'

/**
 * design/branding.md, Nav: floating over heroes (absolute, transparent,
 * white text + glass pill) or solid --surface with a hairline border on
 * utility pages. Right side: "List your court" pill + 36px avatar.
 *
 * Glass surfaces are for use over photos ONLY:
 * rgba(255,255,255,.09) bg + rgba(255,255,255,.18) 1px border + blur(22px).
 *
 * Session state is read via getOptionalUser(), which itself reads
 * supabase.auth.getClaims() — never getSession() — through the same shared
 * path requireUser() uses (see src/lib/auth/guards.ts).
 *
 * NOTE: the signed-in branch is UNVERIFIED. Google OAuth is not yet
 * configured on the Supabase project (docs/foundation-review-notes.md, open
 * item 2), so only the signed-out rendering has been seen in a browser.
 */
export async function Nav({ variant = 'solid' }: { variant?: 'overlay' | 'solid' }) {
  const user = await getOptionalUser()
  const onDark = variant === 'overlay'

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
          <Link
            href="/login"
            className={
              onDark
                ? 'inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-white/[.18] bg-white/[.09] px-4 text-sm font-semibold text-white backdrop-blur-[22px]'
                : 'inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-4 text-sm font-semibold text-[var(--ink)]'
            }
          >
            List your court
          </Link>
          {user ? (
            // UNVERIFIED (no Google OAuth configured yet, see docstring above):
            // a null avatarUrl (no photo on the OAuth profile, or a
            // not-yet-synced profile row) falls back to an initial-letter
            // badge rather than an <img src=""> — which the browser would
            // request as the current page URL and, if that response were
            // ever image-like, could render as a broken/garbage icon.
            user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt=""
                className="h-9 w-9 rounded-full border border-[var(--hairline)] object-cover"
              />
            ) : (
              <span
                aria-hidden
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--hairline)] bg-[var(--court)] text-xs font-semibold text-white"
              >
                {user.email.charAt(0).toUpperCase()}
              </span>
            )
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
