'use client'

import { useActionState } from 'react'
import { BORDERED_BUTTON, FIELD, FormMessage } from '@/app/dashboard/listings/form-ui'
import type { AdminFormState } from '@/app/admin/actions'
import { recordRefundAction } from './actions'

/**
 * The refund queue's one control, following src/app/admin/payouts/payout-
 * forms.tsx's MarkPaidForm exactly: a Server Component cannot render what a
 * Server Action returned, so "already recorded" would look like nothing
 * happening without this being a client component.
 *
 * Rendered once per payment, both in the flagged queue and the lookup
 * section — but never unconditionally: page.tsx's CandidateCard decides per
 * payment whether this form even appears (needsRefund in the flagged queue,
 * `status === 'paid' && refundedOn === null` in the lookup), so recordPaymentRefund's
 * own lack of a status guard is never actually exercised against an unpaid or
 * already-refunded payment from this UI. NO LIME BUTTON: this form repeats
 * per row, and branding.md forbids two lime buttons in one view, so
 * BORDERED_BUTTON (the same choice MarkPaidForm makes for its own repeated
 * per-row control).
 */
export function RecordRefundForm({ paymentId }: { paymentId: string }) {
  const [state, recordRefund, pending] = useActionState<AdminFormState, FormData>(
    recordRefundAction,
    null,
  )
  return (
    <form action={recordRefund} className="mt-3 flex flex-col gap-2">
      <input type="hidden" name="paymentId" value={paymentId} />
      <label htmlFor={`note-${paymentId}`} className="text-[13px] text-[var(--ink-soft)]">
        Provider reference
      </label>
      <input
        id={`note-${paymentId}`}
        name="note"
        type="text"
        maxLength={500}
        placeholder="GCash/Maya refund reference"
        className={FIELD}
      />
      <button type="submit" disabled={pending} className={BORDERED_BUTTON}>
        {pending ? 'Recording…' : 'Record refund'}
      </button>
      <FormMessage state={state} />
    </form>
  )
}
