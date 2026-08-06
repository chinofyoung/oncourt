import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { PhotoBucket } from '@/lib/photos'

/**
 * The narrow slice of Supabase Storage this slice uses, behind an interface.
 *
 * Two functions, both taking a bucket. That is the whole surface — which is
 * what makes it cheap to hand a recorder to the photo tests instead of really
 * uploading. The bucket is shared with the seeded demo photos and an upload
 * has no rollback, so a test that really wrote to it would leave objects in a
 * shared project forever; the DATABASE rows in those tests stay real.
 *
 * Errors come back as a string, not a thrown exception and not Supabase's own
 * error object: callers only ever need "did it work, and what do I log".
 */
export type StorageClient = {
  upload(
    bucket: PhotoBucket,
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ error: string | null }>
  remove(bucket: PhotoBucket, paths: string[]): Promise<{ error: string | null }>
}

/**
 * Built once and reused. `SUPABASE_SECRET_KEY` is the service-role key — it
 * bypasses RLS, which is exactly why uploads happen here on the server behind
 * a guard and never from the browser (see the comment in
 * supabase/migrations/20260801110350_storage_and_cron.sql: storage.objects
 * has zero policies, so the anon key can write nothing).
 *
 * `persistSession: false` because there is no session to persist: this client
 * authenticates as the service role, not as the signed-in user, and the
 * ownership check has already happened in the action's guard.
 */
let cached: SupabaseClient | null = null

function client(): SupabaseClient {
  if (cached) return cached
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required for uploads')
  }
  cached = createClient(url, key, { auth: { persistSession: false } })
  return cached
}

export function serviceRoleStorage(): StorageClient {
  return {
    async upload(bucket, path, bytes, contentType) {
      // upsert stays FALSE: every path this app writes carries a fresh UUID,
      // so an upsert could only ever mask a collision that should not exist.
      const { error } = await client()
        .storage.from(bucket)
        .upload(path, bytes, { contentType, upsert: false })
      return { error: error ? error.message : null }
    },
    async remove(bucket, paths) {
      const { error } = await client().storage.from(bucket).remove(paths)
      return { error: error ? error.message : null }
    },
  }
}
