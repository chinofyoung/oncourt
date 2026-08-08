import { expect, test } from 'vitest'
import { normalizePhPhone } from '@/lib/profile/phone'

test('accepts the three PH mobile shapes and stores one form', () => {
  expect(normalizePhPhone('09171234567')).toBe('+639171234567')
  expect(normalizePhPhone('+639171234567')).toBe('+639171234567')
  expect(normalizePhPhone('639171234567')).toBe('+639171234567')
})

test('ignores spaces, dashes and parentheses', () => {
  expect(normalizePhPhone('0917 123 4567')).toBe('+639171234567')
  expect(normalizePhPhone('0917-123-4567')).toBe('+639171234567')
  expect(normalizePhPhone('(0917) 123-4567')).toBe('+639171234567')
  expect(normalizePhPhone('  09171234567  ')).toBe('+639171234567')
})

test('rejects anything that is not a PH mobile', () => {
  expect(normalizePhPhone('')).toBeNull()
  expect(normalizePhPhone('   ')).toBeNull()
  expect(normalizePhPhone('0917123456')).toBeNull()   // one digit short
  expect(normalizePhPhone('091712345678')).toBeNull() // one digit long
  expect(normalizePhPhone('08171234567')).toBeNull()  // not a 9-series mobile
  expect(normalizePhPhone('+6329123456')).toBeNull()  // landline
  expect(normalizePhPhone('not a phone')).toBeNull()
  expect(normalizePhPhone('+1 415 555 2671')).toBeNull()
})
