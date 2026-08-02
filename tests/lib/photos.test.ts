import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { photoUrl } from '@/lib/photos'

describe('photoUrl', () => {
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL

  beforeAll(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  })

  afterAll(() => {
    // Node coerces `process.env.X = undefined` to the string "undefined"
    // rather than deleting the key, so an unset original value must be
    // restored with `delete`, not assignment.
    if (originalSupabaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl
    }
  })

  it('builds a public object URL', () => {
    expect(photoUrl('branch-photos', 'branches/abc/1.jpg')).toBe(
      'https://example.supabase.co/storage/v1/object/public/branch-photos/branches/abc/1.jpg',
    )
  })

  it('tolerates a trailing slash on the base URL', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co/'
    expect(photoUrl('court-photos', 'courts/x/1.jpg')).toBe(
      'https://example.supabase.co/storage/v1/object/public/court-photos/courts/x/1.jpg',
    )
  })

  it('returns null when there is no path', () => {
    expect(photoUrl('branch-photos', null)).toBeNull()
    expect(photoUrl('branch-photos', undefined)).toBeNull()
    expect(photoUrl('branch-photos', '')).toBeNull()
  })
})
