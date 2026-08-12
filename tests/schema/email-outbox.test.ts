import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedOutboxRow,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

const UNIQUE_VIOLATION = '23505'
const CHECK_VIOLATION = '23514'

function sqlStateOf(error: unknown): string | undefined {
  return (
    (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code
  )
}

async function expectSqlState(promise: Promise<unknown>, code: string) {
  try {
    await promise
  } catch (error) {
    expect(sqlStateOf(error)).toBe(code)
    return
  }
  throw new Error(`expected SQLSTATE ${code}, but the statement succeeded`)
}

test('a booking gets at most one email of each kind', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-09-02', 12), status: 'confirmed',
  })

  await seedOutboxRow({ kind: 'booking_confirmed', bookingId })
  // A DIFFERENT kind for the same booking is fine — the receipt and the
  // reminder are two emails.
  await seedOutboxRow({ kind: 'booking_reminder', bookingId })
  // A second receipt is not. This is what makes a webhook replay a no-op.
  await expectSqlState(
    seedOutboxRow({ kind: 'booking_confirmed', bookingId }),
    UNIQUE_VIOLATION,
  )
})

test('court emails are deliberately NOT deduplicated', async () => {
  // A court can be edited, requeued to pending, and approved again. Its owner
  // should hear each time, so court_id carries no uniqueness.
  const { courtIds } = await seedBranchWithCourts(1)
  await seedOutboxRow({ kind: 'court_moderated', courtId: courtIds[0] })
  await seedOutboxRow({ kind: 'court_moderated', courtId: courtIds[0] })

  const count = await db.execute(sql`
    select count(*)::int as n from email_outbox where court_id = ${courtIds[0]}::uuid
  `)
  expect(Number(count.rows[0].n)).toBe(2)
})

test('sent and sent_at must agree in both directions', async () => {
  await expectSqlState(
    db.execute(sql`
      insert into email_outbox (kind, recipient, payload, status, sent_at)
      values ('booking_confirmed'::email_kind, 'a@example.test', '{}'::jsonb,
              'sent'::email_status, null)
    `),
    CHECK_VIOLATION,
  )
  await expectSqlState(
    db.execute(sql`
      insert into email_outbox (kind, recipient, payload, status, sent_at)
      values ('booking_confirmed'::email_kind, 'a@example.test', '{}'::jsonb,
              'pending'::email_status, now())
    `),
    CHECK_VIOLATION,
  )
})

test('attempts cannot go negative', async () => {
  await expectSqlState(seedOutboxRow({ kind: 'booking_new', attempts: -1 }), CHECK_VIOLATION)
})
