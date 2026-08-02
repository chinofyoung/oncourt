'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createBrowserSupabaseClient } from '@/lib/supabase/client'
import { Wordmark, BRAND_NAME } from '@/components/site/wordmark'

/**
 * Google's four-color "G", the official mark from Google's Identity sign-in
 * button assets (viewBox 0 0 48 48, one path per brand color). Inlined rather
 * than hotlinked so the button never renders a broken/blank icon while an
 * external request is in flight, and so it inherits nothing from the button's
 * `color` — Google's mark must keep its own colors, which is also why the
 * button surface is `--ink` (see the button comment below).
 *
 * `aria-hidden`: the button's own text already says "Continue with Google",
 * so announcing the logo again would be redundant for screen readers.
 */
function GoogleMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden focusable="false" className={className}>
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  )
}

/**
 * Split auth page: photo panel left, sign-in right, per the requested
 * half-left/half-right layout. Deliberately renders without Nav/Footer — an
 * auth page is a full-height focused surface; the wordmark links home instead.
 *
 * Colors and control tokens reference the brand CSS variables in
 * src/app/globals.css (which mirror design/branding.md — the design source of
 * truth), not hardcoded hex, so a branding.md edit propagates here: --surface,
 * --ink, --ball/--ball-ink, --court, --hairline, --btn-radius, --btn-h.
 * Solid colors only, no gradients, per that doc.
 *
 * Layout follows branding.md: columns collapse at the 980px breakpoint, type
 * tightens at 560px, and the dark overlay on the photo is the doc's solid
 * rgba(6,20,13,.68) — not a gradient scrim.
 *
 * The photo is present at every width; only its role changes. Above 980px it's
 * the left grid column with the marketing copy laid over it. Below 980px it
 * goes `absolute inset-0` — dropping out of grid flow so the single remaining
 * column sits on top of it — and the sign-in block picks up card chrome
 * (--panel, 20px radius, --shadow-lg per branding.md's Cards entry) so it reads
 * as a panel floating over the court. The panel is opaque rather than the doc's
 * glass treatment because the button inside it is the dark --ink variant: on
 * glass over a photo already darkened to rgba(6,20,13,.68), an --ink (#0C1F16)
 * button would nearly disappear. An opaque panel keeps one button treatment at
 * both breakpoints instead of recoloring it per viewport.
 */
export default function LoginPage() {
  const [error, setError] = useState<string | null>(null)
  // Guards against a second redirect being kicked off while the first
  // signInWithOAuth() round trip is still resolving — the button stays on
  // screen for that whole window, since the redirect only happens after.
  const [pending, setPending] = useState(false)

  async function signIn() {
    setError(null)
    setPending(true)
    const supabase = createBrowserSupabaseClient()
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    // On success the browser navigates away, so only the failure path needs to
    // release the button.
    if (error) {
      setError(error.message)
      setPending(false)
    }
  }

  return (
    <main className="relative grid min-h-dvh grid-cols-2 max-[980px]:grid-cols-1">
      {/* Left half — photo. Below 980px it leaves grid flow (`absolute
          inset-0`) and becomes the page's full-bleed backdrop instead. Its
          marketing copy is desktop-only: on mobile it would compete with the
          overlaid panel for the same space, and hiding it also keeps the DOM
          order (photo first) from putting that copy ahead of the form for a
          mobile screen-reader user. */}
      <section className="relative flex flex-col justify-between overflow-hidden max-[980px]:absolute max-[980px]:inset-0">
        {/* Same Unsplash court shot the seed data and mockups already use, with
            branding.md's hotlink params. Empty alt + aria-hidden: purely
            decorative, all meaning is in the copy layered over it. */}
        <img
          src="https://images.unsplash.com/photo-1756477558468-b3e485757470?q=70&w=1400&auto=format&fit=crop"
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div aria-hidden className="absolute inset-0 bg-[rgba(6,20,13,.68)]" />

        <div className="relative z-[1] hidden p-14 min-[981px]:block">
          <Link
            href="/"
            className="inline-flex rounded-[var(--btn-radius)] text-[22px] text-white outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ball)] focus-visible:outline-offset-[6px]"
          >
            <Wordmark onDark />
            <span className="sr-only">— back to home</span>
          </Link>
        </div>

        <div className="relative z-[1] hidden p-14 min-[981px]:block">
          <span className="font-mono inline-flex items-center gap-2.5 text-[11.5px] tracking-[.16em] text-white/66 uppercase">
            <span aria-hidden className="h-px w-[22px] bg-[var(--ball)]" />
            Members
          </span>
          {/* A styled <p>, not a second heading: the page's one h1 lives in the
              right column, which is the only column mobile renders. */}
          <p className="font-display mt-[18px] max-w-[420px] text-[44px] leading-[1.04] font-bold tracking-[-0.03em] text-white">
            Your courts, your games,
            <br />
            <span className="text-[var(--ball)]">one account.</span>
          </p>
          <p className="mt-4 max-w-[400px] text-[15px] text-white/75">
            Book across every branch, keep your upcoming games in one place, and pull up receipts
            anytime.
          </p>
          <span className="font-mono mt-9 block text-[11px] tracking-[.14em] text-white/55 uppercase">
            GCash · Maya · Card
          </span>
        </div>
      </section>

      {/* Right half — sign-in. `items-center` (not `mx-auto` on the inner
          block) does the centering: an auto cross-axis margin on a flex item
          disables align-self:stretch, which is what made an earlier page
          shrink-to-fit and overflow horizontally — see the note in
          src/app/page.tsx. */}
      <section className="relative z-[1] flex flex-col items-center justify-center px-14 py-16 max-[560px]:px-5">
        <div className="w-full max-w-[380px] max-[980px]:rounded-[20px] max-[980px]:bg-[var(--panel)] max-[980px]:p-8 max-[980px]:shadow-[var(--shadow-lg)] max-[560px]:p-7">
          {/* Mobile-only wordmark: below 980px the photo panel's own wordmark
              is hidden along with the rest of its copy, so this keeps the page
              branded and keeps a route home. Inside the card, so it sits on
              --panel and takes the light-background bordered lime square. */}
          <Link
            href="/"
            className="mb-10 inline-flex rounded-[var(--btn-radius)] text-[22px] text-[var(--ink)] outline-none min-[981px]:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-[6px]"
          >
            <Wordmark />
            <span className="sr-only">— back to home</span>
          </Link>

          <span className="font-mono block text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
            Sign in
          </span>
          <h1 className="font-display mt-2.5 text-[34px] leading-[1.1] font-bold tracking-[-0.025em] text-[var(--ink)] max-[560px]:text-[28px]">
            Welcome back to {BRAND_NAME}
          </h1>
          <p className="mt-3 text-[15px] text-[var(--ink-soft)]">
            Your Google account is all you need — no new password to remember.
          </p>

          {/* branding.md, Controls: "On light panels a dark button (--ink bg,
              --ball text) is the alternative primary." Taken over the lime
              primary specifically because of the icon: Google's mark keeps its
              own four colors, and its yellow (#FBBC05) has almost no contrast
              on lime (--ball, #E8FF54), whereas all four read cleanly on
              --ink. Height/radius from the --btn-h/--btn-radius tokens. */}
          <button
            onClick={signIn}
            disabled={pending}
            className="font-display mt-8 inline-flex h-[var(--btn-h)] w-full items-center justify-center gap-3 rounded-[var(--btn-radius)] bg-[var(--ink)] px-4 text-[15.5px] font-bold tracking-[-0.01em] text-[var(--ball)] outline-none transition-[filter,transform] duration-150 hover:brightness-[1.25] active:scale-[.98] disabled:pointer-events-none disabled:opacity-60 motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-[3px]"
          >
            <GoogleMark className="h-[18px] w-[18px] shrink-0" />
            {pending ? 'Opening Google…' : 'Continue with Google'}
          </button>

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-4 py-3 text-sm font-medium text-[var(--ink)]"
            >
              {error}
            </p>
          )}

          <p className="mt-8 border-t border-[var(--hairline)] pt-6 text-[13.5px] text-[var(--ink-soft)]">
            Own a court?{' '}
            <span className="text-[var(--ink)]">Sign in with the same Google account</span> to list
            it and manage your branches.
          </p>
        </div>
      </section>
    </main>
  )
}
