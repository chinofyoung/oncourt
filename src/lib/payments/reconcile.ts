import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { PaymentProviderError, type PaymentProvider } from '@/lib/payments/provider'
import { handlePaidEvent, type WebhookOutcome } from '@/lib/payments/webhook'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ReconcileOutcome =
  | WebhookOutcome
  // Nothing payable to check at all: a bad id, someone else's booking, a
  // booking that is no longer pending_payment, or a booking with no session
  // left unresolved. Deliberately one bucket — see the query below — so this
  // path never becomes an existence oracle for a stranger's booking id.
  | 'not_found'
  // PayMongo answered; the session is not paid (yet). Distinct from
  // 'not_found' for the (currently unused) benefit of a caller that wants to
  // tell "nothing to check" apart from "checked, still unpaid".
  | 'not_paid'
  // PayMongo could not be reached, timed out, or answered with something
  // unreadable. The booking is untouched; the next poll tries again.
  | 'provider_unavailable'

/**
 * Actively asks the provider "is this checkout session paid?" for one
 * player's booking, and — if so — runs the EXACT SAME confirmation
 * `handlePaidEvent` runs for a genuine webhook delivery (see the comment on
 * that function). This is the fallback for a webhook that never arrives: a
 * local dev server at http://localhost:3000 PayMongo cannot POST to, or a
 * dropped/delayed delivery in production, which otherwise strands a paid
 * booking at `pending_payment` forever.
 *
 * SCOPED TO ITS OWN PLAYER, in the query below — exactly like
 * getBookingReceipt and startCheckout: fetching by booking id and checking
 * ownership afterward would leak existence (a stranger could tell a real
 * booking id from a fake one). Here every reason for "nothing to check" —
 * wrong id, wrong owner, wrong status, no unresolved session — collapses to
 * the same 'not_found'.
 *
 * Only ever looks at a booking still `pending_payment`, and only a session
 * this booking's OWN unresolved `payments` row still points at
 * (`status = 'pending'`) — never a session that already has an outcome
 * (paid-and-flagged, or claimed by a different payment), so a poll that
 * fires after the booking is already resolved (by this same reconciliation,
 * by a webhook that arrives a moment later, or by an admin) costs nothing
 * beyond the one read below. That is also what makes two concurrent
 * reconciles, or a webhook and a reconcile racing each other, safe: whichever
 * writes first claims the payments row inside handlePaidEvent's own
 * transaction, and provider_payment_id's unique index turns the loser into
 * `handlePaidEvent`'s ordinary 'duplicate' outcome — the identical mechanism
 * that already makes PayMongo's own webhook retries idempotent.
 *
 * The MOST RECENT unresolved session is the one checked: a player who went
 * back and picked a different method (startCheckout's "second session
 * replaces the first") can only ever be paying the latest one, and
 * `handlePaidEvent`'s own anchor-row rule (oldest row PER SESSION) is
 * unaffected by which session we choose to ask PayMongo about.
 */
export async function reconcilePendingBooking(
  bookingId: string,
  playerId: string,
  provider: PaymentProvider,
): Promise<ReconcileOutcome> {
  // Shape-checked before either reaches a `::uuid` cast (22P02 otherwise) —
  // the same guard startCheckout uses, and for the same reason: a forged id
  // and a vanished booking are the same honest answer.
  if (!UUID_RE.test(bookingId) || !UUID_RE.test(playerId)) return 'not_found'

  const rows = await db.execute(sql`
    select p.provider_session_id as session_id
    from payments p
    join bookings bk on bk.id = p.booking_id
    where bk.id = ${bookingId}::uuid
      and bk.player_id = ${playerId}::uuid
      and bk.status = 'pending_payment'
      and p.status = 'pending'
      and p.provider_session_id is not null
    order by p.created_at desc, p.id desc
    limit 1
  `)
  const sessionId = rows.rows[0]?.session_id as string | undefined
  if (!sessionId) return 'not_found'

  let event
  try {
    event = await provider.retrieveSession(sessionId)
  } catch (error) {
    // A benign, expected failure mode from this caller's point of view: the
    // banner that triggers this polls on its own bounded schedule, and the
    // next tick is the retry. Rethrowing would surface as a Server Action
    // error for what is really just "PayMongo was slow just now".
    if (error instanceof PaymentProviderError) return 'provider_unavailable'
    throw error
  }
  if (!event) return 'not_paid'

  // The shared core. `rawBody` is ordinarily the webhook's own delivery
  // payload, verbatim, for audit; there is no such payload here, so a
  // clearly-tagged JSON record of the retrieved event stands in — still
  // genuine data (not a guess), still sanitized by handlePaidEvent's own
  // sanitizeForJsonb before it reaches raw_event, and still enough for an
  // admin reading payments.raw_event later to tell a pulled reconciliation
  // apart from a pushed webhook delivery.
  return handlePaidEvent(event, JSON.stringify({ source: 'reconciliation', event }))
}
