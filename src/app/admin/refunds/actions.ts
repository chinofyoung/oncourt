'use server'

import { revalidatePath } from 'next/cache'
import type { AdminFormState } from '@/app/admin/actions'
import { idFrom, refuseUnlessAdmin } from '@/lib/admin/guard'
import { recordPaymentRefund } from '@/lib/refunds/write'

/**
 * The refund queue's one write.
 *
 * This file exports exactly one guarded action — every OTHER export of a
 * 'use server' file becomes a client-invokable endpoint. All SQL lives in
 * src/lib/refunds/, where it is unit-tested.
 *
 * ONE GUARD SHAPE: requireAdmin, via refuseUnlessAdmin in
 * src/lib/admin/guard.ts — imported, not duplicated, exactly as
 * src/app/admin/payouts/actions.ts does. idFrom is imported from the same
 * module rather than redeclared.
 *
 * A submitted paymentId is safe to guard on because recordPaymentRefund is
 * itself scoped by something the caller cannot forge: it only stamps a row
 * where `refunded_at is null and status = 'paid'`. A wrong, already-recorded,
 * or never-paid id matches no row and returns a friendly reason. The UI-level
 * gate (see refund-forms.tsx / page.tsx — a payment only ever gets a form
 * when it is paid and unrefunded) remains the usability layer, but it is not
 * what keeps a forged FormData submission safe: this action accepts any
 * string as paymentId regardless of what the page rendered, and the lib's
 * `status = 'paid'` guard is the actual enforcement.
 */
const BAD_TARGET = "That doesn't look right — reload the page and try again."

export async function recordRefundAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const paymentId = idFrom(formData, 'paymentId')
  if (!paymentId) return { error: BAD_TARGET }

  const result = await recordPaymentRefund(paymentId, String(formData.get('note') ?? ''))
  if (!result.ok) {
    return { error: "That payment can't be refunded — it was either already recorded or never paid." }
  }

  revalidatePath('/admin/refunds')
  revalidatePath('/admin/payouts')
  revalidatePath('/dashboard/earnings')
  return {
    ok: true,
    message: result.bookingRefunded
      ? 'Refund recorded. The booking is now marked refunded.'
      : // Two situations reach this branch and the copy has to be true for
        // both: an orphan payment whose booking never confirmed, and a
        // duplicate charge on a booking another payment still pays for. In
        // neither case does the booking change — and in the duplicate case it
        // MUST not (see recordPaymentRefund's `not exists` clause). They are
        // not distinguishable from `bookingRefunded` alone, so the copy states
        // the one thing that is true of both rather than guessing which.
        'Refund recorded. The booking is unchanged — this payment either never confirmed it, ' +
        'or another payment still covers it.',
  }
}
