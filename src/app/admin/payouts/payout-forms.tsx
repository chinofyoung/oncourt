'use client'

import { useActionState } from 'react'
import { BORDERED_BUTTON, DARK_BUTTON, FIELD, FormMessage } from '@/app/dashboard/listings/form-ui'
import type { AdminFormState } from '@/app/admin/actions'
import { markPayoutPaidAction, preparePayoutAction } from './actions'

/**
 * The payout ledger's controls. Client components for the same reason
 * moderation-forms.tsx's are: a Server Component cannot render what a Server
 * Action returned, so "already recorded" would look like nothing happening.
 *
 * NO LIME BUTTON here: the list page repeats PrepareForm once per owner, and
 * branding.md forbids two lime buttons in one view. DARK_BUTTON (branding.md's
 * alternative primary) for Prepare; BORDERED_BUTTON for Mark paid.
 */
export function PrepareForm({ ownerId, disabled }: { ownerId: string; disabled: boolean }) {
  const [state, prepare, pending] = useActionState<AdminFormState, FormData>(
    preparePayoutAction,
    null,
  )
  return (
    <form action={prepare} className="flex flex-col gap-2">
      <input type="hidden" name="ownerId" value={ownerId} />
      <button type="submit" disabled={pending || disabled} className={DARK_BUTTON}>
        {pending ? 'Preparing…' : 'Prepare payout'}
      </button>
      <FormMessage state={state} />
    </form>
  )
}

export function MarkPaidForm({ payoutId, ownerId }: { payoutId: string; ownerId: string }) {
  const [state, markPaid, pending] = useActionState<AdminFormState, FormData>(
    markPayoutPaidAction,
    null,
  )
  return (
    <form action={markPaid} className="mt-4 flex flex-col gap-2">
      <input type="hidden" name="payoutId" value={payoutId} />
      <input type="hidden" name="ownerId" value={ownerId} />
      <label htmlFor={`note-${payoutId}`} className="text-[13px] text-[var(--ink-soft)]">
        Transfer reference
      </label>
      <input
        id={`note-${payoutId}`}
        name="note"
        type="text"
        maxLength={500}
        placeholder="GCash ref, bank transaction no."
        className={FIELD}
      />
      <button type="submit" disabled={pending} className={BORDERED_BUTTON}>
        {pending ? 'Recording…' : 'Mark paid'}
      </button>
      <FormMessage state={state} />
    </form>
  )
}
