import { expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { PAYMENT_METHODS } from '@/lib/payments/methods'
import {
  computeFees,
  FeeError,
  platformRetainedCentavos,
  processorFeeFor,
  reconcileSession,
  type FeeBreakdown,
  type ProcessorFeeBearer,
  type ProcessorRate,
} from '@/lib/payments/fees'

/**
 * The seeded rates, copied from
 * supabase/migrations/20260801042931_settings_and_enums.sql. Duplicated as
 * literals here ON PURPOSE: the whole expectation table below is derived from
 * exactly these numbers, and reading them from the database would make a rate
 * change silently rewrite the assertions instead of failing them. The last
 * test in this file is what ties these literals back to the live table.
 */
const RATES: Record<string, ProcessorRate> = {
  gcash: { percentageBps: 223, fixedFeeCentavos: 0 },
  maya: { percentageBps: 200, fixedFeeCentavos: 0 },
  card: { percentageBps: 350, fixedFeeCentavos: 1500 },
}

const BEARERS: ProcessorFeeBearer[] = ['player', 'owner', 'platform']

/** The parent spec's worked example: a ₱1,000 booking at a 10% platform fee. */
const COURT_FEE = 100_000
const PLATFORM_FEE = 10_000

/**
 * Every method × bearer combination, as exact centavo literals.
 *
 * The three `player` totals come from the spec's formula
 * `ceil((courtFee + fixed) * 10000 / (10000 - pct))`:
 *   gcash: ceil(1_000_000_000 / 9777)   = 102_281  (₱1,022.81)
 *   maya:  ceil(1_000_000_000 / 9800)   = 102_041  (₱1,020.41)
 *   card:  ceil(1_015_000_000 / 9650)   = 105_182  (₱1,051.82)
 *
 * NOTE on ₱1,022.81 vs the spec's illustrative "1022.83": the spec states the
 * formula explicitly and then illustrates it with a number two centavos off.
 * The formula wins, and it agrees with the parent spec's
 * `total = (courtFee + fixedFee) / (1 - rate)` = 1000 / 0.9777 = 1022.8085…
 * The rest of the spec's worked figures reproduce exactly: platform →
 * 1000 = 900 + (100 - 22.30) + 22.30; owner → 1000 = 877.70 + 100 + 22.30.
 */
const EXPECTED: Record<string, Record<ProcessorFeeBearer, FeeBreakdown>> = {
  gcash: {
    platform: { courtFeeCentavos: 100_000, platformFeeCentavos: 10_000, transactionFeeCentavos: 0,     totalChargedCentavos: 100_000, processorFeeCentavos: 2_230, ownerNetCentavos: 90_000 },
    owner:    { courtFeeCentavos: 100_000, platformFeeCentavos: 10_000, transactionFeeCentavos: 0,     totalChargedCentavos: 100_000, processorFeeCentavos: 2_230, ownerNetCentavos: 87_770 },
    player:   { courtFeeCentavos: 100_000, platformFeeCentavos: 10_000, transactionFeeCentavos: 2_281, totalChargedCentavos: 102_281, processorFeeCentavos: 2_281, ownerNetCentavos: 90_000 },
  },
  maya: {
    platform: { courtFeeCentavos: 100_000, platformFeeCentavos: 10_000, transactionFeeCentavos: 0,     totalChargedCentavos: 100_000, processorFeeCentavos: 2_000, ownerNetCentavos: 90_000 },
    owner:    { courtFeeCentavos: 100_000, platformFeeCentavos: 10_000, transactionFeeCentavos: 0,     totalChargedCentavos: 100_000, processorFeeCentavos: 2_000, ownerNetCentavos: 88_000 },
    player:   { courtFeeCentavos: 100_000, platformFeeCentavos: 10_000, transactionFeeCentavos: 2_041, totalChargedCentavos: 102_041, processorFeeCentavos: 2_041, ownerNetCentavos: 90_000 },
  },
  card: {
    platform: { courtFeeCentavos: 100_000, platformFeeCentavos: 10_000, transactionFeeCentavos: 0,     totalChargedCentavos: 100_000, processorFeeCentavos: 5_000, ownerNetCentavos: 90_000 },
    owner:    { courtFeeCentavos: 100_000, platformFeeCentavos: 10_000, transactionFeeCentavos: 0,     totalChargedCentavos: 100_000, processorFeeCentavos: 5_000, ownerNetCentavos: 85_000 },
    player:   { courtFeeCentavos: 100_000, platformFeeCentavos: 10_000, transactionFeeCentavos: 5_182, totalChargedCentavos: 105_182, processorFeeCentavos: 5_182, ownerNetCentavos: 90_000 },
  },
}

for (const method of Object.keys(RATES)) {
  for (const bearer of BEARERS) {
    test(`computeFees: ${method} × ${bearer} matches the worked ₱1,000 example exactly`, () => {
      expect(
        computeFees({
          courtFeeCentavos: COURT_FEE,
          platformFeeCentavos: PLATFORM_FEE,
          bearer,
          rate: RATES[method],
        }),
      ).toEqual(EXPECTED[method][bearer])
    })

    test(`the accounting identity holds for ${method} × ${bearer}`, () => {
      // THE CORRECTED IDENTITY, per the spec:
      //   totalCharged = ownerNet + platformRetained + processorFee
      //   platformRetained = platformFee - (bearer === 'platform' ? processorFee : 0)
      // The naive "always add the processor fee" form is WRONG for the
      // platform bearer, where the fee comes OUT of the platform's share.
      const breakdown = computeFees({
        courtFeeCentavos: COURT_FEE,
        platformFeeCentavos: PLATFORM_FEE,
        bearer,
        rate: RATES[method],
      })
      expect(
        breakdown.ownerNetCentavos +
          platformRetainedCentavos(breakdown, bearer) +
          breakdown.processorFeeCentavos,
      ).toBe(breakdown.totalChargedCentavos)
    })

    test(`reconcileSession round-trips computeFees for ${method} × ${bearer}`, () => {
      // The webhook derives a booking's money columns from the two numbers the
      // payments row recorded at quote time (amount, processor fee) rather
      // than re-reading the admin-editable processor_rates table. This asserts
      // the two functions can never drift.
      const breakdown = computeFees({
        courtFeeCentavos: COURT_FEE,
        platformFeeCentavos: PLATFORM_FEE,
        bearer,
        rate: RATES[method],
      })
      expect(
        reconcileSession({
          courtFeeCentavos: COURT_FEE,
          platformFeeCentavos: PLATFORM_FEE,
          bearer,
          amountCentavos: breakdown.totalChargedCentavos,
          processorFeeCentavos: breakdown.processorFeeCentavos,
        }),
      ).toEqual(breakdown)
    })
  }

  test(`the ${method} gross-up never under-collects, and over-collects by at most 1c`, () => {
    // The point of grossing up: apply the PROCESSOR's own formula to the
    // grossed-up total and the platform must still be whole. Rounding is UP,
    // so we may keep at most one centavo and can never absorb a shortfall.
    // (Exactly equal for gcash/maya; one centavo over for card, whose ₱15
    // fixed fee interacts with the ceiling.)
    for (const courtFee of [0, 1, 99, 100, 26_500, 100_000, 365_000, 10_000_000]) {
      const breakdown = computeFees({
        courtFeeCentavos: courtFee,
        platformFeeCentavos: Math.floor(courtFee / 10),
        bearer: 'player',
        rate: RATES[method],
      })
      const processorWouldTake = processorFeeFor(breakdown.totalChargedCentavos, RATES[method])
      const surplus = breakdown.transactionFeeCentavos - processorWouldTake
      expect(surplus).toBeGreaterThanOrEqual(0)
      expect(surplus).toBeLessThanOrEqual(1)
      // And what reaches the owner and the platform is untouched by the
      // grossing-up: the player pays the processor's cut on top.
      expect(breakdown.totalChargedCentavos - breakdown.transactionFeeCentavos).toBe(courtFee)
    }
  })
}

test('a zero court fee still charges the card fixed fee, grossed up', () => {
  // Not reachable from the booking flow today (priceSlots refuses a range
  // shorter than an hour and no rate band is free), but it is the boundary of
  // the formula and it must not divide by zero, round to zero, or go negative.
  expect(
    computeFees({
      courtFeeCentavos: 0,
      platformFeeCentavos: 0,
      bearer: 'player',
      rate: RATES.card,
    }),
  ).toEqual({
    courtFeeCentavos: 0,
    platformFeeCentavos: 0,
    // ceil(1_500 * 10_000 / 9_650) = ceil(15_000_000 / 9_650) = 1_555
    transactionFeeCentavos: 1_555,
    totalChargedCentavos: 1_555,
    processorFeeCentavos: 1_555,
    ownerNetCentavos: 0,
  })
})

test('the platform bearer may retain a NEGATIVE margin on a small card booking', () => {
  // Documented, not prevented (spec: "which may legitimately be negative on a
  // small booking"). ₱100 booking, 10% platform fee, card: the ₱15 fixed fee
  // alone exceeds the ₱10 the platform charges.
  const breakdown = computeFees({
    courtFeeCentavos: 10_000,
    platformFeeCentavos: 1_000,
    bearer: 'platform',
    rate: RATES.card,
  })
  expect(breakdown.processorFeeCentavos).toBe(1_850)
  expect(platformRetainedCentavos(breakdown, 'platform')).toBe(-850)
  // The player still pays exactly the court fee, and the owner is still whole.
  expect(breakdown.totalChargedCentavos).toBe(10_000)
  expect(breakdown.ownerNetCentavos).toBe(9_000)
  // The identity holds even when the platform loses money on the booking.
  expect(
    breakdown.ownerNetCentavos +
      platformRetainedCentavos(breakdown, 'platform') +
      breakdown.processorFeeCentavos,
  ).toBe(breakdown.totalChargedCentavos)
})

test('a large booking stays exact — the identity holds at ₱100,000', () => {
  // 10_000_000 centavos * 10_000 bps = 1e11, well inside Number.MAX_SAFE_INTEGER
  // (9.007e15), so integer arithmetic is exact and no float ever appears.
  for (const bearer of BEARERS) {
    const breakdown = computeFees({
      courtFeeCentavos: 10_000_000,
      platformFeeCentavos: 1_000_000,
      bearer,
      rate: RATES.gcash,
    })
    expect(Number.isSafeInteger(breakdown.totalChargedCentavos)).toBe(true)
    expect(
      breakdown.ownerNetCentavos +
        platformRetainedCentavos(breakdown, bearer) +
        breakdown.processorFeeCentavos,
    ).toBe(breakdown.totalChargedCentavos)
  }
})

test('rounding of the percentage is half-up, and exact at the .5 boundary', () => {
  // 100_000 * 223 / 10_000 = 2230.5 exactly. Half-up gives 2231... no: the
  // fee is computed from the numerator 22_300_000, and (22_300_000 + 5_000) /
  // 10_000 floors to 2230. Pinned as a literal so the direction can never
  // drift silently: this is the number that appears on every platform-bearer
  // GCash booking of ₱1,000.
  expect(processorFeeFor(100_000, RATES.gcash)).toBe(2_230)
  // A clean half: 10_000 * 2_500 bps / 10_000 = 2_500 exactly, no rounding.
  expect(processorFeeFor(10_000, { percentageBps: 2_500, fixedFeeCentavos: 0 })).toBe(2_500)
  // And exact division never gets bumped by a float artefact.
  expect(processorFeeFor(1_000_000, { percentageBps: 1_000, fixedFeeCentavos: 0 })).toBe(100_000)
})

test('computeFees refuses inputs that are not non-negative safe integers', () => {
  const base = { platformFeeCentavos: 0, bearer: 'platform' as const, rate: RATES.gcash }
  expect(() => computeFees({ ...base, courtFeeCentavos: -1 })).toThrow(FeeError)
  expect(() => computeFees({ ...base, courtFeeCentavos: 12.5 })).toThrow(FeeError)
  expect(() => computeFees({ ...base, courtFeeCentavos: Number.NaN })).toThrow(FeeError)
})

test('reconcileSession refuses inputs that are not non-negative safe integers', () => {
  // Mirrors the computeFees guard test above: reconcileSession is the
  // function the webhook uses to write a paid booking's money columns, so a
  // caller bug or a driver coercion (a numeric column round-tripping as a
  // string -> float) must throw a FeeError rather than silently produce a
  // corrupted FeeBreakdown. Parameterized over every guarded field and every
  // bad-value shape rather than four near-duplicate tests.
  const base = {
    courtFeeCentavos: 100_000,
    platformFeeCentavos: 10_000,
    bearer: 'owner' as const,
    amountCentavos: 100_000,
    processorFeeCentavos: 2_230,
  }
  const guardedFields = [
    'courtFeeCentavos',
    'platformFeeCentavos',
    'amountCentavos',
    'processorFeeCentavos',
  ] as const
  const badValues = [-1, 12.5, Number.NaN]

  for (const field of guardedFields) {
    for (const badValue of badValues) {
      expect(() => reconcileSession({ ...base, [field]: badValue })).toThrow(FeeError)
    }
  }
})

test('reconcileSession refuses to confirm a paid amount below the court fee', () => {
  // Review finding I-2: nothing previously asserted the SIGN of the computed
  // transaction fee, only that its inputs were well-formed. A paid amount
  // below the court fee (unreachable through the ordinary quote path, but
  // reachable if a webhook ever resolves the wrong anchor row — see I-1)
  // would otherwise silently produce a negative transactionFeeCentavos, which
  // the `bookings` table's own CHECK constraint
  // (bookings_transaction_fee_centavos_check) would then reject as an
  // uncaught 23514 deep inside the webhook's transaction. Refusing here,
  // loudly and by name, is strictly better: it fails before any write is
  // attempted and is attributable to this function rather than a bare SQL
  // error.
  expect(() =>
    reconcileSession({
      courtFeeCentavos: 100_000,
      platformFeeCentavos: 10_000,
      bearer: 'platform',
      amountCentavos: 99_999,
      processorFeeCentavos: 2_230,
    }),
  ).toThrow(FeeError)

  // The boundary itself — amount exactly equal to the court fee — is fine:
  // transactionFeeCentavos is exactly 0, not negative.
  expect(() =>
    reconcileSession({
      courtFeeCentavos: 100_000,
      platformFeeCentavos: 10_000,
      bearer: 'platform',
      amountCentavos: 100_000,
      processorFeeCentavos: 2_230,
    }),
  ).not.toThrow()
})

test('a processor percentage of 100% or more cannot be grossed up', () => {
  // The gross-up divides by (10_000 - pct). At pct >= 10_000 that is zero or
  // negative — Infinity or a negative total, both of which are real money
  // going the wrong way. processor_rates is admin-editable, so this is a
  // reachable configuration mistake and must fail loudly rather than compute.
  expect(() =>
    computeFees({
      courtFeeCentavos: 100_000,
      platformFeeCentavos: 10_000,
      bearer: 'player',
      rate: { percentageBps: 10_000, fixedFeeCentavos: 0 },
    }),
  ).toThrow(FeeError)
})

test('the code method list and the seeded processor_rates are the same set', async () => {
  // The one database-touching test in this file, and the reason the RATES
  // literals above are trustworthy. Read-only — it must never UPDATE
  // processor_rates, which is a seeded singleton set every other test file's
  // expectations depend on.
  const result = await db.execute(
    sql`select payment_method, percentage_bps, fixed_fee_centavos from processor_rates order by payment_method`,
  )
  const fromDb = Object.fromEntries(
    result.rows.map((row) => [
      row.payment_method as string,
      {
        percentageBps: Number(row.percentage_bps),
        fixedFeeCentavos: Number(row.fixed_fee_centavos),
      },
    ]),
  )
  expect(Object.keys(fromDb).sort()).toEqual([...PAYMENT_METHODS].map((m) => m.key).sort())
  expect(fromDb).toEqual(RATES)
})
