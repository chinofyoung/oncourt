import { expect, test } from 'vitest'
import {
  BRANCH_FIELDS_FAILURE_MESSAGES,
  COURT_FIELDS_FAILURE_MESSAGES,
  isInPhilippines,
  MAX_BRANCH_NAME,
  parseBranchFields,
  parseCourtFields,
  slugifyBranchName,
} from '@/lib/listings/fields'
import { AMENITY_SLUGS } from '@/components/ui/amenity-chip'

/** The minimum a branch form must supply for the required-field checks to pass. */
function branchForm(
  overrides: Record<string, string> = {},
  amenities: string[] = [],
): FormData {
  const data = new FormData()
  data.set('name', 'Smash Zone Marikina')
  data.set('address', '12 Shoe Ave')
  data.set('city', 'Marikina')
  for (const [key, value] of Object.entries(overrides)) data.set(key, value)
  for (const amenity of amenities) data.append('amenities', amenity)
  return data
}

function courtForm(overrides: Record<string, string> = {}): FormData {
  const data = new FormData()
  data.set('name', 'Court 1')
  data.set('environment', 'indoor')
  for (const [key, value] of Object.entries(overrides)) data.set(key, value)
  return data
}

// ------------------------------------------------------------ branch fields

test('parseBranchFields accepts the minimum required fields', () => {
  expect(parseBranchFields(branchForm())).toEqual({
    ok: true,
    fields: {
      name: 'Smash Zone Marikina',
      description: null,
      address: '12 Shoe Ave',
      city: 'Marikina',
      contactPhone: null,
      contactEmail: null,
      amenities: [],
      lat: null,
      lng: null,
    },
  })
})

test('parseBranchFields trims every text field and normalizes blanks to null', () => {
  // '' and null are two representations of "no phone number"; the column is
  // nullable, so only one of them should ever reach it.
  const result = parseBranchFields(
    branchForm({
      name: '  Smash Zone  ',
      description: '   ',
      contactPhone: '  ',
      contactEmail: '   ',
    }),
  )
  expect(result).toEqual({
    ok: true,
    fields: {
      name: 'Smash Zone',
      description: null,
      address: '12 Shoe Ave',
      city: 'Marikina',
      contactPhone: null,
      contactEmail: null,
      amenities: [],
      lat: null,
      lng: null,
    },
  })
})

test('parseBranchFields rejects a missing or whitespace-only name, address, or city', () => {
  expect(parseBranchFields(branchForm({ name: '   ' }))).toEqual({
    ok: false,
    reason: 'missing_name',
  })
  expect(parseBranchFields(branchForm({ address: '' }))).toEqual({
    ok: false,
    reason: 'missing_address',
  })
  expect(parseBranchFields(branchForm({ city: '' }))).toEqual({
    ok: false,
    reason: 'missing_city',
  })
})

test('parseBranchFields rejects an over-long field', () => {
  expect(parseBranchFields(branchForm({ name: 'x'.repeat(MAX_BRANCH_NAME + 1) }))).toEqual({
    ok: false,
    reason: 'too_long',
  })
})

test('parseBranchFields accepts a well-formed contact email', () => {
  const result = parseBranchFields(branchForm({ contactEmail: 'desk@smashzone.ph' }))
  expect(result).toMatchObject({ ok: true, fields: { contactEmail: 'desk@smashzone.ph' } })
})

test('parseBranchFields rejects an obviously malformed contact email', () => {
  // Deliberately loose, same rule as src/lib/staff/write.ts's EMAIL_RE: one
  // '@' with something either side and a dot in the domain. It only has to
  // reject input that is not an address at all.
  for (const contactEmail of ['desk', 'desk@', '@smashzone.ph', 'desk@smashzone']) {
    expect(parseBranchFields(branchForm({ contactEmail }))).toEqual({
      ok: false,
      reason: 'invalid_email',
    })
  }
})

test('parseBranchFields accepts every amenity in the search vocabulary', () => {
  const result = parseBranchFields(branchForm({}, [...AMENITY_SLUGS]))
  expect(result).toMatchObject({ ok: true, fields: { amenities: [...AMENITY_SLUGS] } })
})

test('parseBranchFields rejects an amenity outside the vocabulary', () => {
  // branches.amenities is a bare text[] with no constraint, and the search
  // filter (`b.amenities @> $`) can only ever match slugs it renders a chip
  // for — so an off-vocabulary value would be stored, displayed as a
  // hyphen-stripped fallback, and unfilterable forever.
  expect(parseBranchFields(branchForm({}, ['parking', 'helipad']))).toEqual({
    ok: false,
    reason: 'invalid_amenity',
  })
})

test('parseBranchFields rejects a duplicated amenity', () => {
  expect(parseBranchFields(branchForm({}, ['parking', 'parking']))).toEqual({
    ok: false,
    reason: 'invalid_amenity',
  })
})

test('parseBranchFields accepts a coordinate inside the Philippines', () => {
  const result = parseBranchFields(branchForm({ lat: '14.6507', lng: '121.1029' }))
  expect(result).toMatchObject({ ok: true, fields: { lat: 14.6507, lng: 121.1029 } })
})

test('parseBranchFields rejects a pin at 0,0', () => {
  // The mis-dragged-pin case the spec calls out by name: Null Island is off
  // the coast of Ghana, and a branch there is invisible in every radius
  // search while looking perfectly saved.
  expect(parseBranchFields(branchForm({ lat: '0', lng: '0' }))).toEqual({
    ok: false,
    reason: 'invalid_location',
  })
})

test('parseBranchFields rejects a coordinate outside the Philippines', () => {
  // Swapped lat/lng is the common form of this mistake: 121.1, 14.65 is a
  // latitude that does not exist.
  expect(parseBranchFields(branchForm({ lat: '121.1029', lng: '14.6507' }))).toEqual({
    ok: false,
    reason: 'invalid_location',
  })
})

test('parseBranchFields rejects half a coordinate', () => {
  // branches.location is a single Point column: half of one is not storable,
  // and defaulting the missing half to 0 would put the branch in the ocean.
  expect(parseBranchFields(branchForm({ lat: '14.6507' }))).toEqual({
    ok: false,
    reason: 'invalid_location',
  })
  expect(parseBranchFields(branchForm({ lng: '121.1029' }))).toEqual({
    ok: false,
    reason: 'invalid_location',
  })
})

test('parseBranchFields rejects a non-numeric coordinate', () => {
  expect(parseBranchFields(branchForm({ lat: 'north', lng: '121.1029' }))).toEqual({
    ok: false,
    reason: 'invalid_location',
  })
})

test('isInPhilippines brackets the archipelago', () => {
  expect(isInPhilippines(14.5995, 121.0359)).toBe(true) // Metro Manila
  expect(isInPhilippines(20.45, 121.97)).toBe(true) // Batanes
  expect(isInPhilippines(5.05, 119.78)).toBe(true) // Tawi-Tawi
  expect(isInPhilippines(0, 0)).toBe(false)
  expect(isInPhilippines(1.35, 103.82)).toBe(false) // Singapore
  expect(isInPhilippines(Number.NaN, 121)).toBe(false)
})

// ------------------------------------------------------------- court fields

test('parseCourtFields accepts a name and environment, with surface optional', () => {
  expect(parseCourtFields(courtForm())).toEqual({
    ok: true,
    fields: { name: 'Court 1', environment: 'indoor', surface: null },
  })
})

test('parseCourtFields keeps a trimmed surface', () => {
  expect(parseCourtFields(courtForm({ surface: '  Acrylic  ' }))).toMatchObject({
    ok: true,
    fields: { surface: 'Acrylic' },
  })
})

test('parseCourtFields rejects a missing name', () => {
  expect(parseCourtFields(courtForm({ name: '  ' }))).toEqual({ ok: false, reason: 'missing_name' })
})

test('parseCourtFields rejects an environment outside the enum', () => {
  // courts.environment is the court_environment enum; anything else reaches
  // a ::court_environment cast and raises 22P02.
  for (const environment of ['', 'rooftop', 'INDOOR']) {
    expect(parseCourtFields(courtForm({ environment }))).toEqual({
      ok: false,
      reason: 'invalid_environment',
    })
  }
})

test('parseCourtFields rejects an over-long name or surface', () => {
  expect(parseCourtFields(courtForm({ name: 'x'.repeat(81) }))).toEqual({
    ok: false,
    reason: 'too_long',
  })
  expect(parseCourtFields(courtForm({ surface: 'x'.repeat(81) }))).toEqual({
    ok: false,
    reason: 'too_long',
  })
})

// -------------------------------------------------------------------- slugs

test('slugifyBranchName produces the shape branches.slug already uses', () => {
  expect(slugifyBranchName('Smash Zone Marikina')).toBe('smash-zone-marikina')
})

test('slugifyBranchName strips diacritics and punctuation', () => {
  // Parañaque is a real Metro Manila city (src/lib/geo/cities.ts lists it),
  // and 'para%C3%B1aque' in a URL is not a slug anybody can type.
  expect(slugifyBranchName('Parañaque Pickleball Café')).toBe('paranaque-pickleball-cafe')
  expect(slugifyBranchName('  The Court (BGC) — #2  ')).toBe('the-court-bgc-2')
})

test('slugifyBranchName falls back rather than returning an empty slug', () => {
  // branches.slug is NOT NULL; a name of only emoji or CJK would otherwise
  // produce '' and raise 23502.
  expect(slugifyBranchName('!!!')).toBe('branch')
})

test('slugifyBranchName never ends in a hyphen after truncation', () => {
  // 59 characters then a space puts the hyphen at index 59 — exactly the
  // last character the 60-char cap keeps, which is why the trailing-hyphen
  // strip has to run a second time after the slice.
  const slug = slugifyBranchName('a'.repeat(59) + ' bbbbbbbbbb')
  expect(slug).toBe('a'.repeat(59))
  expect(slug.endsWith('-')).toBe(false)
})

test('every failure reason has a message', () => {
  expect(Object.keys(BRANCH_FIELDS_FAILURE_MESSAGES).sort()).toEqual([
    'invalid_amenity',
    'invalid_email',
    'invalid_location',
    'missing_address',
    'missing_city',
    'missing_name',
    'too_long',
  ])
  expect(Object.keys(COURT_FIELDS_FAILURE_MESSAGES).sort()).toEqual([
    'invalid_environment',
    'missing_name',
    'too_long',
  ])
})
