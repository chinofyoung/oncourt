'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { AuthError, requireUser } from '@/lib/auth/guards'

/**
 * Signs out server-side, so cookie clearing goes through the same
 * @supabase/ssr cookie adapter that set them (src/lib/supabase/server.ts).
 * A client-side signOut() would leave the server's copy of the session cookie
 * to be reconciled by the proxy on the next navigation.
 *
 * requireUser() first, for two reasons. It satisfies the contract
 * tests/auth/action-coverage.test.ts enforces — every 'use server' file calls a
 * guard — and it is genuinely correct: signing out is an authenticated action.
 * But an AuthError here must NOT abort: a user whose session already expired
 * still has a stale cookie in their browser, and refusing to clear it would
 * leave them stuck looking signed in while every request 401s. So that case
 * falls through to the same signOut() + redirect.
 */
export async function signOutAction(): Promise<never> {
  try {
    await requireUser()
  } catch (error) {
    if (!(error instanceof AuthError)) throw error
  }

  const supabase = await createServerSupabaseClient()
  await supabase.auth.signOut()

  // The nav renders from getOptionalUser(), so any cached render of a page
  // showing the signed-in nav is now wrong.
  revalidatePath('/', 'layout')
  redirect('/')
}
