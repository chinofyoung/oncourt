import { afterAll, expect, test } from 'vitest'
import { seedPlayer, teardownFixtures } from '../helpers/fixtures'
import { getPlayerProfileFields } from '@/lib/profile/queries'
import { NAME_MAX, setCitySlug, setFullName, setPhone } from '@/lib/profile/write'

afterAll(teardownFixtures)

// -------------------------------------------------------------- setFullName

test('setFullName trims and stores a valid name', async () => {
  const playerId = await seedPlayer()
  await expect(setFullName(playerId, '  Juan Dela Cruz  ')).resolves.toEqual({ ok: true })
  await expect(getPlayerProfileFields(playerId)).resolves.toMatchObject({
    fullName: 'Juan Dela Cruz',
  })
})

test('setFullName rejects an empty or whitespace-only name, and writes nothing', async () => {
  const playerId = await seedPlayer()

  for (const raw of ['', '   ', '\n\t ']) {
    await expect(setFullName(playerId, raw)).resolves.toEqual({
      ok: false,
      error: 'Enter your name.',
    })
  }
  await expect(getPlayerProfileFields(playerId)).resolves.toMatchObject({ fullName: null })
})

test('setFullName rejects a name over NAME_MAX, and writes nothing', async () => {
  const playerId = await seedPlayer()

  await expect(setFullName(playerId, 'x'.repeat(NAME_MAX + 1))).resolves.toEqual({
    ok: false,
    error: `Keep your name under ${NAME_MAX} characters.`,
  })
  await expect(getPlayerProfileFields(playerId)).resolves.toMatchObject({ fullName: null })

  // The cap itself is accepted — this pins the boundary as inclusive.
  await expect(setFullName(playerId, 'x'.repeat(NAME_MAX))).resolves.toEqual({ ok: true })
})

test('setFullName rejects a non-string (a File coerces to "[object File]" otherwise)', async () => {
  const playerId = await seedPlayer()
  const file = new File(['x'], 'x.txt')

  await expect(setFullName(playerId, file)).resolves.toEqual({
    ok: false,
    error: 'Enter your name.',
  })
  await expect(getPlayerProfileFields(playerId)).resolves.toMatchObject({ fullName: null })
})

// ----------------------------------------------------------------- setPhone

test('setPhone stores the normalized form, not what was typed', async () => {
  const playerId = await seedPlayer()
  await expect(setPhone(playerId, '0917 123 4567')).resolves.toEqual({ ok: true })
  await expect(getPlayerProfileFields(playerId)).resolves.toMatchObject({
    phone: '+639171234567',
  })
})

test('setPhone rejects a non-PH-mobile, and writes nothing', async () => {
  const playerId = await seedPlayer()

  await expect(setPhone(playerId, '+6329123456')).resolves.toEqual({
    ok: false,
    error: 'Enter a Philippine mobile number, like 0917 123 4567.',
  })
  await expect(getPlayerProfileFields(playerId)).resolves.toMatchObject({ phone: null })
})

// -------------------------------------------------------------- setCitySlug

test('setCitySlug stores a slug that is in CITIES', async () => {
  const playerId = await seedPlayer()
  await expect(setCitySlug(playerId, 'cebu-city')).resolves.toEqual({ ok: true })
  await expect(getPlayerProfileFields(playerId)).resolves.toMatchObject({
    citySlug: 'cebu-city',
  })
})

test('setCitySlug rejects a slug outside CITIES, and writes nothing', async () => {
  const playerId = await seedPlayer()

  await expect(setCitySlug(playerId, 'atlantis')).resolves.toEqual({
    ok: false,
    error: 'Pick a city from the list.',
  })
  await expect(getPlayerProfileFields(playerId)).resolves.toMatchObject({ citySlug: null })
})

// ------------------------------------------------------------- id scoping

test('each write touches ONLY the player id it was given, never another player', async () => {
  // Two players, so this test is meaningful: writing to the first must leave
  // the second's row untouched. This stands in for the authorization contract
  // the whole module assumes — that `playerId` always came from the guard,
  // never from the same request's form data.
  const first = await seedPlayer()
  const second = await seedPlayer()

  await setFullName(first, 'First Player')
  await setPhone(first, '0917 123 4567')
  await setCitySlug(first, 'cebu-city')

  await expect(getPlayerProfileFields(second)).resolves.toEqual({
    fullName: null,
    phone: null,
    citySlug: null,
  })
})
