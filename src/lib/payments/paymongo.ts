import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { isPaymentMethod, type PaymentMethodKey } from '@/lib/payments/methods'
import {
  PaymentProviderError,
  requiredEnv,
  type CheckoutSession,
  type CheckoutSessionInput,
  type PaidEvent,
  type PaymentProvider,
  type VerifyOptions,
} from '@/lib/payments/provider'

export const PAYMONGO_API_BASE = 'https://api.paymongo.com/v1'

/**
 * Without a bound, a hung PayMongo would leave the checkout submit — and the
 * player staring at it — pending indefinitely, with no recourse but a reload.
 * The lesson from src/lib/geo/geocode.ts, applied where the stakes are money.
 */
export const PAYMONGO_TIMEOUT_MS = 10_000

/** Lowercased: Headers.get() is case-insensitive, but our own lookups are not. */
export const PAYMONGO_SIGNATURE_HEADER = 'paymongo-signature'

/**
 * Replay window. A captured request replayed later than this is refused even
 * with a perfect digest. Not a documented PayMongo value — our own choice,
 * named per the spec's "with the tolerance stated as a named constant".
 * Generous enough that a legitimate retry of a fresh delivery still verifies.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 300

/**
 * The ONLY event this application acts on.
 *
 * Not `payment.paid`: that payload carries no checkout-session reference, and
 * the session id is exactly what the amount reconciliation needs — a player
 * who returns to checkout and picks a different method has two live sessions
 * which, for the 'player' bearer, legitimately quote different amounts.
 */
export const PAID_EVENT_TYPE = 'checkout_session.payment.paid'

/**
 * Review finding M-4: `PaidEvent.livemode` was parsed and then never
 * consulted. Deriving OUR mode from the API secret key's own prefix — rather
 * than from `NODE_ENV`, which says nothing about which PayMongo mode this
 * deployment is actually wired to — keeps the check self-consistent: whatever
 * `PAYMONGO_SECRET_KEY` this process is configured with IS the mode this
 * process is authoritative for. PayMongo's own key format is `sk_test_...` /
 * `sk_live_...`; anything else (a malformed or placeholder key) is treated as
 * test mode, the safer default.
 */
export function paymongoLiveMode(secretKey: string): boolean {
  return secretKey.startsWith('sk_live_')
}

/**
 * The two directions of the one place our vocabulary and PayMongo's differ.
 * `processor_rates` (and therefore the whole application) says 'maya';
 * PayMongo's payment_method_types and source.type say 'paymaya'. Isolated here
 * so swapping providers, or correcting a spelling, is a one-line change.
 */
const PAYMONGO_TYPE_BY_METHOD: Record<PaymentMethodKey, string> = {
  gcash: 'gcash',
  maya: 'paymaya',
  card: 'card',
}
const METHOD_BY_PAYMONGO_TYPE: Record<string, string> = {
  gcash: 'gcash',
  paymaya: 'maya',
  card: 'card',
}

/**
 * Constant-time string comparison that also tolerates a length mismatch.
 *
 * `timingSafeEqual` THROWS when the buffers differ in length, so the length
 * check has to come first — and that is safe to leak: the length of a hex
 * digest is fixed and public, and a wrong-length candidate is wrong regardless.
 */
function timingSafeEqualString(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(candidate, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Verifies a `Paymongo-Signature` header over the RAW request body.
 *
 * The header is comma-separated `t=<unix seconds>,te=<test sig>,li=<live sig>`;
 * the signed string is `<t>.<rawBody>`, HMAC-SHA256 keyed with the webhook's
 * own secret. Both `te` and `li` are checked against our single secret, which
 * cannot admit a cross-mode event: PayMongo issues a separate secret per
 * webhook endpoint and test/live endpoints are separate objects, so only one
 * position can ever match.
 *
 * Returns FALSE, never throws, for every malformed input — a webhook endpoint
 * must answer a garbage request with 401, not a 500.
 */
export function verifyPaymongoSignature(
  rawBody: string,
  header: string,
  secret: string,
  options: VerifyOptions = {},
): boolean {
  if (!secret) return false

  const parts = new Map<string, string>()
  for (const chunk of header.split(',')) {
    const separator = chunk.indexOf('=')
    if (separator === -1) continue
    parts.set(chunk.slice(0, separator).trim(), chunk.slice(separator + 1).trim())
  }

  const timestamp = parts.get('t')
  if (!timestamp || !/^\d+$/.test(timestamp)) return false

  // Absolute, not one-sided: a forged future timestamp must not buy an
  // attacker a long replay window later.
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000)
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS
  if (Math.abs(nowSeconds - Number(timestamp)) > tolerance) return false

  // Digest encoding: ASSUMED hex. PayMongo's docs do not state the encoding;
  // every published integration treats it as hex, matching what
  // createHmac(...).digest('hex') produces. If a real sandbox event proves
  // this wrong, this is the one line to change (Task 8).
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')

  const candidates = [parts.get('te'), parts.get('li')].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  if (candidates.length === 0) return false

  return candidates.some((candidate) => timingSafeEqualString(expected, candidate))
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

/**
 * Reads a `checkout_session.payment.paid` body into the provider-agnostic
 * PaidEvent, or null.
 *
 * NULL IS ALWAYS THE ANSWER WHEN ANYTHING IS UNCERTAIN — a different event
 * type, a missing session id, no `paid` payment, a non-integer amount. The
 * handler turns null into "200 and ignore", which is the safe outcome; a
 * guessed number here would be a wrong booking confirmed for a wrong amount.
 *
 * The payments array is accepted at either documented location (ASSUMPTION:
 * PayMongo's current docs publish the Checkout Session resource, which
 * carries `payments`, and its `payment_intent` sub-resource, but the literal
 * JSON of THIS event 404s in the fetched docs) — accepting both means a
 * documentation gap cannot become a dropped payment. Task 8 confirms the real
 * shape against a dashboard test event.
 */
export function parsePaymongoPaidEvent(rawBody: string): PaidEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return null
  }

  const data = asRecord(asRecord(parsed)?.data)
  const eventAttributes = asRecord(data?.attributes)
  if (!eventAttributes || eventAttributes.type !== PAID_EVENT_TYPE) return null

  const resource = asRecord(eventAttributes.data)
  const sessionId = resource?.id
  const sessionAttributes = asRecord(resource?.attributes)
  if (typeof sessionId !== 'string' || sessionId.length === 0 || !sessionAttributes) return null

  const direct = sessionAttributes.payments
  const nested = asRecord(asRecord(sessionAttributes.payment_intent)?.attributes)?.payments
  const payments = Array.isArray(direct) ? direct : Array.isArray(nested) ? nested : []

  const paid = payments
    .map((entry) => asRecord(entry))
    .find((entry) => asRecord(entry?.attributes)?.status === 'paid')
  const paidAttributes = asRecord(paid?.attributes)
  const paymentId = paid?.id
  const amount = paidAttributes?.amount
  if (typeof paymentId !== 'string' || paymentId.length === 0) return null
  // Money is integer centavos. A string or a fraction is not a number we are
  // willing to reconcile against — never coerce.
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) return null

  const sourceType = asRecord(paidAttributes?.source)?.type
  // Mapping assumption: PayMongo's payment_method_types spelling for Maya is
  // believed to be 'paymaya' (ours is 'maya') but this was not confirmed in
  // the fetched docs; isolated to METHOD_BY_PAYMONGO_TYPE above (Task 8).
  const mapped = typeof sourceType === 'string' ? METHOD_BY_PAYMONGO_TYPE[sourceType] : undefined

  return {
    eventId: typeof data?.id === 'string' ? data.id : '',
    eventType: PAID_EVENT_TYPE,
    livemode: eventAttributes.livemode === true,
    sessionId,
    paymentId,
    amountCentavos: amount,
    paymentMethod: mapped !== undefined && isPaymentMethod(mapped) ? mapped : null,
  }
}

/**
 * The adapter. `fetchImpl` is injected so tests can fake the boundary — the
 * same shape src/lib/geo/geocode.ts uses, and for the same reason: a test
 * suite must never be traffic against somebody else's server, least of all a
 * payment processor's.
 */
export function createPaymongoProvider(fetchImpl: typeof fetch = fetch): PaymentProvider {
  return {
    async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
      // Read at the call site, before any network work: a missing key must
      // fail loudly here, not silently produce an unauthenticated request.
      const secretKey = requiredEnv('PAYMONGO_SECRET_KEY')

      const payload = {
        data: {
          attributes: {
            line_items: [
              {
                name: input.lineName,
                amount: input.amountCentavos,
                currency: 'PHP',
                quantity: 1,
              },
            ],
            // ONE method per session. That is what makes the fee we showed the
            // fee we charge — the parent spec's rule for the 'player' bearer,
            // applied to every bearer so there is only one code path.
            payment_method_types: [PAYMONGO_TYPE_BY_METHOD[input.paymentMethod]],
            success_url: input.successUrl,
            cancel_url: input.cancelUrl,
            description: input.description,
            reference_number: input.bookingId,
            send_email_receipt: false,
            show_description: true,
            show_line_items: true,
            metadata: { booking_id: input.bookingId },
          },
        },
      }

      let response: Response
      try {
        response = await fetchImpl(`${PAYMONGO_API_BASE}/checkout_sessions`, {
          method: 'POST',
          headers: {
            // Secret key as the Basic username with an EMPTY password.
            Authorization: `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(PAYMONGO_TIMEOUT_MS),
        })
      } catch (error) {
        // A dead or hung network becomes our typed error, never a raw
        // DOMException and never a silent null: a checkout that cannot be
        // created has to tell the player so the hold can be retried.
        throw new PaymentProviderError(
          `PayMongo did not respond: ${error instanceof Error ? error.name : 'unknown error'}`,
        )
      }

      if (!response.ok) {
        throw new PaymentProviderError('PayMongo refused the checkout session', response.status)
      }

      let body: unknown
      try {
        // Wrapped separately from the fetch call above: a 2xx response with a
        // malformed/truncated body is a distinct failure from a dead network,
        // but it is exactly as unusable, and must become the same typed
        // error rather than a raw SyntaxError escaping past this boundary.
        body = await response.json()
      } catch (error) {
        throw new PaymentProviderError(
          `PayMongo returned an unreadable response: ${error instanceof Error ? error.message : 'invalid JSON'}`,
          response.status,
        )
      }

      const sessionData = asRecord(asRecord(body)?.data)
      const sessionId = sessionData?.id
      const checkoutUrl = asRecord(sessionData?.attributes)?.checkout_url
      if (typeof sessionId !== 'string' || typeof checkoutUrl !== 'string') {
        throw new PaymentProviderError('PayMongo returned no checkout session', response.status)
      }
      return { sessionId, checkoutUrl }
    },

    verifyWebhookSignature: verifyPaymongoSignature,
    parsePaidEvent: parsePaymongoPaidEvent,
  }
}

/** The one the app uses. Swap this line to change providers. */
export const paymongo: PaymentProvider = createPaymongoProvider()
