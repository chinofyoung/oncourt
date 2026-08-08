'use server'

import { revalidatePath } from 'next/cache'
import { AuthError, requirePlayer } from '@/lib/auth/guards'
import { setCitySlug, setFullName, setPhone } from '@/lib/profile/write'

/**
 * Matches SettingsFormState's shape (src/app/dashboard/settings/actions.ts) so
 * these forms bind to useActionState exactly like the owner settings forms do.
 */
export type ProfileFormState = { ok: true; message: string } | { error: string } | null

/**
 * requirePlayer, not requireUser: roles are exclusive, /bookings is
 * requirePlayerPage, and an owner or admin has no profile checklist here.
 *
 * tests/auth/action-coverage.test.ts globs every 'use server' file and fails
 * any that mentions no guard from its GUARDS list — `requirePlayer` is on it.
 */
async function playerIdOrError(): Promise<{ id: string } | { error: string }> {
  try {
    const user = await requirePlayer()
    return { id: user.id }
  } catch (error) {
    if (error instanceof AuthError) return { error: 'Sign in as a player to update your profile.' }
    throw error
  }
}

/**
 * Each action does exactly four things: resolve the guard, read its one field
 * off FormData, delegate to src/lib/profile/write.ts, and revalidate.
 * Validation and SQL live there instead, where tests/profile/write.test.ts
 * exercises them directly — a 'use server' export can only be exercised
 * through a mocked session, so logic inlined here would go untested.
 *
 * `formData.get(...)` is passed through UNCHANGED, never wrapped in
 * `String(...)`: rejecting a non-string is write.ts's job now, and its test's.
 */
export async function updateFullNameAction(
  _prevState: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const auth = await playerIdOrError()
  if ('error' in auth) return { error: auth.error }

  const result = await setFullName(auth.id, formData.get('fullName'))
  if (!result.ok) return { error: result.error }

  revalidatePath('/bookings')
  return { ok: true, message: 'Name saved.' }
}

export async function updatePhoneAction(
  _prevState: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const auth = await playerIdOrError()
  if ('error' in auth) return { error: auth.error }

  const result = await setPhone(auth.id, formData.get('phone'))
  if (!result.ok) return { error: result.error }

  revalidatePath('/bookings')
  return { ok: true, message: 'Mobile number saved.' }
}

export async function updateCityAction(
  _prevState: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const auth = await playerIdOrError()
  if ('error' in auth) return { error: auth.error }

  const result = await setCitySlug(auth.id, formData.get('citySlug'))
  if (!result.ok) return { error: result.error }

  revalidatePath('/bookings')
  return { ok: true, message: 'Home city saved.' }
}
