import { describe, expect, it } from 'vitest'
import {
  isValidCalendarDate,
  manilaDateOf,
  manilaHourOf,
  manilaToday,
  manilaWeekday,
  shiftDay,
} from '@/lib/date-manila'

describe('manilaWeekday', () => {
  // 2026-08-01 is a Saturday. The bug this guards against is reading
  // getUTCDay() off a '+08:00'-parsed instant: Manila midnight of Aug 1 is
  // 16:00 UTC on Jul 31, so that returns Friday (5) instead of Saturday (6).
  it('returns the weekday of the calendar date itself', () => {
    expect(manilaWeekday('2026-08-01')).toBe(6)
    expect(manilaWeekday('2026-08-02')).toBe(0)
    expect(manilaWeekday('2026-08-03')).toBe(1)
  })

  it('is correct across a year boundary', () => {
    expect(manilaWeekday('2027-01-01')).toBe(5)
  })
})

describe('shiftDay', () => {
  it('shifts forward', () => {
    expect(shiftDay('2026-08-01', 1)).toBe('2026-08-02')
  })

  // The prior implementation was a no-op forward and a two-day jump backward.
  it('shifts backward by exactly one day', () => {
    expect(shiftDay('2026-08-01', -1)).toBe('2026-07-31')
  })

  it('crosses a month boundary', () => {
    expect(shiftDay('2026-07-31', 1)).toBe('2026-08-01')
  })

  it('crosses a year boundary', () => {
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDay('2027-01-01', -1)).toBe('2026-12-31')
  })

  it('handles a leap day', () => {
    expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29')
  })
})

describe('isValidCalendarDate', () => {
  it('accepts a real date', () => {
    expect(isValidCalendarDate('2026-08-01')).toBe(true)
  })

  it('rejects shape-invalid input', () => {
    expect(isValidCalendarDate('lol')).toBe(false)
    expect(isValidCalendarDate('2026-8-1')).toBe(false)
    expect(isValidCalendarDate('')).toBe(false)
  })

  it('rejects a shape-valid but nonexistent date', () => {
    expect(isValidCalendarDate('2026-02-30')).toBe(false)
    expect(isValidCalendarDate('2026-13-01')).toBe(false)
  })
})

describe('manilaToday', () => {
  it('returns a valid YYYY-MM-DD date', () => {
    expect(isValidCalendarDate(manilaToday())).toBe(true)
  })
})

describe('manilaDateOf', () => {
  it('matches manilaToday when applied to "now"', () => {
    // Both read the same instant; manilaToday is manilaDateOf(new Date()).
    const now = new Date()
    expect(manilaDateOf(now)).toBe(manilaToday())
  })

  it('reads the Manila calendar date, not the UTC one, near the day boundary', () => {
    // 2026-08-01T23:30:00Z is already 2026-08-02T07:30 in Manila (+8h).
    expect(manilaDateOf(new Date('2026-08-01T23:30:00Z'))).toBe('2026-08-02')
  })
})

describe('manilaHourOf', () => {
  it('reads the Manila wall-clock hour for a UTC instant', () => {
    // 10:00 UTC is 18:00 Manila (+8h) — the exact instant class the booking
    // bug this function was added for hinges on (webhook.ts's `ends_at <=
    // now()` gate, mirrored by createHold/loadBranchDay's new elapsed-hour
    // guard).
    expect(manilaHourOf(new Date('2026-08-01T10:00:00Z'))).toBe(18)
  })

  it('rolls over past the Manila day boundary, not the UTC one', () => {
    // 23:30 UTC on Aug 1 is 07:30 Manila on Aug 2 -> hour 7, not 23.
    expect(manilaHourOf(new Date('2026-08-01T23:30:00Z'))).toBe(7)
  })
})
