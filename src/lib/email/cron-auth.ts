import 'server-only'
import { timingSafeEqual } from 'node:crypto'

const BEARER_PREFIX = 'Bearer '

/**
 * What stands in for a session guard on the two cron Route Handlers
 * (src/app/api/cron/drain-email/route.ts, src/app/api/cron/enqueue-
 * reminders/route.ts): their caller is an external scheduler, not a browser
 * with a session, so no `requireUser`/`requireAdmin`-style guard applies.
 * Instead, the caller must present the same bearer secret this deployment
 * holds.
 *
 * `CRON_SECRET` is read HERE, inside the function, not at module scope — the
 * same reasoning as PAYMONGO_WEBHOOK_SECRET in src/lib/payments/paymongo.ts
 * and RESEND_API_KEY in src/lib/email/resend.ts: reading it at import time
 * would make every module that transitively imports this one throw at build
 * time on a machine without the secret set.
 *
 * `timingSafeEqual` throws (rather than returning false) when its two buffers
 * differ in length, so the length check must happen first — a missing
 * header, a malformed one, or one of the wrong length are all treated as
 * "not authorized", never as a thrown error.
 */
export function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false

  const header = request.headers.get('authorization')
  if (!header || !header.startsWith(BEARER_PREFIX)) return false

  const provided = header.slice(BEARER_PREFIX.length)

  const expected = Buffer.from(secret)
  const actual = Buffer.from(provided)
  if (expected.length !== actual.length) return false

  return timingSafeEqual(expected, actual)
}
