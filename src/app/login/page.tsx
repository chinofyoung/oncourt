'use client'

import { useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase/client'

// Colors and control tokens reference the brand CSS variables defined in
// src/app/globals.css (which mirror design/branding.md — the design source
// of truth), not hardcoded hex, so a future branding.md edit propagates
// here automatically: --surface, --ink, --ball/--ball-ink (lime primary
// button), --court (light-background focus ring per branding.md's "Focus"
// rule — --ball is the dark-background variant, but this page's background
// is --surface, a light color), --btn-radius, --btn-h. Solid colors only,
// no gradients, per the branding doc's rule. The global font swap to Inter
// Tight/Inter is out of this task's file list (layout.tsx is not a file
// this task creates or changes), so the page keeps the app's existing font
// stack — that deferral is unchanged from the original implementation.
export default function LoginPage() {
  const [error, setError] = useState<string | null>(null)

  async function signIn() {
    setError(null)
    const supabase = createBrowserSupabaseClient()
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    if (error) setError(error.message)
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 bg-[var(--surface)]">
      <h1 className="text-2xl font-semibold text-[var(--ink)]">Sign in to OnCourt</h1>
      <button
        onClick={signIn}
        className="rounded-[var(--btn-radius)] h-[var(--btn-h)] px-4 font-bold bg-[var(--ball)] text-[var(--ball-ink)] outline-none transition-colors hover:bg-[var(--ball)]/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-[3px]"
      >
        Continue with Google
      </button>
      {error && (
        <p role="alert" className="text-sm font-medium text-[var(--ink)]">
          {error}
        </p>
      )}
    </main>
  )
}
