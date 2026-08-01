import { expect, test } from 'vitest'
import { priceSlots, PricingError, type RateBand } from '@/lib/booking/pricing'

const BANDS: RateBand[] = [
  { startHour: 11, endHour: 15, priceCentavos: 26500 },
  { startHour: 15, endHour: 17, priceCentavos: 31500 },
  { startHour: 17, endHour: 24, priceCentavos: 36500 },
]

test('prices a single hour inside one band', () => {
  expect(priceSlots(BANDS, 12, 13)).toBe(26500)
})

test('sums per-hour prices across a band boundary', () => {
  // 14:00-15:00 at 26500, 15:00-16:00 at 31500
  expect(priceSlots(BANDS, 14, 16)).toBe(58000)
})

test('spans three bands correctly', () => {
  // 14 (26500) + 15,16 (31500 x2) + 17 (36500)
  expect(priceSlots(BANDS, 14, 18)).toBe(126000)
})

test('throws when an hour is not covered by any band', () => {
  expect(() => priceSlots(BANDS, 9, 11)).toThrow(PricingError)
})

test('throws on an empty or inverted range', () => {
  expect(() => priceSlots(BANDS, 13, 13)).toThrow(PricingError)
  expect(() => priceSlots(BANDS, 15, 12)).toThrow(PricingError)
})
