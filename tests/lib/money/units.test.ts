import { expect, test } from 'vitest'
import {
  formatBpsAsPercent,
  formatCentavosAsPesos,
  parsePercentToBps,
  parsePesosToCentavos,
} from '@/lib/money/units'

test('parsePercentToBps converts whole and fractional percentages', () => {
  expect(parsePercentToBps('10')).toBe(1000)
  expect(parsePercentToBps('10.5')).toBe(1050)
  expect(parsePercentToBps('0.01')).toBe(1)
  expect(parsePercentToBps('100')).toBe(10000)
})

test('parsePercentToBps survives IEEE-754', () => {
  // 10.55 * 100 is 1054.9999999999999. A truncating cast yields 1054 — a
  // silently wrong fee. Math.round is load-bearing, not defensive.
  expect(parsePercentToBps('10.55')).toBe(1055)
  expect(parsePercentToBps('29.29')).toBe(2929)
})

test('parsePercentToBps tolerates a trailing percent sign and whitespace', () => {
  expect(parsePercentToBps('10%')).toBe(1000)
  expect(parsePercentToBps('  10 % ')).toBe(1000)
  expect(parsePercentToBps('%10')).toBeNull()
})

test('parsePercentToBps rejects anything it cannot represent exactly', () => {
  expect(parsePercentToBps('10.555')).toBeNull()
  expect(parsePercentToBps('')).toBeNull()
  expect(parsePercentToBps('abc')).toBeNull()
  expect(parsePercentToBps('-5')).toBeNull()
  expect(parsePercentToBps('1e2')).toBeNull()
  expect(parsePercentToBps('1,000')).toBeNull()
  expect(parsePercentToBps('.5')).toBeNull()
})

test('parsePercentToBps rejects zero and anything over 100 percent', () => {
  // Zero: the database constrains the value > 0, and "no fee" is expressed by
  // mode, not by value. Over 100%: the new conditional CHECK forbids it.
  expect(parsePercentToBps('0')).toBeNull()
  expect(parsePercentToBps('0.00')).toBeNull()
  expect(parsePercentToBps('100.01')).toBeNull()
  expect(parsePercentToBps('101')).toBeNull()
})

test('parsePesosToCentavos converts and rejects on the same rules', () => {
  expect(parsePesosToCentavos('250')).toBe(25000)
  expect(parsePesosToCentavos('250.50')).toBe(25050)
  expect(parsePesosToCentavos('250.05')).toBe(25005)
  expect(parsePesosToCentavos('0')).toBeNull()
  expect(parsePesosToCentavos('250.505')).toBeNull()
  expect(parsePesosToCentavos('-1')).toBeNull()
  expect(parsePesosToCentavos('₱250')).toBeNull()
  // No percent ceiling here, and no percent sign tolerated either.
  expect(parsePesosToCentavos('250%')).toBeNull()
})

test('format functions produce input values, not display strings', () => {
  expect(formatBpsAsPercent(1050)).toBe('10.5')
  expect(formatBpsAsPercent(1000)).toBe('10')
  expect(formatBpsAsPercent(1)).toBe('0.01')
  expect(formatCentavosAsPesos(25050)).toBe('250.50')
  expect(formatCentavosAsPesos(25000)).toBe('250')
  expect(formatCentavosAsPesos(1000000)).toBe('10000')

  // An input value carrying ₱ or a thousands separator comes straight back as
  // unparseable on the next submit. That is what separates these from
  // formatPeso, which is for humans to read.
  for (const value of [formatBpsAsPercent(123456), formatCentavosAsPesos(1234567)]) {
    expect(value).not.toContain('₱')
    expect(value).not.toContain(',')
  }
})

test('every format function round-trips through its own parser', () => {
  for (const bps of [1, 250, 1000, 1050, 1055, 10000]) {
    expect(parsePercentToBps(formatBpsAsPercent(bps))).toBe(bps)
  }
  for (const centavos of [1, 5, 100, 25000, 25050, 25005, 1000000]) {
    expect(parsePesosToCentavos(formatCentavosAsPesos(centavos))).toBe(centavos)
  }
})

test('parsers reject magnitudes they cannot represent or store', () => {
  // Past MAX_SAFE_INTEGER these silently returned a WRONG number rather than
  // null: '9007199254740993' parsed to 900719925474099200.
  expect(parsePesosToCentavos('9007199254740993')).toBeNull()
  expect(parsePesosToCentavos('99999999999999999999')).toBeNull()
  expect(parsePercentToBps('9007199254740993')).toBeNull()

  // int4 is the real ceiling — every column these feed is a Postgres integer.
  expect(parsePesosToCentavos('21474836.47')).toBe(2147483647)
  expect(parsePesosToCentavos('21474836.48')).toBeNull()
})
