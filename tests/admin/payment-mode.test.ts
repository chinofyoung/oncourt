import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { getOwnerPaymentMode, updateOwnerPaymentMode } from '@/lib/admin/settings'
import { addPaymentMethod } from '@/lib/owner/payment-methods'
import { seedOwner, seedPlayer, teardownFixtures } from '../helpers/fixtures'

afterAll(teardownFixtures)

async function giveMethod(ownerId: string) {
  const added = await addPaymentMethod(ownerId, {
    kind: 'ewallet',
    institution: 'GCash',
    accountName: 'Smash Courts',
    accountNumber: '09171234567',
  })
  if (!added.ok) throw new Error('setup failed')
}

test('an owner starts on the automated rail', async () => {
  const ownerId = await seedOwner()
  expect(await getOwnerPaymentMode(ownerId)).toBe('automated')
})

test('flipping to manual is refused when the owner has no payment method', async () => {
  const ownerId = await seedOwner()
  expect(await updateOwnerPaymentMode(ownerId, 'manual')).toEqual({
    ok: false,
    reason: 'no_payment_methods',
  })
  expect(await getOwnerPaymentMode(ownerId)).toBe('automated')
})

test('flipping to manual succeeds once a payment method exists', async () => {
  const ownerId = await seedOwner()
  await giveMethod(ownerId)
  expect(await updateOwnerPaymentMode(ownerId, 'manual')).toEqual({ ok: true })
  expect(await getOwnerPaymentMode(ownerId)).toBe('manual')
})

test('flipping back to automated is always allowed, even with no methods left', async () => {
  const ownerId = await seedOwner()
  await giveMethod(ownerId)
  await updateOwnerPaymentMode(ownerId, 'manual')
  await db.execute(sql`delete from owner_payment_methods where owner_id = ${ownerId}::uuid`)
  expect(await updateOwnerPaymentMode(ownerId, 'automated')).toEqual({ ok: true })
  expect(await getOwnerPaymentMode(ownerId)).toBe('automated')
})

test('a plain player cannot be put on the manual rail', async () => {
  const playerId = await seedPlayer()
  await db.execute(sql`
    insert into owner_payment_methods
      (owner_id, kind, institution, account_name, account_number, position)
    values (${playerId}::uuid, 'bank', 'BPI', 'Not An Owner', '1234567890', 0)
  `)
  expect(await updateOwnerPaymentMode(playerId, 'manual')).toEqual({
    ok: false,
    reason: 'not_found',
  })
})
