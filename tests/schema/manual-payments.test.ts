import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedOwner,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

async function enumValues(typeName: string): Promise<string[]> {
  const result = await db.execute(sql`
    select e.enumlabel from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = ${typeName}
    order by e.enumsortorder
  `)
  return result.rows.map((r) => r.enumlabel as string)
}

test('the three new enum types exist with their values', async () => {
  expect(await enumValues('payment_mode')).toEqual(['automated', 'manual'])
  expect(await enumValues('payment_method_kind')).toEqual(['bank', 'ewallet'])
  expect(await enumValues('manual_proof_status')).toEqual(['pending', 'approved', 'rejected'])
})

test('a new profile defaults to the automated rail', async () => {
  const ownerId = await seedOwner()
  const result = await db.execute(sql`
    select payment_mode::text as mode, manual_review_minutes
    from profiles where id = ${ownerId}::uuid
  `)
  expect(result.rows[0].mode).toBe('automated')
  expect(result.rows[0].manual_review_minutes).toBeNull()
})

test('manual_review_minutes is bounded to 30 minutes .. 7 days', async () => {
  const ownerId = await seedOwner()
  await expect(
    db.execute(sql`update profiles set manual_review_minutes = 29 where id = ${ownerId}::uuid`),
  ).rejects.toThrow()
  await expect(
    db.execute(sql`update profiles set manual_review_minutes = 10081 where id = ${ownerId}::uuid`),
  ).rejects.toThrow()
  await db.execute(sql`update profiles set manual_review_minutes = 720 where id = ${ownerId}::uuid`)
  const ok = await db.execute(
    sql`select manual_review_minutes as m from profiles where id = ${ownerId}::uuid`,
  )
  expect(Number(ok.rows[0].m)).toBe(720)
})

test('owner_payment_methods and manual_payment_proofs have RLS on and zero policies', async () => {
  const result = await db.execute(sql`
    select c.relname, c.relrowsecurity,
           (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('owner_payment_methods', 'manual_payment_proofs')
    order by c.relname
  `)
  expect(result.rows).toHaveLength(2)
  for (const row of result.rows) {
    expect(row.relrowsecurity).toBe(true)
    expect(Number(row.policies)).toBe(0)
  }
})

test('a payment method can be deleted', async () => {
  const { ownerId } = await seedBranchWithCourts(1)
  const method = await db.execute(sql`
    insert into owner_payment_methods
      (owner_id, kind, institution, account_name, account_number, position)
    values (${ownerId}::uuid, 'bank', 'BPI', 'Fixture Courts Inc', '1234567890', 0)
    returning id
  `)
  const methodId = method.rows[0].id as string

  await db.execute(sql`delete from owner_payment_methods where id = ${methodId}::uuid`)

  const gone = await db.execute(
    sql`select count(*)::int as n from owner_payment_methods where id = ${methodId}::uuid`,
  )
  expect(Number(gone.rows[0].n)).toBe(0)
})

test('the two storage buckets exist with the right visibility', async () => {
  const result = await db.execute(sql`
    select id, public from storage.buckets
    where id in ('payment-proofs', 'payment-qr') order by id
  `)
  expect(result.rows).toEqual([
    { id: 'payment-proofs', public: false },
    { id: 'payment-qr', public: true },
  ])
})

test('booking_status gained pending_verification', async () => {
  expect(await enumValues('booking_status')).toContain('pending_verification')
})

test('email_kind gained the three manual-rail kinds', async () => {
  const kinds = await enumValues('email_kind')
  expect(kinds).toContain('manual_proof_submitted')
  expect(kinds).toContain('manual_proof_rejected')
  expect(kinds).toContain('manual_review_expired')
})

test('a pending_verification booking blocks the same slot', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerA = await seedPlayer()
  const playerB = await seedPlayer()
  const startsAt = manilaHour('2027-03-04', 12)

  await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: playerA,
    startsAt,
    status: 'pending_verification',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })

  await expect(
    seedBooking({
      courtId: courtIds[0],
      branchId,
      playerId: playerB,
      startsAt,
      status: 'pending_verification',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }),
  ).rejects.toThrow()
})

test('expire_stale_holds sweeps an overdue pending_verification booking', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2027-03-05', 12),
    status: 'pending_verification',
    expiresAt: new Date(Date.now() - 60 * 1000),
  })

  await db.execute(sql`select expire_stale_holds()`)

  const after = await db.execute(
    sql`select status::text as status from bookings where id = ${bookingId}::uuid`,
  )
  expect(after.rows[0].status).toBe('expired')
})

test('the sweep leaves a live pending_verification booking alone', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2027-03-06', 12),
    status: 'pending_verification',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })

  await db.execute(sql`select expire_stale_holds()`)

  const after = await db.execute(
    sql`select status::text as status from bookings where id = ${bookingId}::uuid`,
  )
  expect(after.rows[0].status).toBe('pending_verification')
})
