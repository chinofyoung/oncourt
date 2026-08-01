import { expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

async function createAuthUser(email: string) {
  const result = await db.execute(sql`
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', ${email},
            ${JSON.stringify({ full_name: 'Test Player', avatar_url: 'https://example.test/a.png' })}::jsonb)
    returning id
  `)
  return result.rows[0].id as string
}

test('a new auth user automatically gets a player profile', async () => {
  const email = `player-${Date.now()}@example.test`
  const userId = await createAuthUser(email)

  try {
    const result = await db.execute(
      sql`select id, email, role, full_name, avatar_url from profiles where id = ${userId}::uuid`,
    )
    expect(result.rows[0]).toMatchObject({
      id: userId,
      email,
      role: 'player',
      full_name: 'Test Player',
      avatar_url: 'https://example.test/a.png',
    })
  } finally {
    // Final whole-branch review, ALSO FIX #3 follow-up: this test never
    // cleaned up its own auth.users/profiles row (unlike the "cascades"
    // and "slug" tests below it in this file), leaking one row into this
    // shared, persistent database on every run. try/finally so cleanup
    // still runs even if the assertion above fails.
    await db.execute(sql`delete from auth.users where id = ${userId}::uuid`)
  }
})

test('deleting an auth user cascades to the profile', async () => {
  const userId = await createAuthUser(`cascade-${Date.now()}@example.test`)
  await db.execute(sql`delete from auth.users where id = ${userId}::uuid`)

  const result = await db.execute(sql`select 1 from profiles where id = ${userId}::uuid`)
  expect(result.rows).toHaveLength(0)
})

test('fee override mode and value must both be set or both be null', async () => {
  const userId = await createAuthUser(`fees-${Date.now()}@example.test`)

  try {
    // Only one of the pair — must be rejected.
    await expect(
      db.execute(sql`update profiles set platform_fee_mode = 'flat' where id = ${userId}::uuid`),
    ).rejects.toThrow()

    // Both together — allowed.
    await db.execute(sql`
      update profiles set platform_fee_mode = 'flat', platform_fee_value = 5000
      where id = ${userId}::uuid
    `)
    const result = await db.execute(
      sql`select platform_fee_value from profiles where id = ${userId}::uuid`,
    )
    expect(result.rows[0].platform_fee_value).toBe(5000)
  } finally {
    // Final whole-branch review, ALSO FIX #3 follow-up: same un-cleaned
    // leak as the test above — this row was never deleted either.
    await db.execute(sql`delete from auth.users where id = ${userId}::uuid`)
  }
})

test('slug is unique but may be null for non-owners', async () => {
  const a = await createAuthUser(`slug-a-${Date.now()}@example.test`)
  const b = await createAuthUser(`slug-b-${Date.now()}@example.test`)

  try {
    // Two null slugs coexist.
    const nulls = await db.execute(
      sql`select count(*)::int as n from profiles where id in (${a}::uuid, ${b}::uuid) and slug is null`,
    )
    expect(nulls.rows[0].n).toBe(2)

    // Randomized per run, like the emails above -- not the fixed literal
    // 'smash-zone' this test originally used. That literal started colliding
    // for real once Task 10's seed (supabase/seed.sql) permanently gave the
    // seeded owner profile `slug = 'smash-zone'`: this test's own cleanup
    // below only ever deletes the two throwaway profiles it creates, so a
    // fixed literal shared with a real, permanent seed row fails here every
    // run, not just on a second run of this test. Randomizing removes the
    // fragility outright rather than picking a different one-off fixed
    // string that could collide with some future seed too.
    const testSlug = `test-slug-${crypto.randomUUID()}`
    await db.execute(sql`update profiles set slug = ${testSlug} where id = ${a}::uuid`)
    await expect(
      db.execute(sql`update profiles set slug = ${testSlug} where id = ${b}::uuid`),
    ).rejects.toThrow()
  } finally {
    // Final whole-branch review, ALSO FIX #3 follow-up: moved into
    // try/finally so an unexpected failure in the assertions above (or a
    // future edit to them) can't leak just one half of the pair — observed
    // live: a leaked `slug-b-*` row with no matching `slug-a-*` from the
    // same run, from exactly this kind of asymmetric failure. Even though
    // the slug is now randomized, the two profile rows themselves are still
    // throwaway fixtures that must not accumulate on this shared,
    // persistent database (no reset between runs here). Deleting the
    // auth.users rows cascades to profiles.
    await db.execute(sql`delete from auth.users where id in (${a}::uuid, ${b}::uuid)`)
  }
})
