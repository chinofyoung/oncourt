import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PlayerProfileFields = {
  fullName: string | null
  phone: string | null
  citySlug: string | null
}

/**
 * The three fields the completion checklist tracks. Shape-checked before the
 * `::uuid` cast (22P02 otherwise), the same guard startCheckout uses.
 *
 * A missing row returns all-nulls rather than throwing: the caller is a
 * dashboard panel, and "nothing filled in" is the honest render for a profile
 * row that somehow does not exist yet.
 */
export async function getPlayerProfileFields(userId: string): Promise<PlayerProfileFields> {
  if (!UUID_RE.test(userId)) return { fullName: null, phone: null, citySlug: null }
  const result = await db.execute(sql`
    select full_name, phone, city_slug from profiles where id = ${userId}::uuid
  `)
  const row = result.rows[0]
  return {
    fullName: (row?.full_name as string | null) ?? null,
    phone: (row?.phone as string | null) ?? null,
    citySlug: (row?.city_slug as string | null) ?? null,
  }
}

/**
 * Just the city, for seeding the Where field on `/` and `/search`. A separate
 * one-column query rather than widening getOptionalUser, whose job is auth,
 * not profile data.
 */
export async function getPlayerCitySlug(userId: string): Promise<string | null> {
  if (!UUID_RE.test(userId)) return null
  const result = await db.execute(sql`
    select city_slug from profiles where id = ${userId}::uuid
  `)
  return (result.rows[0]?.city_slug as string | null) ?? null
}
