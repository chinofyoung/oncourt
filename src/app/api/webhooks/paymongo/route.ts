import { PAID_EVENT_TYPE, PAYMONGO_SIGNATURE_HEADER, paymongo, paymongoLiveMode } from '@/lib/payments/paymongo'
import { requiredEnv } from '@/lib/payments/provider'
import { handlePaidEvent } from '@/lib/payments/webhook'

/**
 * THE FIRST PUBLIC, UNAUTHENTICATED WRITE ENDPOINT IN THIS APPLICATION.
 *
 * Every other write here is behind a session guard. This one is behind a
 * signature — and it is a ROUTE HANDLER, NOT A SERVER ACTION, which is why it
 * is exempt from tests/auth/action-coverage.test.ts BY CONSTRUCTION. That test
 * globs the whole src tree and then skips any file without a 'use server'
 * directive; this file has none, and must never be given one. It could not
 * satisfy that test in any case: the caller is
 * PayMongo, which has no session, so no session guard is applicable and none
 * may be added. See the plan's Task 5 for the recorded decision.
 *
 * What stands in for a guard:
 *   1. HMAC-SHA256 over the RAW request bytes, timing-safe, with a bounded
 *      replay window (src/lib/payments/paymongo.ts).
 *   2. An enumerated state table in which the ONLY path to `confirmed`
 *      requires a payments row we created, an amount we quoted, and a slot
 *      that is verifiably free (src/lib/payments/webhook.ts).
 *
 * node:crypto needs the Node runtime. That is the App Router default for
 * Route Handlers, but it is pinned here rather than assumed — an edge runtime
 * would break signature verification at the worst possible moment.
 */
export const runtime = 'nodejs'

/**
 * REVIEW FIX I-1: `parsePaidEvent` returning null is the landing zone for the
 * slice's biggest unverified assumption — the paid-event payload shape, whose
 * docs 404'd. If PayMongo's real shape differs from what that parser expects,
 * EVERY payment would silently land here and be discarded with a 200, forever.
 *
 * This is a cheap, INDEPENDENT re-check: does the raw body's own event-type
 * field match the paid-event constant, even though the full structural parse
 * gave up? A plain JSON.parse plus one field read is negligible next to the
 * signature verification already done above, so there is no cost reason not
 * to run it on every ignored event. Session/payment ids are best-effort only
 * (`undefined` when the shape is too broken to reach them) — the caller must
 * never log more than that plus the body's LENGTH, never its content, and
 * never the signature or any secret.
 */
function describeIfPaidEventShape(rawBody: string): {
  isPaidEventType: boolean
  sessionId?: string
  paymentId?: string
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return { isPaidEventType: false }
  }
  const eventAttributes = (parsed as { data?: { attributes?: unknown } } | null)?.data?.attributes as
    | { type?: unknown; data?: { id?: unknown; attributes?: { payments?: unknown[] } } }
    | undefined
  if (!eventAttributes || eventAttributes.type !== PAID_EVENT_TYPE) return { isPaidEventType: false }

  const sessionId = typeof eventAttributes.data?.id === 'string' ? eventAttributes.data.id : undefined
  const payments = eventAttributes.data?.attributes?.payments
  const firstPaymentId =
    Array.isArray(payments) && typeof (payments[0] as { id?: unknown })?.id === 'string'
      ? ((payments[0] as { id: string }).id as string)
      : undefined
  return { isPaidEventType: true, sessionId, paymentId: firstPaymentId }
}

export async function POST(request: Request): Promise<Response> {
  // RAW BODY, ALWAYS. request.json() would parse and re-stringify, and the
  // signature — which is over the exact bytes PayMongo sent — would never
  // verify again. The parsed event is derived from this same string below.
  const rawBody = await request.text()
  const header = request.headers.get(PAYMONGO_SIGNATURE_HEADER) ?? ''

  let secret: string
  try {
    secret = requiredEnv('PAYMONGO_WEBHOOK_SECRET')
  } catch {
    // A missing secret is our misconfiguration, not PayMongo's fault: 500 so
    // it retries once we have fixed it, rather than 401 so it gives up.
    // REVIEW FIX I-3: logged with no request data at all — there is nothing
    // safe to log here beyond the fact that this deployment is misconfigured.
    console.error('[payments/webhook] PAYMONGO_WEBHOOK_SECRET is not set — refusing to verify')
    return new Response('Webhook is not configured', { status: 500 })
  }

  if (!paymongo.verifyWebhookSignature(rawBody, header, secret)) {
    // Nothing about the request is logged or echoed: at this point the body is
    // unverified, attacker-controlled input. REVIEW FIX I-3: only its length
    // and whether a signature header was even present are safe to record —
    // never the header value (a digest, not a secret, but still no reason to
    // keep attacker-supplied text) and never the body.
    console.warn('[payments/webhook] invalid signature — refusing with 401', {
      bodyLength: rawBody.length,
      hadSignatureHeader: header.length > 0,
    })
    return new Response('Invalid signature', { status: 401 })
  }

  const event = paymongo.parsePaidEvent(rawBody)
  // Other event types, and anything we cannot read with certainty, get a 200
  // so PayMongo stops retrying. Non-2xx is reserved for signature failure and
  // genuine server errors, where a retry is exactly what we want.
  if (!event) {
    // REVIEW FIX I-1: independently confirm whether this was a paid event we
    // simply failed to parse — if so, that is a payload-shape mismatch and a
    // silent 200 would discard real money with no trace. Logged only when it
    // matches; every other ignored event (a different event type entirely)
    // stays silent, as before.
    const shape = describeIfPaidEventShape(rawBody)
    if (shape.isPaidEventType) {
      console.error('[payments/webhook] a paid event we could not parse was silently 200ed', {
        bodyLength: rawBody.length,
        sessionId: shape.sessionId,
        paymentId: shape.paymentId,
      })
    }
    return Response.json({ received: true, outcome: 'ignored' })
  }

  // REVIEW FIX M-4: `event.livemode` was parsed and never consulted. Our own
  // mode is derived from the API secret key's own prefix — not NODE_ENV,
  // which says nothing about which PayMongo mode this deployment is actually
  // wired to — so this is self-consistent: whichever mode PAYMONGO_SECRET_KEY
  // belongs to is the only mode this process is authoritative for. A
  // contradicting event (a live event delivered to a test-mode deployment, or
  // vice versa) is not this deployment's concern; ignored, not confirmed.
  let apiSecretKey: string
  try {
    apiSecretKey = requiredEnv('PAYMONGO_SECRET_KEY')
  } catch {
    console.error('[payments/webhook] PAYMONGO_SECRET_KEY is not set — cannot verify event mode')
    return new Response('Webhook is not configured', { status: 500 })
  }
  if (paymongoLiveMode(apiSecretKey) !== event.livemode) {
    // REVIEW FIX I-1: the one branch here that could discard PRODUCTION
    // traffic wholesale — a live event arriving at a deployment wired to the
    // wrong key, or vice versa. Ids only, never the raw body or any secret.
    console.warn('[payments/webhook] livemode mismatch — ignoring event', {
      sessionId: event.sessionId,
      paymentId: event.paymentId,
      eventLivemode: event.livemode,
      ourLivemode: paymongoLiveMode(apiSecretKey),
    })
    return Response.json({ received: true, outcome: 'ignored' })
  }

  // Deliberately NOT wrapped in a try/catch: an unexpected throw becomes a
  // 500, and a 500 is the retry signal. Swallowing it into a 200 would tell
  // PayMongo a payment was handled when it was not.
  const outcome = await handlePaidEvent(event, rawBody)
  return Response.json({ received: true, outcome })
}
