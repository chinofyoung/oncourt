'use server'

import { revalidatePath } from 'next/cache'
import type { AdminFormState } from '@/app/admin/actions'
import { idFrom, refuseUnlessAdmin } from '@/lib/admin/guard'
import { formatPeso } from '@/lib/format'
import { markPayoutPaid, preparePayout } from '@/lib/payouts/write'

/**
 * The payout ledger's two writes.
 *
 * This file exports exactly two guarded actions — every OTHER export of a
 * 'use server' file becomes a client-invokable endpoint. All SQL lives in
 * src/lib/payouts/, where it is unit-tested.
 *
 * ONE GUARD SHAPE: requireAdmin, via refuseUnlessAdmin in
 * src/lib/admin/guard.ts — imported, not duplicated, exactly as
 * src/app/admin/settings/actions.ts does. idFrom is imported from the same
 * module rather than redeclared, per that module's own doc comment.
 *
 * A submitted id is safe to guard on because both writes underneath are
 * scoped by something the caller cannot forge: preparePayout resolves its own
 * line set from the owner's bookings, and markPayoutPaid is status-scoped
 * (`and status = 'pending'`). A wrong id matches no row and returns a
 * friendly reason.
 */
const BAD_TARGET = "That doesn't look right — reload the page and try again."

export async function preparePayoutAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const ownerId = idFrom(formData, 'ownerId')
  if (!ownerId) return { error: BAD_TARGET }

  const result = await preparePayout(ownerId)
  if (!result.ok) {
    return { error: 'There is nothing to pay this owner right now.' }
  }

  revalidatePath('/admin/payouts')
  revalidatePath(`/admin/payouts/${ownerId}`)
  revalidatePath('/dashboard/earnings')
  return {
    ok: true,
    message: `Prepared ${formatPeso(result.netCentavos)} across ${result.lineCount} ${
      result.lineCount === 1 ? 'booking' : 'bookings'
    }. Send the transfer, then mark it paid.`,
  }
}

export async function markPayoutPaidAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const payoutId = idFrom(formData, 'payoutId')
  const ownerId = idFrom(formData, 'ownerId')
  if (!payoutId || !ownerId) return { error: BAD_TARGET }

  const result = await markPayoutPaid(payoutId, String(formData.get('note') ?? ''))
  if (!result.ok) {
    return { error: 'That payout has already been recorded as paid.' }
  }

  revalidatePath('/admin/payouts')
  revalidatePath(`/admin/payouts/${ownerId}`)
  revalidatePath('/dashboard/earnings')
  return { ok: true, message: 'Payout recorded.' }
}
