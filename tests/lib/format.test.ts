import { describe, expect, it } from 'vitest'
import {
  formatDateLabel,
  formatHour,
  formatHourRange,
  formatPeso,
  formatPriceFrom,
} from '@/lib/format'

describe('formatPeso', () => {
  it('omits centavos when the amount is whole pesos', () => {
    expect(formatPeso(30000)).toBe('₱300')
    expect(formatPeso(0)).toBe('₱0')
  })

  it('shows centavos when they are non-zero', () => {
    expect(formatPeso(102290)).toBe('₱1,022.90')
    expect(formatPeso(2230)).toBe('₱22.30')
  })

  it('separates thousands', () => {
    expect(formatPeso(100000)).toBe('₱1,000')
  })
})

describe('formatPriceFrom', () => {
  it('renders the price-from pattern', () => {
    expect(formatPriceFrom(20000)).toBe('from ₱200/hr')
  })
})

describe('formatHour', () => {
  it('formats morning and afternoon hours', () => {
    expect(formatHour(6)).toBe('6 AM')
    expect(formatHour(11)).toBe('11 AM')
    expect(formatHour(13)).toBe('1 PM')
    expect(formatHour(23)).toBe('11 PM')
  })

  it('formats both noon and midnight as 12', () => {
    expect(formatHour(0)).toBe('12 AM')
    expect(formatHour(12)).toBe('12 PM')
  })

  // court_operating_hours.closes_hour is allowed to be 24 and the fixtures
  // use it, so this path runs constantly. Rendering it as '24 AM' was a real
  // bug (docs/foundation-review-notes.md).
  it('formats hour 24 as midnight', () => {
    expect(formatHour(24)).toBe('12 AM')
  })
})

describe('formatHourRange', () => {
  it('collapses a shared period onto the end of the range', () => {
    expect(formatHourRange(7, 9)).toBe('7 – 9 AM')
  })

  it('keeps both periods when they differ', () => {
    expect(formatHourRange(11, 13)).toBe('11 AM – 1 PM')
    expect(formatHourRange(17, 24)).toBe('5 PM – 12 AM')
  })
})

describe('formatDateLabel', () => {
  it('renders weekday, month and day', () => {
    expect(formatDateLabel('2026-08-01')).toBe('Sat, Aug 1')
  })

  it('does not shift the date across a timezone boundary', () => {
    // 2026-01-01 is actually a Thursday (2026-08-01 is a Saturday per the
    // date-manila tests; 212 days later is +2 weekdays: Thu + 2 = Sat).
    expect(formatDateLabel('2026-01-01')).toBe('Thu, Jan 1')
  })
})
