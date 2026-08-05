'use client'

import { useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase/client'

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
 * Client half of the login page: owns the `pending`/`error` state and the
 * `signInWithOAuth` call, so the surrounding page (photo panel, headings,
 * copy) can stay a Server Component and stop shipping as client JS.
 *
 * `next` arrives already normalized by safeNextPath() on the server. It is
 * appended to the callback URL, and the callback normalizes it again — the
 * value makes a round trip through Google in between, so re-checking on
 * arrival is not redundant.
 */
export function SignInButton({ next }: { next: string }) {
  const [error, setError] = useState<string | null>(null)
  // Guards against a second redirect being kicked off while the first
  // signInWithOAuth() round trip is still resolving — the button stays on
  // screen for that whole window, since the redirect only happens after.
  const [pending, setPending] = useState(false)

  async function signIn() {
    setError(null)
    setPending(true)
    const supabase = createBrowserSupabaseClient()
    const callback = new URL('/auth/callback', window.location.origin)
    if (next !== '/') callback.searchParams.set('next', next)

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: callback.toString() },
    })
    // On success the browser navigates away, so only the failure path needs to
    // release the button.
    if (error) {
      setError(error.message)
      setPending(false)
    }
  }

  return (
    <>
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
    </>
  )
}
