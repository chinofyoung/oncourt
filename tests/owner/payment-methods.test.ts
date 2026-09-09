import { afterAll, expect, test } from 'vitest'
import {
  addPaymentMethod,
  countPaymentMethods,
  listPaymentMethods,
  removePaymentMethod,
  updatePaymentMethod,
} from '@/lib/owner/payment-methods'
import { seedOwner, teardownFixtures } from '../helpers/fixtures'

afterAll(teardownFixtures)

test('a new owner has no payment methods', async () => {
  const ownerId = await seedOwner()
  expect(await listPaymentMethods(ownerId)).toEqual([])
  expect(await countPaymentMethods(ownerId)).toBe(0)
})

test('adding a method returns it in order, with trimmed fields', async () => {
  const ownerId = await seedOwner()
  const bank = await addPaymentMethod(ownerId, {
    kind: 'bank',
    institution: '  BPI  ',
    accountName: 'Smash Courts Inc',
    accountNumber: '  1234567890 ',
  })
  expect(bank.ok).toBe(true)
  const wallet = await addPaymentMethod(ownerId, {
    kind: 'ewallet',
    institution: 'GCash',
    accountName: 'Smash Courts',
    accountNumber: '09171234567',
  })
  expect(wallet.ok).toBe(true)

  const methods = await listPaymentMethods(ownerId)
  expect(methods.map((m) => m.institution)).toEqual(['BPI', 'GCash'])
  expect(methods.map((m) => m.position)).toEqual([0, 1])
  expect(methods[0].accountNumber).toBe('1234567890')
  expect(methods[0].qrStoragePath).toBeNull()
})

test('a blank required field is refused', async () => {
  const ownerId = await seedOwner()
  const result = await addPaymentMethod(ownerId, {
    kind: 'bank',
    institution: '   ',
    accountName: 'Smash Courts Inc',
    accountNumber: '1234567890',
  })
  expect(result).toEqual({ ok: false, reason: 'invalid_input' })
  expect(await countPaymentMethods(ownerId)).toBe(0)
})

test('one owner cannot touch another owner’s method', async () => {
  const mine = await seedOwner()
  const theirs = await seedOwner()
  const added = await addPaymentMethod(theirs, {
    kind: 'bank',
    institution: 'BDO',
    accountName: 'Their Courts',
    accountNumber: '9999999999',
  })
  if (!added.ok) throw new Error('setup failed')

  expect(await removePaymentMethod(mine, added.id)).toEqual({ ok: false, reason: 'not_found' })
  expect(
    await updatePaymentMethod(mine, added.id, {
      kind: 'bank',
      institution: 'Hijacked',
      accountName: 'Hijacked',
      accountNumber: '0000000000',
    }),
  ).toEqual({ ok: false, reason: 'not_found' })

  const stillTheirs = await listPaymentMethods(theirs)
  expect(stillTheirs[0].institution).toBe('BDO')
})

test('removing a method resequences the rest from zero', async () => {
  const ownerId = await seedOwner()
  const ids: string[] = []
  for (const institution of ['BPI', 'BDO', 'GCash']) {
    const added = await addPaymentMethod(ownerId, {
      kind: 'bank',
      institution,
      accountName: 'Smash Courts Inc',
      accountNumber: '1234567890',
    })
    if (!added.ok) throw new Error('setup failed')
    ids.push(added.id)
  }

  expect(await removePaymentMethod(ownerId, ids[0])).toEqual({ ok: true, id: ids[0] })

  const methods = await listPaymentMethods(ownerId)
  expect(methods.map((m) => m.institution)).toEqual(['BDO', 'GCash'])
  expect(methods.map((m) => m.position)).toEqual([0, 1])
})

test('the method count is capped', async () => {
  const ownerId = await seedOwner()
  for (let i = 0; i < 8; i++) {
    const added = await addPaymentMethod(ownerId, {
      kind: 'bank',
      institution: `Bank ${i}`,
      accountName: 'Smash Courts Inc',
      accountNumber: '1234567890',
    })
    expect(added.ok).toBe(true)
  }
  const overflow = await addPaymentMethod(ownerId, {
    kind: 'bank',
    institution: 'One too many',
    accountName: 'Smash Courts Inc',
    accountNumber: '1234567890',
  })
  expect(overflow).toEqual({ ok: false, reason: 'limit_reached' })
})
