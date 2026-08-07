import { describe, expect, it } from 'vitest'
import nextConfig from '../../next.config'
import { MAX_PHOTO_BYTES } from '@/lib/photos'

/**
 * Next.js caps Server Action request bodies at 1 MB by default, which is
 * below this app's own MAX_PHOTO_BYTES (5 MB) — see the comment on
 * `SERVER_ACTION_BODY_SIZE_LIMIT_BYTES` in next.config.ts. This test exists
 * so nobody can "clean up" next.config.ts back to an empty config (or drop
 * the bodySizeLimit override) without a test failure, since that regression
 * has no type error and no lint warning to catch it.
 */
describe('next.config serverActions.bodySizeLimit', () => {
  it('is at least MAX_PHOTO_BYTES, with room for multipart overhead', () => {
    const limit = nextConfig.experimental?.serverActions?.bodySizeLimit
    expect(limit).toBeDefined()

    const limitBytes = parseSizeLimit(limit!)

    expect(limitBytes).toBeGreaterThanOrEqual(MAX_PHOTO_BYTES)
    // Not just >=, but with real headroom for multipart boundaries/headers,
    // the other form fields, and the Server Action payload — see
    // next.config.ts for why exactly-equal would still reject valid uploads.
    expect(limitBytes).toBeGreaterThan(MAX_PHOTO_BYTES)
  })
})

/** Mirrors Next's own SizeLimit type: a byte count, or a string like '6mb'. */
function parseSizeLimit(limit: number | string): number {
  if (typeof limit === 'number') return limit

  const match = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)$/i.exec(limit.trim())
  if (!match) {
    throw new Error(`Unrecognized SizeLimit format: ${limit}`)
  }

  const value = Number(match[1])
  const unit = match[2].toLowerCase()
  const multiplier = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit]!
  return value * multiplier
}
