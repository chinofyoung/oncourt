import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'
import {
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
  sqlStateOf,
} from '@/lib/db/sql-state'
import { slugifyBranchName, type BranchFields, type CourtFields } from '@/lib/listings/fields'
import {
  operatingSpan,
  validateBandShapes,
  validateOperatingHours,
  validateRateBands,
  type BandsFailure,
  type HoursFailure,
  type OperatingHoursDay,
  type RateBand,
} from '@/lib/listings/schedule'

/**
 * Every listing write. Exported for the guarded actions in
 * src/app/dashboard/listings/*.ts, which are the only production callers.
 *
 * The lifecycle rules live here rather than in the actions because they are
 * the part worth testing: a key-field edit (rate bands, operating hours,
 * environment) re-queues an `approved` or `rejected` court to `pending` and
 * clears its rejection_reason; a name/surface/photo/branch edit does not; and
 * a `suspended` court never moves, because suspension is an admin action an
 * owner must not be able to edit their way out of.
 */

/**
 * The status transition, as ONE status-scoped UPDATE.
 *
 * Zero rows is a meaningful answer, not an error: the court was already
 * `pending` (nothing visible changed) or `suspended` (it must not move). No
 * read-then-write, so two concurrent edits cannot race into an inconsistent
 * status — the same shape as the blocks slice's writes and as Slice C's
 * approve/reject will use.
 */
function requeueCourtSql(courtId: string): SQL {
  return sql`
    update courts set status = 'pending', rejection_reason = null
    where id = ${courtId}::uuid and status in ('approved', 'rejected')
    returning id
  `
}

/**
 * `branches.location` is `geography(Point, 4326)`. st_makepoint takes
 * (x, y) = (longitude, latitude) — in that order, which is the reverse of
 * how humans say it and the single easiest thing to get wrong here.
 * Matches tests/helpers/fixtures.ts's seed exactly.
 */
function locationSql(fields: BranchFields): SQL {
  if (fields.lat === null || fields.lng === null) return sql`null`
  return sql`st_setsrid(st_makepoint(${fields.lng}, ${fields.lat}), 4326)::geography`
}

export type CreateBranchResult =
  | { ok: true; branchId: string; slug: string }
  | { ok: false; reason: 'slug_unavailable' }

/**
 * How many slugs to try before giving up. The first is the clean one derived
 * from the name; the rest carry a short random suffix. Five is far past the
 * point where a collision is anything but a name every owner in the country
 * chose — and giving up with a friendly reason beats looping forever.
 */
const SLUG_ATTEMPTS = 5

export async function createBranch(input: {
  ownerId: string
  fields: BranchFields
}): Promise<CreateBranchResult> {
  const base = slugifyBranchName(input.fields.name)

  // Try-and-catch rather than select-then-insert: branches.slug is UNIQUE, so
  // the constraint is the authority. A "is this slug free?" SELECT would be
  // a TOCTOU window that two owners registering "Rally Point" at the same
  // moment would walk straight through.
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${crypto.randomUUID().slice(0, 6)}`
    try {
      const result = await db.execute(sql`
        insert into branches (
          owner_id, name, slug, description, address, city, amenities,
          contact_phone, contact_email, location
        ) values (
          ${input.ownerId}::uuid, ${input.fields.name}, ${slug}, ${input.fields.description},
          ${input.fields.address}, ${input.fields.city},
          ${sql.param(input.fields.amenities)}::text[],
          ${input.fields.contactPhone}, ${input.fields.contactEmail},
          ${locationSql(input.fields)}
        )
        returning id, slug
      `)
      return {
        ok: true,
        branchId: result.rows[0].id as string,
        slug: result.rows[0].slug as string,
      }
    } catch (error) {
      if (sqlStateOf(error) !== PG_UNIQUE_VIOLATION) throw error
    }
  }

  return { ok: false, reason: 'slug_unavailable' }
}

export type UpdateBranchResult = { ok: true } | { ok: false; reason: 'not_found' }

/**
 * Replaces every editable branch field.
 *
 * The SLUG IS NOT TOUCHED. It is the public /venues/<slug> URL, printed on
 * posters and linked from search results and player receipts; a rename that
 * silently moved the page would break all of them. Renaming the URL is a
 * separate, deliberate operation that this product does not offer.
 *
 * Branch edits never touch court statuses — spec: "all branch-level edits do
 * not re-queue."
 */
export async function updateBranch(input: {
  branchId: string
  fields: BranchFields
}): Promise<UpdateBranchResult> {
  const result = await db.execute(sql`
    update branches set
      name = ${input.fields.name},
      description = ${input.fields.description},
      address = ${input.fields.address},
      city = ${input.fields.city},
      amenities = ${sql.param(input.fields.amenities)}::text[],
      contact_phone = ${input.fields.contactPhone},
      contact_email = ${input.fields.contactEmail},
      location = ${locationSql(input.fields)}
    where id = ${input.branchId}::uuid
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'not_found' }
}

export type CreateCourtResult =
  | { ok: true; courtId: string }
  | { ok: false; reason: 'branch_missing' }

/**
 * A new court. `status` and `rejection_reason` are left to the column
 * defaults ('pending', null) rather than written explicitly, so the rule "a
 * new court inserts as pending" has exactly one home — the schema.
 */
export async function createCourt(input: {
  branchId: string
  fields: CourtFields
}): Promise<CreateCourtResult> {
  try {
    const result = await db.execute(sql`
      insert into courts (branch_id, name, environment, surface)
      values (
        ${input.branchId}::uuid, ${input.fields.name},
        ${input.fields.environment}::court_environment, ${input.fields.surface}
      )
      returning id
    `)
    return { ok: true, courtId: result.rows[0].id as string }
  } catch (error) {
    // The branch was deleted between the guard and the write. Reported, not
    // thrown — the form says "that branch no longer exists".
    if (sqlStateOf(error) === PG_FOREIGN_KEY_VIOLATION) {
      return { ok: false, reason: 'branch_missing' }
    }
    throw error
  }
}

export type CourtWriteResult =
  | { ok: true; requeued: boolean }
  | { ok: false; reason: 'not_found' | 'no_operating_hours' | HoursFailure | BandsFailure }

/**
 * Court name, environment and surface.
 *
 * `environment` is the only key field of the three, so the re-queue is
 * conditional on it actually CHANGING — saving the form without touching the
 * radio must not knock an approved court off the market. The `for update`
 * lock on the pre-read is what makes "did it change?" trustworthy against a
 * concurrent edit: without it two simultaneous saves could both read the old
 * value and both decide nothing changed.
 *
 * Returning `{ ok: false }` from inside the transaction does NOT roll it
 * back in Drizzle — that is fine here and in the two functions below, because
 * every early return happens before any write.
 */
export async function updateCourtFields(input: {
  courtId: string
  fields: CourtFields
}): Promise<CourtWriteResult> {
  return db.transaction(
    async (tx) => {
      const before = await tx.execute(sql`
        select environment::text as environment from courts
        where id = ${input.courtId}::uuid
        for update
      `)
      if (before.rows.length === 0) return { ok: false as const, reason: 'not_found' as const }

      await tx.execute(sql`
        update courts set
          name = ${input.fields.name},
          surface = ${input.fields.surface},
          environment = ${input.fields.environment}::court_environment
        where id = ${input.courtId}::uuid
      `)

      if (before.rows[0].environment === input.fields.environment) {
        return { ok: true as const, requeued: false }
      }

      const requeued = await tx.execute(requeueCourtSql(input.courtId))
      return { ok: true as const, requeued: requeued.rows.length > 0 }
    },
    { isolationLevel: 'read committed' },
  )
}

/**
 * The court's whole week, replaced atomically.
 *
 * Delete-then-insert-then-re-queue in ONE transaction: a partially applied
 * week would leave the court open on days the owner just closed, and
 * court_operating_hours_unique_day means an insert-first strategy would
 * collide with the rows it is replacing.
 *
 * Deliberately does NOT check that the existing rate bands still tile the new
 * hours. Refusing here would deadlock the owner — the bands form validates
 * against the STORED hours, so they could not widen the bands first either.
 * The court is re-queued to `pending` (off every public surface, since public
 * reads filter to `approved`) and getListingCourt's `scheduleWarning` tells
 * them to fix the bands next.
 */
export async function replaceOperatingHours(input: {
  courtId: string
  days: OperatingHoursDay[]
}): Promise<CourtWriteResult> {
  // Re-validated here, not merely trusted from the action: this module is the
  // last thing between a caller and a 23514/23505 from the column CHECKs.
  const failure = validateOperatingHours(input.days)
  if (failure !== null) return { ok: false, reason: failure }

  return db.transaction(
    async (tx) => {
      const court = await tx.execute(sql`
        select id from courts where id = ${input.courtId}::uuid for update
      `)
      if (court.rows.length === 0) return { ok: false as const, reason: 'not_found' as const }

      await tx.execute(sql`
        delete from court_operating_hours where court_id = ${input.courtId}::uuid
      `)
      for (const day of input.days) {
        await tx.execute(sql`
          insert into court_operating_hours (court_id, day_of_week, opens_hour, closes_hour)
          values (${input.courtId}::uuid, ${day.dayOfWeek}, ${day.opensHour}, ${day.closesHour})
        `)
      }

      const requeued = await tx.execute(requeueCourtSql(input.courtId))
      return { ok: true as const, requeued: requeued.rows.length > 0 }
    },
    { isolationLevel: 'read committed' },
  )
}

/**
 * The court's whole price schedule, replaced atomically.
 *
 * The tiling check lives HERE and not in the pure parser because the span it
 * validates against — `[min(opens_hour), max(closes_hour)]` across the week —
 * is stored data. Read inside the same transaction as the write, behind the
 * court's `for update` lock, so a concurrent hours change cannot slip a
 * different span between the check and the insert.
 *
 * court_rate_bands_no_overlap would catch overlaps on its own (23P01), but
 * never gaps — supabase/migrations/20260801063910_listings.sql says so
 * explicitly — and a gap is the worse failure: it surfaces as priceSlots()
 * throwing "No rate band covers hour N" in the middle of a player's checkout.
 */
export async function replaceRateBands(input: {
  courtId: string
  bands: RateBand[]
}): Promise<CourtWriteResult> {
  if (input.bands.length === 0) return { ok: false, reason: 'no_bands' }
  const shapeFailure = validateBandShapes(input.bands)
  if (shapeFailure !== null) return { ok: false, reason: shapeFailure }

  return db.transaction(
    async (tx) => {
      const court = await tx.execute(sql`
        select id from courts where id = ${input.courtId}::uuid for update
      `)
      if (court.rows.length === 0) return { ok: false as const, reason: 'not_found' as const }

      const hours = await tx.execute(sql`
        select day_of_week, opens_hour, closes_hour from court_operating_hours
        where court_id = ${input.courtId}::uuid
      `)
      const span = operatingSpan(
        hours.rows.map((row) => ({
          dayOfWeek: Number(row.day_of_week),
          opensHour: Number(row.opens_hour),
          closesHour: Number(row.closes_hour),
        })),
      )
      if (span === null) return { ok: false as const, reason: 'no_operating_hours' as const }

      const failure = validateRateBands(input.bands, span)
      if (failure !== null) return { ok: false as const, reason: failure }

      await tx.execute(sql`
        delete from court_rate_bands where court_id = ${input.courtId}::uuid
      `)
      for (const band of input.bands) {
        await tx.execute(sql`
          insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
          values (
            ${input.courtId}::uuid, ${band.startHour}, ${band.endHour}, ${band.priceCentavos}
          )
        `)
      }

      const requeued = await tx.execute(requeueCourtSql(input.courtId))
      return { ok: true as const, requeued: requeued.rows.length > 0 }
    },
    { isolationLevel: 'read committed' },
  )
}
