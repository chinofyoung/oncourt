import { expect, test } from 'vitest'
import { profileCompletion } from '@/lib/profile/completion'

const EMPTY = { fullName: null, phone: null, citySlug: null }

test('an untouched profile is 0% with three steps, none done', () => {
  const result = profileCompletion(EMPTY)
  expect(result.total).toBe(3)
  expect(result.doneCount).toBe(0)
  expect(result.percent).toBe(0)
  expect(result.steps.map((step) => step.key)).toEqual(['full_name', 'phone', 'city'])
  expect(result.steps.every((step) => !step.done)).toBe(true)
})

test('percent rounds to 33 / 67 / 100 as steps complete', () => {
  expect(profileCompletion({ ...EMPTY, fullName: 'Ana Cruz' }).percent).toBe(33)
  expect(profileCompletion({ ...EMPTY, fullName: 'Ana Cruz', phone: '+639171234567' }).percent).toBe(67)
  expect(
    profileCompletion({ fullName: 'Ana Cruz', phone: '+639171234567', citySlug: 'cebu-city' }).percent,
  ).toBe(100)
})

test('a whitespace-only value does not count as done', () => {
  const result = profileCompletion({ fullName: '   ', phone: '\t', citySlug: ' ' })
  expect(result.doneCount).toBe(0)
  expect(result.percent).toBe(0)
})

test('each step reports its own done flag independently', () => {
  const result = profileCompletion({ ...EMPTY, citySlug: 'davao-city' })
  const byKey = Object.fromEntries(result.steps.map((step) => [step.key, step.done]))
  expect(byKey).toEqual({ full_name: false, phone: false, city: true })
  expect(result.doneCount).toBe(1)
})

test('every step carries a human label', () => {
  for (const step of profileCompletion(EMPTY).steps) {
    expect(step.label.length).toBeGreaterThan(0)
  }
})
