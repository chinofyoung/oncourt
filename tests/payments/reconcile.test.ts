import { expect, test, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { reconcilePendingBooking } from '@/lib/payments/reconcile'
import { PaymentProviderError, type PaidEvent, type PaymentProvider } from '@/lib/payments/provider'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedPayment,
  seedPlayer,
} from '../helpers/fixtures'

/**
 * A hand-written PaymentProvider whose only live method is retrieveSession —
 * the one method this slice adds. Matches
 * tests/payments/checkout.test.ts's recordingProvider precedent:
 * createCheckoutSession/verifyWebhookSignature/parsePaidEvent are already
 * proven elsewhere (tests/payments/paymongo.test.ts,
 * tests/payments/checkout.test.ts, tests/payments/webhook.test.ts), so this
 * double stubs them out and never touches PayMongo's network.
 */
function fakeProvider(
  behavior: { event?: PaidEvent | null; throws?: unknown } = {},
): { provider: PaymentProvider; retrieveSession: ReturnType<typeof vi.fn> } {
  const retrieveSession = vi.fn(async () => {
    if (behavior.throws) throw behavior.throws
    return behavior.event ?? null
  })
  const provider: PaymentProvider = {
    createCheckoutSession: async () => {
      throw new Error('not used by this test file')
    },
    verifyWebhookSignature: () => true,
    parsePaidEvent: () => null,
    retrieveSession,
  }
  return { provider, retrieveSession }
}

function paidEvent(overrides: Partial<PaidEvent> = {}): PaidEvent {
  return {
    eventId: '',
    eventType: 'checkout_session.payment.paid',
    livemode: false,
    sessionId: overrides.sessionId ?? 'cs_x',
    paymentId: overrides.paymentId ?? 'pay_' + crypto.randomUUID(),
    amountCentavos: overrides.amountCentavos ?? 100_000,
    paymentMethod: overrides.paymentMethod ?? 'gcash',
  }
}

/**
 * A pending_payment booking plus the `payments` row a completed startCheckout
 * would have written for it: a ₱1,000 GCash session with a ₱22.30 quoted
 * processor fee, still `status = 'pending'` — exactly the shape
 * reconcilePendingBooking looks for.
 */
async function seedHold(opts: { startHour?: number } = {}) {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2026-12-05', opts.startHour ?? 18),
    status: 'pending_payment',
    totalCentavos: 100_000,
    expiresAt: new Date(Date.now() + 600_000),
  })
  const sessionId = 'cs_' + crypto.randomUUID()
  await seedPayment({
    bookingId,
    sessionId,
    paymentMethod: 'gcash',
    amountCentavos: 100_000,
    processorFeeCentavos: 2_230,
  })
  return { bookingId, playerId, branchId, courtIds, sessionId }
}

async function readBookingStatus(bookingId: string): Promise<string> {
  const result = await db.execute(
    sql`select status::text as status from bookings where id = ${bookingId}::uuid`,
  )
  return result.rows[0].status as string
}

async function readPayments(bookingId: string) {
  const result = await db.execute(sql`
    select provider_payment_id, status::text as status, needs_refund, raw_event
    from payments where booking_id = ${bookingId}::uuid order by created_at, id
  `)
  return result.rows.map((row) => ({
    paymentId: row.provider_payment_id as string | null,
    status: row.status as string,
    needsRefund: row.needs_refund === true,
    rawEvent: row.raw_event as Record<string, unknown> | null,
  }))
}

test('a paid session reconciles a pending_payment booking to confirmed', async () => {
  const { bookingId, playerId, sessionId } = await seedHold({ startHour: 8 })
  const { provider, retrieveSession } = fakeProvider({
    event: paidEvent({ sessionId, amountCentavos: 100_000 }),
  })

  expect(await reconcilePendingBooking(bookingId, playerId, provider)).toBe('confirmed')
  expect(await readBookingStatus(bookingId)).toBe('confirmed')
  expect(retrieveSession).toHaveBeenCalledTimes(1)
  expect(retrieveSession).toHaveBeenCalledWith(sessionId)

  const payments = await readPayments(bookingId)
  expect(payments).toHaveLength(1)
  expect(payments[0]).toMatchObject({ status: 'paid', needsRefund: false })
  // Genuine data, but tagged so an admin reading raw_event later can tell a
  // pulled reconciliation apart from a real pushed webhook delivery.
  expect(payments[0].rawEvent).toMatchObject({ source: 'reconciliation' })
})

test('reconciling an already-confirmed booking is a safe no-op', async () => {
  const { bookingId, playerId, sessionId } = await seedHold({ startHour: 9 })
  const { provider } = fakeProvider({ event: paidEvent({ sessionId, amountCentavos: 100_000 }) })

  expect(await reconcilePendingBooking(bookingId, playerId, provider)).toBe('confirmed')
  const afterFirst = await readPayments(bookingId)

  // Second call: the booking is no longer pending_payment (and the one
  // payments row is no longer status = 'pending'), so the query that picks a
  // session to check finds nothing. 'not_found', not a second confirm
  // attempt — and PayMongo is never even asked again.
  const { provider: secondProvider, retrieveSession } = fakeProvider({
    event: paidEvent({ sessionId, amountCentavos: 100_000 }),
  })
  expect(await reconcilePendingBooking(bookingId, playerId, secondProvider)).toBe('not_found')
  expect(retrieveSession).not.toHaveBeenCalled()
  expect(await readBookingStatus(bookingId)).toBe('confirmed')
  expect(await readPayments(bookingId)).toEqual(afterFirst)
})

test('two concurrent reconciles for the same session confirm exactly once — the loser lands on duplicate, never a double confirm', async () => {
  // Both providers report the identical already-decided payment id,
  // modeling two browser tabs (or two overlapping polls) asking about the
  // same still-pending session before either has committed anything.
  const { bookingId, playerId, sessionId } = await seedHold({ startHour: 10 })
  const paymentId = 'pay_' + crypto.randomUUID()
  const { provider: providerA } = fakeProvider({
    event: paidEvent({ sessionId, paymentId, amountCentavos: 100_000 }),
  })
  const { provider: providerB } = fakeProvider({
    event: paidEvent({ sessionId, paymentId, amountCentavos: 100_000 }),
  })

  const outcomes = await Promise.all([
    reconcilePendingBooking(bookingId, playerId, providerA),
    reconcilePendingBooking(bookingId, playerId, providerB),
  ])
  // handlePaidEvent's own `for update` lock on the payments row serializes
  // the two: whichever commits first claims provider_payment_id via the
  // UPDATE path; the second re-reads that claimed row, takes the INSERT
  // path with the SAME provider_payment_id, and collides on the unique
  // index — the identical mechanism that already makes a real webhook's own
  // retries idempotent (tests/payments/webhook.test.ts).
  expect(outcomes.slice().sort()).toEqual(['confirmed', 'duplicate'])
  expect(await readBookingStatus(bookingId)).toBe('confirmed')
  expect(await readPayments(bookingId)).toHaveLength(1)
})

test('an unpaid/pending session changes nothing', async () => {
  const { bookingId, playerId } = await seedHold({ startHour: 11 })
  // PayMongo says: not paid yet.
  const { provider } = fakeProvider({ event: null })

  expect(await reconcilePendingBooking(bookingId, playerId, provider)).toBe('not_paid')
  expect(await readBookingStatus(bookingId)).toBe('pending_payment')
  expect((await readPayments(bookingId))[0]).toMatchObject({ paymentId: null, status: 'pending' })
})

test('an amount that does not match the session quote flags without confirming', async () => {
  const { bookingId, playerId, sessionId } = await seedHold({ startHour: 12 })
  const { provider } = fakeProvider({
    event: paidEvent({ sessionId, amountCentavos: 99_999 }), // underpaid
  })

  expect(await reconcilePendingBooking(bookingId, playerId, provider)).toBe('amount_mismatch')
  expect(await readBookingStatus(bookingId)).toBe('pending_payment')
  const payments = await readPayments(bookingId)
  expect(payments[0]).toMatchObject({ status: 'paid', needsRefund: true })
})

test('a malformed/unexpected retrieve response confirms nothing', async () => {
  // retrieveSession's own contract (src/lib/payments/provider.ts,
  // src/lib/payments/paymongo.ts's paidPaymentFromSessionResource) maps a
  // response it cannot read with certainty to the SAME null a genuinely
  // unpaid session produces — never a guess either way. This double models
  // that null directly, exactly as the adapter itself would return it for a
  // shape it could not parse.
  const { bookingId, playerId } = await seedHold({ startHour: 13 })
  const { provider } = fakeProvider({ event: null })

  expect(await reconcilePendingBooking(bookingId, playerId, provider)).toBe('not_paid')
  expect(await readBookingStatus(bookingId)).toBe('pending_payment')
  expect((await readPayments(bookingId))[0]).toMatchObject({ paymentId: null, status: 'pending' })
})

test('a provider failure is distinct from "not paid" and leaves the booking untouched', async () => {
  const { bookingId, playerId } = await seedHold({ startHour: 14 })
  const { provider } = fakeProvider({ throws: new PaymentProviderError('PayMongo did not respond') })

  expect(await reconcilePendingBooking(bookingId, playerId, provider)).toBe('provider_unavailable')
  expect(await readBookingStatus(bookingId)).toBe('pending_payment')
})

test('an unexpected (non-provider) error still propagates — this is not swallowed like a provider outage', async () => {
  const { bookingId, playerId } = await seedHold({ startHour: 15 })
  const { provider } = fakeProvider({ throws: new Error('a genuine bug, not PayMongo being slow') })

  await expect(reconcilePendingBooking(bookingId, playerId, provider)).rejects.toThrow(
    'a genuine bug, not PayMongo being slow',
  )
  expect(await readBookingStatus(bookingId)).toBe('pending_payment')
})

test("a stranger cannot trigger a check on someone else's booking", async () => {
  const { bookingId, sessionId } = await seedHold({ startHour: 16 })
  const stranger = await seedPlayer()
  const { provider, retrieveSession } = fakeProvider({
    event: paidEvent({ sessionId, amountCentavos: 100_000 }),
  })

  // Ownership is IN THE QUERY, exactly like getBookingReceipt/startCheckout:
  // wrong owner and "no such booking" are the same 'not_found' answer, and
  // PayMongo is never even asked.
  expect(await reconcilePendingBooking(bookingId, stranger, provider)).toBe('not_found')
  expect(retrieveSession).not.toHaveBeenCalled()
  expect(await readBookingStatus(bookingId)).toBe('pending_payment')
})

test('a forged non-UUID id is a no-op, never a ::uuid cast error', async () => {
  const { playerId } = await seedHold({ startHour: 17 })
  const { provider, retrieveSession } = fakeProvider({ event: paidEvent() })

  expect(await reconcilePendingBooking('not-a-uuid', playerId, provider)).toBe('not_found')
  expect(await reconcilePendingBooking('11111111-1111-1111-1111-111111111111', 'also-not-a-uuid', provider)).toBe(
    'not_found',
  )
  expect(retrieveSession).not.toHaveBeenCalled()
})

test('a booking with no session on it at all is a no-op', async () => {
  // A hold that was created but never reached startCheckout — no payments
  // row exists yet, so there is nothing to ask PayMongo about.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2026-12-05', 18),
    status: 'pending_payment',
    totalCentavos: 100_000,
    expiresAt: new Date(Date.now() + 600_000),
  })
  const { provider, retrieveSession } = fakeProvider({ event: paidEvent() })

  expect(await reconcilePendingBooking(bookingId, playerId, provider)).toBe('not_found')
  expect(retrieveSession).not.toHaveBeenCalled()
})
