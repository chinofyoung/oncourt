import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { CITIES } from '@/lib/geo/cities'
import { normalizePhPhone } from '@/lib/profile/phone'

/**
 * The three profile writes, as plain functions taking an ALREADY-AUTHORIZED
 * player id.
 *
 * Split out of src/app/bookings/profile-actions.ts so this logic is directly
 * testable: a 'use server' action can only be exercised through a mocked
 * session, so inlined validation goes untested and a future edit can break
 * authorization or validation with nothing failing. Same split, and same
 * reason, as src/lib/owner/settings.ts.
 *
 * `playerId` is the guard's return value and NEVER anything read from
 * FormData — a caller that passes a user-supplied id would let one player
 * write another's profile. That contract is this module's whole security
 * assumption, which is exactly why it is worth a test of its own.
 *
 * Each takes `raw: unknown`, not `string`. FormData.get() returns
 * `string | File | null`, and `String(someFile)` yields the literal
 * "[object File]" — non-empty, under the length cap, and silently storable as
 * a player's name. Rejecting a non-string here, in the tested layer, closes
 * that instead of trusting the caller to coerce correctly.
 */
export type ProfileWriteResult = { ok: true } | { ok: false; error: string }

export const NAME_MAX = 80

export async function setFullName(playerId: string, raw: unknown): Promise<ProfileWriteResult> {
  if (typeof raw !== 'string') return { ok: false, error: 'Enter your name.' }
  const fullName = raw.trim()
  if (fullName.length === 0) return { ok: false, error: 'Enter your name.' }
  if (fullName.length > NAME_MAX) {
    return { ok: false, error: `Keep your name under ${NAME_MAX} characters.` }
  }
  await db.execute(sql`update profiles set full_name = ${fullName} where id = ${playerId}::uuid`)
  return { ok: true }
}

export async function setPhone(playerId: string, raw: unknown): Promise<ProfileWriteResult> {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Enter a Philippine mobile number, like 0917 123 4567.' }
  }
  // Normalized, never stored as typed: one person's number gets exactly one
  // representation. Null means it is not a PH mobile.
  const phone = normalizePhPhone(raw)
  if (phone === null) {
    return { ok: false, error: 'Enter a Philippine mobile number, like 0917 123 4567.' }
  }
  await db.execute(sql`update profiles set phone = ${phone} where id = ${playerId}::uuid`)
  return { ok: true }
}

export async function setCitySlug(playerId: string, raw: unknown): Promise<ProfileWriteResult> {
  // The closed set is the gate: a slug outside CITIES never reaches SQL. There
  // is no FK to lean on — the city table is TypeScript, by deliberate design.
  if (typeof raw !== 'string' || !CITIES.some((city) => city.slug === raw)) {
    return { ok: false, error: 'Pick a city from the list.' }
  }
  await db.execute(sql`update profiles set city_slug = ${raw} where id = ${playerId}::uuid`)
  return { ok: true }
}
