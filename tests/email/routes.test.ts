import { afterAll, expect, test, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { manilaHourOf, manilaToday, shiftDay } from '@/lib/date-manila'
import { fakeProvider } from '@/lib/email/fake'
import {
  manilaHour, seedBlock, seedBooking, seedBranchWithCourts, seedOutboxRow, seedPlayer, teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

/**
 * The ONE place in this whole slice that mocks a module rather than testing
 * against the real thing. This does not violate the codebase's usual
 * avoid-module-mocking convention -- that convention exists so DOMAIN LOGIC
 * (queries, transactions, constraints) is exercised against the real,
 * hosted database rather than a mock of it. This mocks an OUTBOUND
 * THIRD-PARTY NETWORK BOUNDARY (Resend) at a route whose handler constructs
 * its own `resendProvider()` internally and therefore cannot take a provider
 * as a parameter the way `drainOutbox` itself does. `fakeProvider`
 * (src/lib/email/fake.ts) is exactly the double every other email test in
 * this codebase already uses for this -- the only reason it must be
 * substituted at the module level here, instead of passed as an argument, is
 * this route's fixed `(request: Request) => Response` signature.
 *
 * Do NOT "fix" this back to the real resendProvider(). Without it, the
 * drain-email route's 200 test would depend on the shared, persistent
 * database currently holding zero due `pending` rows -- true when this test
 * was written, but not something any single test run can guarantee (an
 * interrupted run's afterAll can leave an orphaned pending row behind), and
 * a due row would mean a REAL Resend send from this suite.
 */
vi.mock('@/lib/email/resend', () => ({ resendProvider: () => fakeProvider() }))

/**
 * Set directly at module scope, before the routes are dynamically imported
 * below -- mirrors tests/payments/webhook.test.ts's PAYMONGO_WEBHOOK_SECRET.
 * Belt-and-braces only: isAuthorizedCron reads CRON_SECRET at CALL time,
 * never at module scope, so this ordering doesn't matter for correctness --
 * but it keeps this file deterministic and independent of whatever (if
 * anything) .env.local happens to set, and it is restored below so no other
 * file in the same run sees a stray value.
 */
const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET
const SECRET = 'cron_test_' + crypto.randomUUID()
process.env.CRON_SECRET = SECRET

afterAll(() => {
  if (ORIGINAL_CRON_SECRET === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = ORIGINAL_CRON_SECRET
})

const { GET: drainEmailGET, POST: drainEmailPOST } = await import('@/app/api/cron/drain-email/route')
const { GET: enqueueRemindersGET, POST: enqueueRemindersPOST } = await import(
  '@/app/api/cron/enqueue-reminders/route'
)
const { enqueueDayOfReminders } = await import('@/lib/email/reminders')

function cronRequest(url: string, headers?: Record<string, string>, method: string = 'POST'): Request {
  return new Request(url, { method, headers })
}

// --- Auth gate, both endpoints ----------------------------------------------

test('drain-email: 401 with no Authorization header', async () => {
  const res = await drainEmailPOST(cronRequest('https://oncourt.test/api/cron/drain-email'))
  expect(res.status).toBe(401)
})

test('drain-email: 401 with a wrong secret', async () => {
  const res = await drainEmailPOST(
    cronRequest('https://oncourt.test/api/cron/drain-email', { authorization: 'Bearer wrong-secret' }),
  )
  expect(res.status).toBe(401)
})

test('drain-email: 200 with the right secret', async () => {
  // Nothing is seeded here, so this exercises exactly the auth gate and the
  // response shape it's named for -- resendProvider() is mocked to the fake
  // above regardless, so even an unrelated due row left over from another
  // file could not turn this into a real Resend call.
  const res = await drainEmailPOST(
    cronRequest('https://oncourt.test/api/cron/drain-email', { authorization: `Bearer ${SECRET}` }),
  )
  expect(res.status).toBe(200)
})

test('drain-email: GET is also authorized -- 401 with no Authorization header', async () => {
  // Vercel Cron can only call its target with GET (it cannot be configured
  // to send POST), so the bearer gate and the 200 path must both work for
  // GET too, not just POST -- see the GET/POST comment on the route itself.
  const res = await drainEmailGET(
    cronRequest('https://oncourt.test/api/cron/drain-email', undefined, 'GET'),
  )
  expect(res.status).toBe(401)
})

test('drain-email: GET is also authorized -- 200 with the right secret', async () => {
  const res = await drainEmailGET(
    cronRequest('https://oncourt.test/api/cron/drain-email', { authorization: `Bearer ${SECRET}` }, 'GET'),
  )
  expect(res.status).toBe(200)
})

test('drain-email: the send goes through the fake, never the real Resend adapter', async () => {
  // Proof that the vi.mock above actually took effect, not merely that
  // nothing happened to be due (the previous test seeds nothing, so it alone
  // cannot distinguish "mocked" from "real but idle"). RESEND_API_KEY is
  // unset for the duration of this call: if resendProvider() still resolved
  // to the REAL adapter, its send() would call
  // requiredEmailEnv('RESEND_API_KEY'), throw EmailConfigError, and the row
  // below would land on 'failed', non-retryable -- never 'sent'.
  // fakeProvider() reads no env var at all, so it sends regardless, making
  // "this row is 'sent'" a genuine proof of which provider ran, not a
  // coincidence.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId, startsAt: laterTodayManila(), status: 'confirmed',
  })
  const outboxId = await seedOutboxRow({
    kind: 'booking_confirmed',
    payload: {
      kind: 'booking_confirmed',
      booking: {
        playerName: 'Ana Cruz', branchName: 'Fixture Branch', courtName: 'Court 1',
        bookedOn: manilaToday(), startHour: 12, endHour: 13,
        totalChargedCentavos: 30000, bookingId,
      },
    },
    bookingId,
  })

  const originalResendKey = process.env.RESEND_API_KEY
  delete process.env.RESEND_API_KEY
  let status: number
  try {
    const res = await drainEmailPOST(
      cronRequest('https://oncourt.test/api/cron/drain-email', { authorization: `Bearer ${SECRET}` }),
    )
    status = res.status
  } finally {
    if (originalResendKey === undefined) delete process.env.RESEND_API_KEY
    else process.env.RESEND_API_KEY = originalResendKey
  }
  expect(status).toBe(200)

  const row = await db.execute(sql`
    select status::text as status from email_outbox where id = ${outboxId}::uuid
  `)
  expect(row.rows[0].status).toBe('sent')
})

test('enqueue-reminders: 401 with no Authorization header', async () => {
  const res = await enqueueRemindersPOST(cronRequest('https://oncourt.test/api/cron/enqueue-reminders'))
  expect(res.status).toBe(401)
})

test('enqueue-reminders: 401 with a wrong secret', async () => {
  const res = await enqueueRemindersPOST(
    cronRequest('https://oncourt.test/api/cron/enqueue-reminders', { authorization: 'Bearer wrong-secret' }),
  )
  expect(res.status).toBe(401)
})

test('enqueue-reminders: 200 with the right secret', async () => {
  const res = await enqueueRemindersPOST(
    cronRequest('https://oncourt.test/api/cron/enqueue-reminders', { authorization: `Bearer ${SECRET}` }),
  )
  expect(res.status).toBe(200)
  // `eligible`, not `enqueued` -- see the route's own comment: this counts
  // bookings found eligible and attempted this run, not rows actually
  // inserted, and the field is named to say so honestly in the cron log.
  const body = (await res.json()) as { eligible: number }
  expect(typeof body.eligible).toBe('number')
})

test('enqueue-reminders: GET is also authorized -- 401 with no Authorization header', async () => {
  const res = await enqueueRemindersGET(
    cronRequest('https://oncourt.test/api/cron/enqueue-reminders', undefined, 'GET'),
  )
  expect(res.status).toBe(401)
})

test('enqueue-reminders: GET is also authorized -- 200 with the right secret', async () => {
  const res = await enqueueRemindersGET(
    cronRequest(
      'https://oncourt.test/api/cron/enqueue-reminders',
      { authorization: `Bearer ${SECRET}` },
      'GET',
    ),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { eligible: number }
  expect(typeof body.eligible).toBe('number')
})

// --- The reminder query itself, called directly ----------------------------

/**
 * A future hour, still on today's Manila calendar date. Derived from the
 * current Manila hour rather than hardcoded: a fixed hour would pass or fail
 * depending on what time of day the suite happens to run.
 */
function laterTodayManila(): Date {
  const today = manilaToday()
  const currentHour = manilaHourOf(new Date())
  if (currentHour < 23) return manilaHour(today, currentHour + 1)
  // The last hour of the Manila day: a whole-hour slot cannot stay both
  // "today" and "in the future" from here. A fixed "+5 minutes" would itself
  // cross into tomorrow between 23:55 and 23:59:59 -- exactly the
  // time-of-day flake this function exists to avoid, just relocated. Halfway
  // to the next Manila midnight is always both strictly in the future and
  // strictly before that midnight: `currentHour === 23` means "now" is
  // already somewhere inside [23:00:00, 23:59:59.999] today, so the gap to
  // the next midnight is a positive amount strictly less than one hour, and
  // half of a positive amount is still positive and still smaller than the
  // whole.
  const nextManilaMidnight = manilaHour(shiftDay(today, 1), 0)
  const msRemaining = nextManilaMidnight.getTime() - Date.now()
  return new Date(Date.now() + msRemaining / 2)
}

async function reminderRowsFor(bookingId: string) {
  const r = await db.execute(sql`
    select recipient from email_outbox
    where booking_id = ${bookingId}::uuid and kind = 'booking_reminder'
  `)
  return r.rows
}

test('enqueues for a confirmed booking later today, and not for the rest', async () => {
  const { branchId, ownerId, courtIds } = await seedBranchWithCourts(5)
  const playerId = await seedPlayer()
  const today = manilaToday()
  const currentHour = manilaHourOf(new Date())

  const laterTodayBookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId, startsAt: laterTodayManila(), status: 'confirmed',
  })
  // Already started: this hour's own boundary is always <= "now", by
  // definition of what "the current hour" means.
  const startedBookingId = await seedBooking({
    courtId: courtIds[1], branchId, playerId,
    startsAt: manilaHour(today, currentHour), status: 'confirmed',
  })
  const tomorrowBookingId = await seedBooking({
    courtId: courtIds[2], branchId, playerId,
    startsAt: manilaHour(shiftDay(today, 1), 12), status: 'confirmed',
  })
  const pendingBookingId = await seedBooking({
    courtId: courtIds[3], branchId, playerId,
    startsAt: laterTodayManila(), status: 'pending_payment',
  })
  const blockedBookingId = await seedBlock({
    courtId: courtIds[4], branchId, createdBy: ownerId, startsAt: laterTodayManila(),
  })

  const result = await enqueueDayOfReminders()
  expect(result.enqueued).toBeGreaterThanOrEqual(1)

  expect((await reminderRowsFor(laterTodayBookingId)).length).toBe(1)
  expect((await reminderRowsFor(startedBookingId)).length).toBe(0)
  expect((await reminderRowsFor(tomorrowBookingId)).length).toBe(0)
  expect((await reminderRowsFor(pendingBookingId)).length).toBe(0)
  expect((await reminderRowsFor(blockedBookingId)).length).toBe(0)
})

test('running enqueueDayOfReminders twice enqueues once', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId, startsAt: laterTodayManila(), status: 'confirmed',
  })

  await enqueueDayOfReminders()
  await enqueueDayOfReminders()

  expect((await reminderRowsFor(bookingId)).length).toBe(1)
})
