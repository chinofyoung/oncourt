import { isAuthorizedCron } from '@/lib/email/cron-auth'
import { enqueueDayOfReminders } from '@/lib/email/reminders'

/**
 * A ROUTE HANDLER, NOT A SERVER ACTION -- it carries no `'use server'`
 * directive and is therefore exempt from tests/auth/action-coverage.test.ts
 * BY CONSTRUCTION. That test globs the whole src tree and then skips any file
 * without a 'use server' directive; this file has none, and must never be
 * given one. It could not satisfy that test in any case: the caller is an
 * external scheduler (Vercel Cron, GitHub Actions, cron-job.org, or a local
 * curl -- see the design spec's "Scheduling" section), which has no session,
 * so no session guard is applicable and none may be added. See
 * src/app/api/webhooks/paymongo/route.ts:5-16 for the precedent this mirrors.
 *
 * What stands in for a guard: a bearer `CRON_SECRET`, compared timing-safely
 * in src/lib/email/cron-auth.ts.
 *
 * node:crypto (inside isAuthorizedCron) needs the Node runtime. That is the
 * App Router default for Route Handlers, but it is pinned here rather than
 * assumed, matching the webhook route.
 */
export const runtime = 'nodejs'

async function handle(request: Request): Promise<Response> {
  if (!isAuthorizedCron(request)) {
    return new Response('Unauthorized', { status: 401 })
  }
  const result = await enqueueDayOfReminders()
  // `eligible`, NOT `enqueued`: enqueueDayOfReminders's own doc comment is
  // explicit that this number counts bookings found eligible and ATTEMPTED
  // this run, not rows actually inserted (the partial unique index silently
  // dedupes a replay via `on conflict do nothing`, and this function has no
  // visibility into which attempts that swallowed). `enqueued` in a cron log
  // reads as "N new emails queued" to an operator -- on the second run of the
  // same day's batch this number REPEATS while the outbox gains zero new
  // rows, which looks like a bug. Renaming only the JSON key here keeps
  // enqueueDayOfReminders's own return shape and reasoning untouched.
  return Response.json({ eligible: result.enqueued })
}

/**
 * BOTH VERBS, ONE HANDLER. The bearer check is method-agnostic, so exposing
 * GET alongside POST is purely additive -- POST keeps working unchanged.
 *
 * WHY BOTH: the design spec originally documented POST only and named Vercel
 * Cron as one of three interchangeable hosts, but Vercel Cron invokes its
 * target with a GET request and cannot be configured to send POST. On that
 * host a POST-only handler would return 405 while presenting a perfectly
 * valid bearer token -- and the failure would be silent: no reminders would
 * ever enqueue, and there is no badge or counter anywhere that would visibly
 * drop to reveal it. GitHub Actions, cron-job.org, and a plain container
 * cron can all call either verb, so POST stays exported too rather than
 * being replaced. Do NOT "tidy up" the GET export away -- that silently
 * breaks Vercel Cron specifically, with no error anywhere to catch it.
 */
export const GET = handle
export const POST = handle
