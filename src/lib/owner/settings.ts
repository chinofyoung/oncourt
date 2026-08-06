import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  ALLOWED_PHOTO_TYPES,
  MAX_PHOTO_BYTES,
  PHOTO_EXTENSIONS,
  type PhotoBucket,
} from '@/lib/photos'
import type { StorageClient } from '@/lib/listings/storage'
import { MAX_BUSINESS_NAME_LENGTH } from '@/lib/staff/write'

/**
 * An owner's own brand identity: business name, logo, and the slug they can
 * see but not change. Backs /dashboard/settings.
 *
 * Every function here is scoped to ONE owner id, which the action takes from
 * the guarded session and never from the form. There is no branch scoping in
 * this module because none of it is branch-shaped: a business name belongs to
 * the account, not to a location.
 *
 * `role = 'owner'` is in the WHERE clause of every write, not checked after a
 * read. requireOwner (the actions' guard) admits ADMINS as well as owners —
 * see its doc comment — so that clause is the second layer that stops an admin
 * from acquiring a business identity by visiting a dashboard page.
 *
 * `storage` is a parameter rather than an import for the same reason
 * src/lib/listings/photos.ts takes one: the one boundary that cannot be rolled
 * back is the one boundary the tests fake. The rows stay real.
 */

/**
 * Logos live in the EXISTING `branch-photos` bucket under a `logos/` prefix.
 *
 * Only two buckets exist (supabase/migrations/20260801110350_storage_and_cron.sql
 * creates `branch-photos` and `court-photos`, both public), this slice has no
 * migration, and the prefixes already in use are `branches/<id>/` and
 * `courts/<id>/` — so `logos/<ownerId>/` collides with nothing. `court-photos`
 * would be the wrong half of the pair: a brand logo is not a court photo.
 *
 * Exported so the settings page, the public brand page and the tests all read
 * the bucket from one place rather than repeating the string.
 */
export const LOGO_BUCKET: PhotoBucket = 'branch-photos'

export type OwnerSettings = {
  businessName: string | null
  slug: string | null
  logoPath: string | null
}

export type SettingsFailure =
  | 'not_an_owner'
  | 'empty_name'
  | 'name_too_long'
  | 'no_file'
  | 'bad_type'
  | 'too_large'
  | 'upload_failed'

export type SettingsResult = { ok: true } | { ok: false; reason: SettingsFailure }

/**
 * The three fields the settings page renders, or null when this id has no
 * owner profile.
 *
 * Null is a REACHABLE state, not a defensive branch: requireOwner admits
 * admins, and an admin has no business_name or slug by construction (see
 * seedAdmin's note and promoteToOwner's `role = 'player'` scoping). The page
 * renders a short explanation for it rather than an empty form that would
 * refuse every submission.
 */
export async function getOwnerSettings(ownerId: string): Promise<OwnerSettings | null> {
  const result = await db.execute(sql`
    select business_name, slug, business_logo_path
    from profiles
    where id = ${ownerId}::uuid and role = 'owner'
  `)
  const row = result.rows[0]
  if (!row) return null
  return {
    businessName: (row.business_name as string | null) ?? null,
    slug: (row.slug as string | null) ?? null,
    logoPath: (row.business_logo_path as string | null) ?? null,
  }
}

export async function updateBusinessName(input: {
  ownerId: string
  businessName: string
}): Promise<SettingsResult> {
  // Trimmed BEFORE measuring, so a name that fits is not refused for its
  // trailing spaces, and checked before any SQL: the column is plain `text`
  // with no constraint, so nothing below this line would refuse an empty name
  // — and an owner with a blank business name disappears from their own brand
  // page, which falls back to the slug.
  const businessName = input.businessName.trim()
  if (businessName.length === 0) return { ok: false, reason: 'empty_name' }
  if (businessName.length > MAX_BUSINESS_NAME_LENGTH) return { ok: false, reason: 'name_too_long' }

  const result = await db.execute(sql`
    update profiles set business_name = ${businessName}
    where id = ${input.ownerId}::uuid and role = 'owner'
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'not_an_owner' }
}

/**
 * Swaps `business_logo_path` and reports what was there before, in one
 * transaction.
 *
 * `for update` on the read is what makes the previous path trustworthy rather
 * than merely likely: two uploads racing would otherwise both read the same
 * previous path and both try to delete it, and the loser would delete the
 * object the winner's row now points at. Same lock discipline as
 * approveCourt/replaceRateBands.
 */
async function swapLogoPath(
  ownerId: string,
  nextPath: string | null,
): Promise<{ ok: true; previousPath: string | null } | { ok: false; reason: 'not_an_owner' }> {
  return db.transaction(
    async (tx) => {
      const current = await tx.execute(sql`
        select business_logo_path from profiles
        where id = ${ownerId}::uuid and role = 'owner'
        for update
      `)
      if (current.rows.length === 0) return { ok: false as const, reason: 'not_an_owner' as const }
      const previousPath = (current.rows[0].business_logo_path as string | null) ?? null

      await tx.execute(sql`
        update profiles set business_logo_path = ${nextPath}
        where id = ${ownerId}::uuid and role = 'owner'
      `)
      return { ok: true as const, previousPath }
    },
    { isolationLevel: 'read committed' },
  )
}

export async function updateBusinessLogo(input: {
  ownerId: string
  file: File
  storage: StorageClient
}): Promise<SettingsResult> {
  const { ownerId, file, storage } = input

  // The same three server-side rules that govern every other upload in this
  // app, imported from the pure module rather than restated. The file input's
  // `accept` attribute is a browser hint a hand-crafted POST ignores; this is
  // the real check.
  if (file.size === 0) return { ok: false, reason: 'no_file' }
  if (!(ALLOWED_PHOTO_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, reason: 'bad_type' }
  }
  if (file.size > MAX_PHOTO_BYTES) return { ok: false, reason: 'too_large' }

  const storagePath = `logos/${ownerId}/${crypto.randomUUID()}.${PHOTO_EXTENSIONS[file.type]}`
  const bytes = new Uint8Array(await file.arrayBuffer())

  // OBJECT FIRST. A row pointing at an object that does not exist is a broken
  // logo on the owner's own public brand page; an object with no row is
  // invisible. Of the two, only the first is visible to a player.
  const uploaded = await storage.upload(LOGO_BUCKET, storagePath, bytes, file.type)
  if (uploaded.error !== null) return { ok: false, reason: 'upload_failed' }

  const swapped = await swapLogoPath(ownerId, storagePath)
  if (!swapped.ok) {
    // The object went up before the row was checked, so a refusal reclaims it
    // — the same cleanup addPhoto does when its target has vanished.
    await storage.remove(LOGO_BUCKET, [storagePath])
    return { ok: false, reason: swapped.reason }
  }

  // BEST EFFORT, and deliberately AFTER the path update has committed: a
  // dangling old object costs storage, while removing it first and then
  // failing to write the row would leave the owner's brand page pointing at
  // nothing. The error is swallowed for the same reason — the save succeeded,
  // and there is nothing the owner could do about a storage hiccup.
  if (swapped.previousPath !== null && swapped.previousPath !== storagePath) {
    await storage.remove(LOGO_BUCKET, [swapped.previousPath])
  }
  return { ok: true }
}

export async function removeBusinessLogo(input: {
  ownerId: string
  storage: StorageClient
}): Promise<SettingsResult> {
  const { ownerId, storage } = input

  // ROW FIRST here — the opposite order from the upload, and for the same
  // reason: the state worth avoiding is a row pointing at an object that is
  // already gone, so the row stops pointing at it first.
  const swapped = await swapLogoPath(ownerId, null)
  if (!swapped.ok) return { ok: false, reason: swapped.reason }

  // Nothing to reclaim when there was no logo — a double-submit is a no-op,
  // not a failure the owner has to interpret.
  if (swapped.previousPath !== null) {
    await storage.remove(LOGO_BUCKET, [swapped.previousPath])
  }
  return { ok: true }
}
