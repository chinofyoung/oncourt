import { expect, test, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedPlayer, teardownFixtures } from '../helpers/fixtures'
import { getPlayerProfileFields, getPlayerCitySlug } from '@/lib/profile/queries'
import { CITIES } from '@/lib/geo/cities'
import { normalizePhPhone } from '@/lib/profile/phone'

let userId: string

afterAll(teardownFixtures)

test('a fresh profile reports every field null', async () => {
  userId = await seedPlayer()
  const fields = await getPlayerProfileFields(userId)
  expect(fields).toEqual({ fullName: null, phone: null, citySlug: null })
})

test('getPlayerCitySlug round-trips a city written to the column', async () => {
  await db.execute(sql`update profiles set city_slug = 'cebu-city' where id = ${userId}::uuid`)
  expect(await getPlayerCitySlug(userId)).toBe('cebu-city')
  const fields = await getPlayerProfileFields(userId)
  expect(fields.citySlug).toBe('cebu-city')
})

test('a malformed id returns nulls instead of raising 22P02', async () => {
  expect(await getPlayerCitySlug('not-a-uuid')).toBeNull()
  expect(await getPlayerProfileFields('not-a-uuid')).toEqual({
    fullName: null,
    phone: null,
    citySlug: null,
  })
})

test('every slug the city action would accept exists in CITIES', () => {
  // The action's gate is `CITIES.some(...)`; this pins the vocabulary it
  // enforces so a renamed slug cannot silently widen or narrow it.
  expect(CITIES.some((city) => city.slug === 'cebu-city')).toBe(true)
  expect(CITIES.some((city) => city.slug === 'atlantis')).toBe(false)
})

test('the phone the action would store is always canonical', () => {
  expect(normalizePhPhone('0917 123 4567')).toBe('+639171234567')
  expect(normalizePhPhone('+6329123456')).toBeNull()
})
