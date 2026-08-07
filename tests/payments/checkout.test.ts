import { expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { startCheckout } from '@/lib/payments/checkout'
import { getCheckoutView } from '@/lib/payments/queries'
import type { CheckoutSessionInput, PaymentProvider } from '@/lib/payments/provider'
import { PaymentProviderError } from '@/lib/payments/provider'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedPlayer,
} from '../helpers/fixtures'

const SITE_URL = 'https://oncourt.test'

/**
 * A hand-written PaymentProvider. The second permitted double in this slice,
 * and the reason startCheckout takes the provider as a PARAMETER rather than
 * importing the singleton: the entire write path — fee recompute, status-
 * scoped UPDATE, payments INSERT — is exercised against real database rows
 * with no network anywhere.
 */
function recordingProvider(behavior: { fail?: unknown } = {}) {
  const calls: CheckoutSessionInput[] = []
  let counter = 0
  const provider: PaymentProvider = {
    async createCheckoutSession(input) {
      calls.push(input)
      if (behavior.fail) throw behavior.fail
      counter += 1
      return {
        sessionId: `cs_${counter}_${crypto.randomUUID()}`,
        checkoutUrl: `https://checkout.paymongo.test/${counter}`,
      }
    },
    verifyWebhookSignature: () => true,
    parsePaidEvent: () => null,
  }
  return { provider, calls }
}

/** A ₱1,000 hold expiring in 10 minutes, on its own freshly seeded court. */
async function seedHold(opts: { bearer?: 'player' | 'owner' | 'platform'; startHour?: number } = {}) {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2026-11-01', opts.startHour ?? 18),
    status: 'pending_payment',
    totalCentavos: 100_000,
    expiresAt: new Date(Date.now() + 600_000),
  })
  if (opts.bearer && opts.bearer !== 'platform') {
    // seedBooking writes bearer 'platform'; the other two are set here rather
    // than by a fixture option, because this is the only slice that cares.
    await db.execute(sql`
      update bookings
      set fee_config_snapshot = jsonb_set(fee_config_snapshot, '{bearer}', ${JSON.stringify(opts.bearer)}::jsonb)
      where id = ${bookingId}::uuid
    `)
  }
  return { bookingId, playerId, branchId, courtId: courtIds[0] }
}

async function readBooking(bookingId: string) {
  const result = await db.execute(sql`
    select status::text as status,
           court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
           platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
           fee_config_snapshot
    from bookings where id = ${bookingId}::uuid
  `)
  const row = result.rows[0]
  return {
    status: row.status as string,
    courtFee: Number(row.court_fee_centavos),
    transactionFee: Number(row.transaction_fee_centavos),
    totalCharged: Number(row.total_charged_centavos),
    platformFee: Number(row.platform_fee_centavos),
    processorFee: Number(row.processor_fee_centavos),
    ownerNet: Number(row.owner_net_centavos),
    snapshot: row.fee_config_snapshot as Record<string, unknown>,
  }
}

async function readPayments(bookingId: string) {
  const result = await db.execute(sql`
    select provider, provider_session_id, provider_payment_id, payment_method,
           amount_centavos, processor_fee_centavos, status::text as status, needs_refund
    from payments where booking_id = ${bookingId}::uuid order by created_at, id
  `)
  return result.rows.map((row) => ({
    provider: row.provider as string,
    sessionId: row.provider_session_id as string | null,
    paymentId: row.provider_payment_id as string | null,
    method: row.payment_method as string | null,
    amount: Number(row.amount_centavos),
    processorFee: Number(row.processor_fee_centavos),
    status: row.status as string,
    needsRefund: row.needs_refund === true,
  }))
}

test('startCheckout persists the platform-bearer fees and records the session', async () => {
  const { bookingId, playerId } = await seedHold()
  const { provider, calls } = recordingProvider()

  const result = await startCheckout({
    bookingId, playerId, paymentMethod: 'gcash', provider, siteUrl: SITE_URL,
  })
  expect(result).toMatchObject({ ok: true, checkoutUrl: 'https://checkout.paymongo.test/1' })

  // ₱1,000, 10% platform fee, GCash 223bps, platform bears the processor fee:
  // the player pays exactly the court fee and ₱22.30 comes out of the
  // platform's ₱100.
  const booking = await readBooking(bookingId)
  expect(booking).toMatchObject({
    status: 'pending_payment',
    courtFee: 100_000,
    transactionFee: 0,
    totalCharged: 100_000,
    platformFee: 10_000,
    processorFee: 2_230,
    ownerNet: 90_000,
  })
  // The snapshot gains the method and NOTHING else — no rate key, which a
  // later session on another method would leave stale.
  expect(booking.snapshot).toMatchObject({ bearer: 'platform', method: 'gcash' })
  expect(booking.snapshot).not.toHaveProperty('rate')

  const payments = await readPayments(bookingId)
  expect(payments).toHaveLength(1)
  expect(payments[0]).toMatchObject({
    provider: 'paymongo',
    paymentId: null, // no payment exists until the webhook says so
    method: 'gcash',
    amount: 100_000,
    processorFee: 2_230,
    status: 'pending',
    needsRefund: false,
  })
  expect(payments[0].sessionId).toMatch(/^cs_/)

  // The provider is asked for exactly what we quoted, restricted to one method.
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    bookingId,
    amountCentavos: 100_000,
    paymentMethod: 'gcash',
    successUrl: `${SITE_URL}/bookings/${bookingId}?paid=1`,
    cancelUrl: `${SITE_URL}/bookings/${bookingId}/checkout?canceled=1`,
  })
})

test('startCheckout grosses up for the player bearer, per method', async () => {
  const { bookingId, playerId } = await seedHold({ bearer: 'player' })
  const { provider } = recordingProvider()

  await startCheckout({ bookingId, playerId, paymentMethod: 'card', provider, siteUrl: SITE_URL })

  // card = 350bps + ₱15: ceil(1_015_000_000 / 9_650) = 105_182.
  const booking = await readBooking(bookingId)
  expect(booking).toMatchObject({
    transactionFee: 5_182,
    totalCharged: 105_182,
    processorFee: 5_182,
    ownerNet: 90_000, // the owner is untouched by who bears the processor fee
  })
  expect((await readPayments(bookingId))[0]).toMatchObject({
    method: 'card',
    amount: 105_182,
    processorFee: 5_182,
  })
})

test('a second checkout on a different method replaces the fees and adds a second payments row', async () => {
  // This is exactly the situation the spec's session-based reconciliation
  // exists for: two live sessions quoting DIFFERENT amounts for one booking.
  const { bookingId, playerId } = await seedHold({ bearer: 'player' })
  const { provider } = recordingProvider()

  await startCheckout({ bookingId, playerId, paymentMethod: 'gcash', provider, siteUrl: SITE_URL })
  await startCheckout({ bookingId, playerId, paymentMethod: 'maya', provider, siteUrl: SITE_URL })

  const payments = await readPayments(bookingId)
  expect(payments).toHaveLength(2)
  expect(payments.map((p) => [p.method, p.amount])).toEqual([
    ['gcash', 102_281],
    ['maya', 102_041],
  ])
  // The booking reflects the LATEST session, which is why the webhook must
  // never reconcile against it.
  expect(await readBooking(bookingId)).toMatchObject({ totalCharged: 102_041 })
})

test("startCheckout refuses another player's booking, writing nothing", async () => {
  const { bookingId } = await seedHold()
  const stranger = await seedPlayer()
  const { provider, calls } = recordingProvider()

  expect(
    await startCheckout({
      bookingId, playerId: stranger, paymentMethod: 'gcash', provider, siteUrl: SITE_URL,
    }),
  ).toEqual({ ok: false, reason: 'stale_hold' })

  // The provider was never even asked — the ownership check is in the WHERE
  // clause, before any external work.
  expect(calls).toHaveLength(0)
  expect(await readPayments(bookingId)).toHaveLength(0)
  expect(await readBooking(bookingId)).toMatchObject({ processorFee: 0, transactionFee: 0 })
})

test('startCheckout refuses a booking that is not pending_payment', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-11-02', 18), status: 'confirmed', totalCentavos: 100_000,
  })
  const { provider } = recordingProvider()

  expect(
    await startCheckout({ bookingId, playerId, paymentMethod: 'gcash', provider, siteUrl: SITE_URL }),
  ).toEqual({ ok: false, reason: 'stale_hold' })
  expect(await readPayments(bookingId)).toHaveLength(0)
})

test('startCheckout refuses an expired hold — never a payable form for a dead hold', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-11-03', 18), status: 'pending_payment',
    totalCentavos: 100_000,
    // Already past, and NOT yet swept by the cron — the exact state the
    // expires_at predicate exists to catch.
    expiresAt: new Date(Date.now() - 60_000),
  })
  const { provider, calls } = recordingProvider()

  expect(
    await startCheckout({ bookingId, playerId, paymentMethod: 'gcash', provider, siteUrl: SITE_URL }),
  ).toEqual({ ok: false, reason: 'stale_hold' })
  expect(calls).toHaveLength(0)
  expect(await readPayments(bookingId)).toHaveLength(0)
})

test('startCheckout refuses a method that is not one of ours', async () => {
  const { bookingId, playerId } = await seedHold()
  const { provider, calls } = recordingProvider()

  for (const method of ['bitcoin', '', 'GCash', "gcash'; drop table payments;--"]) {
    expect(
      await startCheckout({ bookingId, playerId, paymentMethod: method, provider, siteUrl: SITE_URL }),
    ).toEqual({ ok: false, reason: 'unknown_method' })
  }
  expect(calls).toHaveLength(0)
  expect(await readPayments(bookingId)).toHaveLength(0)
})

test('a provider failure leaves the hold intact and writes nothing', async () => {
  const { bookingId, playerId } = await seedHold()
  const { provider } = recordingProvider({ fail: new PaymentProviderError('PayMongo is down', 503) })

  expect(
    await startCheckout({ bookingId, playerId, paymentMethod: 'gcash', provider, siteUrl: SITE_URL }),
  ).toEqual({ ok: false, reason: 'provider_unavailable' })

  // The hold survives so the player can simply try again — deleting it because
  // a later step failed would be worse than an unused provider session.
  expect(await readBooking(bookingId)).toMatchObject({
    status: 'pending_payment', processorFee: 0, transactionFee: 0,
  })
  expect(await readPayments(bookingId)).toHaveLength(0)
})

test('getCheckoutView quotes every method and is scoped to the booking owner', async () => {
  const { bookingId, playerId } = await seedHold({ bearer: 'player', startHour: 19 })

  const view = await getCheckoutView(bookingId, playerId)
  expect(view).not.toBeNull()
  expect(view).toMatchObject({
    bookingId,
    status: 'pending_payment',
    expired: false,
    courtName: 'Court 1',
    environment: 'indoor',
    branchCity: 'Marikina',
    date: '2026-11-01',
    startHour: 19,
    endHour: 20,
    courtFeeCentavos: 100_000,
  })
  expect(view!.methods).toEqual([
    { method: 'gcash', label: 'GCash', transactionFeeCentavos: 2_281, totalChargedCentavos: 102_281 },
    { method: 'maya', label: 'Maya', transactionFeeCentavos: 2_041, totalChargedCentavos: 102_041 },
    { method: 'card', label: 'Credit/Debit card', transactionFeeCentavos: 5_182, totalChargedCentavos: 105_182 },
  ])

  // Someone else's booking is null, not a 403 — a distinct answer would
  // confirm the row exists.
  expect(await getCheckoutView(bookingId, await seedPlayer())).toBeNull()
})

test('getCheckoutView reports an unswept expired hold as expired', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-11-04', 18), status: 'pending_payment',
    totalCentavos: 100_000, expiresAt: new Date(Date.now() - 1_000),
  })
  const view = await getCheckoutView(bookingId, playerId)
  // Status still says pending_payment (the cron has not run), but the page
  // must render the dead-hold state, never a payable form.
  expect(view).toMatchObject({ status: 'pending_payment', expired: true })
})
