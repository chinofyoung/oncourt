'use server'

import { revalidatePath } from 'next/cache'
import type { AdminFormState } from '@/app/admin/actions'
import { idFrom, refuseUnlessAdmin } from '@/lib/admin/guard'
import { retryEmail } from '@/lib/email/outbox'

/**
 * The failed-email queue's one write, mirroring src/app/admin/refunds/
 * actions.ts's shape exactly.
 *
 * This file exports exactly one guarded action — every OTHER export of a
 * 'use server' file becomes a client-invokable endpoint. All SQL lives in
 * src/lib/email/outbox.ts, where it is unit-tested.
 *
 * ONE GUARD SHAPE: requireAdmin, via refuseUnlessAdmin in
 * src/lib/admin/guard.ts — imported, not duplicated.
 *
 * A submitted emailId is safe to guard on because retryEmail is itself
 * status-scoped (`where id = ? and status = 'failed'`): a wrong, already-
 * retried, or already-sent id matches no row and comes back as
 * `already_moved`, not an error.
 */
const BAD_TARGET = "That doesn't look right — reload the page and try again."

export async function retryEmailAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const emailId = idFrom(formData, 'emailId')
  if (!emailId) return { error: BAD_TARGET }

  const result = await retryEmail(emailId)
  if (!result.ok) {
    return { error: 'That email has already been retried or sent.' }
  }

  revalidatePath('/admin/emails')
  return { ok: true, message: 'Queued for another attempt.' }
}
