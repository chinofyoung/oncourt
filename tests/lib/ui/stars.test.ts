import { expect, test } from 'vitest'
import { starFill } from '@/components/ui/stars'

test('rounds to the nearest half star', () => {
  expect(starFill(0)).toBe(0)
  expect(starFill(0.24)).toBe(0)
  expect(starFill(0.25)).toBe(0.5)
  expect(starFill(4.3)).toBe(4.5)
  expect(starFill(4.74)).toBe(4.5)
  expect(starFill(4.75)).toBe(5)
  expect(starFill(5)).toBe(5)
})

test('an exact integer rating is unchanged', () => {
  for (const n of [1, 2, 3, 4, 5]) expect(starFill(n)).toBe(n)
})

test('clamps out-of-range input instead of overflowing the row', () => {
  // The DB constrains reviews to 1..5, but an average is computed and this
  // component is public API — a value outside the range must not render six
  // stars or a negative-width overlay.
  expect(starFill(-3)).toBe(0)
  expect(starFill(7)).toBe(5)
  expect(starFill(Number.NaN)).toBe(0)
})
