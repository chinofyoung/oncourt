import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedPayout,
  seedPayoutLine,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

/** Postgres SQLSTATEs this file asserts on. */
const UNIQUE_VIOLATION = '23505'
const CHECK_VIOLATION = '23514'

function sqlStateOf(error: unknown): string | undefined {
  return (error as { cause?: { code?: string }; code?: string })?.cause?.code
    ?? (error as { code?: string })?.code
}

async function expectSqlState(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => sqlStateOf(error) === code,
    `expected SQLSTATE ${code}`,
  )
}

test('a booking can be paid once and clawed back once, but never paid twice', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2026-07-02', 12),
    status: 'completed',
  })

  const first = await seedPayout({ ownerId })
  await seedPayoutLine({ payoutId: first, bookingId, kind: 'payment', netCentavos: 27000 })

  // A clawback alongside the payment is exactly what the composite key exists
  // to permit — this is the refund-after-payout path.
  const second = await seedPayout({ ownerId })
  await seedPayoutLine({ payoutId: second, bookingId, kind: 'clawback', netCentavos: -27000 })

  // A second payment line for the same booking is a double-pay, and the
  // primary key is what makes it impossible rather than merely unlikely.
  await expectSqlState(
    seedPayoutLine({ payoutId: second, bookingId, kind: 'payment', netCentavos: 27000 }),
    UNIQUE_VIOLATION,
  )
})

test('a payout of zero or less is rejected', async () => {
  const { ownerId } = await seedBranchWithCourts(1)
  await expectSqlState(seedPayout({ ownerId, netCentavos: 0 }), CHECK_VIOLATION)
  await expectSqlState(seedPayout({ ownerId, netCentavos: -1 }), CHECK_VIOLATION)
})

test('paid and paid_at must agree in both directions', async () => {
  const { ownerId } = await seedBranchWithCourts(1)

  await expectSqlState(
    db.execute(sql`
      insert into payouts (owner_id, period_start, period_end,
                           gross_centavos, fee_centavos, net_centavos, status, paid_at)
      values (${ownerId}::uuid, '2026-08-01'::date, '2026-08-07'::date,
              55000, 5000, 50000, 'paid'::payout_status, null)
    `),
    CHECK_VIOLATION,
  )

  await expectSqlState(
    db.execute(sql`
      insert into payouts (owner_id, period_start, period_end,
                           gross_centavos, fee_centavos, net_centavos, status, paid_at)
      values (${ownerId}::uuid, '2026-08-01'::date, '2026-08-07'::date,
              55000, 5000, 50000, 'pending'::payout_status, now())
    `),
    CHECK_VIOLATION,
  )
})

test('an inverted period is rejected', async () => {
  const { ownerId } = await seedBranchWithCourts(1)
  await expectSqlState(
    seedPayout({ ownerId, periodStart: '2026-08-07', periodEnd: '2026-08-01' }),
    CHECK_VIOLATION,
  )
})
