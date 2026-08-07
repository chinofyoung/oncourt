'use server'

import { redirect } from 'next/navigation'
import { AuthError, requirePlayer } from '@/lib/auth/guards'
import { startCheckout, type StartCheckoutResult } from '@/lib/payments/checkout'
import { paymongo } from '@/lib/payments/paymongo'
import { PaymentConfigError, requiredEnv } from '@/lib/payments/provider'

export type CheckoutFormState = { error: string } | null

type FailureReason = Exclude<StartCheckoutResult, { ok: true }>['reason']

/**
 * The `never` default is a compile-time guard: if StartCheckoutResult's reason
 * union ever grows, this fails to typecheck instead of silently falling
 * through to a generic message for a paying user.
 */
function messageFor(reason: FailureReason): string {
  switch (reason) {
    case 'stale_hold':
      return 'That hold is no longer available. Pick your slots again to start a new one.'
    case 'unknown_method':
      return 'Pick one of the payment methods listed above.'
    case 'provider_unavailable':
      return "We couldn't reach the payment provider. Your slots are still held — please try again."
    default: {
      const exhaustive: never = reason
      return exhaustive
    }
  }
}

/**
 * The one exported action of this file, and the only one this slice adds.
 *
 * Thin and guarded by construction: every rule about who may pay for what
 * lives in startCheckout's WHERE clause (src/lib/payments/checkout.ts), which
 * is where it is testable. This function resolves the session, hands over the
 * real provider, and turns a typed reason into a sentence.
 *
 * requirePlayer, not requireUser: roles are exclusive, and an owner or admin
 * account can never hold a paid booking — so it can never pay for one either.
 * The 401/403 split mirrors createHoldAction: a signed-out visitor is mid-flow
 * and belongs at /login; a signed-in owner needs an explanation, not a login
 * page they are already past.
 */
export async function payAction(
  _prevState: CheckoutFormState,
  formData: FormData,
): Promise<CheckoutFormState> {
  let user
  try {
    user = await requirePlayer()
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.status === 401) redirect('/login')
      return { error: "Owner and admin accounts can't pay for court bookings." }
    }
    throw error
  }

  const bookingId = String(formData.get('bookingId') ?? '')
  const paymentMethod = String(formData.get('paymentMethod') ?? '')

  let result: StartCheckoutResult
  try {
    result = await startCheckout({
      bookingId,
      // Never from the form: a playerId taken from client input would let
      // anyone pay for — and thereby confirm — anyone else's hold.
      playerId: user.id,
      paymentMethod,
      provider: paymongo,
      siteUrl: requiredEnv('SITE_URL'),
    })
  } catch (error) {
    // A missing PAYMONGO_SECRET_KEY or SITE_URL is our misconfiguration.
    // Surface it as a sentence rather than an error boundary, and never leak
    // which variable is missing.
    if (error instanceof PaymentConfigError) {
      return { error: 'Payments are temporarily unavailable. Please try again shortly.' }
    }
    throw error
  }

  if (!result.ok) return { error: messageFor(result.reason) }

  // Outside the try: redirect() signals by throwing, and catching it here
  // would turn a successful checkout into an error message. The destination is
  // PayMongo's hosted page — an absolute, external URL.
  redirect(result.checkoutUrl)
}
