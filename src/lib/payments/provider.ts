import 'server-only'
import type { PaymentMethodKey } from '@/lib/payments/methods'

/**
 * The provider boundary the parent spec calls for: "PaymentProvider interface
 * with PayMongo as the first adapter. Provider is swappable (e.g. Xendit)
 * without touching booking logic."
 *
 * Only three operations, because only three are needed: start a payment, prove
 * an inbound webhook is genuine, and read the one event that matters. Anything
 * a second adapter would not also need does not belong here.
 */

export type CheckoutSessionInput = {
  /** Our booking id. Sent as the provider's reference number and metadata. */
  bookingId: string
  /** The total to charge, in integer centavos. Already grossed up if the player bears the fee. */
  amountCentavos: number
  /** Our rate key ('gcash' | 'maya' | 'card'). The ADAPTER maps it to the provider's spelling. */
  paymentMethod: PaymentMethodKey
  /** The single line item's name, e.g. "Palo Verde Pickle Club — Court A2 (Indoor)". */
  lineName: string
  /** Human summary shown on the hosted page, e.g. "Fri, Aug 1 · 7 – 9 AM · 2 hours". */
  description: string
  successUrl: string
  cancelUrl: string
}

export type CheckoutSession = { sessionId: string; checkoutUrl: string }

/**
 * The provider-agnostic shape of "a payment succeeded".
 *
 * `sessionId` is the load-bearing field: the webhook resolves OUR payments row
 * by it, and reconciles the paid amount against the amount THAT session
 * quoted. An event with no session reference is unusable and must parse to
 * null rather than to a guess.
 */
export type PaidEvent = {
  eventId: string
  eventType: string
  livemode: boolean
  sessionId: string
  paymentId: string
  amountCentavos: number
  /** Our rate key, mapped back from the provider's spelling. Null when absent or unknown. */
  paymentMethod: string | null
}

/** `nowMs` and `toleranceSeconds` exist so the replay window is testable without a fake clock. */
export type VerifyOptions = { nowMs?: number; toleranceSeconds?: number }

export interface PaymentProvider {
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession>
  verifyWebhookSignature(
    rawBody: string,
    header: string,
    secret: string,
    options?: VerifyOptions,
  ): boolean
  parsePaidEvent(rawBody: string): PaidEvent | null
  /**
   * Actively asks the provider whether a checkout session it created has
   * been paid — the fallback for a webhook that never arrives. A local dev
   * server at http://localhost:3000 is one reason (PayMongo cannot POST to
   * it); a dropped or delayed delivery in production is another, and a real
   * gap either way, because `parsePaidEvent`/the webhook route are otherwise
   * the ONLY path to `confirmed`.
   *
   * Returns the SAME `PaidEvent` shape `parsePaidEvent` produces — never a
   * parallel shape — so a caller has exactly one thing to hand to
   * `handlePaidEvent` regardless of whether the paid event was pushed or
   * pulled. Null covers both "not paid yet" and "the response doesn't carry
   * a paid payment we can read with certainty," mirroring `parsePaidEvent`'s
   * own null contract: never guess, even about a well-formed but unpaid
   * response.
   *
   * Network failure, a non-2xx response, or an unparsable body throw
   * `PaymentProviderError` (matching `createCheckoutSession`) rather than
   * returning null — "PayMongo could not be reached" and "PayMongo says this
   * is not paid" are different facts, and a caller retrying later needs to
   * tell them apart.
   */
  retrieveSession(sessionId: string): Promise<PaidEvent | null>
}

/** The provider refused, timed out, or answered something we cannot read. */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'PaymentProviderError'
  }
}

/** A required secret is missing from the environment. */
export class PaymentConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentConfigError'
  }
}

/**
 * Read at the CALL SITE, never at module scope.
 *
 * Module-scope reads would throw during `next build` and take down every page
 * in the application over a payments secret. Per the spec: "Absent keys must
 * fail loudly at the call site with a clear message, never silently no-op."
 */
export function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new PaymentConfigError(`${name} is not set`)
  return value
}
