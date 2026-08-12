'use client'

import { useActionState } from 'react'
import { BORDERED_BUTTON, FormMessage } from '@/app/dashboard/listings/form-ui'
import type { AdminFormState } from '@/app/admin/actions'
import { retryEmailAction } from './actions'

/**
 * The failed-email queue's one control, following src/app/admin/refunds/
 * refund-forms.tsx's RecordRefundForm exactly: a Server Component cannot
 * render what a Server Action returned, so "already retried or sent" would
 * look like nothing happening without this being a client component.
 *
 * Rendered once per failed row. NO LIME BUTTON: this form repeats per row,
 * and branding.md forbids two lime buttons in one view, so BORDERED_BUTTON —
 * the same choice RecordRefundForm and MarkPaidForm make for their own
 * repeated per-row control.
 *
 * Imports only from ./actions and form-ui, per the interface this task is
 * scoped to — no value import of anything reaching @/db (that would pass
 * tsc and lint and then 500 at runtime, since this file is 'use client').
 */
export function RetryForm({ emailId }: { emailId: string }) {
  const [state, retry, pending] = useActionState<AdminFormState, FormData>(retryEmailAction, null)
  return (
    <form action={retry} className="flex flex-col items-start gap-2">
      <input type="hidden" name="emailId" value={emailId} />
      <button type="submit" disabled={pending} className={BORDERED_BUTTON}>
        {pending ? 'Retrying…' : 'Retry'}
      </button>
      <FormMessage state={state} />
    </form>
  )
}
