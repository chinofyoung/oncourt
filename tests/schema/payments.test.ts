import { expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedPayment,
  seedPlayer,
} from '../helpers/fixtures'

test('the payment_status enum has exactly the three states the app knows about', async () => {
  const result = await db.execute(sql`
    select e.enumlabel from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'payment_status'
    order by e.enumsortorder
  `)
  expect(result.rows.map((r) => r.enumlabel)).toEqual(['pending', 'paid', 'failed'])
})

test('provider_payment_id is unique — this is what makes webhook replays no-ops', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-10-01', 18), status: 'confirmed',
  })

  const paymentId = 'pay_test_' + crypto.randomUUID()
  await seedPayment({ bookingId, paymentId, amountCentavos: 30000 })

  // The second insert is the replay. 23505 is the whole idempotency story:
  // the handler catches it and returns 200 without touching the booking.
  await expect(
    seedPayment({ bookingId, paymentId, amountCentavos: 30000 }),
  ).rejects.toMatchObject({ cause: { code: '23505' } })
})

test('two payments for one booking are allowed — an abandoned session is audit trail', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-10-01', 19), status: 'pending_payment',
  })

  await seedPayment({ bookingId, paymentMethod: 'gcash', amountCentavos: 30000 })
  await seedPayment({ bookingId, paymentMethod: 'card', amountCentavos: 31000 })

  const result = await db.execute(
    sql`select count(*)::int as n from payments where booking_id = ${bookingId}::uuid`,
  )
  expect(Number(result.rows[0].n)).toBe(2)
})

test('payment_method must name a real processor rate', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-10-01', 20), status: 'pending_payment',
  })

  // 23503: a method with no row in processor_rates cannot be priced, so it
  // must not be recordable either.
  await expect(
    seedPayment({ bookingId, paymentMethod: 'bitcoin', amountCentavos: 30000 }),
  ).rejects.toMatchObject({ cause: { code: '23503' } })
})

test('negative amounts are rejected by CHECK, in both money columns', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-10-01', 21), status: 'pending_payment',
  })

  await expect(
    seedPayment({ bookingId, amountCentavos: -1 }),
  ).rejects.toMatchObject({ cause: { code: '23514' } })
  await expect(
    seedPayment({ bookingId, amountCentavos: 100, processorFeeCentavos: -1 }),
  ).rejects.toMatchObject({ cause: { code: '23514' } })
})

test('deleting a booking that has a payment is rejected, not cascaded', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-10-01', 22), status: 'confirmed',
  })
  await seedPayment({ bookingId, amountCentavos: 30000 })

  // RESTRICT, deliberately: a payment is a financial record and must not
  // vanish with its booking. This is also exactly why teardownFixtures()
  // deletes payments first.
  await expect(
    db.execute(sql`delete from bookings where id = ${bookingId}::uuid`),
  ).rejects.toMatchObject({ cause: { code: '23503' } })

  await db.execute(sql`delete from payments where booking_id = ${bookingId}::uuid`)
  await db.execute(sql`delete from bookings where id = ${bookingId}::uuid`)
})

test('every foreign key on payments has its own index, and needs_refund is partial', async () => {
  // CLAUDE.md: index every foreign key explicitly — Postgres does not do it
  // for you, and an unindexed FK makes both joins and RESTRICT checks scan.
  const result = await db.execute(sql`
    select indexname, indexdef from pg_indexes
    where schemaname = 'public' and tablename = 'payments'
    order by indexname
  `)
  const byName = new Map(result.rows.map((r) => [r.indexname as string, r.indexdef as string]))

  expect(byName.has('payments_booking_id_idx')).toBe(true)
  expect(byName.has('payments_payment_method_idx')).toBe(true)
  expect(byName.has('payments_provider_session_id_idx')).toBe(true)
  expect(byName.get('payments_needs_refund_idx')).toMatch(/WHERE needs_refund/i)
})

test('payments has RLS enabled and zero policies, and is not forced', async () => {
  const result = await db.execute(sql`
    select c.relrowsecurity, c.relforcerowsecurity,
           (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'payments'
  `)
  const row = result.rows[0]
  expect(row.relrowsecurity).toBe(true)
  // force RLS would subject the owner role to the (nonexistent) policies and
  // deny our own queries. Never turn it on.
  expect(row.relforcerowsecurity).toBe(false)
  expect(Number(row.policies)).toBe(0)
})
