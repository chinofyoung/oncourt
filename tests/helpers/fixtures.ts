import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { ProcessorFeeBearer } from '@/lib/payments/fees'

// Tracks every auth.users id this test *file's* seedPlayer()/
// seedBranchWithCourts() calls have created during the current run, so
// teardownFixtures() can delete exactly what this run created and nothing
// else (final whole-branch review, MUST FIX #3: this shared, persistent
// hosted database has no `db reset` between runs, and only
// tests/schema/profiles.test.ts previously cleaned up after itself — every
// other file using these helpers left rows behind forever). This module-
// level array is the entire selection mechanism; teardownFixtures() never
// queries by slug pattern, email pattern, or "everything older than X" —
// only ids this module itself just created, so it can never touch
// smash-zone-marikina, task9-verify-smash-zone, or any other pre-existing
// row. State resets per test file: Vitest's default `isolate: true` gives
// each test file (and its setupFiles) a fresh module registry, so this
// array never leaks ids across files.
const createdUserIds: string[] = []

// Tracks every email_outbox id this test file's seedOutboxRow() calls have
// created during the current run, so teardownFixtures() can delete exactly
// what this run created and nothing else. This array is the entire
// selection mechanism for those rows, the same way createdUserIds is above
// — and it exists for a reason createdUserIds alone cannot cover: an outbox
// row with both booking_id and court_id null (e.g. a seedOutboxRow() call in
// a test that isn't exercising the booking/court FKs at all) traces back to
// no tracked booking and no tracked court, so the predicate-based
// email_outbox delete below — which finds rows via tracked bookings/courts —
// can never reach it. Without this array, that row is invisible to teardown
// and sits in the shared, persistent database forever.
const createdOutboxIds: string[] = []

export async function seedPlayer(): Promise<string> {
  const email = `player-${crypto.randomUUID()}@example.test`
  const result = await db.execute(sql`
    insert into auth.users (id, instance_id, aud, role, email)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated', ${email})
    returning id
  `)
  const id = result.rows[0].id as string
  createdUserIds.push(id)
  return id
}

/**
 * A player promoted to owner. Extracted because three call sites had this
 * exact two-step inline (tests/owner/queries.test.ts,
 * tests/branches/search.test.ts's seedBranchAt, and seedBranchWithCourts
 * below), and because the roles-and-staff slice adds more.
 *
 * Sets ONLY the role. business_name/slug stay null: the real promotion path
 * (promoteToOwner in src/lib/staff/write.ts) sets those, and a fixture that
 * silently filled them in would hide a query that depends on them.
 */
export async function seedOwner(): Promise<string> {
  const id = await seedPlayer()
  await db.execute(sql`update profiles set role = 'owner' where id = ${id}::uuid`)
  return id
}

/**
 * A player promoted to admin, by the same one-line role flip seedOwner() uses.
 *
 * Extracted for the same reason seedOwner() was: tests/auth/guards.test.ts has
 * its own private copy (it seeds auth.users directly and cannot use this
 * module), and tests/staff/write.test.ts had this exact two-step inline. The
 * admin surface needs an admin session in three more files.
 *
 * Sets ONLY the role. business_name/slug stay null — an admin is not an owner
 * and has no business identity, and filling those in would hide a query that
 * depends on them.
 */
export async function seedAdmin(): Promise<string> {
  const id = await seedPlayer()
  await db.execute(sql`update profiles set role = 'admin' where id = ${id}::uuid`)
  return id
}

export async function seedBranchWithCourts(courtCount = 2) {
  const ownerId = await seedOwner()

  const slug = 'fixture-' + crypto.randomUUID()
  const branch = await db.execute(sql`
    insert into branches (owner_id, name, slug, address, city, location)
    values (${ownerId}::uuid, 'Fixture Branch', ${slug},
            '1 Fixture St', 'Marikina',
            st_setsrid(st_makepoint(121.1029, 14.6507), 4326)::geography)
    returning id
  `)
  const branchId = branch.rows[0].id as string

  const courtIds: string[] = []
  for (let i = 1; i <= courtCount; i++) {
    const court = await db.execute(sql`
      insert into courts (branch_id, name, environment, status)
      values (${branchId}::uuid, ${'Court ' + i}, 'indoor', 'approved')
      returning id
    `)
    const courtId = court.rows[0].id as string
    courtIds.push(courtId)

    await db.execute(sql`
      insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos) values
        (${courtId}::uuid, 11, 15, 26500),
        (${courtId}::uuid, 15, 17, 31500),
        (${courtId}::uuid, 17, 24, 36500)
    `)
    for (let day = 0; day <= 6; day++) {
      await db.execute(sql`
        insert into court_operating_hours (court_id, day_of_week, opens_hour, closes_hour)
        values (${courtId}::uuid, ${day}, 11, 24)
      `)
    }
  }

  return { ownerId, branchId, slug, courtIds }
}

/**
 * A payment method for a manual-rail owner.
 *
 * No teardown tracking of its own: owner_payment_methods.owner_id is
 * ON DELETE CASCADE from profiles, so teardownFixtures()'s auth.users delete
 * already reaches it.
 */
export async function seedPaymentMethod(opts: {
  ownerId: string
  kind?: 'bank' | 'ewallet'
  institution?: string
  accountName?: string
  accountNumber?: string
  position?: number
}): Promise<string> {
  const result = await db.execute(sql`
    insert into owner_payment_methods
      (owner_id, kind, institution, account_name, account_number, position)
    values (
      ${opts.ownerId}::uuid,
      ${opts.kind ?? 'bank'}::payment_method_kind,
      ${opts.institution ?? 'BPI'},
      ${opts.accountName ?? 'Fixture Courts Inc'},
      ${opts.accountNumber ?? '1234567890'},
      ${opts.position ?? 0}
    )
    returning id
  `)
  return result.rows[0].id as string
}

/**
 * Deletes everything the current test file's seedPlayer()/
 * seedBranchWithCourts() calls created, in FK-safe order.
 *
 * bookings.court_id/branch_id/player_id are ON DELETE RESTRICT, not CASCADE
 * (bookings are financial records — see the trailing comment on
 * supabase/migrations/20260801070328_bookings.sql) — so any booking a test
 * inserted against a tracked user's branch/court, or directly against a
 * tracked player, must be deleted *first*. Deleting the tracked auth.users
 * rows before that would raise 23503, exactly like the real-world case this
 * schema is guarding against (tests/schema/bookings.test.ts pins that
 * behavior deliberately). Once bookings are cleared, deleting auth.users
 * cascades the rest for free: auth.users -> profiles -> branches -> courts
 * -> court_rate_bands / court_operating_hours / branch_photos / court_photos
 * (every one of those FKs is ON DELETE CASCADE).
 *
 * Call this from an `afterAll` in any test file that uses these helpers.
 * tests/setup.ts does it globally (via a dynamic import, so files that never
 * touch these helpers pay no cost and this module is a no-op for them).
 *
 * FK-safe order: email_outbox -> payout_bookings -> payouts -> reviews ->
 * manual_payment_proofs -> payments -> bookings -> auth.users.
 */
export async function teardownFixtures(): Promise<void> {
  // Two independent tracking arrays, two independent early-return guards
  // would be wrong here: a test file can call seedOutboxRow() without ever
  // calling seedPlayer()/seedBranchWithCourts() (e.g. a row with no
  // booking_id and no court_id, exercising nothing but the outbox table
  // itself), and the original `if (createdUserIds.length === 0) return`
  // would skip the outbox delete entirely in that case. Bail only when
  // BOTH arrays are empty.
  if (createdUserIds.length === 0 && createdOutboxIds.length === 0) return
  const ids = createdUserIds.splice(0, createdUserIds.length)
  const outboxIds = createdOutboxIds.splice(0, createdOutboxIds.length)

  // Must run before the predicate-based email_outbox delete just below (and
  // before everything else): this is the ONLY thing that reaches a row whose
  // booking_id and court_id are BOTH null — such a row traces back to no
  // tracked booking and no tracked court, so the predicate delete can never
  // find it. Deleted by id directly, not by predicate, which is why it needs
  // its own tracked array (createdOutboxIds) rather than reusing `ids`.
  if (outboxIds.length > 0) {
    await db.execute(sql`
      delete from email_outbox where id = any (${sql.param(outboxIds)}::uuid[])
    `)
  }

  // Must precede the bookings delete AND the auth.users cascade:
  // email_outbox.booking_id and .court_id are NO ACTION (RESTRICT), like
  // payout_bookings, payments and reviews. The booking predicate mirrors the
  // bookings delete below exactly, so no row can be missed by a row a later
  // statement removes; the court predicate reaches rows whose booking_id is
  // null (court_moderated emails).
  await db.execute(sql`
    delete from email_outbox
    where booking_id in (
        select id from bookings
        where player_id = any (${sql.param(ids)}::uuid[])
           or created_by = any (${sql.param(ids)}::uuid[])
           or branch_id in (
             select id from branches where owner_id = any (${sql.param(ids)}::uuid[])
           )
      )
       or court_id in (
        select c.id from courts c
        join branches b on b.id = c.branch_id
        where b.owner_id = any (${sql.param(ids)}::uuid[])
      )
  `)

  // Must precede BOTH the bookings delete and the auth.users delete:
  // payout_bookings.booking_id and .payout_id are NO ACTION (RESTRICT), for
  // the same reason payments and reviews are — a payout line is a financial
  // record. The booking predicate mirrors the bookings delete below exactly,
  // so no line can be missed by a row a later statement removes.
  await db.execute(sql`
    delete from payout_bookings
    where payout_id in (
        select id from payouts where owner_id = any (${sql.param(ids)}::uuid[])
      )
       or booking_id in (
        select id from bookings
        where player_id = any (${sql.param(ids)}::uuid[])
           or created_by = any (${sql.param(ids)}::uuid[])
           or branch_id in (
             select id from branches where owner_id = any (${sql.param(ids)}::uuid[])
           )
      )
  `)

  // payouts.owner_id is RESTRICT, so this must precede the auth.users delete.
  await db.execute(sql`
    delete from payouts where owner_id = any (${sql.param(ids)}::uuid[])
  `)

  // Must precede the bookings delete: reviews.booking_id is NO ACTION
  // (a booking is a financial record), so a surviving review blocks its
  // booking's deletion with 23503 — which would abort teardown and leak
  // every row this run created into the shared, persistent database.
  await db.execute(sql`
    delete from reviews
    where player_id = any (${sql.param(ids)}::uuid[])
       or branch_id in (
         select id from branches where owner_id = any (${sql.param(ids)}::uuid[])
       )
       or booking_id in (
         select id from bookings
         where player_id = any (${sql.param(ids)}::uuid[])
            or created_by = any (${sql.param(ids)}::uuid[])
            or branch_id in (
              select id from branches where owner_id = any (${sql.param(ids)}::uuid[])
            )
       )
  `)

  // Must precede the bookings delete, and the payments delete is the model:
  // manual_payment_proofs.booking_id is NO ACTION (RESTRICT) for the same
  // reason payments.booking_id is -- a proof is a financial record.
  await db.execute(sql`
    delete from manual_payment_proofs
    where booking_id in (
      select id from bookings
      where player_id = any (${sql.param(ids)}::uuid[])
         or created_by = any (${sql.param(ids)}::uuid[])
         or branch_id in (
           select id from branches where owner_id = any (${sql.param(ids)}::uuid[])
         )
    )
  `)

  // Must precede the bookings delete for the same reason the reviews delete
  // does: payments.booking_id is RESTRICT (a payment is a financial record),
  // so a surviving payment blocks its booking's deletion with 23503 — which
  // would abort teardown and leak every row this run created into the shared,
  // persistent database. The predicate mirrors the bookings delete below
  // exactly, so no payment can be missed by a row the next statement removes.
  await db.execute(sql`
    delete from payments
    where booking_id in (
      select id from bookings
      where player_id = any (${sql.param(ids)}::uuid[])
         or created_by = any (${sql.param(ids)}::uuid[])
         or branch_id in (
           select id from branches where owner_id = any (${sql.param(ids)}::uuid[])
         )
    )
  `)

  // `created_by` is in this predicate for a hard reason, not for tidiness:
  // bookings.created_by carries no `on delete` clause, so it is RESTRICT. A
  // `blocked` row created by a tracked user has a NULL player_id and may sit
  // under a branch this run did not create, so neither of the other two
  // clauses reaches it — and the `delete from auth.users` below would then
  // raise 23503, aborting teardown and leaking the whole run's rows into this
  // shared, persistent database.
  await db.execute(sql`
    delete from bookings
    where player_id = any (${sql.param(ids)}::uuid[])
       or created_by = any (${sql.param(ids)}::uuid[])
       or branch_id in (
         select id from branches where owner_id = any (${sql.param(ids)}::uuid[])
       )
  `)

  await db.execute(sql`
    delete from auth.users where id = any (${sql.param(ids)}::uuid[])
  `)
}

/** Manila is UTC+8 with no DST, so a fixed offset is correct and stable. */
export function manilaHour(date: string, hour: number): Date {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+08:00`)
}

/**
 * Inserts a booking directly, bypassing the hold/pricing path — these tests
 * are about reads, not about how a booking comes to exist.
 *
 * No teardown tracking of its own: the caller's court/branch/player all come
 * from seedPlayer()/seedBranchWithCourts(), and teardownFixtures() already
 * deletes bookings by tracked player_id and by branches under tracked owners
 * before deleting the users themselves (bookings' FKs are RESTRICT, so that
 * ordering is required).
 *
 * Callers must choose non-overlapping hours per court: bookings_no_overlap is
 * an exclusion constraint, and two bookings on one court at one hour raise
 * 23P01.
 */
export async function seedBooking(opts: {
  courtId: string
  branchId: string
  playerId: string
  startsAt: Date
  hours?: number
  status?:
    | 'pending_payment'
    | 'pending_verification'
    | 'confirmed'
    | 'completed'
    | 'expired'
    | 'refunded_manual'
  totalCentavos?: number
  /**
   * Explicit override for the hold clock. Payments tests need three shapes the
   * default cannot express: a hold expiring in the future (the checkout happy
   * path), a hold that already expired but has not been swept (the sweep race),
   * and `null` for any non-hold status. Left undefined, the previous behavior
   * is preserved exactly — now + 15 minutes for `pending_payment`, null
   * otherwise — so every existing caller is unaffected.
   */
  expiresAt?: Date | null
  /**
   * Who bears the processor fee. Left undefined, defaults to 'platform' —
   * the previous, only behavior this fixture produced. Added for the earnings
   * follow-up (owner earnings table Processor fee column): every non-platform
   * bearer needs a seeded booking whose money columns actually reflect that
   * bearer, matching src/lib/payments/fees.ts's computeFees() shape, so
   * queries reading those columns (getOwnerEarnings) have something real to
   * sum.
   */
  bearer?: ProcessorFeeBearer
  /**
   * The processor's cut, in centavos. Left undefined, defaults to 0 — the
   * previous, only value this fixture produced. Non-zero only makes sense
   * paired with a non-'platform' bearer; passing it alongside the default
   * 'platform' bearer is allowed (computeFees documents platform's own
   * retained margin absorbing it) but does not change total_charged or
   * owner_net, matching computeFees' 'platform' branch.
   */
  processorFeeCentavos?: number
}): Promise<string> {
  const hours = opts.hours ?? 1
  const endsAt = new Date(opts.startsAt.getTime() + hours * 3_600_000)
  const status = opts.status ?? 'completed'
  // The court fee. Named `total` (not `courtFee`) to preserve every existing
  // caller's field name (`totalCentavos`) exactly — it only equals
  // total_charged_centavos for the 'platform' and 'owner' bearers, matching
  // computeFees(): only the 'player' bearer grosses total_charged up above it.
  const total = opts.totalCentavos ?? 30000
  const platformFee = Math.round(total * 0.1)
  const bearer = opts.bearer ?? 'platform'
  const processorFee = opts.processorFeeCentavos ?? 0
  // pending_payment is the only status the CHECK constraint
  // (bookings_hold_has_expiry) requires an expires_at for.
  const expiresAt =
    opts.expiresAt !== undefined
      ? opts.expiresAt
      : status === 'pending_payment'
        ? new Date(Date.now() + 900_000)
        : null

  // Mirrors src/lib/payments/fees.ts's computeFees() bearer branches exactly
  // (with processorFee taken as a direct input rather than derived from a
  // processor_rates row, since these fixtures seed a finished, already-priced
  // booking, not a live checkout quote):
  //   'player'   grosses total_charged up by the processor fee; owner_net is
  //              untouched by it.
  //   'owner'    total_charged stays at the court fee; the processor fee comes
  //              out of owner_net.
  //   'platform' (default) total_charged stays at the court fee; owner_net is
  //              untouched — the processor fee comes out of the platform's own
  //              retained margin, not out of anything stored on this row.
  const transactionFee = bearer === 'player' ? processorFee : 0
  const totalCharged = bearer === 'player' ? total + processorFee : total
  const ownerNet = bearer === 'owner' ? total - platformFee - processorFee : total - platformFee

  const result = await db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status, expires_at,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
      fee_config_snapshot
    ) values (
      ${opts.courtId}::uuid, ${opts.branchId}::uuid, ${opts.playerId}::uuid,
      ${opts.startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz,
      ${status}::booking_status, ${expiresAt ? expiresAt.toISOString() : null}::timestamptz,
      ${total}, ${transactionFee}, ${totalCharged}, ${platformFee}, ${processorFee}, ${ownerNet},
      ${JSON.stringify({ mode: 'percentage', value: 1000, bearer, holdMinutes: 15 })}::jsonb
    )
    returning id
  `)
  return result.rows[0].id as string
}

/**
 * A `payments` row, for tests that need a checkout session to already exist.
 *
 * No teardown tracking of its own: teardownFixtures() deletes payments by
 * booking_id for every booking it is about to delete (added in this task, and
 * REQUIRED — payments.booking_id is RESTRICT, so a surviving payment would
 * abort the bookings delete with 23503 and leak the whole run's rows into this
 * shared, persistent database).
 *
 * `sessionId` defaults to a fresh unique value rather than a fixed literal:
 * the webhook resolves rows by provider_session_id, and two tests sharing a
 * literal on a persistent database would resolve each other's rows.
 */
export async function seedPayment(opts: {
  bookingId: string
  sessionId?: string
  paymentId?: string | null
  paymentMethod?: string
  amountCentavos: number
  processorFeeCentavos?: number
  status?: 'pending' | 'paid' | 'failed'
}): Promise<string> {
  const result = await db.execute(sql`
    insert into payments (
      booking_id, provider_session_id, provider_payment_id, payment_method,
      amount_centavos, processor_fee_centavos, status
    ) values (
      ${opts.bookingId}::uuid,
      ${opts.sessionId ?? 'cs_test_' + crypto.randomUUID()},
      ${opts.paymentId ?? null},
      ${opts.paymentMethod ?? 'gcash'},
      ${opts.amountCentavos}, ${opts.processorFeeCentavos ?? 0},
      ${opts.status ?? 'pending'}::payment_status
    )
    returning id
  `)
  return result.rows[0].id as string
}

/**
 * A `payouts` row. Defaults describe a plausible prepared payout; every field
 * is overridable because the schema tests exist specifically to push each
 * constraint over its edge.
 *
 * No teardown tracking of its own: teardownFixtures() deletes payouts by
 * tracked owner_id, and payout_bookings before them (both FKs are RESTRICT).
 */
export async function seedPayout(opts: {
  ownerId: string
  netCentavos?: number
  grossCentavos?: number
  periodStart?: string
  periodEnd?: string
  status?: 'pending' | 'paid'
}): Promise<string> {
  const net = opts.netCentavos ?? 50000
  const gross = opts.grossCentavos ?? net + 5000
  const status = opts.status ?? 'pending'
  const result = await db.execute(sql`
    insert into payouts (
      owner_id, period_start, period_end,
      gross_centavos, fee_centavos, net_centavos, status, paid_at
    ) values (
      ${opts.ownerId}::uuid,
      ${opts.periodStart ?? '2026-08-01'}::date,
      ${opts.periodEnd ?? '2026-08-07'}::date,
      ${gross}, ${gross - net}, ${net}, ${status}::payout_status,
      ${status === 'paid' ? new Date().toISOString() : null}::timestamptz
    )
    returning id
  `)
  return result.rows[0].id as string
}

/** A single `payout_bookings` line. Sign is the caller's responsibility. */
export async function seedPayoutLine(opts: {
  payoutId: string
  bookingId: string
  kind: 'payment' | 'clawback'
  netCentavos: number
}): Promise<void> {
  await db.execute(sql`
    insert into payout_bookings (booking_id, kind, payout_id, net_centavos)
    values (${opts.bookingId}::uuid, ${opts.kind}::payout_line_kind,
            ${opts.payoutId}::uuid, ${opts.netCentavos})
  `)
}

/**
 * An `email_outbox` row. Defaults describe a plausible pending receipt; every
 * field is overridable because the schema and drain tests exist specifically
 * to push each one over its edge.
 *
 * Tracked by id in createdOutboxIds, in addition to whatever booking/court
 * predicate reach teardownFixtures()'s other delete gives it: a call with
 * neither bookingId nor courtId set (a bare queue-count fixture, or a
 * court_moderated row whose court is never seeded) has no predicate that
 * reaches it at all, and would otherwise leak into this shared, persistent
 * database forever.
 */
export async function seedOutboxRow(opts: {
  kind: string
  recipient?: string
  payload?: object
  bookingId?: string | null
  courtId?: string | null
  status?: 'pending' | 'sent' | 'failed'
  attempts?: number
  nextAttemptAt?: Date
}): Promise<string> {
  const status = opts.status ?? 'pending'
  const result = await db.execute(sql`
    insert into email_outbox (
      kind, recipient, payload, booking_id, court_id,
      status, attempts, next_attempt_at, sent_at
    ) values (
      ${opts.kind}::email_kind,
      ${opts.recipient ?? `player-${crypto.randomUUID()}@example.test`},
      ${JSON.stringify(opts.payload ?? { placeholder: true })}::jsonb,
      ${opts.bookingId ?? null}::uuid,
      ${opts.courtId ?? null}::uuid,
      ${status}::email_status,
      ${opts.attempts ?? 0},
      ${(opts.nextAttemptAt ?? new Date()).toISOString()}::timestamptz,
      ${status === 'sent' ? new Date().toISOString() : null}::timestamptz
    )
    returning id
  `)
  const id = result.rows[0].id as string
  createdOutboxIds.push(id)
  return id
}

/**
 * Inserts a `blocked` booking — an owner/staff block or walk-in.
 *
 * Separate from seedBooking() rather than a widened `status` option because
 * the column shape genuinely differs, and the database now enforces every
 * difference: player_id must be null (bookings_player_unless_blocked),
 * created_by must be set (bookings_blocked_has_creator), fee_config_snapshot
 * must be null (bookings_snapshot_unless_blocked), and every money column must
 * be 0 (bookings_blocked_is_free). A single helper covering both would make
 * `playerId` optional for every existing seedBooking() caller.
 *
 * `createdBy` is any profile id — there is no DB constraint tying it to the
 * branch's owner or staff. That rule lives in the server action
 * (requireBranchAccess), which is why these tests can and do pass an owner id
 * directly.
 *
 * No teardown tracking of its own: teardownFixtures() deletes bookings by
 * tracked player_id, by branches under tracked owners, AND by tracked
 * created_by (added in Step 3) — the last of which is required, because
 * bookings.created_by is RESTRICT and a surviving block would otherwise abort
 * the auth.users delete with 23503.
 *
 * Callers must choose non-overlapping hours per court: bookings_no_overlap now
 * includes 'blocked' in its predicate, so a block over a booking (or another
 * block) on one court raises 23P01.
 */
export async function seedBlock(opts: {
  courtId: string
  branchId: string
  createdBy: string
  startsAt: Date
  hours?: number
  note?: string | null
}): Promise<string> {
  const hours = opts.hours ?? 1
  const endsAt = new Date(opts.startsAt.getTime() + hours * 3_600_000)

  const result = await db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status, created_by, note,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
      fee_config_snapshot
    ) values (
      ${opts.courtId}::uuid, ${opts.branchId}::uuid, null,
      ${opts.startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz,
      'blocked'::booking_status, ${opts.createdBy}::uuid, ${opts.note ?? null},
      0, 0, 0, 0, 0, 0, null::jsonb
    )
    returning id
  `)
  return result.rows[0].id as string
}

/**
 * A branch_staff grant. At least one permission must be true — the
 * branch_staff_some_permission CHECK rejects an all-false row — so callers
 * always pass at least one flag. Defaults are all false so a caller states
 * exactly the permissions the test is about, which is what makes the
 * requireBranchAccess matrix tests readable.
 *
 * No teardown tracking: branch_staff.branch_id and .user_id both CASCADE, so
 * deleting the tracked auth.users rows reclaims these for free.
 */
export async function seedStaffGrant(opts: {
  branchId: string
  userId: string
  viewBookings?: boolean
  blockSlots?: boolean
  manageCourts?: boolean
  viewEarnings?: boolean
}): Promise<string> {
  const result = await db.execute(sql`
    insert into branch_staff (
      branch_id, user_id, view_bookings, block_slots, manage_courts, view_earnings
    ) values (
      ${opts.branchId}::uuid, ${opts.userId}::uuid,
      ${opts.viewBookings ?? false}, ${opts.blockSlots ?? false},
      ${opts.manageCourts ?? false}, ${opts.viewEarnings ?? false}
    )
    returning id
  `)
  return result.rows[0].id as string
}
