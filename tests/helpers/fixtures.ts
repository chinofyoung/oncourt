import { sql } from 'drizzle-orm'
import { db } from '@/db'

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
 */
export async function teardownFixtures(): Promise<void> {
  if (createdUserIds.length === 0) return
  const ids = createdUserIds.splice(0, createdUserIds.length)

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
  status?: 'pending_payment' | 'confirmed' | 'completed'
  totalCentavos?: number
}): Promise<string> {
  const hours = opts.hours ?? 1
  const endsAt = new Date(opts.startsAt.getTime() + hours * 3_600_000)
  const status = opts.status ?? 'completed'
  const total = opts.totalCentavos ?? 30000
  const platformFee = Math.round(total * 0.1)
  // pending_payment is the only status the CHECK constraint
  // (bookings_hold_has_expiry) requires an expires_at for.
  const expiresAt = status === 'pending_payment' ? new Date(Date.now() + 900_000) : null

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
      ${total}, 0, ${total}, ${platformFee}, 0, ${total - platformFee},
      '{"test": true}'::jsonb
    )
    returning id
  `)
  return result.rows[0].id as string
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
