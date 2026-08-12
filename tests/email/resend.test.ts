import { expect, test } from 'vitest'
import { classifyStatus } from '@/lib/email/provider'
import { fakeProvider } from '@/lib/email/fake'
import { classifyResendError } from '@/lib/email/resend'

const MSG = { to: 'a@example.test', subject: 'S', html: '<p>H</p>', text: 'H' }

test('5xx, 429 and network failures are retryable; other 4xx are not', () => {
  // The whole point of the retryable flag: "Resend is down, try again" must be
  // distinguishable from "that address is malformed, stop". Getting this
  // backwards means either giving up on a transient outage or retrying a
  // permanent rejection five times.
  expect(classifyStatus(500)).toBe(true)
  expect(classifyStatus(502)).toBe(true)
  expect(classifyStatus(503)).toBe(true)
  expect(classifyStatus(429)).toBe(true)
  expect(classifyStatus(400)).toBe(false)
  expect(classifyStatus(401)).toBe(false)
  expect(classifyStatus(403)).toBe(false)
  expect(classifyStatus(422)).toBe(false)
})

test('the fake records what it was asked to send and reports a message id', async () => {
  const provider = fakeProvider()
  const result = await provider.send(MSG)
  expect(result).toMatchObject({ ok: true })
  expect(provider.sent).toEqual([MSG])
})

test('the fake can fail a fixed number of times, then succeed', async () => {
  // Needed by the drain tests' backoff ladder: a row must retry and then land.
  const provider = fakeProvider({ failWith: { retryable: true, error: 'boom' }, failTimes: 2 })
  expect(await provider.send(MSG)).toEqual({ ok: false, retryable: true, error: 'boom' })
  expect(await provider.send(MSG)).toEqual({ ok: false, retryable: true, error: 'boom' })
  expect(await provider.send(MSG)).toMatchObject({ ok: true })
  expect(provider.sent).toHaveLength(1)
})

test('the fake can fail permanently', async () => {
  const provider = fakeProvider({ failWith: { retryable: false, error: 'bad address' } })
  expect(await provider.send(MSG)).toEqual({ ok: false, retryable: false, error: 'bad address' })
  expect(await provider.send(MSG)).toEqual({ ok: false, retryable: false, error: 'bad address' })
  expect(provider.sent).toEqual([])
})

test('classifyResendError: a null statusCode (the network-failure case) is retryable', () => {
  // This is the case the adapter got backwards on the first pass: the SDK
  // swallows fetch()-level failures (DNS, TCP, timeout) internally and
  // reports them as `{ statusCode: null }` rather than throwing. `null` here
  // means "no response came back to classify" — not "unknown, assume the
  // worst" — and it is exactly the case that must retry: a transient outage
  // retried five times is cheap, a real receipt abandoned on the first
  // hiccup is not. This is the one line in this file with no regression
  // guard until this test existed.
  expect(classifyResendError({ statusCode: null, name: 'application_error', message: 'Unable to fetch data.' })).toEqual({
    ok: false,
    retryable: true,
    error: 'application_error: Unable to fetch data.',
  })
})

test('classifyResendError: 5xx and 429 status codes are retryable', () => {
  expect(classifyResendError({ statusCode: 500, name: 'application_error', message: 'boom' })).toMatchObject({ retryable: true })
  expect(classifyResendError({ statusCode: 503, name: 'application_error', message: 'boom' })).toMatchObject({ retryable: true })
  expect(classifyResendError({ statusCode: 429, name: 'rate_limit_exceeded', message: 'too many requests' })).toMatchObject({
    retryable: true,
  })
})

test('classifyResendError: other 4xx status codes are not retryable', () => {
  expect(classifyResendError({ statusCode: 400, name: 'validation_error', message: 'bad input' })).toMatchObject({ retryable: false })
  expect(classifyResendError({ statusCode: 401, name: 'invalid_api_key', message: 'unauthorized' })).toMatchObject({ retryable: false })
  expect(classifyResendError({ statusCode: 422, name: 'invalid_from_address', message: 'not a real address' })).toMatchObject({
    retryable: false,
  })
})

test('classifyResendError: the error string carries both the SDK name and message, for /admin/emails to show why', () => {
  const result = classifyResendError({ statusCode: 422, name: 'invalid_from_address', message: 'not a real address' })
  expect(result).toEqual({ ok: false, retryable: false, error: 'invalid_from_address: not a real address' })
})
