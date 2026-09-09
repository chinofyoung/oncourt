import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { BPS } from '@/lib/money/units'

export type FeeMode = 'percentage' | 'flat'
export type ProcessorFeeBearer = 'player' | 'owner' | 'platform'

export type PlatformSettings = {
  feeMode: FeeMode
  /** Basis points when feeMode is 'percentage', centavos when it is 'flat'. */
  feeValue: number
  processorFeeBearer: ProcessorFeeBearer
  holdDurationMinutes: number
  updatedOn: string
}

/**
 * Policy bounds, deliberately NOT database constraints.
 *
 * The percentage ceiling IS a constraint (platform_settings_percentage_ceiling
 * / profiles_fee_percentage_ceiling) — but it only constrains the PERCENTAGE
 * case: a fee above 100% makes `owner_net = courtFee - platformFee`
 * structurally negative on every booking, pure arithmetic independent of any
 * particular court's price. Final whole-branch review, MUST-FIX #1: an
 * earlier version of this comment claimed that ceiling meant no configuration
 * could express a negative owner net at all, which is false — the FLAT case
 * takes a bare centavo amount with no relation to any court's price, so a
 * flat fee at or above a court's cheapest hourly rate produces the same
 * negative `owner_net` with the percentage ceiling never in play. There is no
 * equivalent database constraint on the flat case (a fixed centavo amount
 * cannot be bounded without knowing the court's rate, which lives in a
 * different table), so it is bounded at SAVE TIME instead, against the
 * cheapest approved court's rate — see `cheapestApprovedRateCentavos` and its
 * callers in `updatePlatformSettings`/`updateOwnerFeeOverride` below. The
 * `bookings_owner_net_non_negative` CHECK (migration
 * 20260809010000_owner_net_non_negative.sql) is the database backstop behind
 * that guard, for any row the guard didn't cover.
 *
 * MIN_HOLD_MINUTES/MAX_HOLD_MINUTES below are judgement, unlike the ceiling:
 * nothing breaks at a 300-minute hold, it is just a bad idea, and encoding a
 * number someone should be able to reconsider into a CHECK means a migration
 * to change your mind. MIN_HOLD_MINUTES is 5, not 1, for a concrete reason:
 * a PayMongo redirect cannot complete in under a minute or two in practice,
 * so a 1-minute hold dies mid-payment and generates manual-refund work on a
 * cadence, not as a rare edge case — 5 is the live platform default.
 */
const MIN_HOLD_MINUTES = 5
const MAX_HOLD_MINUTES = 120
/** ₱10,000. An obvious-typo guard on flat fees, not a business rule. */
const MAX_FLAT_FEE_CENTAVOS = 1_000_000

export async function getPlatformSettings(): Promise<PlatformSettings> {
  // No `where` and no `limit`: platform_settings_singleton means there is
  // exactly one row, and a limit would imply otherwise.
  const result = await db.execute(sql`
    select default_platform_fee_mode::text as fee_mode,
           default_platform_fee_value as fee_value,
           default_processor_fee_bearer::text as bearer,
           hold_duration_minutes,
           to_char(updated_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as updated_on
    from platform_settings
  `)
  const row = result.rows[0]
  return {
    feeMode: row.fee_mode as FeeMode,
    feeValue: Number(row.fee_value),
    processorFeeBearer: row.bearer as ProcessorFeeBearer,
    holdDurationMinutes: Number(row.hold_duration_minutes),
    updatedOn: row.updated_on as string,
  }
}

/**
 * Structurally minimal so both `db` and a Drizzle transaction handle satisfy
 * it: `db.execute` and `tx.execute` are two different bound methods, and only
 * their shared call signature belongs here. Verified against drizzle-orm
 * 0.45.2's node-postgres driver: NodePgTransaction extends PgTransaction
 * extends PgDatabase<NodePgQueryResultHKT, ...>, and `execute` is declared
 * exactly once, on PgDatabase — so `db` and every `tx` drizzle hands to a
 * `db.transaction()` callback share the identical `execute` signature already.
 * `typeof db.execute` therefore types this correctly with no widening needed;
 * this comment exists so the next person does not have to re-derive that from
 * the .d.ts files.
 */
export type SqlExecutor = { execute: typeof db.execute }

export type SettingsInput = {
  feeMode: FeeMode
  feeValue: number
  processorFeeBearer: ProcessorFeeBearer
  holdDurationMinutes: number
}

export type SettingsWriteResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_fee' | 'invalid_hold' }
  | { ok: false; reason: 'flat_fee_exceeds_cheapest_rate'; cheapestRateCentavos: number }

function feeValueIsValid(mode: FeeMode, value: number): boolean {
  if (!Number.isInteger(value) || value <= 0) return false
  return mode === 'percentage' ? value <= BPS : value <= MAX_FLAT_FEE_CENTAVOS
}

/**
 * Final whole-branch review, MUST-FIX #1: the cheapest hourly rate a FLAT
 * platform fee could clash with. A flat fee is a bare centavo amount with no
 * relation to any court's price — `ownerNet = courtFee - platformFee` in
 * src/lib/booking/hold.ts goes negative the moment the fee meets or exceeds
 * the court's rate for that booking, and nothing before this guard existed
 * caught it (the `bookings` table's `>= 0` CHECKs cover every OTHER money
 * column, never `owner_net_centavos`).
 *
 * Scoped to `status = 'approved'` courts only: a pending/rejected/suspended
 * court can never actually be booked, so its rate bands can never receive a
 * real charge and are not a real conflict.
 *
 * Returns `null` when there is nothing to conflict with (no approved courts,
 * or none with rate bands yet) — the caller must treat that as "allow the
 * save," not as a rate of zero, or every flat fee would be rejected on a
 * platform/owner with no courts.
 *
 * Takes an explicit `SqlExecutor` rather than importing `db` directly: the
 * platform-wide caller (`updatePlatformSettings`) runs inside a test's
 * rolled-back transaction, and reading through a bare `db` here would escape
 * that transaction's snapshot and see only committed data.
 */
async function cheapestApprovedRateCentavos(
  exec: SqlExecutor,
  ownerId?: string,
): Promise<number | null> {
  const result = await exec.execute(
    ownerId
      ? sql`
          select min(rb.price_centavos) as min_rate
          from court_rate_bands rb
          join courts c on c.id = rb.court_id
          join branches b on b.id = c.branch_id
          where c.status = 'approved' and b.owner_id = ${ownerId}::uuid
        `
      : sql`
          select min(rb.price_centavos) as min_rate
          from court_rate_bands rb
          join courts c on c.id = rb.court_id
          where c.status = 'approved'
        `,
  )
  const minRate = result.rows[0]?.min_rate
  return minRate === null || minRate === undefined ? null : Number(minRate)
}

/**
 * Editing these changes bookings made from now on and nothing else. createHold
 * snapshots the computed fees onto each booking row along with a
 * fee_config_snapshot, and nothing downstream ever recomputes — a price change
 * must never rewrite a live hold.
 *
 * `exec` exists for testing, and only for testing. platform_settings is a
 * seeded singleton in a shared, persistent database that other suites read
 * concurrently, so its test writes through a transaction it rolls back rather
 * than mutating the row and restoring it.
 */
export async function updatePlatformSettings(
  input: SettingsInput,
  exec: SqlExecutor = db,
): Promise<SettingsWriteResult> {
  if (!feeValueIsValid(input.feeMode, input.feeValue)) return { ok: false, reason: 'invalid_fee' }
  if (
    !Number.isInteger(input.holdDurationMinutes) ||
    input.holdDurationMinutes < MIN_HOLD_MINUTES ||
    input.holdDurationMinutes > MAX_HOLD_MINUTES
  ) {
    return { ok: false, reason: 'invalid_hold' }
  }

  // Only the flat case can conflict with a court's rate — a percentage is
  // inherently proportional and is already capped at 100% by the database's
  // platform_settings_percentage_ceiling constraint. See
  // cheapestApprovedRateCentavos's doc comment for why `null` means "allow".
  if (input.feeMode === 'flat') {
    const cheapest = await cheapestApprovedRateCentavos(exec)
    if (cheapest !== null && input.feeValue >= cheapest) {
      return { ok: false, reason: 'flat_fee_exceeds_cheapest_rate', cheapestRateCentavos: cheapest }
    }
  }

  await exec.execute(sql`
    update platform_settings
    set default_platform_fee_mode    = ${input.feeMode}::platform_fee_mode,
        default_platform_fee_value   = ${input.feeValue},
        default_processor_fee_bearer = ${input.processorFeeBearer}::processor_fee_bearer,
        hold_duration_minutes        = ${input.holdDurationMinutes},
        updated_at                   = now()
    where id
  `)
  return { ok: true }
}

export type OwnerFeeOverride = {
  /** Null mode AND null value means "inherit the platform default". */
  feeMode: FeeMode | null
  feeValue: number | null
  /** Independently nullable — not part of the fee pair. */
  processorFeeBearer: ProcessorFeeBearer | null
}

export type OverrideWriteResult =
  | { ok: true }
  | { ok: false; reason: 'no_such_owner' | 'invalid_fee' | 'unpaired_fee' }
  | { ok: false; reason: 'flat_fee_exceeds_cheapest_rate'; cheapestRateCentavos: number }

export async function updateOwnerFeeOverride(
  ownerId: string,
  override: OwnerFeeOverride,
): Promise<OverrideWriteResult> {
  const { feeMode, feeValue } = override
  // profiles_fee_override_pair: both null or both set. Checked here so an
  // admin gets a sentence rather than a 23514.
  if ((feeMode === null) !== (feeValue === null)) return { ok: false, reason: 'unpaired_fee' }
  if (feeMode !== null && feeValue !== null && !feeValueIsValid(feeMode, feeValue)) {
    return { ok: false, reason: 'invalid_fee' }
  }

  // Same reasoning as updatePlatformSettings's identical guard, scoped to
  // just THIS owner's own branches/courts rather than the whole platform —
  // an override only ever prices bookings under this owner.
  if (feeMode === 'flat' && feeValue !== null) {
    const cheapest = await cheapestApprovedRateCentavos(db, ownerId)
    if (cheapest !== null && feeValue >= cheapest) {
      return { ok: false, reason: 'flat_fee_exceeds_cheapest_rate', cheapestRateCentavos: cheapest }
    }
  }

  // role in ('owner','admin') is not decoration. Without it an admin could pin
  // an override onto a player's profile, where it would sit invisible and
  // inert until that player was promoted, and then silently take effect.
  //
  // `returning id` + counting the returned rows, not `result.rowCount`.
  // Checked empirically against this driver stack (drizzle-orm 0.45.2 over
  // node-postgres): `rowCount` IS present and DOES report correctly on an
  // UPDATE with no `returning` (a scratch check against the live DB showed
  // `rowCount: 1, rows.length: 0` for a matched, returning-less UPDATE) — so
  // the brief's prediction that it might be missing did not hold. Used
  // `returning id` + `rows.length` anyway: it is the shape this codebase
  // already uses everywhere else for the identical "did my UPDATE's WHERE
  // match a row" question (src/lib/admin/write.ts's four moderation
  // transitions; `rowCount` appears nowhere in src/ or tests/), and it is the
  // one the brief explicitly forbids getting wrong — an UPDATE with no
  // `returning` reports 0 *rows* regardless of what it touched, which would
  // make every call wrongly report `no_such_owner` while having actually
  // written the row. Adding `returning id` here removes that trap entirely.
  const result = await db.execute(sql`
    update profiles
    set platform_fee_mode    = ${feeMode}::platform_fee_mode,
        platform_fee_value   = ${feeValue},
        processor_fee_bearer = ${override.processorFeeBearer}::processor_fee_bearer
    where id = ${ownerId}::uuid and role in ('owner', 'admin')
    returning id
  `)

  return result.rows.length === 0 ? { ok: false, reason: 'no_such_owner' } : { ok: true }
}

export type PaymentModeResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'no_payment_methods' }

export async function getOwnerPaymentMode(
  ownerId: string,
): Promise<'automated' | 'manual' | null> {
  const result = await db.execute(sql`
    select payment_mode::text as mode from profiles where id = ${ownerId}::uuid
  `)
  if (result.rows.length === 0) return null
  return result.rows[0].mode as 'automated' | 'manual'
}

/**
 * Which payment rail an owner is on. Admin-only, like the fee override
 * directly above -- same `role in ('owner','admin')` scoping so a rail can
 * never be parked on a plain player's profile.
 *
 * Flipping TO manual is guarded on the owner having at least one payment
 * method. Without one, the checkout page has nothing to show and the owner's
 * courts become unbookable the instant the switch lands -- the same
 * save-time-guard shape as cheapestApprovedRateCentavos above, which refuses a
 * flat fee that would exceed the owner's cheapest rate.
 *
 * Flipping BACK to automated is unconditional: bookings already in flight
 * carry their own snapshotted rail (bookings.payment_mode), so nothing in
 * progress is disturbed.
 *
 * The count and the update share a transaction so an owner deleting their
 * last method concurrently cannot slip between the two -- deliberately NOT
 * importing countPaymentMethods from src/lib/owner/payment-methods.ts: that
 * helper runs against the bare `db` handle, outside any transaction, so it
 * cannot see this transaction's snapshot and could race a concurrent delete.
 * The inline `select count(*)` below runs on `tx`, the same connection as the
 * UPDATE, closing that window.
 */
export async function updateOwnerPaymentMode(
  ownerId: string,
  mode: 'automated' | 'manual',
): Promise<PaymentModeResult> {
  return db.transaction(
    async (tx) => {
      if (mode === 'manual') {
        const methods = await tx.execute(sql`
          select count(*)::int as n from owner_payment_methods
          where owner_id = ${ownerId}::uuid
        `)
        if (Number(methods.rows[0].n) === 0) {
          return { ok: false as const, reason: 'no_payment_methods' as const }
        }
      }

      // `returning id` + rows.length, never rowCount: an UPDATE without
      // returning reports zero rows regardless of what it touched. Same trap
      // documented at length in updateOwnerFeeOverride above.
      const updated = await tx.execute(sql`
        update profiles set payment_mode = ${mode}::payment_mode
        where id = ${ownerId}::uuid and role in ('owner', 'admin')
        returning id
      `)
      if (updated.rows.length === 0) return { ok: false as const, reason: 'not_found' as const }
      return { ok: true as const }
    },
    { isolationLevel: 'read committed' },
  )
}
