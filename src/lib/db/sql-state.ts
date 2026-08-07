/**
 * SQLSTATE of a failed query, wherever the driver left it.
 *
 * drizzle-orm 0.45.2's `db.execute`/`tx.execute` wrap the driver error in
 * `DrizzleQueryError` and only expose the original `pg` error as `.cause` (see
 * node_modules/drizzle-orm/pg-core/session.js) — so the code lives at
 * `.cause.code`, not `.code`, for anything raised through drizzle. Checking
 * both keeps this robust either way, including for the raw `pg.Client` some
 * tests use.
 *
 * Extracted from src/lib/booking/hold.ts, which had it as a private function,
 * when src/lib/blocks/write.ts needed the same thing;
 * src/lib/bookings/review-write.ts had a third, hand-rolled copy of the same
 * `.cause` unwrap. One definition, three callers.
 *
 * Not `server-only`: it inspects a plain object and touches nothing.
 */
export function sqlStateOf(error: unknown): string | undefined {
  const withCause = error as { cause?: { code?: string }; code?: string }
  return withCause?.cause?.code ?? withCause?.code
}

/**
 * The constraint NAME behind a 23505/23P01/etc, wherever the driver left it —
 * same `.cause` unwrap as sqlStateOf, for the same reason.
 *
 * A bare SQLSTATE check is not enough to safely translate "unique violation"
 * into a business outcome: any future unique index on a table could raise the
 * identical 23505, and a check that only looks at the code would silently
 * swallow a genuinely different collision as if it were the one it was
 * written for. Checking the constraint name too is what keeps that
 * translation scoped to the index it was written for.
 */
export function constraintNameOf(error: unknown): string | undefined {
  const withCause = error as { cause?: { constraint?: string }; constraint?: string }
  return withCause?.cause?.constraint ?? withCause?.constraint
}

export const PG_UNIQUE_VIOLATION = '23505'
export const PG_CHECK_VIOLATION = '23514'
/**
 * A referenced row does not exist (or a referencing row still does). Raised
 * here when a court is inserted against a branch that was deleted between the
 * guard and the write — a normal outcome to report, not an exception.
 */
export const PG_FOREIGN_KEY_VIOLATION = '23503'
export const PG_EXCLUSION_VIOLATION = '23P01'
/**
 * Two overlapping requests can form a genuine wait-for cycle the deadlock
 * detector has to break, so this is a second way "someone else took this slot"
 * arrives. Treated identically to 23P01 by every caller.
 */
export const PG_DEADLOCK_DETECTED = '40P01'
