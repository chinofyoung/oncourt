import 'server-only'

export type EmailMessage = { to: string; subject: string; html: string; text: string }

/**
 * `retryable` is the load-bearing field of this whole slice.
 *
 * It is what separates "Resend is down, try again in five minutes" from "that
 * address is malformed, stop". The ADAPTER classifies; the drainer obeys and
 * never re-derives. Keeping the judgement here means the drainer has no
 * provider-specific knowledge at all, which is what makes swapping providers a
 * one-file change.
 */
export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; retryable: boolean; error: string }

export type EmailProvider = { send(msg: EmailMessage): Promise<SendResult> }

/**
 * Mirrors PaymentConfigError in src/lib/payments/provider.ts rather than
 * importing it: a missing RESEND_API_KEY is not a payment configuration
 * problem, and an error class whose name lies is worse than one more
 * four-line class.
 */
export class EmailConfigError extends Error {}

export function requiredEmailEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new EmailConfigError(`${name} is not set`)
  return value
}

/**
 * 5xx is Resend's problem and will pass. 429 is a rate limit, which is the
 * most retryable thing there is — the free tier's 100/day cap surfaces here,
 * and a reminder batch is exactly the shape that trips it. Everything else in
 * the 4xx range is our problem (bad key, unverified domain, malformed address)
 * and will fail identically on every retry, so five attempts would just delay
 * the admin finding out.
 */
export function classifyStatus(status: number): boolean {
  return status >= 500 || status === 429
}
