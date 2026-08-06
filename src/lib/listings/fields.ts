/**
 * Branch and court field rules.
 *
 * PURE, for the same two reasons as src/lib/listings/schedule.ts: the branch
 * and court forms are client components that render the failure messages, and
 * nothing here touches a database or a session.
 *
 * The amenity vocabulary is IMPORTED, never redeclared. AMENITY_SLUGS in
 * src/components/ui/amenity-chip.tsx is the single source of truth already
 * shared by the search query-param whitelist (src/lib/search/params.ts) and
 * the filter chips; branches.amenities is a bare `text[]` with no constraint,
 * so a slug outside that list would be stored, rendered as a hyphen-stripped
 * fallback chip, and permanently unmatched by the search filter's
 * `b.amenities @> $` predicate.
 */
import { AMENITY_SLUGS } from '@/components/ui/amenity-chip'

export type BranchFields = {
  name: string
  description: string | null
  address: string
  city: string
  contactPhone: string | null
  contactEmail: string | null
  amenities: string[]
  /** Both null, or both set. `branches.location` is one Point column. */
  lat: number | null
  lng: number | null
}

export type CourtEnvironment = 'indoor' | 'outdoor'
export type CourtFields = { name: string; environment: CourtEnvironment; surface: string | null }

/** Mirrors the `court_environment` enum exactly. */
export const COURT_ENVIRONMENTS = ['indoor', 'outdoor'] as const

/**
 * Sentence-case labels for the `court_environment` enum, in one place. Three
 * files carried the same `environment === 'indoor' ? 'Indoor' : 'Outdoor'`
 * ternary before the admin queue would have made it four; all three iterate a
 * `CourtEnvironment`, so this indexes safely everywhere.
 */
export const COURT_ENVIRONMENT_LABELS: Record<CourtEnvironment, string> = {
  indoor: 'Indoor',
  outdoor: 'Outdoor',
}

/**
 * A generous box around the archipelago — Batanes in the north (~21.1 N),
 * Tawi-Tawi in the south (~4.6 N), Palawan's west coast (~116.9 E), and the
 * eastern seaboard (~126.6 E).
 *
 * A sanity check, not a service area: its job is to catch a pin dragged to
 * 0,0 (Null Island, off Ghana) or a swapped lat/lng, both of which save
 * cleanly and then make the branch invisible to every radius search while
 * looking perfectly fine on the form.
 */
export const PH_BOUNDS = { minLat: 4.2, maxLat: 21.4, minLng: 116.7, maxLng: 126.7 } as const

export const MAX_BRANCH_NAME = 120
export const MAX_DESCRIPTION = 2000
export const MAX_ADDRESS = 240
export const MAX_CITY = 80
export const MAX_PHONE = 40
export const MAX_EMAIL = 160
export const MAX_COURT_NAME = 80
export const MAX_SURFACE = 80
/** branches.slug is UNIQUE and public; long enough to stay readable, short enough to type. */
const MAX_SLUG = 60

/** Same deliberately-loose rule as src/lib/staff/write.ts — see that module's comment. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type BranchFieldsFailure =
  | 'missing_name'
  | 'missing_address'
  | 'missing_city'
  | 'too_long'
  | 'invalid_email'
  | 'invalid_amenity'
  | 'invalid_location'

export type CourtFieldsFailure = 'missing_name' | 'invalid_environment' | 'too_long'

export const BRANCH_FIELDS_FAILURE_MESSAGES: Record<BranchFieldsFailure, string> = {
  missing_name: 'Give the branch a name.',
  missing_address: 'Enter the street address.',
  missing_city: 'Enter the city.',
  too_long: 'One of those fields is too long — shorten it and try again.',
  invalid_email: "That contact email doesn't look right.",
  invalid_amenity: 'Pick amenities from the list, without repeating one.',
  invalid_location:
    'Set the map pin somewhere in the Philippines, or leave it unset and place it later.',
}

export const COURT_FIELDS_FAILURE_MESSAGES: Record<CourtFieldsFailure, string> = {
  missing_name: 'Give the court a name.',
  invalid_environment: 'Choose indoor or outdoor.',
  too_long: 'The name or surface is too long — shorten it and try again.',
}

export function isInPhilippines(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= PH_BOUNDS.minLat &&
    lat <= PH_BOUNDS.maxLat &&
    lng >= PH_BOUNDS.minLng &&
    lng <= PH_BOUNDS.maxLng
  )
}

/** Trimmed string for a form field; '' for anything absent. */
function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

export function parseBranchFields(
  formData: FormData,
): { ok: true; fields: BranchFields } | { ok: false; reason: BranchFieldsFailure } {
  const name = text(formData, 'name')
  const address = text(formData, 'address')
  const city = text(formData, 'city')
  const description = text(formData, 'description')
  const contactPhone = text(formData, 'contactPhone')
  const contactEmail = text(formData, 'contactEmail')
  const amenities = formData.getAll('amenities').map((value) => String(value))
  const rawLat = text(formData, 'lat')
  const rawLng = text(formData, 'lng')

  if (name.length === 0) return { ok: false, reason: 'missing_name' }
  if (address.length === 0) return { ok: false, reason: 'missing_address' }
  if (city.length === 0) return { ok: false, reason: 'missing_city' }

  if (
    name.length > MAX_BRANCH_NAME ||
    address.length > MAX_ADDRESS ||
    city.length > MAX_CITY ||
    description.length > MAX_DESCRIPTION ||
    contactPhone.length > MAX_PHONE ||
    contactEmail.length > MAX_EMAIL
  ) {
    return { ok: false, reason: 'too_long' }
  }

  if (contactEmail.length > 0 && !EMAIL_RE.test(contactEmail)) {
    return { ok: false, reason: 'invalid_email' }
  }

  for (const amenity of amenities) {
    if (!(AMENITY_SLUGS as readonly string[]).includes(amenity)) {
      return { ok: false, reason: 'invalid_amenity' }
    }
  }
  // A duplicate is never something a checkbox set can produce; it means the
  // POST was hand-crafted, and `amenities @> '{parking,parking}'` would still
  // match, so storing it achieves nothing but a doubled chip.
  if (new Set(amenities).size !== amenities.length) {
    return { ok: false, reason: 'invalid_amenity' }
  }

  // Both or neither. `branches.location` is nullable, so "no pin yet" is a
  // legitimate state — geocoding is non-blocking per the spec — but half a
  // coordinate is not storable and defaulting the missing half to 0 would
  // drop the branch in the ocean.
  if ((rawLat === '') !== (rawLng === '')) return { ok: false, reason: 'invalid_location' }

  let lat: number | null = null
  let lng: number | null = null
  if (rawLat !== '') {
    lat = Number(rawLat)
    lng = Number(rawLng)
    if (!isInPhilippines(lat, lng)) return { ok: false, reason: 'invalid_location' }
  }

  return {
    ok: true,
    fields: {
      name,
      description: description.length > 0 ? description : null,
      address,
      city,
      contactPhone: contactPhone.length > 0 ? contactPhone : null,
      contactEmail: contactEmail.length > 0 ? contactEmail : null,
      amenities,
      lat,
      lng,
    },
  }
}

export function parseCourtFields(
  formData: FormData,
): { ok: true; fields: CourtFields } | { ok: false; reason: CourtFieldsFailure } {
  const name = text(formData, 'name')
  const environment = text(formData, 'environment')
  const surface = text(formData, 'surface')

  if (name.length === 0) return { ok: false, reason: 'missing_name' }
  if (!(COURT_ENVIRONMENTS as readonly string[]).includes(environment)) {
    return { ok: false, reason: 'invalid_environment' }
  }
  if (name.length > MAX_COURT_NAME || surface.length > MAX_SURFACE) {
    return { ok: false, reason: 'too_long' }
  }

  return {
    ok: true,
    fields: {
      name,
      environment: environment as CourtEnvironment,
      surface: surface.length > 0 ? surface : null,
    },
  }
}

/**
 * Derives the public `/venues/<slug>` segment from the branch name.
 *
 * Owners are never asked for a slug — the spec's branch-field list has no
 * such field — but branches.slug is `not null unique`, so one has to come
 * from somewhere. Collisions are resolved by createBranch (see
 * src/lib/listings/write.ts), which is the only layer that can see them.
 *
 * NFD + combining-mark strip is what turns 'Parañaque' into 'paranaque'
 * rather than percent-encoded noise in the URL. The trailing-hyphen strip
 * runs twice on purpose: once before the length cap, once after, because
 * slicing mid-word can leave a hyphen at the new end.
 */
export function slugifyBranchName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '')

  // branches.slug is NOT NULL, so a name with no ASCII-able characters at
  // all (emoji, pure CJK) must still produce something insertable.
  return slug.length > 0 ? slug : 'branch'
}
