import 'server-only'
import type { EmailMessage, EmailProvider, SendResult } from './provider'

export type RecordedEmail = EmailMessage

/**
 * The test double for every email test in this codebase. Zero Resend quota is
 * consumed by the suite — which matters concretely, because the free tier is
 * 100 sends a day and this suite runs many times a day.
 *
 * Lives in src/ rather than tests/ because src/lib/email/drain.ts takes an
 * EmailProvider parameter and a fixture importing across that boundary would
 * invert the dependency.
 */
export function fakeProvider(opts?: {
  failWith?: { retryable: boolean; error: string }
  /** Fail this many times, then start succeeding. Omit to fail forever. */
  failTimes?: number
}): EmailProvider & { sent: RecordedEmail[] } {
  const sent: RecordedEmail[] = []
  let failures = 0

  return {
    sent,
    async send(msg: EmailMessage): Promise<SendResult> {
      if (opts?.failWith) {
        const exhausted = opts.failTimes !== undefined && failures >= opts.failTimes
        if (!exhausted) {
          failures++
          return { ok: false, ...opts.failWith }
        }
      }
      sent.push(msg)
      return { ok: true, messageId: `fake_${sent.length}_${crypto.randomUUID()}` }
    },
  }
}
