/**
 * Public URLs for objects in the `branch-photos` and `court-photos` buckets.
 *
 * Both buckets are created `public` (supabase/migrations/*_storage_and_cron.sql),
 * so the URL is deterministic and needs no client, no signing, and no round
 * trip. Built by hand rather than through supabase-js's
 * `storage.from(b).getPublicUrl(p)` so this module stays importable from a
 * Server Component without instantiating a client.
 *
 * NEXT_PUBLIC_SUPABASE_URL is deliberately the public env var: these URLs end
 * up in <img src> and are meant to be fetched by the browser.
 */

export type PhotoBucket = 'branch-photos' | 'court-photos'

export function photoUrl(
  bucket: PhotoBucket,
  storagePath: string | null | undefined,
): string | null {
  if (!storagePath) return null
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  return `${base.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/${storagePath}`
}
