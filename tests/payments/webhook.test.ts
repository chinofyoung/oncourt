import { createHmac } from 'node:crypto'
import { Client } from 'pg'
import { expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { PAID_EVENT_TYPE } from '@/lib/payments/paymongo'
import {
  manilaHour,
  seedBlock,
  seedBooking,
  seedBranchWithCourts,
  seedPayment,
  seedPlayer,
} from '../helpers/fixtures'

/**
 * The secret is set HERE, not read from .env.local, so this file is
 * deterministic on any machine and never depends on a developer having a real
 * PayMongo webhook configured. It is set before the route module is imported
 * below — but that ordering is belt-and-braces only: the handler reads the
 * variable at CALL time via requiredEnv, never at module scope.
 */
const SECRET = 'whsk_test_' + 'oncourt'
process.env.PAYMONGO_WEBHOOK_SECRET = SECRET

const { POST } = await import('@/app/api/webhooks/paymongo/route')

/**
 * A real HMAC over the real scheme. Nothing about the signature is stubbed —
 * this is the same computation the verifier performs, which is what makes
 * "correct signature accepts, tampered body rejects" a meaningful assertion.
 */
function sign(rawBody: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex')
  return `t=${timestamp},te=${digest}`
}

function paidBody(opts: {
  sessionId: string
  paymentId: string
  amount: number
  method?: string
  livemode?: boolean
}) {
  return JSON.stringify({
    data: {
      id: 'evt_' + crypto.randomUUID(),
      type: 'event',
      attributes: {
        type: PAID_EVENT_TYPE,
        livemode: opts.livemode ?? false,
        created_at: Math.floor(Date.now() / 1000),
        data: {
          id: opts.sessionId,
          type: 'checkout_session',
          attributes: {
            payments: [
              {
                id: opts.paymentId,
                type: 'payment',
                attributes: {
                  amount: opts.amount,
                  status: 'paid',
                  source: { type: opts.method ?? 'gcash' },
                },
              },
            ],
          },
        },
      },
    },
  })
}

async function post(rawBody: string, header = sign(rawBody)) {
  const response = await POST(
    new Request('https://oncourt.test/api/webhooks/paymongo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'paymongo-signature': header },
      body: rawBody,
    }),
  )
  const json = response.status === 200 ? await response.json() : null
  return { status: response.status, outcome: json?.outcome as string | undefined }
}

async function readBooking(bookingId: string) {
  const result = await db.execute(sql`
    select status::text as status, expires_at,
           transaction_fee_centavos, total_charged_centavos,
           processor_fee_centavos, owner_net_centavos, fee_config_snapshot
    from bookings where id = ${bookingId}::uuid
  `)
  const row = result.rows[0]
  return {
    status: row.status as string,
    expiresAt: row.expires_at as string | null,
    transactionFee: Number(row.transaction_fee_centavos),
    totalCharged: Number(row.total_charged_centavos),
    processorFee: Number(row.processor_fee_centavos),
    ownerNet: Number(row.owner_net_centavos),
    snapshot: row.fee_config_snapshot as Record<string, unknown>,
  }
}

async function readPayments(bookingId: string) {
  const result = await db.execute(sql`
    select provider_payment_id, payment_method, amount_centavos,
           status::text as status, needs_refund, paid_at, raw_event
    from payments where booking_id = ${bookingId}::uuid order by created_at, id
  `)
  return result.rows.map((row) => ({
    paymentId: row.provider_payment_id as string | null,
    method: row.payment_method as string | null,
    amount: Number(row.amount_centavos),
    status: row.status as string,
    needsRefund: row.needs_refund === true,
    paidAt: row.paid_at as string | null,
    rawEvent: row.raw_event as Record<string, unknown> | null,
  }))
}

/**
 * A booking plus the `payments` row a completed checkout would have written:
 * a ₱1,000 GCash session, platform-bearer, quoting exactly the court fee with
 * a ₱22.30 processor fee.
 */
async function seedPaidSession(opts: {
  status?: 'pending_payment' | 'confirmed' | 'completed' | 'expired' | 'refunded_manual'
  startHour?: number
  amount?: number
  processorFee?: number
  courtIndex?: number
  /**
   * All existing callers pass a future date, which is exactly why C-1 (a
   * late payment confirming an already-ended slot) went uncaught. Left
   * undefined, behavior is unchanged; C-1's regression tests pass a past
   * date so `ends_at <= now()` is true.
   */
  date?: string
} = {}) {
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  const playerId = await seedPlayer()
  const status = opts.status ?? 'pending_payment'
  const bookingId = await seedBooking({
    courtId: courtIds[opts.courtIndex ?? 0],
    branchId,
    playerId,
    startsAt: manilaHour(opts.date ?? '2026-12-01', opts.startHour ?? 18),
    status,
    totalCentavos: 100_000,
    expiresAt: status === 'pending_payment' ? new Date(Date.now() + 600_000) : null,
  })
  const sessionId = 'cs_' + crypto.randomUUID()
  await seedPayment({
    bookingId,
    sessionId,
    paymentMethod: 'gcash',
    amountCentavos: opts.amount ?? 100_000,
    processorFeeCentavos: opts.processorFee ?? 2_230,
  })
  return { bookingId, playerId, branchId, courtIds, sessionId }
}

// ---------- authorization ----------

test('an invalid signature is refused with 401 and writes nothing', async () => {
  const { bookingId, sessionId } = await seedPaidSession()
  const body = paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000 })

  expect((await post(body, 't=1,te=deadbeef')).status).toBe(401)
  expect((await post(body, '')).status).toBe(401)
  // A perfect digest under the WRONG secret is still 401.
  const wrong = createHmac('sha256', 'whsk_attacker').update(`1.${body}`).digest('hex')
  expect((await post(body, `t=${Math.floor(Date.now() / 1000)},te=${wrong}`)).status).toBe(401)

  expect((await readBooking(bookingId)).status).toBe('pending_payment')
  expect((await readPayments(bookingId))[0].paymentId).toBeNull()
})

test('a tampered body is refused — the signature covers the exact bytes', async () => {
  const { bookingId, sessionId } = await seedPaidSession()
  const honest = paidBody({ sessionId, paymentId: 'pay_x', amount: 100_000 })
  const header = sign(honest)
  const tampered = paidBody({ sessionId, paymentId: 'pay_x', amount: 1 })

  expect((await post(tampered, header)).status).toBe(401)
  expect((await readBooking(bookingId)).status).toBe('pending_payment')
})

test('a stale timestamp is refused even with a correct digest', async () => {
  const { sessionId } = await seedPaidSession({ startHour: 19 })
  const body = paidBody({ sessionId, paymentId: 'pay_y', amount: 100_000 })
  const stale = Math.floor(Date.now() / 1000) - 3_600
  expect((await post(body, sign(body, stale))).status).toBe(401)
})

// ---------- the state table ----------

test('the first paid event confirms the booking and reconciles its money columns', async () => {
  const { bookingId, sessionId } = await seedPaidSession({ startHour: 20 })
  const paymentId = 'pay_' + crypto.randomUUID()

  expect(await post(paidBody({ sessionId, paymentId, amount: 100_000 }))).toEqual({
    status: 200,
    outcome: 'confirmed',
  })

  const booking = await readBooking(bookingId)
  expect(booking).toMatchObject({
    status: 'confirmed',
    // Derived from what the SESSION quoted, per reconcileSession.
    transactionFee: 0,
    totalCharged: 100_000,
    processorFee: 2_230,
    ownerNet: 90_000,
  })
  // "set only while pending_payment" — a confirmed booking carries no clock.
  expect(booking.expiresAt).toBeNull()
  expect(booking.snapshot).toMatchObject({ method: 'gcash' })

  const payments = await readPayments(bookingId)
  expect(payments).toHaveLength(1)
  expect(payments[0]).toMatchObject({
    paymentId, status: 'paid', needsRefund: false, amount: 100_000,
  })
  expect(payments[0].paidAt).not.toBeNull()
  // The provider's own payload is preserved verbatim for audit.
  expect(payments[0].rawEvent).toMatchObject({ data: { attributes: { type: PAID_EVENT_TYPE } } })
})

test('the identical event replayed is a 200 no-op with the booking untouched', async () => {
  const { bookingId, sessionId } = await seedPaidSession({ startHour: 21 })
  const paymentId = 'pay_' + crypto.randomUUID()
  const body = paidBody({ sessionId, paymentId, amount: 100_000 })

  expect(await post(body)).toEqual({ status: 200, outcome: 'confirmed' })
  const afterFirst = await readBooking(bookingId)

  // The replay. 23505 on provider_payment_id is the whole mechanism, and it
  // fires BEFORE any booking write — which is why the second call must not
  // fall through to the "already confirmed = double charge" branch.
  expect(await post(body)).toEqual({ status: 200, outcome: 'duplicate' })

  expect(await readBooking(bookingId)).toEqual(afterFirst)
  const payments = await readPayments(bookingId)
  expect(payments).toHaveLength(1)
  expect(payments[0].needsRefund).toBe(false)
})

test('an event for a session we never created is a 200 no-op', async () => {
  // The spec asks for the payment to be recorded here, but payments.booking_id
  // is `not null` and there is no booking to attach it to — so the honest
  // answer is 200 and no write. See the plan's resolved-ambiguity note 3.
  expect(
    await post(paidBody({ sessionId: 'cs_never_created', paymentId: 'pay_z', amount: 100_000 })),
  ).toEqual({ status: 200, outcome: 'unknown_session' })
})

test('a paid amount that does not match the session quote flags without confirming', async () => {
  const { bookingId, sessionId } = await seedPaidSession({ startHour: 22 })

  expect(
    await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 99_999 })),
  ).toEqual({ status: 200, outcome: 'amount_mismatch' })

  expect((await readBooking(bookingId)).status).toBe('pending_payment')
  const payments = await readPayments(bookingId)
  expect(payments[0]).toMatchObject({ status: 'paid', needsRefund: true })
  // The QUOTE is preserved, not overwritten by the paid amount: it is the
  // reconciliation anchor and the evidence of the mismatch.
  expect(payments[0].amount).toBe(100_000)
})

test('I-1: repeated mismatched deliveries never drift the reconciliation anchor', async () => {
  // Review finding I-1, reproduced: resolving the anchor row by
  // `order by created_at desc` picks the NEWEST payments row. The insert path
  // (taken once the original row is claimed) writes the PAID amount, not a
  // quote, into that new row's amount_centavos. So a second mismatched
  // delivery's own (wrong) amount would become the anchor for a THIRD
  // delivery — and a third delivery repeating that same wrong amount would
  // then wrongly match and confirm an underpayment. Fixed by anchoring on the
  // OLDEST row (`order by created_at asc`) instead, which is always the
  // original quote written by startCheckout and never mutated by any
  // insert-path delivery.
  const { bookingId, sessionId } = await seedPaidSession({ startHour: 8, courtIndex: 1 })

  // First delivery: underpaid, mismatch. Claims the original (oldest) row via
  // the UPDATE path (its provider_payment_id was null).
  expect(
    await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 99_999 })),
  ).toEqual({ status: 200, outcome: 'amount_mismatch' })

  // Second delivery: same underpaid amount, mismatch again. The oldest row's
  // provider_payment_id is now non-null, so this one takes the INSERT path —
  // creating a SECOND payments row whose amount_centavos is 99_999 (what was
  // actually paid, not a quote). Before the fix, THIS row — being newest —
  // would become the next delivery's anchor.
  expect(
    await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 99_999 })),
  ).toEqual({ status: 200, outcome: 'amount_mismatch' })

  // Third delivery: the SAME underpaid amount a third time. With the bug,
  // this would be compared against the second row's amount_centavos (99_999)
  // and wrongly pass as 'confirmed' — an underpayment accepted. Fixed, it is
  // still compared against the ORIGINAL quote (100_000) and correctly
  // refused.
  expect(
    await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 99_999 })),
  ).toEqual({ status: 200, outcome: 'amount_mismatch' })

  expect((await readBooking(bookingId)).status).toBe('pending_payment')
  const payments = await readPayments(bookingId)
  expect(payments).toHaveLength(3)
  // Every one of the three attempts is flagged, and none confirmed anything.
  expect(payments.every((p) => p.needsRefund)).toBe(true)
  expect(payments.every((p) => p.status === 'paid')).toBe(true)

  // A LEGITIMATE full payment, delivered fourth, must still confirm — proving
  // the anchor is the ORIGINAL quote (100_000), not corrupted by the three
  // mismatched attempts that came before it. Also proves the
  // `provider_payment_id is null` branch is exhausted after exactly the first
  // delivery: attempts two through four all took the INSERT path.
  expect(
    await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000 })),
  ).toEqual({ status: 200, outcome: 'confirmed' })
  expect((await readBooking(bookingId)).status).toBe('confirmed')
  const finalPayments = await readPayments(bookingId)
  expect(finalPayments).toHaveLength(4)
  expect(finalPayments.filter((p) => p.needsRefund)).toHaveLength(3)
  expect(finalPayments.filter((p) => !p.needsRefund)).toHaveLength(1)
})

test('the amount is reconciled against the SESSION, not the booking', async () => {
  // The corrected hole: a player picked GCash, then went back and picked card.
  // The booking now carries the card total, but the FIRST session is still
  // payable and quoted less. Paying it must confirm, not be rejected.
  const { bookingId, sessionId, playerId } = await seedPaidSession({ startHour: 23 })
  await db.execute(sql`
    -- Plain digits, no underscore separators: numeric-literal underscores are
    -- a PostgreSQL 16+ feature and this is SQL, not TypeScript.
    update bookings set total_charged_centavos = 105182, transaction_fee_centavos = 5182
    where id = ${bookingId}::uuid and player_id = ${playerId}::uuid
  `)

  expect(
    await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000 })),
  ).toEqual({ status: 200, outcome: 'confirmed' })

  // And the booking's columns are reconciled back to the session that was
  // actually paid.
  expect(await readBooking(bookingId)).toMatchObject({
    status: 'confirmed', totalCharged: 100_000, transactionFee: 0, processorFee: 2_230,
  })
})

test('a payment after expiry confirms when the slot is still free', async () => {
  const { bookingId, sessionId } = await seedPaidSession({ status: 'expired', startHour: 9 })

  expect(
    await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000 })),
  ).toEqual({ status: 200, outcome: 'confirmed_after_expiry' })

  expect(await readBooking(bookingId)).toMatchObject({ status: 'confirmed', totalCharged: 100_000 })
  expect((await readPayments(bookingId))[0]).toMatchObject({ needsRefund: false })
})

test('a payment after expiry flags for refund when the slot was retaken', async () => {
  const { bookingId, sessionId, branchId, courtIds } = await seedPaidSession({
    status: 'expired', startHour: 10,
  })
  const otherPlayer = await seedPlayer()
  // Somebody else booked the same court, the same hour, and paid.
  await seedBooking({
    courtId: courtIds[0], branchId, playerId: otherPlayer,
    startsAt: manilaHour('2026-12-01', 10), status: 'confirmed', totalCentavos: 100_000,
  })

  expect(
    await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000 })),
  ).toEqual({ status: 200, outcome: 'slot_taken' })

  // Never keep money for an unusable slot: the booking stays dead and the
  // money is visibly owed back.
  expect((await readBooking(bookingId)).status).toBe('expired')
  expect((await readPayments(bookingId))[0]).toMatchObject({ status: 'paid', needsRefund: true })
})

test('an owner block on the slot also counts as retaken', async () => {
  // 'blocked' is inside bookings_no_overlap's predicate, so the free-slot
  // check has to see it too — otherwise a late payment would confirm on top
  // of a maintenance block and the constraint would raise 23P01 into a 500.
  const { bookingId, sessionId, branchId, courtIds, playerId } = await seedPaidSession({
    status: 'expired', startHour: 11,
  })
  const ownerBlockCreator = playerId
  await seedBlock({
    courtId: courtIds[0], branchId, createdBy: ownerBlockCreator,
    startsAt: manilaHour('2026-12-01', 11),
  })

  expect(
    await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000 })),
  ).toEqual({ status: 200, outcome: 'slot_taken' })
  expect((await readBooking(bookingId)).status).toBe('expired')
})

test('an expired-but-unswept hold from someone else does NOT count as retaken', async () => {
  // The exclusion constraint's predicate cannot call now(), so a dead hold
  // still reads as 'pending_payment'. The handler sweeps overlapping stale
  // holds first, exactly as src/lib/booking/hold.ts does — otherwise a
  // legitimate late payment would be refused by a hold that is already dead.
  const { bookingId, sessionId, branchId, courtIds } = await seedPaidSession({
    status: 'expired', startHour: 12,
  })
  const otherPlayer = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0], branchId, playerId: otherPlayer,
    startsAt: manilaHour('2026-12-01', 12), status: 'pending_payment',
    expiresAt: new Date(Date.now() - 60_000),
  })

  expect(
    await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000 })),
  ).toEqual({ status: 200, outcome: 'confirmed_after_expiry' })
  expect((await readBooking(bookingId)).status).toBe('confirmed')
})

// ---------- C-1: a late payment must never confirm an already-ended slot ----------

test('C-1: a payment for an expired booking whose slot has already ended is slot_elapsed, not confirmed', async () => {
  // Every seedPaidSession call elsewhere in this file uses manilaHour
  // ('2026-12-01', …) — a future date, which is exactly why this hole was
  // never caught. A past `date` here makes `ends_at <= now()` true.
  const { bookingId, sessionId } = await seedPaidSession({
    status: 'expired', startHour: 10, date: '2026-01-15',
  })

  expect(
    await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000 })),
  ).toEqual({ status: 200, outcome: 'slot_elapsed' })

  // Never keep money for an unusable slot: the booking stays dead — never
  // confirmed — and the money is visibly owed back.
  expect((await readBooking(bookingId)).status).toBe('expired')
  expect((await readPayments(bookingId))[0]).toMatchObject({ status: 'paid', needsRefund: true })
})

test('C-1: a payment for a pending_payment booking whose slot has already ended is also slot_elapsed', async () => {
  // The narrower window the review called out: the hold's own expires_at
  // (seeded, per seedPaidSession, 600s in the future — not yet swept) hasn't
  // elapsed, but the COURT TIME it names already has. Before the fix this
  // read simply as status === 'pending_payment' and confirmed
  // unconditionally, with no gate on `ends_at` at all.
  const { bookingId, sessionId } = await seedPaidSession({
    status: 'pending_payment', startHour: 11, date: '2026-01-15',
  })

  expect(
    await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000 })),
  ).toEqual({ status: 200, outcome: 'slot_elapsed' })

  expect((await readBooking(bookingId)).status).toBe('pending_payment')
  expect((await readPayments(bookingId))[0]).toMatchObject({ status: 'paid', needsRefund: true })
})

test('C-1 regression: a payment after expiry on a FUTURE slot still confirms', async () => {
  // Mirrors the pre-existing 'a payment after expiry confirms when the slot
  // is still free' test verbatim, kept as its own case so the C-1 gate's
  // effect on the future-slot path is asserted by name, not only incidentally
  // by that older test continuing to pass.
  const { bookingId, sessionId } = await seedPaidSession({ status: 'expired', startHour: 23 })

  expect(
    await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000 })),
  ).toEqual({ status: 200, outcome: 'confirmed_after_expiry' })

  expect(await readBooking(bookingId)).toMatchObject({ status: 'confirmed', totalCharged: 100_000 })
  expect((await readPayments(bookingId))[0]).toMatchObject({ needsRefund: false })
})

test('a second payment on an already-confirmed booking is a double charge, not a no-op', async () => {
  // THE CORRECTION: this is NOT a replay — the unique index catches those
  // first. Two sessions, two real payments, one slot: the money is visibly
  // owed back and the booking is left exactly as it was.
  const { bookingId, sessionId } = await seedPaidSession({ startHour: 13 })
  expect(
    await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000 })),
  ).toEqual({ status: 200, outcome: 'confirmed' })

  const secondSession = 'cs_' + crypto.randomUUID()
  await seedPayment({
    bookingId, sessionId: secondSession, paymentMethod: 'card',
    amountCentavos: 100_000, processorFeeCentavos: 5_000,
  })

  expect(
    await post(paidBody({ sessionId: secondSession, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000, method: 'card' })),
  ).toEqual({ status: 200, outcome: 'double_charge' })

  const booking = await readBooking(bookingId)
  expect(booking).toMatchObject({ status: 'confirmed', processorFee: 2_230 }) // untouched
  const payments = await readPayments(bookingId)
  expect(payments).toHaveLength(2)
  expect(payments[0].needsRefund).toBe(false)
  expect(payments[1]).toMatchObject({ status: 'paid', needsRefund: true })
})

test('a completed or manually refunded booking is recorded and flagged, never touched', async () => {
  for (const status of ['completed', 'refunded_manual'] as const) {
    const { bookingId, sessionId } = await seedPaidSession({ status, startHour: 14 })
    expect(
      await post(paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000 })),
    ).toEqual({ status: 200, outcome: 'not_payable' })
    expect((await readBooking(bookingId)).status).toBe(status)
    expect((await readPayments(bookingId))[0]).toMatchObject({ needsRefund: true })
  }
})

test('an unknown event type returns 200 and writes nothing', async () => {
  // 200 so PayMongo stops retrying. Non-2xx is reserved for signature failure
  // and genuine server errors, where a retry is what we want.
  const { bookingId, sessionId } = await seedPaidSession({ startHour: 15 })
  const body = JSON.stringify({
    data: { id: 'evt_o', attributes: { type: 'payment.failed', livemode: false, data: { id: sessionId } } },
  })
  expect(await post(body)).toEqual({ status: 200, outcome: 'ignored' })
  expect((await readBooking(bookingId)).status).toBe('pending_payment')
  expect((await readPayments(bookingId))[0].paymentId).toBeNull()
})

test('a valid signature over an empty or non-JSON body returns 200 and writes nothing', async () => {
  // A correctly signed request whose body we cannot read is still PayMongo's
  // — answering 401 would make it retry forever.
  expect(await post('')).toEqual({ status: 200, outcome: 'ignored' })
  expect(await post('not json at all')).toEqual({ status: 200, outcome: 'ignored' })
})

// ---------- review fix regressions ----------

test('M-1: a body carrying a raw \\u0000 escape is sanitized before storage, not a permanent 500', async () => {
  // jsonb (unlike json) cannot represent U+0000 at all — Postgres raises
  // 22P05 the instant `raw_event = ${rawBody}::jsonb` tries to cast text
  // containing it, whether the NUL arrives as a literal control byte or (as
  // spliced in here) the six-character \u0000 escape sequence, which is
  // perfectly legal JSON and something JSON.parse itself accepts without
  // complaint. An untouched write would fail identically on every retry.
  const { bookingId, sessionId } = await seedPaidSession({ startHour: 16 })
  const paymentId = 'pay_' + crypto.randomUUID()
  const honest = paidBody({ sessionId, paymentId, amount: 100_000 })
  const body = honest.replace('"gcash"', '"gc\\u0000ash"')
  expect(body).toContain('\\u0000')
  expect(() => JSON.parse(body)).not.toThrow()

  expect(await post(body)).toEqual({ status: 200, outcome: 'confirmed' })
  expect((await readBooking(bookingId)).status).toBe('confirmed')
  expect((await readPayments(bookingId))[0]).toMatchObject({ paymentId, status: 'paid' })
})

test('M-4: an event whose livemode contradicts our own key is ignored, not acted on', async () => {
  // Our real PAYMONGO_SECRET_KEY (loaded from .env.local by tests/setup.ts)
  // is a sk_test_ key, so every other test's default livemode: false matches
  // it. This event claims livemode: true — a live-mode payment delivered to
  // a test-mode deployment — and must be ignored rather than confirmed.
  const { bookingId, sessionId } = await seedPaidSession({ startHour: 15 })
  const body = paidBody({
    sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000, livemode: true,
  })
  expect(await post(body)).toEqual({ status: 200, outcome: 'ignored' })
  expect((await readBooking(bookingId)).status).toBe('pending_payment')
  expect((await readPayments(bookingId))[0].paymentId).toBeNull()
})

test('M-4: the other direction — a live-mode key refuses a test-mode event', async () => {
  const { bookingId, sessionId } = await seedPaidSession({ startHour: 14 })
  const body = paidBody({ sessionId, paymentId: 'pay_' + crypto.randomUUID(), amount: 100_000 })

  const original = process.env.PAYMONGO_SECRET_KEY
  process.env.PAYMONGO_SECRET_KEY = 'sk_live_forced_for_this_test'
  try {
    expect(await post(body)).toEqual({ status: 200, outcome: 'ignored' })
  } finally {
    // Every other test in this file relies on the real (test-mode) key, so
    // this must be restored unconditionally before the next test runs.
    if (original === undefined) delete process.env.PAYMONGO_SECRET_KEY
    else process.env.PAYMONGO_SECRET_KEY = original
  }
  expect((await readBooking(bookingId)).status).toBe('pending_payment')
  expect((await readPayments(bookingId))[0].paymentId).toBeNull()
})

test('row 10: a genuine 23P01 on the expired-path confirm rolls back completely, and the retry lands on slot_taken', async () => {
  // The review independently reproduced this: open a second raw connection,
  // insert a competing 'confirmed' booking on the exact same court+slot
  // inside an UNCOMMITTED transaction, then run the webhook. Our free-slot
  // check is a plain, non-locking SELECT under READ COMMITTED, so it cannot
  // see the rival's uncommitted row and proceeds as though the slot were
  // free — but the CONFIRM UPDATE collides with it, because Postgres's
  // exclusion-constraint enforcement uses a dirty snapshot that also sees (and
  // waits on) uncommitted conflicting rows, exactly like a unique index does.
  const { bookingId, sessionId, branchId, courtIds, playerId } = await seedPaidSession({
    status: 'expired', startHour: 17,
  })
  const paymentId = 'pay_' + crypto.randomUUID()
  const body = paidBody({ sessionId, paymentId, amount: 100_000 })

  const rival = new Client({ connectionString: process.env.DATABASE_URL })
  await rival.connect()
  await rival.query('begin')
  try {
    await rival.query(
      `insert into bookings (
         court_id, branch_id, player_id, starts_at, ends_at, status,
         court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
         platform_fee_centavos, processor_fee_centavos, owner_net_centavos, fee_config_snapshot
       ) values ($1,$2,$3,$4,$5,'confirmed',$6,$7,$8,$9,$10,$11,'{}'::jsonb)`,
      [
        courtIds[0], branchId, playerId,
        manilaHour('2026-12-01', 17).toISOString(),
        manilaHour('2026-12-01', 18).toISOString(),
        100_000, 0, 100_000, 10_000, 0, 90_000,
      ],
    )

    // Fire the webhook without awaiting it yet: its confirm UPDATE will block
    // on the rival's still-open, conflicting transaction.
    const pending = POST(
      new Request('https://oncourt.test/api/webhooks/paymongo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'paymongo-signature': sign(body) },
        body,
      }),
    )

    // A fixed sleep here would be a coin flip against a hosted DB's variable
    // round-trip latency: too short and the commit lands before the webhook
    // even reaches the free-slot check (which would then correctly, but
    // uselessly for this test, see the row as already taken and return
    // 'slot_taken' without ever exercising the race); too long wastes time.
    // Poll pg_stat_activity instead for the webhook's own backend genuinely
    // BLOCKED on the confirm UPDATE — the only state that proves the free
    // check already ran (saw 'free') and the constraint check is now the
    // thing waiting on the rival's uncommitted row.
    const deadline = Date.now() + 8_000
    let sawBlockedUpdate = false
    while (Date.now() < deadline) {
      const waiting = await db.execute(sql`
        select 1 from pg_stat_activity
        where wait_event_type = 'Lock' and state = 'active'
          and query ilike '%update bookings set%confirmed%'
        limit 1
      `)
      if (waiting.rows.length > 0) {
        sawBlockedUpdate = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(sawBlockedUpdate).toBe(true)
    await rival.query('commit')

    // Now that the rival is committed, Postgres resolves the wait: the
    // exclusion index genuinely conflicts, and — per row 10 — this must
    // reject rather than silently recover, rolling back the payments write
    // alongside the booking write.
    await expect(pending).rejects.toMatchObject({ cause: { code: '23P01' } })
  } finally {
    await rival.end()
  }

  // Nothing committed: the booking is still 'expired', and the payments row
  // this event would have claimed is still unclaimed.
  expect((await readBooking(bookingId)).status).toBe('expired')
  const beforeRetry = await readPayments(bookingId)
  expect(beforeRetry).toHaveLength(1)
  expect(beforeRetry[0]).toMatchObject({ paymentId: null, needsRefund: false })

  // The retry: the rival's booking is now committed and visible, so the
  // free-slot check correctly sees the slot as taken.
  expect(await post(body)).toEqual({ status: 200, outcome: 'slot_taken' })
  expect((await readBooking(bookingId)).status).toBe('expired')
  expect((await readPayments(bookingId))[0]).toMatchObject({
    paymentId, status: 'paid', needsRefund: true,
  })
})
