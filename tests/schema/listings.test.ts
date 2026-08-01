import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

// Final whole-branch review, MUST FIX #3: this file seeds its own
// auth.users/branches/courts rows directly (not via
// tests/helpers/fixtures.ts) and previously never cleaned them up, leaking
// rows (visible live as `smash-*`-slugged branches) into the shared hosted
// database on every run. Tracked here and swept in the `afterAll` below. No
// bookings are ever created against these fixtures, so a plain cascading
// delete on auth.users (-> profiles -> branches -> courts -> rate
// bands/operating hours) is sufficient — no bookings.*_id RESTRICT to work
// around, unlike tests/schema/bookings.test.ts.
const createdUserIds: string[] = []

afterAll(async () => {
  if (createdUserIds.length === 0) return
  await db.execute(sql`delete from auth.users where id = any (${sql.param(createdUserIds)}::uuid[])`)
})

async function seedOwnerAndBranch() {
  const email = `owner-${crypto.randomUUID()}@example.test`
  const user = await db.execute(sql`
    insert into auth.users (id, instance_id, aud, role, email)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated', ${email})
    returning id
  `)
  const ownerId = user.rows[0].id as string
  createdUserIds.push(ownerId)
  await db.execute(sql`update profiles set role = 'owner' where id = ${ownerId}::uuid`)

  const branch = await db.execute(sql`
    insert into branches (owner_id, name, slug, address, city, location, amenities)
    values (${ownerId}::uuid, 'Smash Zone Marikina', ${'smash-' + crypto.randomUUID()},
            '123 Sample St', 'Marikina',
            st_setsrid(st_makepoint(121.1029, 14.6507), 4326)::geography,
            array['parking', 'showers'])
    returning id
  `)
  return { ownerId, branchId: branch.rows[0].id as string }
}

async function seedCourt(branchId: string) {
  const court = await db.execute(sql`
    insert into courts (branch_id, name, environment, status)
    values (${branchId}::uuid, 'Court 1', 'indoor', 'approved')
    returning id
  `)
  return court.rows[0].id as string
}

test('a branch stores a geography point that supports distance queries', async () => {
  const { branchId } = await seedOwnerAndBranch()
  const result = await db.execute(sql`
    select st_distance(location, st_setsrid(st_makepoint(121.0437, 14.6760), 4326)::geography) as metres
    from branches where id = ${branchId}::uuid
  `)
  const metres = Number(result.rows[0].metres)
  // Marikina to central Quezon City is roughly 7-9 km.
  expect(metres).toBeGreaterThan(5_000)
  expect(metres).toBeLessThan(15_000)
})

test('rate bands on the same court cannot overlap', async () => {
  const { branchId } = await seedOwnerAndBranch()
  const courtId = await seedCourt(branchId)

  await db.execute(sql`
    insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
    values (${courtId}::uuid, 11, 15, 26500)
  `)

  // 14-17 overlaps 11-15.
  // drizzle-orm 0.45.2's db.execute() wraps the driver's pg error in a
  // DrizzleQueryError and only sets it as `.cause` (it doesn't spread pg's
  // `code`/`constraint`/etc. onto the outer rejection), so the SQLSTATE has
  // to be asserted on `cause`, not the rejection itself.
  await expect(
    db.execute(sql`
      insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
      values (${courtId}::uuid, 14, 17, 31500)
    `),
  ).rejects.toMatchObject({ cause: { code: '23P01' } })

  // 15-17 is adjacent, not overlapping — must be allowed.
  await db.execute(sql`
    insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
    values (${courtId}::uuid, 15, 17, 31500)
  `)
  const bands = await db.execute(
    sql`select count(*)::int as n from court_rate_bands where court_id = ${courtId}::uuid`,
  )
  expect(bands.rows[0].n).toBe(2)
})

test('rate bands reject an inverted or out-of-range hour span', async () => {
  const { branchId } = await seedOwnerAndBranch()
  const courtId = await seedCourt(branchId)

  await expect(
    db.execute(sql`
      insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
      values (${courtId}::uuid, 17, 11, 26500)
    `),
  ).rejects.toThrow()

  await expect(
    db.execute(sql`
      insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
      values (${courtId}::uuid, 11, 25, 26500)
    `),
  ).rejects.toThrow()
})

test('a court has at most one operating-hours row per weekday', async () => {
  const { branchId } = await seedOwnerAndBranch()
  const courtId = await seedCourt(branchId)

  await db.execute(sql`
    insert into court_operating_hours (court_id, day_of_week, opens_hour, closes_hour)
    values (${courtId}::uuid, 1, 11, 24)
  `)
  await expect(
    db.execute(sql`
      insert into court_operating_hours (court_id, day_of_week, opens_hour, closes_hour)
      values (${courtId}::uuid, 1, 9, 22)
    `),
  ).rejects.toThrow()
})

test('every foreign key in the listing tables is indexed', async () => {
  const result = await db.execute(sql`
    select conrelid::regclass::text as table_name, a.attname as fk_column
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.contype = 'f'
      and connamespace = 'public'::regnamespace
      and not exists (
        select 1 from pg_index i
        where i.indrelid = c.conrelid and a.attnum = i.indkey[0]
      )
    order by 1, 2
  `)
  expect(result.rows).toEqual([])
})
