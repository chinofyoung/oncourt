/**
 * The fee engine. PURE — no database, no network, no `server-only`, no
 * imports at all. All arithmetic is INTEGER CENTAVOS; percentages are integer
 * basis points. No float ever appears in a returned value.
 *
 * Division is done with the two integer helpers below rather than
 * `Math.ceil(a / b)` / `Math.round(a / b)`. That is not pedantry: IEEE-754
 * division of two exact integers can land a hair above an exact quotient, and
 * `Math.ceil` would then add a whole centavo to somebody's bill. `%` and
 * `Math.floor` on integers below 2^53 are exact, so the helpers are not.
 *
 * Every numeric input accepted anywhere in this module is asserted a
 * non-negative safe integer (`Number.isSafeInteger`, i.e. well below
 * `Number.MAX_SAFE_INTEGER` = 2^53 - 1) — a bound no real booking's centavo
 * amount, basis-point rate, or product of the two comes remotely close to.
 */

export type ProcessorFeeBearer = 'player' | 'owner' | 'platform'

/** One row of `processor_rates`, already coerced out of the driver. */
export type ProcessorRate = { percentageBps: number; fixedFeeCentavos: number }

export type FeeBreakdown = {
  courtFeeCentavos: number
  platformFeeCentavos: number
  transactionFeeCentavos: number
  totalChargedCentavos: number
  processorFeeCentavos: number
  ownerNetCentavos: number
}

export class FeeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeeError'
  }
}

const BPS = 10_000

export function isProcessorFeeBearer(value: unknown): value is ProcessorFeeBearer {
  return value === 'player' || value === 'owner' || value === 'platform'
}

function assertCentavos(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new FeeError(`${name} must be a non-negative safe integer, got ${value}`)
  }
}

/** Exact integer ceiling division. Both arguments must be positive integers. */
function ceilDiv(numerator: number, denominator: number): number {
  const whole = Math.floor(numerator / denominator)
  return numerator % denominator === 0 ? whole : whole + 1
}

/** Exact integer half-up division. Both arguments must be positive integers. */
function roundHalfUpDiv(numerator: number, denominator: number): number {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator)
}

/**
 * What the processor takes out of `amountCentavos` — its percentage of that
 * amount plus its fixed fee. ONE definition, used by the owner/platform
 * bearers directly and by the test that proves the player bearer's gross-up
 * actually leaves the platform whole.
 */
export function processorFeeFor(amountCentavos: number, rate: ProcessorRate): number {
  assertCentavos('amountCentavos', amountCentavos)
  assertCentavos('rate.percentageBps', rate.percentageBps)
  assertCentavos('rate.fixedFeeCentavos', rate.fixedFeeCentavos)
  return roundHalfUpDiv(amountCentavos * rate.percentageBps, BPS) + rate.fixedFeeCentavos
}

/**
 * The full money breakdown for one booking on one payment method.
 *
 * `courtFeeCentavos` and `platformFeeCentavos` come from the hold — already
 * computed and snapshotted by src/lib/booking/hold.ts — and are never
 * recomputed here. This function's whole job is the processor fee and who
 * absorbs it.
 *
 *   bearer = 'player'   the platform is made whole by grossing UP, because the
 *                       processor also takes its percentage of the fee line
 *                       itself:
 *                         total = ceil((courtFee + fixed) * 10000 / (10000 - pct))
 *                       By construction the grossed-up increment IS what the
 *                       processor takes, so transactionFee and processorFee
 *                       are the same number. Rounding is UP, so the platform
 *                       may keep at most one centavo and can never absorb a
 *                       shortfall.
 *   bearer = 'owner'    the player pays the court fee; the processor's cut
 *                       comes out of the owner's net.
 *   bearer = 'platform' (default) the player pays the court fee; the
 *                       processor's cut comes out of the platform's own share,
 *                       so its retained margin is platformFee - processorFee,
 *                       WHICH MAY LEGITIMATELY BE NEGATIVE on a small booking.
 *                       Documented, not prevented.
 */
export function computeFees(input: {
  courtFeeCentavos: number
  platformFeeCentavos: number
  bearer: ProcessorFeeBearer
  rate: ProcessorRate
}): FeeBreakdown {
  const { courtFeeCentavos, platformFeeCentavos, bearer, rate } = input
  assertCentavos('courtFeeCentavos', courtFeeCentavos)
  assertCentavos('platformFeeCentavos', platformFeeCentavos)
  assertCentavos('rate.percentageBps', rate.percentageBps)
  assertCentavos('rate.fixedFeeCentavos', rate.fixedFeeCentavos)

  if (bearer === 'player') {
    // processor_rates is admin-editable, so a 100%-or-more percentage is a
    // reachable configuration mistake. Dividing by zero here would produce
    // Infinity; dividing by a negative would produce a negative total. Both
    // are real money going the wrong way, so fail loudly.
    if (rate.percentageBps >= BPS) {
      throw new FeeError(
        `A processor percentage of ${rate.percentageBps} bps cannot be grossed up`,
      )
    }
    const totalChargedCentavos = ceilDiv(
      (courtFeeCentavos + rate.fixedFeeCentavos) * BPS,
      BPS - rate.percentageBps,
    )
    const grossedUp = totalChargedCentavos - courtFeeCentavos
    return {
      courtFeeCentavos,
      platformFeeCentavos,
      transactionFeeCentavos: grossedUp,
      totalChargedCentavos,
      processorFeeCentavos: grossedUp,
      ownerNetCentavos: courtFeeCentavos - platformFeeCentavos,
    }
  }

  const processorFeeCentavos = processorFeeFor(courtFeeCentavos, rate)
  return {
    courtFeeCentavos,
    platformFeeCentavos,
    transactionFeeCentavos: 0,
    totalChargedCentavos: courtFeeCentavos,
    processorFeeCentavos,
    ownerNetCentavos:
      bearer === 'owner'
        ? courtFeeCentavos - platformFeeCentavos - processorFeeCentavos
        : courtFeeCentavos - platformFeeCentavos,
  }
}

/**
 * What the platform actually keeps.
 *
 * THE CORRECTION, in one function so no caller ever writes the conditional
 * twice: for the 'platform' bearer the processor's fee is carved OUT of the
 * platform fee, so the retained amount is smaller than the fee charged — and
 * may be negative. For 'player' and 'owner' the platform keeps the whole fee.
 */
export function platformRetainedCentavos(
  breakdown: FeeBreakdown,
  bearer: ProcessorFeeBearer,
): number {
  return breakdown.platformFeeCentavos - (bearer === 'platform' ? breakdown.processorFeeCentavos : 0)
}

/**
 * The webhook's derivation: a booking's six money columns from the two
 * numbers the `payments` row recorded AT QUOTE TIME plus the booking's own
 * court fee, platform fee and bearer.
 *
 * Deliberately does NOT re-read `processor_rates`. That table is
 * admin-editable, and an edit between checkout and the webhook would otherwise
 * silently rewrite a booking's money columns after the player had already
 * paid. `amountCentavos` is what we quoted for the session that was actually
 * paid, which is the only number the player ever agreed to.
 *
 * `transactionFeeCentavos` is `amount - courtFee`: zero for the owner and
 * platform bearers (where the session quoted exactly the court fee) and the
 * grossed-up increment for the player bearer. A test asserts
 * reconcileSession(computeFees(x)) === computeFees(x) for every method ×
 * bearer, so the two functions cannot drift.
 */
export function reconcileSession(input: {
  courtFeeCentavos: number
  platformFeeCentavos: number
  bearer: ProcessorFeeBearer
  amountCentavos: number
  processorFeeCentavos: number
}): FeeBreakdown {
  const { courtFeeCentavos, platformFeeCentavos, bearer, amountCentavos, processorFeeCentavos } =
    input
  assertCentavos('courtFeeCentavos', courtFeeCentavos)
  assertCentavos('platformFeeCentavos', platformFeeCentavos)
  assertCentavos('amountCentavos', amountCentavos)
  assertCentavos('processorFeeCentavos', processorFeeCentavos)

  const transactionFeeCentavos = amountCentavos - courtFeeCentavos
  // Every legitimate quote has amountCentavos >= courtFeeCentavos (computeFees
  // never produces a totalChargedCentavos below courtFeeCentavos for any
  // bearer), so this should be unreachable in the ordinary flow. It exists as
  // a hard backstop for the anchor row ever being resolved wrong: the
  // `bookings` table has its own CHECK on this column
  // (bookings_transaction_fee_centavos_check), and letting a negative value
  // reach that UPDATE would surface as an uncaught 23514 deep inside the
  // webhook's transaction instead of a clearly attributable failure here —
  // exactly the same reasoning as the >=100% processor-rate guard above.
  if (transactionFeeCentavos < 0) {
    throw new FeeError(
      `Paid amount ${amountCentavos} is less than the court fee ${courtFeeCentavos} — refusing to confirm`,
    )
  }

  return {
    courtFeeCentavos,
    platformFeeCentavos,
    transactionFeeCentavos,
    totalChargedCentavos: amountCentavos,
    processorFeeCentavos,
    ownerNetCentavos:
      bearer === 'owner'
        ? courtFeeCentavos - platformFeeCentavos - processorFeeCentavos
        : courtFeeCentavos - platformFeeCentavos,
  }
}
