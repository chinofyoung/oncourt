import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBranchWithCourts, teardownFixtures } from '../helpers/fixtures'
import { addPhoto, deletePhoto, movePhoto, type PhotoTarget } from '@/lib/listings/photos'
import { MAX_PHOTO_BYTES } from '@/lib/photos'
import type { StorageClient } from '@/lib/listings/storage'

afterAll(teardownFixtures)

const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555'

/**
 * The ONE permitted test double in the write path, and only because the
 * bucket is shared and an upload cannot be rolled back — a test that really
 * uploaded would leave objects in a shared Supabase project forever. Every
 * database row below is real.
 *
 * `rowsAtCall` is what makes the ordering assertions meaningful rather than
 * decorative: the fake counts the target's photo rows AT THE MOMENT storage
 * is called, so "object first, then row" is observed instead of assumed.
 */
type StorageCall = { op: 'upload' | 'remove'; bucket: string; paths: string[]; rowsAtCall: number }

function recorder(
  target: PhotoTarget,
  options: { uploadError?: string; removeError?: string } = {},
) {
  const calls: StorageCall[] = []

  async function countRows(): Promise<number> {
    const result =
      target.kind === 'branch'
        ? await db.execute(
            sql`select count(*)::int as n from branch_photos where branch_id = ${target.branchId}::uuid`,
          )
        : await db.execute(
            sql`select count(*)::int as n from court_photos where court_id = ${target.courtId}::uuid`,
          )
    return Number(result.rows[0].n)
  }

  const client: StorageClient = {
    async upload(bucket, path) {
      calls.push({ op: 'upload', bucket, paths: [path], rowsAtCall: await countRows() })
      return { error: options.uploadError ?? null }
    },
    async remove(bucket, paths) {
      calls.push({ op: 'remove', bucket, paths, rowsAtCall: await countRows() })
      return { error: options.removeError ?? null }
    },
  }

  return { client, calls }
}

function imageFile(type = 'image/jpeg', bytes = 64): File {
  return new File([new Uint8Array(bytes)], 'photo', { type })
}

async function photoRows(target: PhotoTarget) {
  const result =
    target.kind === 'branch'
      ? await db.execute(sql`
          select id, storage_path, sort_order from branch_photos
          where branch_id = ${target.branchId}::uuid order by sort_order, id
        `)
      : await db.execute(sql`
          select id, storage_path, sort_order from court_photos
          where court_id = ${target.courtId}::uuid order by sort_order, id
        `)
  return result.rows.map((row) => ({
    id: row.id as string,
    storagePath: row.storage_path as string,
    sortOrder: Number(row.sort_order),
  }))
}

test('addPhoto uploads the object before inserting the row', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)

  const result = await addPhoto({ target, file: imageFile(), storage: storage.client })
  expect(result).toMatchObject({ ok: true })
  if (!result.ok) throw new Error('unreachable')

  expect(storage.calls).toHaveLength(1)
  expect(storage.calls[0].op).toBe('upload')
  expect(storage.calls[0].bucket).toBe('branch-photos')
  // Zero rows existed when the object was written: object first, then row.
  expect(storage.calls[0].rowsAtCall).toBe(0)
  expect(result.storagePath.startsWith(`branches/${branchId}/`)).toBe(true)
  expect(result.storagePath.endsWith('.jpg')).toBe(true)

  const rows = await photoRows(target)
  expect(rows).toHaveLength(1)
  expect(rows[0].storagePath).toBe(result.storagePath)
  expect(rows[0].sortOrder).toBe(0)
})

test('addPhoto assigns the next sort_order', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)

  await addPhoto({ target, file: imageFile(), storage: storage.client })
  await addPhoto({ target, file: imageFile('image/png'), storage: storage.client })
  await addPhoto({ target, file: imageFile('image/webp'), storage: storage.client })

  const rows = await photoRows(target)
  expect(rows.map((row) => row.sortOrder)).toEqual([0, 1, 2])
  expect(rows.map((row) => row.storagePath.split('.').pop())).toEqual(['jpg', 'png', 'webp'])
})

test('addPhoto stores court photos under their own prefix and bucket', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  const target: PhotoTarget = { kind: 'court', courtId: courtIds[0] }
  const storage = recorder(target)

  const result = await addPhoto({ target, file: imageFile(), storage: storage.client })
  if (!result.ok) throw new Error('addPhoto failed')

  expect(storage.calls[0].bucket).toBe('court-photos')
  expect(result.storagePath.startsWith(`courts/${courtIds[0]}/`)).toBe(true)
})

test('addPhoto rejects a file type that is not jpeg, png or webp', async () => {
  // Server-side, not merely an `accept` attribute: the attribute is a hint
  // the browser applies and a hand-crafted POST ignores.
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)

  for (const type of ['application/pdf', 'image/gif', 'text/html', '']) {
    expect(await addPhoto({ target, file: imageFile(type), storage: storage.client })).toEqual({
      ok: false,
      reason: 'bad_type',
    })
  }
  expect(storage.calls).toHaveLength(0)
  expect(await photoRows(target)).toEqual([])
})

test('addPhoto rejects a file over 5 MB', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)

  const result = await addPhoto({
    target,
    file: imageFile('image/jpeg', MAX_PHOTO_BYTES + 1),
    storage: storage.client,
  })
  expect(result).toEqual({ ok: false, reason: 'too_large' })
  expect(storage.calls).toHaveLength(0)
})

test('addPhoto rejects an empty file', async () => {
  // An <input type="file"> with nothing chosen still submits an entry with a
  // zero-byte body and an empty name.
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)

  expect(
    await addPhoto({ target, file: imageFile('image/jpeg', 0), storage: storage.client }),
  ).toEqual({ ok: false, reason: 'no_file' })
  expect(storage.calls).toHaveLength(0)
})

test('addPhoto writes no row when the upload fails', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target, { uploadError: 'network unreachable' })

  expect(await addPhoto({ target, file: imageFile(), storage: storage.client })).toEqual({
    ok: false,
    reason: 'upload_failed',
  })
  expect(await photoRows(target)).toEqual([])
})

test('addPhoto removes the uploaded object when the row insert fails', async () => {
  // The branch was deleted between the guard and the write: 23503. Without
  // the compensating remove, the object would be orphaned in the bucket with
  // nothing pointing at it and no way to find it again.
  const target: PhotoTarget = { kind: 'branch', branchId: UNKNOWN_ID }
  const storage = recorder(target)

  expect(await addPhoto({ target, file: imageFile(), storage: storage.client })).toEqual({
    ok: false,
    reason: 'target_missing',
  })
  expect(storage.calls.map((call) => call.op)).toEqual(['upload', 'remove'])
})

test('deletePhoto removes the object first, then the row', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)
  const added = await addPhoto({ target, file: imageFile(), storage: storage.client })
  if (!added.ok) throw new Error('addPhoto failed')

  expect(await deletePhoto({ target, photoId: added.photoId, storage: storage.client })).toEqual({
    ok: true,
  })

  const remove = storage.calls.find((call) => call.op === 'remove')!
  expect(remove.paths).toEqual([added.storagePath])
  // The row was still there when the object went: object first, then row.
  expect(remove.rowsAtCall).toBe(1)
  expect(await photoRows(target)).toEqual([])
})

test('deletePhoto keeps the row when the storage removal fails', async () => {
  // Retryable rather than lost: the owner presses delete again and the second
  // remove of a missing object is a no-op anyway.
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const ok = recorder(target)
  const added = await addPhoto({ target, file: imageFile(), storage: ok.client })
  if (!added.ok) throw new Error('addPhoto failed')

  const failing = recorder(target, { removeError: 'bucket unavailable' })
  expect(await deletePhoto({ target, photoId: added.photoId, storage: failing.client })).toEqual({
    ok: false,
    reason: 'delete_failed',
  })
  expect(await photoRows(target)).toHaveLength(1)
})

test('deletePhoto refuses a photo belonging to another target', async () => {
  // Target-scoped in the WHERE clause, not checked after a read: an owner who
  // passes their own branch id with someone else's photo id must delete
  // nothing.
  const first = await seedBranchWithCourts(0)
  const second = await seedBranchWithCourts(0)
  const firstTarget: PhotoTarget = { kind: 'branch', branchId: first.branchId }
  const storage = recorder(firstTarget)
  const added = await addPhoto({ target: firstTarget, file: imageFile(), storage: storage.client })
  if (!added.ok) throw new Error('addPhoto failed')

  const result = await deletePhoto({
    target: { kind: 'branch', branchId: second.branchId },
    photoId: added.photoId,
    storage: storage.client,
  })
  expect(result).toEqual({ ok: false, reason: 'not_found' })
  expect(await photoRows(firstTarget)).toHaveLength(1)
})

test('movePhoto swaps a photo with the one before it', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)
  const a = await addPhoto({ target, file: imageFile(), storage: storage.client })
  const b = await addPhoto({ target, file: imageFile(), storage: storage.client })
  if (!a.ok || !b.ok) throw new Error('addPhoto failed')

  expect(await movePhoto({ target, photoId: b.photoId, direction: 'up' })).toEqual({ ok: true })
  expect((await photoRows(target)).map((row) => row.id)).toEqual([b.photoId, a.photoId])

  expect(await movePhoto({ target, photoId: b.photoId, direction: 'down' })).toEqual({ ok: true })
  expect((await photoRows(target)).map((row) => row.id)).toEqual([a.photoId, b.photoId])
})

test('movePhoto reports at_edge at either end', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)
  const a = await addPhoto({ target, file: imageFile(), storage: storage.client })
  const b = await addPhoto({ target, file: imageFile(), storage: storage.client })
  if (!a.ok || !b.ok) throw new Error('addPhoto failed')

  expect(await movePhoto({ target, photoId: a.photoId, direction: 'up' })).toEqual({
    ok: false,
    reason: 'at_edge',
  })
  expect(await movePhoto({ target, photoId: b.photoId, direction: 'down' })).toEqual({
    ok: false,
    reason: 'at_edge',
  })
})

test('movePhoto resequences duplicate sort_order values', async () => {
  // branch_photos has no unique constraint on (branch_id, sort_order), and
  // scripts/seed-photos.ts writes 0,1,2 per branch with no coordination — so
  // duplicates are representable. A pure two-row swap would be a no-op on
  // two rows sharing a value; resequencing the whole list is self-healing.
  const { branchId } = await seedBranchWithCourts(0)
  const target: PhotoTarget = { kind: 'branch', branchId }
  const storage = recorder(target)
  const a = await addPhoto({ target, file: imageFile(), storage: storage.client })
  const b = await addPhoto({ target, file: imageFile(), storage: storage.client })
  if (!a.ok || !b.ok) throw new Error('addPhoto failed')
  await db.execute(sql`update branch_photos set sort_order = 0 where branch_id = ${branchId}::uuid`)

  // Both rows now share sort_order 0, so `order by sort_order, id` (the same
  // ordering movePhoto itself uses) tie-breaks on a random gen_random_uuid()
  // id — branch_photos has no created_at, so nothing else records which of
  // a/b was written first. Reading which one currently lists second, rather
  // than assuming it is `b`, is what keeps this assertion independent of that
  // random tie-break instead of ~50% flaky on it.
  const before = await photoRows(target)
  const second = before[1].id

  expect(await movePhoto({ target, photoId: second, direction: 'up' })).toEqual({ ok: true })
  const rows = await photoRows(target)
  expect(rows.map((row) => row.sortOrder)).toEqual([0, 1])
  expect(rows[0].id).toBe(second)
})

test('movePhoto reports not_found for an unknown photo', async () => {
  const { branchId } = await seedBranchWithCourts(0)
  expect(
    await movePhoto({
      target: { kind: 'branch', branchId },
      photoId: UNKNOWN_ID,
      direction: 'up',
    }),
  ).toEqual({ ok: false, reason: 'not_found' })
})
