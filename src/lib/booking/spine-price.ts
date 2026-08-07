import type { GridCell } from './availability'

/**
 * The single price that describes every bookable cell in one grid row, or
 * `null` when no such price exists.
 *
 * Only `open` cells count. A `closed` cell's price is not meaningful:
 * buildAvailabilityGrid's band lookup ignores the operating window, so a
 * closed cell carries either a
 * band price it will never charge or, when no band covers the hour at all, the
 * `band?.priceCentavos ?? 0` placeholder zero. `booked`/`past` cells do carry a
 * real band price but render "Booked"/"Past" rather than a number, so a price
 * in the time spine would not be describing them either.
 *
 * Returns null when open cells disagree (courts can define different rate
 * bands for the same hour) or when the row has no open cells at all. The
 * availability grid falls back to printing each open cell's own price in that
 * case, so a shared price is only ever displayed once it has been verified.
 *
 * Lives in its own import-free module (only a `import type` from
 * availability.ts, which is erased at compile time) because availability.ts
 * itself imports `@/db`, which imports `server-only` — a client component
 * like src/components/availability-grid.tsx cannot value-import from a module
 * that pulls in `server-only` without breaking the page (Next.js 500s with
 * "You're importing a module that depends on 'server-only'"). Keeping this
 * function import-free lets the client safely value-import it.
 */
export function spinePriceCentavos(cells: GridCell[]): number | null {
  let price: number | null = null
  for (const cell of cells) {
    if (cell.state !== 'open') continue
    if (price === null) price = cell.priceCentavos
    else if (price !== cell.priceCentavos) return null
  }
  return price
}
