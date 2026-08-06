'use client'

import { useActionState } from 'react'
import {
  removeBusinessLogoAction,
  updateBusinessLogoAction,
  updateBusinessNameAction,
  type SettingsFormState,
} from './actions'
import {
  BORDERED_BUTTON,
  DARK_BUTTON,
  FIELD,
  FormMessage,
  LABEL,
  LIME_BUTTON,
} from '@/app/dashboard/listings/form-ui'
// The PURE photo module, never src/lib/owner/settings.ts or
// src/lib/listings/photos.ts — those are `server-only` and importing either
// here would throw the moment this component reached the client bundle.
import { ALLOWED_PHOTO_TYPES } from '@/lib/photos'

/**
 * The two settings forms.
 *
 * FormMessage is imported from the listings form-ui module rather than
 * re-implemented: SettingsFormState is structurally identical to
 * ListingFormState, and that module is a route-agnostic set of class strings
 * plus one renderer despite where it lives.
 *
 * branding.md, "never two lime buttons in one view": Save is the page's single
 * lime primary; the logo controls use the dark alternative primary and the
 * bordered secondary. FOCUS_RING is baked into every one of those class
 * constants, which is why none of them is concatenated with it here.
 */
export function BusinessNameForm({
  businessName,
  maxLength,
}: {
  businessName: string | null
  maxLength: number
}) {
  const [state, action, pending] = useActionState<SettingsFormState, FormData>(
    updateBusinessNameAction,
    null,
  )

  return (
    <form action={action} className="flex flex-col gap-3">
      <div>
        <label className={LABEL} htmlFor="businessName">
          Business name
        </label>
        <input
          id="businessName"
          name="businessName"
          type="text"
          required
          maxLength={maxLength}
          defaultValue={businessName ?? ''}
          placeholder="Smash Zone Marikina"
          className={FIELD}
        />
      </div>
      <div>
        <button type="submit" disabled={pending} className={LIME_BUTTON}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <FormMessage state={state} />
    </form>
  )
}

export function LogoForm({ logoUrl }: { logoUrl: string | null }) {
  const [uploadState, uploadAction, uploadPending] = useActionState<SettingsFormState, FormData>(
    updateBusinessLogoAction,
    null,
  )
  const [removeState, removeAction, removePending] = useActionState<SettingsFormState, FormData>(
    removeBusinessLogoAction,
    null,
  )

  return (
    <div className="flex flex-col gap-4">
      {logoUrl && (
        /* eslint-disable-next-line @next/next/no-img-element -- the bucket is
           public and this is an already-sized upload; next/image would add a
           loader round trip for a dashboard thumbnail. */
        <img
          src={logoUrl}
          alt="Your current logo"
          className="h-[72px] w-[72px] rounded-full border border-[var(--hairline)] object-cover"
        />
      )}

      <form action={uploadAction} className="flex flex-col gap-3">
        <div>
          <label className={LABEL} htmlFor="logo">
            {logoUrl ? 'Replace logo' : 'Upload logo'}
          </label>
          <input
            id="logo"
            name="logo"
            type="file"
            // A browser hint only — the server checks the type and the size
            // again, because a hand-crafted POST ignores this attribute.
            accept={ALLOWED_PHOTO_TYPES.join(',')}
            // `py-1.5` on top of FIELD, exactly as photo-forms.tsx does it:
            // FIELD's fixed --btn-h-sm height crops a file input's own
            // "Choose file" button in Chrome without it.
            className={`${FIELD} py-1.5`}
          />
          <p className="mt-1 text-[12px] text-[var(--ink-soft)]">JPEG, PNG or WebP, up to 5 MB.</p>
        </div>
        <div>
          <button type="submit" disabled={uploadPending} className={DARK_BUTTON}>
            {uploadPending ? 'Uploading…' : 'Upload'}
          </button>
        </div>
        <FormMessage state={uploadState} />
      </form>

      {logoUrl && (
        <form action={removeAction}>
          <button type="submit" disabled={removePending} className={BORDERED_BUTTON}>
            {removePending ? 'Removing…' : 'Remove logo'}
          </button>
          <FormMessage state={removeState} />
        </form>
      )}
    </div>
  )
}
