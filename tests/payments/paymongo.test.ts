import { createHmac } from 'node:crypto'
import { beforeEach, expect, test, vi } from 'vitest'
import { PaymentConfigError, PaymentProviderError } from '@/lib/payments/provider'
import {
  createPaymongoProvider,
  PAID_EVENT_TYPE,
  PAYMONGO_API_BASE,
  parsePaymongoPaidEvent,
  verifyPaymongoSignature,
  WEBHOOK_TOLERANCE_SECONDS,
} from '@/lib/payments/paymongo'

/**
 * `fetch` is the only double in this file, for the obvious reason: PayMongo is
 * a payment processor and a test suite must never be traffic against one. What
 * is tested is that the request we WOULD send is the correct one and that
 * every failure shape becomes a typed error rather than a silent wrong answer.
 *
 * The HMAC below is REAL — computed with node:crypto over the real scheme. The
 * signature tests generate signatures the same way the verifier does, so they
 * pin the verifier's contract ("accepts what this scheme produces, rejects
 * everything else") independently of whether PayMongo's digest encoding turns
 * out to be hex or base64.
 */
function fakeFetch(response: { ok?: boolean; status?: number; body?: unknown; throws?: unknown }) {
  return vi.fn(async () => {
    if (response.throws) throw response.throws
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body ?? {}),
    } as unknown as Response
  })
}

const SECRET = 'whsk_test_secret'

function signedHeader(rawBody: string, opts: { secret?: string; timestamp?: number; key?: 'te' | 'li' } = {}) {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000)
  const digest = createHmac('sha256', opts.secret ?? SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')
  return `t=${timestamp},${opts.key ?? 'te'}=${digest}`
}

function paidEventBody(overrides: {
  type?: string
  sessionId?: string
  paymentId?: string
  amount?: unknown
  status?: string
  sourceType?: string
  nest?: boolean
} = {}) {
  const payment = {
    id: overrides.paymentId ?? 'pay_abc123',
    type: 'payment',
    attributes: {
      amount: overrides.amount ?? 102281,
      status: overrides.status ?? 'paid',
      source: { type: overrides.sourceType ?? 'gcash' },
    },
  }
  const sessionAttributes: Record<string, unknown> = {
    checkout_url: 'https://checkout.paymongo.com/cs_abc',
    status: 'active',
  }
  if (overrides.nest) {
    sessionAttributes.payment_intent = { attributes: { payments: [payment] } }
  } else {
    sessionAttributes.payments = [payment]
  }
  return JSON.stringify({
    data: {
      id: 'evt_abc',
      type: 'event',
      attributes: {
        type: overrides.type ?? PAID_EVENT_TYPE,
        livemode: false,
        created_at: 1_780_000_000,
        data: {
          id: overrides.sessionId ?? 'cs_abc',
          type: 'checkout_session',
          attributes: sessionAttributes,
        },
      },
    },
  })
}

/**
 * The body of a `GET /checkout_sessions/:id` response — the top-level
 * `data` here is believed to be the SAME Checkout Session resource shape
 * `paidEventBody` above embeds under `data.attributes.data`, per
 * paymongo.ts's `paidPaymentFromSessionResource` (Task 8 confirms against a
 * real response). `noPayments` models a response that is a well-formed
 * checkout session but genuinely has no payment on it yet — the
 * not-paid-yet case, distinct from a shape this reader cannot parse at all.
 */
function sessionResourceBody(overrides: {
  sessionId?: string
  paymentId?: string
  amount?: unknown
  status?: string
  sourceType?: string
  nest?: boolean
  noPayments?: boolean
} = {}) {
  const payment = {
    id: overrides.paymentId ?? 'pay_abc123',
    type: 'payment',
    attributes: {
      amount: overrides.amount ?? 102281,
      status: overrides.status ?? 'paid',
      source: { type: overrides.sourceType ?? 'gcash' },
    },
  }
  const sessionAttributes: Record<string, unknown> = {
    checkout_url: 'https://checkout.paymongo.com/cs_abc',
    status: 'active',
  }
  if (!overrides.noPayments) {
    if (overrides.nest) {
      sessionAttributes.payment_intent = { attributes: { payments: [payment] } }
    } else {
      sessionAttributes.payments = [payment]
    }
  }
  return {
    data: {
      id: overrides.sessionId ?? 'cs_abc',
      type: 'checkout_session',
      attributes: sessionAttributes,
    },
  }
}

// Restored before every test because one test deletes it to prove the
// call-site failure. Assigned directly rather than through vi.stubEnv: the
// adapter reads process.env at call time, so there is nothing to stub.
beforeEach(() => {
  process.env.PAYMONGO_SECRET_KEY = 'sk_test_key'
})

// ---------- createCheckoutSession ----------

test('createCheckoutSession posts the documented shape with Basic auth and a timeout', async () => {
  const fetchImpl = fakeFetch({
    body: { data: { id: 'cs_abc', attributes: { checkout_url: 'https://checkout.paymongo.com/cs_abc' } } },
  })
  const provider = createPaymongoProvider(fetchImpl as unknown as typeof fetch)

  const session = await provider.createCheckoutSession({
    bookingId: '11111111-1111-1111-1111-111111111111',
    amountCentavos: 102_281,
    paymentMethod: 'gcash',
    lineName: 'Palo Verde Pickle Club — Court A2 (Indoor)',
    description: 'Fri, Aug 1 · 7 – 9 AM · 2 hours',
    successUrl: 'https://oncourt.ph/bookings/1/?paid=1',
    cancelUrl: 'https://oncourt.ph/bookings/1/checkout?canceled=1',
  })

  expect(session).toEqual({ sessionId: 'cs_abc', checkoutUrl: 'https://checkout.paymongo.com/cs_abc' })

  expect(fetchImpl).toHaveBeenCalledTimes(1)
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe(`${PAYMONGO_API_BASE}/checkout_sessions`)
  expect(init.method).toBe('POST')

  const headers = init.headers as Record<string, string>
  // Secret key as the Basic username with an EMPTY password — PayMongo's
  // documented scheme. The trailing colon is not optional.
  expect(headers.Authorization).toBe(`Basic ${Buffer.from('sk_test_key:').toString('base64')}`)
  expect(headers['Content-Type']).toBe('application/json')
  // Without a bound, a hung PayMongo would leave the checkout submit pending
  // forever with no recourse but a reload — the lesson from the geocoder.
  expect(init.signal).toBeInstanceOf(AbortSignal)
  expect((init.signal as AbortSignal).aborted).toBe(false)

  const body = JSON.parse(init.body as string)
  expect(body.data.attributes.line_items).toEqual([
    {
      name: 'Palo Verde Pickle Club — Court A2 (Indoor)',
      amount: 102_281,
      currency: 'PHP',
      quantity: 1,
    },
  ])
  // ONE method per session — that is what makes the fee we showed the fee we
  // charge (the parent spec's rule for the 'player' bearer, applied to every
  // bearer so there is only one code path).
  expect(body.data.attributes.payment_method_types).toEqual(['gcash'])
  expect(body.data.attributes.success_url).toBe('https://oncourt.ph/bookings/1/?paid=1')
  expect(body.data.attributes.cancel_url).toBe('https://oncourt.ph/bookings/1/checkout?canceled=1')
  expect(body.data.attributes.reference_number).toBe('11111111-1111-1111-1111-111111111111')
  expect(body.data.attributes.metadata).toEqual({
    booking_id: '11111111-1111-1111-1111-111111111111',
  })
})

test('createCheckoutSession maps our rate key to PayMongo spelling', async () => {
  // processor_rates calls it 'maya'; PayMongo's payment_method_types calls it
  // 'paymaya'. The translation lives ONLY in the adapter — nothing else in the
  // application ever sees PayMongo's spelling.
  const fetchImpl = fakeFetch({
    body: { data: { id: 'cs_x', attributes: { checkout_url: 'https://checkout.paymongo.com/cs_x' } } },
  })
  const provider = createPaymongoProvider(fetchImpl as unknown as typeof fetch)
  await provider.createCheckoutSession({
    bookingId: '11111111-1111-1111-1111-111111111111',
    amountCentavos: 100_000,
    paymentMethod: 'maya',
    lineName: 'Court',
    description: 'Slot',
    successUrl: 'https://oncourt.ph/a',
    cancelUrl: 'https://oncourt.ph/b',
  })
  const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
  expect(JSON.parse(init.body as string).data.attributes.payment_method_types).toEqual(['paymaya'])
})

test('createCheckoutSession throws PaymentProviderError on a non-2xx, carrying the status', async () => {
  const provider = createPaymongoProvider(
    fakeFetch({ ok: false, status: 402, body: { errors: [{ detail: 'nope' }] } }) as unknown as typeof fetch,
  )
  await expect(
    provider.createCheckoutSession({
      bookingId: '1', amountCentavos: 100, paymentMethod: 'card',
      lineName: 'x', description: 'y', successUrl: 'a', cancelUrl: 'b',
    }),
  ).rejects.toMatchObject({ name: 'PaymentProviderError', status: 402 })
})

test('createCheckoutSession throws PaymentProviderError when the request times out', async () => {
  // AbortSignal.timeout rejects with a TimeoutError DOMException. It must
  // surface as our typed error, never as a raw DOMException and never as a
  // silent null — a checkout that cannot be created has to tell the player.
  const provider = createPaymongoProvider(
    fakeFetch({ throws: new DOMException('The operation timed out.', 'TimeoutError') }) as unknown as typeof fetch,
  )
  await expect(
    provider.createCheckoutSession({
      bookingId: '1', amountCentavos: 100, paymentMethod: 'gcash',
      lineName: 'x', description: 'y', successUrl: 'a', cancelUrl: 'b',
    }),
  ).rejects.toBeInstanceOf(PaymentProviderError)
})

test('createCheckoutSession throws PaymentProviderError when the response has no checkout_url', async () => {
  const provider = createPaymongoProvider(
    fakeFetch({ body: { data: { id: 'cs_abc', attributes: {} } } }) as unknown as typeof fetch,
  )
  await expect(
    provider.createCheckoutSession({
      bookingId: '1', amountCentavos: 100, paymentMethod: 'gcash',
      lineName: 'x', description: 'y', successUrl: 'a', cancelUrl: 'b',
    }),
  ).rejects.toBeInstanceOf(PaymentProviderError)
})

test('createCheckoutSession throws PaymentProviderError, not a raw SyntaxError, when a 2xx body is unparsable', async () => {
  // A malformed/truncated body on an otherwise-2xx response is a distinct
  // failure from a dead socket, but it is exactly as unusable, and the typed-
  // error contract this function promises everywhere else must hold here too.
  const fetchImpl = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input')
    },
    text: async () => 'not json',
  })) as unknown as typeof fetch
  const provider = createPaymongoProvider(fetchImpl)
  await expect(
    provider.createCheckoutSession({
      bookingId: '1', amountCentavos: 100, paymentMethod: 'gcash',
      lineName: 'x', description: 'y', successUrl: 'a', cancelUrl: 'b',
    }),
  ).rejects.toMatchObject({ name: 'PaymentProviderError', status: 200 })
})

test('createCheckoutSession fails loudly, and without calling the network, when the key is missing', async () => {
  delete process.env.PAYMONGO_SECRET_KEY
  const fetchImpl = fakeFetch({ body: {} })
  const provider = createPaymongoProvider(fetchImpl as unknown as typeof fetch)
  await expect(
    provider.createCheckoutSession({
      bookingId: '1', amountCentavos: 100, paymentMethod: 'gcash',
      lineName: 'x', description: 'y', successUrl: 'a', cancelUrl: 'b',
    }),
  ).rejects.toBeInstanceOf(PaymentConfigError)
  expect(fetchImpl).not.toHaveBeenCalled()
})

// ---------- retrieveSession ----------

test('retrieveSession reads a paid session into the same PaidEvent shape parsePaidEvent produces', async () => {
  const fetchImpl = fakeFetch({
    body: sessionResourceBody({ sessionId: 'cs_abc', paymentId: 'pay_abc123', amount: 100_000 }),
  })
  const provider = createPaymongoProvider(fetchImpl as unknown as typeof fetch)

  const event = await provider.retrieveSession('cs_abc')
  expect(event).toMatchObject({
    sessionId: 'cs_abc',
    paymentId: 'pay_abc123',
    amountCentavos: 100_000,
    paymentMethod: 'gcash',
  })

  expect(fetchImpl).toHaveBeenCalledTimes(1)
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe(`${PAYMONGO_API_BASE}/checkout_sessions/cs_abc`)
  expect(init.method).toBe('GET')
  const headers = init.headers as Record<string, string>
  // Same auth scheme as createCheckoutSession — secret key as the Basic
  // username with an empty password.
  expect(headers.Authorization).toBe(`Basic ${Buffer.from('sk_test_key:').toString('base64')}`)
  // Same bound as createCheckoutSession, for the same reason: a hung
  // PayMongo must not leave a poll waiting forever.
  expect(init.signal).toBeInstanceOf(AbortSignal)
})

test('retrieveSession URL-encodes the session id', async () => {
  const fetchImpl = fakeFetch({ body: sessionResourceBody() })
  const provider = createPaymongoProvider(fetchImpl as unknown as typeof fetch)
  await provider.retrieveSession('cs abc/../x')
  const [url] = fetchImpl.mock.calls[0] as unknown as [string]
  expect(url).toBe(`${PAYMONGO_API_BASE}/checkout_sessions/${encodeURIComponent('cs abc/../x')}`)
})

test('retrieveSession finds the payments array nested under payment_intent too', async () => {
  const fetchImpl = fakeFetch({ body: sessionResourceBody({ nest: true }) })
  const provider = createPaymongoProvider(fetchImpl as unknown as typeof fetch)
  expect((await provider.retrieveSession('cs_abc'))?.paymentId).toBe('pay_abc123')
})

test('retrieveSession returns null, never a guess, for a session with no paid payment yet', async () => {
  const fetchImpl = fakeFetch({ body: sessionResourceBody({ noPayments: true }) })
  const provider = createPaymongoProvider(fetchImpl as unknown as typeof fetch)
  expect(await provider.retrieveSession('cs_abc')).toBeNull()
})

test('retrieveSession returns null for a malformed/unexpected response body — same as parsePaidEvent', async () => {
  for (const body of [{ data: {} }, {}, { data: { id: 'cs_abc', attributes: {} } }]) {
    const provider = createPaymongoProvider(fakeFetch({ body }) as unknown as typeof fetch)
    expect(await provider.retrieveSession('cs_abc'), JSON.stringify(body)).toBeNull()
  }
})

test('retrieveSession throws PaymentProviderError on a non-2xx, carrying the status', async () => {
  const provider = createPaymongoProvider(
    fakeFetch({ ok: false, status: 404, body: { errors: [{ detail: 'not found' }] } }) as unknown as typeof fetch,
  )
  await expect(provider.retrieveSession('cs_missing')).rejects.toMatchObject({
    name: 'PaymentProviderError',
    status: 404,
  })
})

test('retrieveSession throws PaymentProviderError when the request times out', async () => {
  const provider = createPaymongoProvider(
    fakeFetch({ throws: new DOMException('The operation timed out.', 'TimeoutError') }) as unknown as typeof fetch,
  )
  await expect(provider.retrieveSession('cs_abc')).rejects.toBeInstanceOf(PaymentProviderError)
})

test('retrieveSession throws PaymentProviderError, not a raw SyntaxError, when a 2xx body is unparsable', async () => {
  const fetchImpl = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input')
    },
    text: async () => 'not json',
  })) as unknown as typeof fetch
  const provider = createPaymongoProvider(fetchImpl)
  await expect(provider.retrieveSession('cs_abc')).rejects.toMatchObject({
    name: 'PaymentProviderError',
    status: 200,
  })
})

test('retrieveSession fails loudly, and without calling the network, when the key is missing', async () => {
  delete process.env.PAYMONGO_SECRET_KEY
  const fetchImpl = fakeFetch({ body: sessionResourceBody() })
  const provider = createPaymongoProvider(fetchImpl as unknown as typeof fetch)
  await expect(provider.retrieveSession('cs_abc')).rejects.toBeInstanceOf(PaymentConfigError)
  expect(fetchImpl).not.toHaveBeenCalled()
})

// ---------- verifyWebhookSignature ----------

test('a correct signature is accepted, in both test and live positions', () => {
  const body = paidEventBody()
  expect(verifyPaymongoSignature(body, signedHeader(body, { key: 'te' }), SECRET)).toBe(true)
  // PayMongo issues a separate secret per webhook endpoint, and test and live
  // endpoints are separate objects with separate secrets — so accepting
  // whichever of te/li matches OUR secret cannot admit a cross-mode event.
  expect(verifyPaymongoSignature(body, signedHeader(body, { key: 'li' }), SECRET)).toBe(true)
})

test('a tampered body is rejected', () => {
  const body = paidEventBody()
  const header = signedHeader(body)
  // One centavo changed. This is the attack the signature exists to stop.
  expect(verifyPaymongoSignature(paidEventBody({ amount: 1 }), header, SECRET)).toBe(false)
})

test('a wrong secret is rejected', () => {
  const body = paidEventBody()
  expect(verifyPaymongoSignature(body, signedHeader(body, { secret: 'whsk_other' }), SECRET)).toBe(false)
})

test('a malformed header is rejected in every shape', () => {
  const body = paidEventBody()
  const digest = createHmac('sha256', SECRET).update(`1.${body}`).digest('hex')
  for (const header of [
    '',
    'garbage',
    `te=${digest}`, // no timestamp
    't=,te=abc', // empty timestamp
    't=notanumber,te=abc',
    `t=${Math.floor(Date.now() / 1000)}`, // no digest at all
    `t=${Math.floor(Date.now() / 1000)},te=`, // empty digest
    `t=${Math.floor(Date.now() / 1000)},zz=${digest}`, // digest under an unknown key
  ]) {
    expect(verifyPaymongoSignature(body, header, SECRET), header).toBe(false)
  }
})

test('a stale timestamp is rejected even though the digest is correct', () => {
  // Replay defence. The digest below verifies perfectly — the ONLY thing
  // wrong with this request is that it is old, which is exactly the shape of
  // a captured-and-replayed webhook.
  const body = paidEventBody()
  const stale = Math.floor(Date.now() / 1000) - (WEBHOOK_TOLERANCE_SECONDS + 60)
  const header = signedHeader(body, { timestamp: stale })
  expect(verifyPaymongoSignature(body, header, SECRET)).toBe(false)
  // Inside the window it is accepted, which proves the rejection above was
  // the timestamp and not a broken digest.
  const fresh = signedHeader(body, { timestamp: Math.floor(Date.now() / 1000) - 10 })
  expect(verifyPaymongoSignature(body, fresh, SECRET)).toBe(true)
})

test('a timestamp from the future beyond tolerance is rejected too', () => {
  // The window is absolute, not one-sided: a clock-skewed or hand-forged
  // future timestamp must not buy an attacker an arbitrarily long replay
  // window later.
  const body = paidEventBody()
  const header = signedHeader(body, {
    timestamp: Math.floor(Date.now() / 1000) + WEBHOOK_TOLERANCE_SECONDS + 60,
  })
  expect(verifyPaymongoSignature(body, header, SECRET)).toBe(false)
})

test('an empty secret never verifies anything', () => {
  const body = paidEventBody()
  expect(verifyPaymongoSignature(body, signedHeader(body, { secret: '' }), '')).toBe(false)
})

// ---------- parsePaidEvent ----------

test('parsePaidEvent reads the session id, payment id, amount and mapped method', () => {
  expect(parsePaymongoPaidEvent(paidEventBody())).toEqual({
    eventId: 'evt_abc',
    eventType: PAID_EVENT_TYPE,
    livemode: false,
    sessionId: 'cs_abc',
    paymentId: 'pay_abc123',
    amountCentavos: 102_281,
    paymentMethod: 'gcash',
  })
})

test('parsePaidEvent maps PayMongo source types back to our rate keys', () => {
  expect(parsePaymongoPaidEvent(paidEventBody({ sourceType: 'paymaya' }))?.paymentMethod).toBe('maya')
  expect(parsePaymongoPaidEvent(paidEventBody({ sourceType: 'card' }))?.paymentMethod).toBe('card')
  // An unmapped source type is null, never a guess: the webhook records the
  // method only to help an admin, and a wrong one would be worse than none.
  expect(parsePaymongoPaidEvent(paidEventBody({ sourceType: 'grab_pay' }))?.paymentMethod).toBeNull()
})

test('parsePaidEvent finds the payments array nested under payment_intent too', () => {
  // The literal payload of checkout_session.payment.paid is not published in
  // PayMongo's current docs; the resource reference documents `payments` on
  // the Checkout Session and a `payment_intent` sub-resource. Both locations
  // are accepted so a doc ambiguity cannot become a dropped payment.
  expect(parsePaymongoPaidEvent(paidEventBody({ nest: true }))?.paymentId).toBe('pay_abc123')
})

test('parsePaidEvent returns null for anything it cannot read with certainty', () => {
  for (const body of [
    'not json',
    '{}',
    JSON.stringify({ data: { attributes: { type: 'payment.failed' } } }),
    // Right event type, but no paid payment in it.
    paidEventBody({ status: 'awaiting_payment_method' }),
    // Right event type, but a non-integer amount — never coerce money.
    paidEventBody({ amount: '102281' }),
    paidEventBody({ amount: 102281.5 }),
    // Right event type, but no session id to resolve our payments row by.
    JSON.stringify({
      data: { id: 'evt_x', attributes: { type: PAID_EVENT_TYPE, livemode: false, data: {} } },
    }),
  ]) {
    expect(parsePaymongoPaidEvent(body), body.slice(0, 60)).toBeNull()
  }
})

test('parsePaidEvent ignores every other event type', () => {
  // "Other event types -> 200 and ignore (so PayMongo stops retrying)." Null
  // from the parser is what the handler turns into that 200.
  for (const type of ['payment.paid', 'payment.failed', 'refund.succeeded', 'qr.paid']) {
    expect(parsePaymongoPaidEvent(paidEventBody({ type }))).toBeNull()
  }
})
