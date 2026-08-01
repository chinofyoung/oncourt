import { afterEach, expect, test } from 'vitest'
import { isAdminEmail } from '@/lib/auth/admin-allowlist'

const original = process.env.ADMIN_EMAILS
afterEach(() => { process.env.ADMIN_EMAILS = original })

test('matches an allowlisted email case-insensitively with surrounding whitespace', () => {
  process.env.ADMIN_EMAILS = ' Admin@OnCourt.ph , second@oncourt.ph '
  expect(isAdminEmail('admin@oncourt.ph')).toBe(true)
  expect(isAdminEmail('SECOND@ONCOURT.PH')).toBe(true)
})

test('rejects a non-allowlisted email', () => {
  process.env.ADMIN_EMAILS = 'admin@oncourt.ph'
  expect(isAdminEmail('player@example.test')).toBe(false)
})

test('an unset or empty allowlist grants nobody admin', () => {
  delete process.env.ADMIN_EMAILS
  expect(isAdminEmail('admin@oncourt.ph')).toBe(false)

  process.env.ADMIN_EMAILS = '   '
  expect(isAdminEmail('admin@oncourt.ph')).toBe(false)
})

test('an empty email is never admin even if the allowlist has empty entries', () => {
  process.env.ADMIN_EMAILS = 'admin@oncourt.ph,,'
  expect(isAdminEmail('')).toBe(false)
})
