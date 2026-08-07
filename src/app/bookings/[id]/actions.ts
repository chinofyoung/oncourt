'use server'

import { AuthError, requirePlayer } from '@/lib/auth/guards'
import { paymongo } from '@/lib/payments/paymongo'
import { reconcilePendingBooking } from '@/lib/payments/reconcile'

/**
 * Called by ConfirmingBanner on ITS OWN bounded poll schedule (never more
 * than confirming-banner.tsx's MAX_POLLS times) — the reconciliation
 * fallback's only trigger. Actively asks PayMongo whether this booking's
 * checkout session was paid and, if so, runs the exact confirmation the
 * webhook runs (src/lib/payments/reconcile.ts, sharing handlePaidEvent's
 * core). Exists because a webhook cannot reach http://localhost:3000 during
 * local development, and because a dropped or delayed webhook is a real,
 * if rare, production gap this application otherwise has no recovery from.
 *
 * requirePlayer IS the guard here — there is no page around this action to
 * gate it a second time. A signed-out caller or an owner/admin account gets
 * AuthError, which is a quiet no-op: this action has no error UI of its own,
 * and the banner's router.refresh() afterward is always safe regardless.
 * reconcilePendingBooking additionally scopes its own query to
 * `bookingId` AND `playerId`, so even a caller that tampered with the
 * bookingId argument can never trigger a check on, let alone confirm,
 * someone else's booking.
 *
 * Bookings never trust the browser's own `?paid=1` for anything beyond copy
 * — see src/app/bookings/[id]/page.tsx. The evidence here is exclusively
 * PayMongo's own retrieveSession response, fetched fresh on every call.
 */
export async function checkPaymentAction(bookingId: string): Promise<void> {
  let user
  try {
    user = await requirePlayer()
  } catch (error) {
    if (error instanceof AuthError) return
    throw error
  }

  await reconcilePendingBooking(bookingId, user.id, paymongo)
}
