'use server'

import { revalidatePath } from 'next/cache'
import { AuthError, requireOwner } from '@/lib/auth/guards'
import { serviceRoleStorage } from '@/lib/listings/storage'
import {
  removeBusinessLogo,
  updateBusinessLogo,
  updateBusinessName,
  type SettingsFailure,
} from '@/lib/owner/settings'

/**
 * /dashboard/settings.
 *
 * This file exports nothing but three async guarded actions and the
 * `SettingsFormState` type its forms bind to — every OTHER export of a
 * 'use server' file becomes a client-invokable endpoint. All validation and
 * all SQL live in src/lib/owner/settings.ts, where they are unit-tested.
 *
 * ONE guard shape: requireOwner, with the owner id taken from ITS RETURN
 * VALUE. No action here reads an id from the form, so there is nothing for a
 * forged submission to point at. requireOwner also admits admins (see its doc
 * comment); the library's `role = 'owner'` scoping is what turns that into a
 * friendly refusal rather than an admin quietly acquiring a business identity.
 *
 * Every action takes useActionState's (prevState, formData) shape. The
 * previous state is unused — each submission is judged on its own input — but
 * the parameter must exist for React to bind the action to the form's state.
 */
export type SettingsFormState = { ok: true; message: string } | { error: string } | null

const NOT_AN_OWNER_ACTION = 'Only court owners can change these settings.'

const SETTINGS_MESSAGES: Record<SettingsFailure, string> = {
  not_an_owner: "Your account isn't a court-owner account, so there's nothing to save here.",
  empty_name: 'Your business name can’t be blank.',
  name_too_long: 'That business name is too long — shorten it and try again.',
  no_file: 'Choose an image first.',
  bad_type: 'Logos must be JPEG, PNG or WebP.',
  too_large: 'That image is over 5 MB — use a smaller one.',
  upload_failed: "That upload didn't go through. Try again.",
}

/**
 * A name or logo change is brand identity: it shows on the owner's public
 * brand page and in the "Hosted by" strip on every one of their branch pages,
 * as well as in the dashboard's own sidebar chip. All four go.
 *
 * 'layout' on the two public route groups, matching how the listings actions
 * already revalidate /venues — both are dynamic segments with no static index
 * to name individually.
 */
function revalidateBrand(): void {
  revalidatePath('/dashboard/settings')
  revalidatePath('/dashboard')
  revalidatePath('/owners', 'layout')
  revalidatePath('/venues', 'layout')
}

export async function updateBusinessNameAction(
  _prevState: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  let user
  try {
    user = await requireOwner()
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_AN_OWNER_ACTION }
    throw error
  }

  const result = await updateBusinessName({
    ownerId: user.id,
    businessName: String(formData.get('businessName') ?? ''),
  })
  if (!result.ok) return { error: SETTINGS_MESSAGES[result.reason] }

  revalidateBrand()
  return { ok: true, message: 'Business name saved.' }
}

export async function updateBusinessLogoAction(
  _prevState: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  let user
  try {
    user = await requireOwner()
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_AN_OWNER_ACTION }
    throw error
  }

  // An <input type="file"> with nothing chosen still submits a zero-byte
  // entry, so this only has to catch a submission with no field at all.
  const file = formData.get('logo')
  if (!(file instanceof File)) return { error: SETTINGS_MESSAGES.no_file }

  const result = await updateBusinessLogo({
    ownerId: user.id,
    file,
    storage: serviceRoleStorage(),
  })
  if (!result.ok) return { error: SETTINGS_MESSAGES[result.reason] }

  revalidateBrand()
  return { ok: true, message: 'Logo saved.' }
}

export async function removeBusinessLogoAction(
  _prevState: SettingsFormState,
  _formData: FormData,
): Promise<SettingsFormState> {
  let user
  try {
    user = await requireOwner()
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_AN_OWNER_ACTION }
    throw error
  }

  const result = await removeBusinessLogo({ ownerId: user.id, storage: serviceRoleStorage() })
  if (!result.ok) return { error: SETTINGS_MESSAGES[result.reason] }

  revalidateBrand()
  return { ok: true, message: 'Logo removed.' }
}
