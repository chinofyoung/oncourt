import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { drainOutbox, MAX_ATTEMPTS } from '@/lib/email/drain'
import { fakeProvider } from '@/lib/email/fake'
import type { EmailProvider } from '@/lib/email/provider'
import {
  manilaHour, seedBooking, seedBranchWithCourts, seedOutboxRow, seedPlayer, teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

const PAYLOAD = {
  kind: 'booking_confirmed',
  booking: {
    playerName: 'Ana Cruz', branchName: 'Fixture Branch', courtName: 'Court 1',
    bookedOn: '2026-09-25', startHour: 17, endHour: 19,
    totalChargedCentavos: 73000, bookingId: '11111111-2222-3333-4444-555555555555',
  },
}

async function seedDueRow(bookingId: string, over?: Partial<Parameters<typeof seedOutboxRow>[0]>) {
  return seedOutboxRow({ kind: 'booking_confirmed', payload: PAYLOAD, bookingId, ...over })
}

async function row(id: string) {
  const r = await db.execute(sql`
    select status::text as status, attempts, last_error, provider_message_id, sent_at,
           next_attempt_at, recipient
    from email_outbox where id = ${id}::uuid
  `)
  return r.rows[0]
}

async function seedBookingFor(date: string, hour: number) {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  return seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour(date, hour), status: 'confirmed',
  })
}

test('a due row sends and is marked, with the provider message id kept', async () => {
  const bookingId = await seedBookingFor('2026-09-25', 17)
  const id = await seedDueRow(bookingId)
  const provider = fakeProvider()

  const result = await drainOutbox(provider, 50)
  expect(result.sent).toBeGreaterThanOrEqual(1)

  const r = await row(id)
  expect(r.status).toBe('sent')
  expect(r.sent_at).not.toBeNull()
  expect(r.provider_message_id).toBeTruthy()

  // The row's own recipient must be the one addressed — a drainer that sent
  // every email to the same address would still pass a looser assertion.
  const mine = provider.sent.find((m) => m.to === (r.recipient as string))
  expect(mine).toBeDefined()
  expect(mine!.subject).toContain('Fixture Branch')
  expect(mine!.text.trim().length).toBeGreaterThan(0)
})

test('a successful send clears any last_error left over from a prior failed attempt', async () => {
  // A row that failed once (leaving last_error populated) and then sends on
  // a later attempt must not end up 'sent' while still showing a stale
  // error -- retryEmail already clears last_error for the admin-retry path;
  // this is the same symmetry for the ordinary drain-succeeds path.
  const bookingId = await seedBookingFor('2026-10-03', 12)
  const id = await seedDueRow(bookingId, { attempts: 1 })
  await db.execute(sql`update email_outbox set last_error = 'previous failure' where id = ${id}::uuid`)

  await drainOutbox(fakeProvider(), 50)

  const r = await row(id)
  expect(r.status).toBe('sent')
  expect(r.last_error).toBeNull()
})

test('a row not yet due is left alone', async () => {
  const bookingId = await seedBookingFor('2026-09-26', 17)
  const future = new Date(Date.now() + 60 * 60 * 1000)
  const id = await seedDueRow(bookingId, { nextAttemptAt: future })

  await drainOutbox(fakeProvider(), 50)
  expect((await row(id)).status).toBe('pending')
})

test('a retryable failure backs off and keeps the error', async () => {
  const bookingId = await seedBookingFor('2026-09-27', 17)
  const id = await seedDueRow(bookingId)
  const before = new Date()

  await drainOutbox(fakeProvider({ failWith: { retryable: true, error: 'resend 503' } }), 50)

  const r = await row(id)
  expect(r.status).toBe('pending')
  expect(Number(r.attempts)).toBe(1)
  expect(r.last_error).toContain('503')
  expect(new Date(r.next_attempt_at as string).getTime()).toBeGreaterThan(before.getTime())
})

test('a non-retryable failure goes terminal in one step', async () => {
  const bookingId = await seedBookingFor('2026-09-28', 17)
  const id = await seedDueRow(bookingId)

  await drainOutbox(fakeProvider({ failWith: { retryable: false, error: 'invalid address' } }), 50)

  const r = await row(id)
  expect(r.status).toBe('failed')
  expect(Number(r.attempts)).toBe(1)
  expect(r.last_error).toContain('invalid address')
})

test('the last allowed attempt goes terminal rather than retrying forever', async () => {
  const bookingId = await seedBookingFor('2026-09-29', 17)
  const id = await seedDueRow(bookingId, { attempts: MAX_ATTEMPTS - 1 })

  await drainOutbox(fakeProvider({ failWith: { retryable: true, error: 'still down' } }), 50)

  const r = await row(id)
  expect(r.status).toBe('failed')
  expect(Number(r.attempts)).toBe(MAX_ATTEMPTS)
})

test('a payload the templates cannot render fails that row without taking the batch down', async () => {
  const goodBooking = await seedBookingFor('2026-09-30', 17)
  const badBooking = await seedBookingFor('2026-09-30', 19)
  const good = await seedDueRow(goodBooking)
  const bad = await seedOutboxRow({
    kind: 'booking_confirmed',
    payload: { kind: 'nonsense' },   // renderEmail's exhaustive switch throws
    bookingId: badBooking,
  })

  await drainOutbox(fakeProvider(), 50)

  expect((await row(good)).status).toBe('sent')
  const r = await row(bad)
  expect(r.status).toBe('failed')
  expect(r.last_error).toBeTruthy()
})

test('a row whose own marking UPDATE throws does not take the rest of the batch down', async () => {
  // Proves the try/catch AROUND `processRow` in drainOutbox's loop -- not the
  // one already inside processRow around renderEmail (that's the "a payload
  // the templates cannot render..." test above, a DIFFERENT code path).
  //
  // This throws for real, not via a mock: a NUL byte (0x00) is not valid
  // inside a Postgres `text` value (SQLSTATE 22021,
  // character_not_in_repertoire; verified directly against this hosted
  // database before writing this test). Returning one as `error` makes the
  // retryable-failure branch's own `last_error = ${result.error}` UPDATE
  // throw inside processRow's transaction, past any try/catch processRow has
  // of its own -- the same shape of failure a Supavisor pooler blip on any of
  // processRow's `tx.execute` calls would produce. Without the fix, this
  // throw would propagate out of `await processRow(...)` uncaught and abort
  // the loop, leaving the "good" row below un-processed.
  const goodBooking = await seedBookingFor('2026-10-02', 12)
  const poisonBooking = await seedBookingFor('2026-10-02', 14)
  const good = await seedDueRow(goodBooking)
  const poisonRecipient = `poison-${crypto.randomUUID()}@example.test`
  const poison = await seedDueRow(poisonBooking, { recipient: poisonRecipient })

  const ok = fakeProvider()
  const provider: EmailProvider = {
    send: (msg) =>
      msg.to === poisonRecipient
        ? Promise.resolve({
            ok: false,
            retryable: true,
            error: `bad${String.fromCharCode(0)}nul`,
          })
        : ok.send(msg),
  }

  const result = await drainOutbox(provider, 50)

  // The good row went through normally -- the batch was not taken down.
  expect((await row(good)).status).toBe('sent')

  // The poisoned row's own transaction rolled back on the SQLSTATE 22021
  // error, so it never committed a status change -- it is still exactly
  // where it started: pending, zero attempts, ready for the next tick to
  // pick it up (and hit the same real failure again, which is correct: a
  // transient pooler blip should retry with no attempts burned, same as any
  // row whose transaction never got to commit).
  const poisonRow = await row(poison)
  expect(poisonRow.status).toBe('pending')
  expect(Number(poisonRow.attempts)).toBe(0)

  // This tick's own telemetry counts the poisoned row as claimed-and-failed,
  // per drain.ts's comment on the catch -- it is not simply dropped from the
  // result either.
  expect(result.claimed).toBeGreaterThanOrEqual(2)
  expect(result.sent).toBeGreaterThanOrEqual(1)
  expect(result.failed).toBeGreaterThanOrEqual(1)

  // The poisoned row is DELIBERATELY left `pending` and due (see above) --
  // exactly the state a later test's own `drainOutbox` call would also pick
  // up as an unrelated stray row. teardownFixtures only runs in afterAll, at
  // the very end of the file, so without this explicit cleanup the poisoned
  // row would still be sitting there `pending` when "two concurrent drains
  // send each row exactly once" runs later in this same file, inflating its
  // send count by one. Delete it directly rather than waiting for teardown.
  await db.execute(sql`delete from email_outbox where id = ${poison}::uuid`)
})

test('two concurrent drains send each row exactly once', async () => {
  // `for update skip locked` is what makes this safe. Without it both drains
  // claim the same rows and every player gets two receipts.
  const ids: string[] = []
  for (let hour = 12; hour < 18; hour++) {
    const bookingId = await seedBookingFor('2026-10-01', hour)
    ids.push(await seedDueRow(bookingId))
  }

  const a = fakeProvider()
  const b = fakeProvider()
  await Promise.all([drainOutbox(a, 10), drainOutbox(b, 10)])

  const mine = await db.execute(sql`
    select status::text as status from email_outbox
    where id = any (${sql.param(ids)}::uuid[])
  `)
  expect(mine.rows.every((r) => r.status === 'sent')).toBe(true)
  expect(a.sent.length + b.sent.length).toBe(ids.length)
})
