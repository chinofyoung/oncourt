import { expect, test } from 'vitest'
import {
  isValidCalendarMonth,
  manilaMonth,
  shiftMonth,
} from '@/lib/date-manila'

test('isValidCalendarMonth accepts a real month and rejects everything else', () => {
  expect(isValidCalendarMonth('2026-08')).toBe(true)
  expect(isValidCalendarMonth('2026-01')).toBe(true)
  expect(isValidCalendarMonth('2026-12')).toBe(true)
  expect(isValidCalendarMonth('2026-00')).toBe(false)
  expect(isValidCalendarMonth('2026-13')).toBe(false)
  expect(isValidCalendarMonth('2026-8')).toBe(false)
  expect(isValidCalendarMonth('2026-08-01')).toBe(false)
  expect(isValidCalendarMonth('')).toBe(false)
  expect(isValidCalendarMonth('nope')).toBe(false)
})

test('shiftMonth crosses year boundaries in both directions', () => {
  expect(shiftMonth('2026-08', 1)).toBe('2026-09')
  expect(shiftMonth('2026-08', -1)).toBe('2026-07')
  expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  expect(shiftMonth('2026-08', 0)).toBe('2026-08')
  expect(shiftMonth('2026-08', 12)).toBe('2027-08')
})

test('manilaMonth is the first seven characters of manilaToday', async () => {
  const { manilaToday } = await import('@/lib/date-manila')
  expect(manilaMonth()).toBe(manilaToday().slice(0, 7))
})
