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

/**
 * Upload rules, kept HERE rather than in src/lib/listings/photos.ts because
 * this module is pure and that one is `server-only`: the file input's
 * `accept` attribute and the "up to 5 MB" hint are rendered by a client
 * component, which cannot import a server-only module without throwing at
 * runtime. The server-side check is still the real one — an `accept`
 * attribute is a browser hint a hand-crafted POST ignores entirely.
 */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024

export const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

/** MIME type -> the extension the stored object gets. Keys match ALLOWED_PHOTO_TYPES. */
export const PHOTO_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}
