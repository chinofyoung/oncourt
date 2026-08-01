export type RateBand = { startHour: number; endHour: number; priceCentavos: number }

export class PricingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PricingError'
  }
}

/** Sum of the band price for each booked hour. All amounts are integer centavos. */
export function priceSlots(bands: RateBand[], startHour: number, endHour: number): number {
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) {
    throw new PricingError('Hours must be integers')
  }
  if (endHour <= startHour) throw new PricingError('Range must cover at least one hour')

  let total = 0
  for (let hour = startHour; hour < endHour; hour++) {
    const band = bands.find((b) => hour >= b.startHour && hour < b.endHour)
    if (!band) throw new PricingError(`No rate band covers hour ${hour}`)
    total += band.priceCentavos
  }
  return total
}
