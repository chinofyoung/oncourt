import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { PG_FOREIGN_KEY_VIOLATION, sqlStateOf } from '@/lib/db/sql-state'
import {
  ALLOWED_PHOTO_TYPES,
  MAX_PHOTO_BYTES,
  PHOTO_EXTENSIONS,
  type PhotoBucket,
} from '@/lib/photos'
import type { StorageClient } from '@/lib/listings/storage'

/**
 * Branch and court photos: upload, reorder, delete. No cropping, no editing
 * (see the spec's Out of scope).
 *
 * A photo edit NEVER re-queues a court — nothing here touches courts.status.
 *
 * `storage` is a parameter rather than an import so the one boundary that
 * cannot be rolled back is the one boundary the tests fake. The rows stay
 * real; the network call is observed.
 *
 * Branch and court photos live in two tables with two buckets and two path
 * prefixes, and each SQL statement below is written out for both kinds rather
 * than assembled from a variable table name. Building identifiers with
 * `sql.raw` for a two-case switch would trade a real safety property for four
 * saved lines.
 */
export type PhotoTarget = { kind: 'branch'; branchId: string } | { kind: 'court'; courtId: string }

export function bucketFor(target: PhotoTarget): PhotoBucket {
  return target.kind === 'branch' ? 'branch-photos' : 'court-photos'
}

/** The path prefix the seeded photos already use: `branches/<id>/`, `courts/<id>/`. */
function prefixFor(target: PhotoTarget): string {
  return target.kind === 'branch' ? `branches/${target.branchId}/` : `courts/${target.courtId}/`
}

export type AddPhotoResult =
  | { ok: true; photoId: string; storagePath: string }
  | { ok: false; reason: 'no_file' | 'bad_type' | 'too_large' | 'upload_failed' | 'target_missing' }

export async function addPhoto(input: {
  target: PhotoTarget
  file: File
  storage: StorageClient
}): Promise<AddPhotoResult> {
  const { file, target, storage } = input

  // An <input type="file"> with nothing chosen still submits a zero-byte
  // entry, so "empty" is the normal shape of "no photo attached".
  if (file.size === 0) return { ok: false, reason: 'no_file' }
  if (!(ALLOWED_PHOTO_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, reason: 'bad_type' }
  }
  if (file.size > MAX_PHOTO_BYTES) return { ok: false, reason: 'too_large' }

  // A fresh UUID per object, never the uploaded filename: two photos called
  // IMG_0001.jpg would otherwise collide, and a user-supplied name in a
  // public URL is a path-traversal question nobody needs to answer.
  const storagePath = `${prefixFor(target)}${crypto.randomUUID()}.${PHOTO_EXTENSIONS[file.type]}`
  const bytes = new Uint8Array(await file.arrayBuffer())

  // OBJECT FIRST. A row pointing at an object that does not exist renders a
  // broken image on the owner's own page; an object with no row is invisible
  // and unreclaimable. Of the two, only the first is fixable.
  const uploaded = await storage.upload(bucketFor(target), storagePath, bytes, file.type)
  if (uploaded.error !== null) return { ok: false, reason: 'upload_failed' }

  try {
    // sort_order = one past the current maximum, computed in SQL so two
    // concurrent uploads cannot both read the same maximum in TypeScript.
    // coalesce covers the first photo (max over zero rows is null).
    const result =
      target.kind === 'branch'
        ? await db.execute(sql`
            insert into branch_photos (branch_id, storage_path, sort_order)
            select ${target.branchId}::uuid, ${storagePath},
              coalesce(max(sort_order) + 1, 0)
            from branch_photos where branch_id = ${target.branchId}::uuid
            returning id
          `)
        : await db.execute(sql`
            insert into court_photos (court_id, storage_path, sort_order)
            select ${target.courtId}::uuid, ${storagePath},
              coalesce(max(sort_order) + 1, 0)
            from court_photos where court_id = ${target.courtId}::uuid
            returning id
          `)
    return { ok: true, photoId: result.rows[0].id as string, storagePath }
  } catch (error) {
    if (sqlStateOf(error) !== PG_FOREIGN_KEY_VIOLATION) throw error
    // The branch or court vanished between the guard and the write. Best
    // effort: take the object back out, so a failed add leaves nothing.
    await storage.remove(bucketFor(target), [storagePath])
    return { ok: false, reason: 'target_missing' }
  }
}

export type DeletePhotoResult = { ok: true } | { ok: false; reason: 'not_found' | 'delete_failed' }

export async function deletePhoto(input: {
  target: PhotoTarget
  photoId: string
  storage: StorageClient
}): Promise<DeletePhotoResult> {
  const { target, photoId, storage } = input

  // Target-scoped in the WHERE clause, not compared after a read: an owner
  // who passes their own branch id with someone else's photo id must find
  // nothing rather than be told whose it is.
  const found =
    target.kind === 'branch'
      ? await db.execute(sql`
          select storage_path from branch_photos
          where id = ${photoId}::uuid and branch_id = ${target.branchId}::uuid
        `)
      : await db.execute(sql`
          select storage_path from court_photos
          where id = ${photoId}::uuid and court_id = ${target.courtId}::uuid
        `)
  if (found.rows.length === 0) return { ok: false, reason: 'not_found' }
  const storagePath = found.rows[0].storage_path as string

  // OBJECT FIRST, for the reason addPhoto documents. If this succeeds and the
  // row delete below then fails, the owner sees a broken thumbnail and can
  // press delete again — a second remove of a missing object is a no-op.
  const removed = await storage.remove(bucketFor(target), [storagePath])
  if (removed.error !== null) return { ok: false, reason: 'delete_failed' }

  if (target.kind === 'branch') {
    await db.execute(sql`
      delete from branch_photos
      where id = ${photoId}::uuid and branch_id = ${target.branchId}::uuid
    `)
  } else {
    await db.execute(sql`
      delete from court_photos
      where id = ${photoId}::uuid and court_id = ${target.courtId}::uuid
    `)
  }
  return { ok: true }
}

export type MovePhotoResult = { ok: true } | { ok: false; reason: 'not_found' | 'at_edge' }

/**
 * Moves one photo one place up or down.
 *
 * Implemented as "reorder the list, then write every position back" rather
 * than as a two-row swap of sort_order values. Neither branch_photos nor
 * court_photos has a unique constraint on (target, sort_order) — and
 * scripts/seed-photos.ts writes 0,1,2 with no coordination — so duplicates
 * are representable, and a swap between two rows sharing a value would be a
 * silent no-op. Rewriting the whole sequence is self-healing and still
 * "swaps sort_order values" for the case the spec describes.
 *
 * One transaction, so a partial resequence can never leave two photos
 * claiming the same position.
 */
export async function movePhoto(input: {
  target: PhotoTarget
  photoId: string
  direction: 'up' | 'down'
}): Promise<MovePhotoResult> {
  const { target, photoId, direction } = input

  return db.transaction(
    async (tx) => {
      const listed =
        target.kind === 'branch'
          ? await tx.execute(sql`
              select id from branch_photos where branch_id = ${target.branchId}::uuid
              order by sort_order, id
              for update
            `)
          : await tx.execute(sql`
              select id from court_photos where court_id = ${target.courtId}::uuid
              order by sort_order, id
              for update
            `)

      const ids = listed.rows.map((row) => row.id as string)
      const index = ids.indexOf(photoId)
      if (index === -1) return { ok: false as const, reason: 'not_found' as const }

      const target_index = direction === 'up' ? index - 1 : index + 1
      if (target_index < 0 || target_index >= ids.length) {
        return { ok: false as const, reason: 'at_edge' as const }
      }

      const reordered = [...ids]
      reordered[index] = ids[target_index]
      reordered[target_index] = ids[index]

      for (const [position, id] of reordered.entries()) {
        if (target.kind === 'branch') {
          await tx.execute(sql`
            update branch_photos set sort_order = ${position}
            where id = ${id}::uuid and branch_id = ${target.branchId}::uuid
          `)
        } else {
          await tx.execute(sql`
            update court_photos set sort_order = ${position}
            where id = ${id}::uuid and court_id = ${target.courtId}::uuid
          `)
        }
      }

      return { ok: true as const }
    },
    { isolationLevel: 'read committed' },
  )
}
