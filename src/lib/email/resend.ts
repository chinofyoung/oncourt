import 'server-only'
import { Resend } from 'resend'
import {
  classifyStatus,
  requiredEmailEnv,
  EmailConfigError,
  type EmailMessage,
  type EmailProvider,
  type SendResult,
} from './provider'

/**
 * Resend's ErrorResponse -> our SendResult. Pure and exported ONLY so the
 * classification can be tested without mocking the SDK: this mapping is the
 * load-bearing decision in this file, and `statusCode: null` (which the SDK
 * returns for network-level failures it swallows internally, rather than
 * throwing) must classify as RETRYABLE. Getting that backwards abandons a
 * paid player's receipt on a transient blip.
 *
 * Verified against resend@6.19.0's shipped type declarations
 * (node_modules/resend/dist/index.d.mts) and its compiled source
 * (dist/index.cjs): ErrorResponse is `{ message: string; statusCode: number |
 * null; name: string }`, NOT `statusCode?: number`. The SDK sets statusCode to
 * a real HTTP status for every error that came from an actual response
 * (parsed error body, or response.status when the body didn't parse) — but to
 * `null` specifically when fetch() itself threw (DNS, TCP, timeout) and
 * fetchRequest's outer catch built a synthetic error instead of rethrowing.
 * So `null` here means "the network case," not "unknown, assume the worst" —
 * and it is exactly the case that must retry, since a transient fault retried
 * five times is cheap while a real receipt abandoned on the first hiccup is
 * not.
 */
export function classifyResendError(error: { statusCode: number | null; name: string; message: string }): SendResult {
  const status = error.statusCode
  return {
    ok: false,
    retryable: status === null ? true : classifyStatus(status),
    error: `${error.name}: ${error.message}`,
  }
}

/**
 * The only file in this codebase that knows Resend exists.
 *
 * Constructed lazily inside send() rather than at module scope: reading
 * RESEND_API_KEY at import time would make every module that transitively
 * imports this one throw at build time on a machine without the key set.
 */
export function resendProvider(): EmailProvider {
  return {
    async send(msg: EmailMessage): Promise<SendResult> {
      try {
        const resend = new Resend(requiredEmailEnv('RESEND_API_KEY'))
        const { data, error } = await resend.emails.send({
          from: requiredEmailEnv('EMAIL_FROM'),
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        })

        if (error) return classifyResendError(error)
        if (!data?.id) {
          // Unreachable under the SDK's current types — CreateEmailResponseSuccess.id
          // is a required `string`, never absent on a non-error response. Kept
          // as cheap insurance against the SDK breaking that contract in a
          // future version, not as a case this codebase has ever observed.
          return { ok: false, retryable: true, error: 'Resend returned no message id' }
        }
        return { ok: true, messageId: data.id }
      } catch (cause) {
        // Reachable only for EmailConfigError (a missing env var thrown by
        // requiredEmailEnv before the request is built) or a truly
        // unanticipated exception — resend.emails.send() itself does not
        // throw on network failure, it returns one via `error` above. A
        // config error is NOT retryable — it will fail identically forever.
        const message = cause instanceof Error ? cause.message : String(cause)
        return { ok: false, retryable: cause instanceof EmailConfigError ? false : true, error: message }
      }
    },
  }
}
