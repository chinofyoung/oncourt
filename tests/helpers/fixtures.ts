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

export async function seedBranchWithCourts(courtCount = 2) {
  const ownerId = await seedPlayer()
  await db.execute(sql`update profiles set role = 'owner' where id = ${ownerId}::uuid`)

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

  await db.execute(sql`
    delete from bookings
    where player_id = any (${sql.param(ids)}::uuid[])
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
