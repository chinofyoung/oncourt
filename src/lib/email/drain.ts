import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { EmailProvider } from './provider'
import { renderEmail } from './render'
import type { EmailPayload } from './payload'

/**
 * Attempt N waits BACKOFF_MINUTES[N-1] before the next try. A fixed list, not
 * a computed exponent: four values read more clearly as a list than as a
 * formula.
 *
 * MAX_ATTEMPTS IS DERIVED FROM THIS ARRAY'S LENGTH (+1), not a separate
 * literal -- this is the fix for a real review finding, not a style choice.
 * The LAST attempt is always terminal (a row that has just been marked
 * `failed` needs no `next_attempt_at` of its own), so only the first
 * `MAX_ATTEMPTS - 1` attempts ever consult this array -- exactly
 * `BACKOFF_MINUTES.length` of them, at indices `0..BACKOFF_MINUTES.length-1`.
 * That is precisely what the `+ 1` buys: every entry in this array is
 * genuinely reachable; none is dead weight.
 *
 * Before this fix, MAX_ATTEMPTS was its own literal (5) sized to a 5-entry
 * array that ALSO had 5 entries -- one too many, since only 4 of them could
 * ever be indexed. `BACKOFF_MINUTES[4]` (a documented 6-hour ceiling) was
 * declared but structurally unreachable, and if a future edit had bumped
 * MAX_ATTEMPTS to 6 without separately remembering to extend the array,
 * `BACKOFF_MINUTES[4]` would have evaluated to `undefined`, which
 * `make_interval(mins => undefined)` turns into `make_interval(mins => NULL)`,
 * which makes `next_attempt_at` NULL -- a NOT NULL violation on the marking
 * UPDATE inside processRow's transaction, rejecting that row's transaction.
 * Deriving MAX_ATTEMPTS here removes it as an independently-editable constant
 * altogether: the only way to change the number of attempts is to add or
 * remove an entry in THIS array, and the cap always tracks it exactly -- no
 * drift possible, and no dead entry left as a trap for the next person who
 * raises MAX_ATTEMPTS in isolation. Do NOT reintroduce a standalone
 * `export const MAX_ATTEMPTS = <number>`, and do NOT change this to
 * `BACKOFF_MINUTES.length` without the `+ 1` -- that reproduces the exact
 * same dead-last-entry shape this comment describes, just with a shorter
 * array.
 */
export const BACKOFF_MINUTES = [1, 5, 15, 60] as const
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1

export type DrainResult = { claimed: number; sent: number; retrying: number; failed: number }

type RowOutcome = 'sent' | 'retrying' | 'failed' | 'skipped'

/**
 * Claims, renders, sends, and marks exactly one email_outbox row, inside its
 * own read-committed transaction.
 *
 * The inner select filters on BOTH `id` AND `status = 'pending'`. Filtering
 * on `id` alone would be wrong: `for update skip locked` only guards against
 * a row another transaction currently holds locked — it says nothing about a
 * row that was locked, sent, and committed by another drain in the gap
 * between this drain's outer scan and this transaction's start. Once that
 * commit lands the row is unlocked again, and a bare `where id = ...` would
 * happily re-lock and resend it. Requiring `status = 'pending'` here makes
 * both cases — currently locked, and already finished — collapse into the
 * same "zero rows back, skip it" outcome.
 */
async function processRow(id: string, provider: EmailProvider): Promise<RowOutcome> {
  return db.transaction(
    async (tx) => {
      const claimed = await tx.execute(sql`
        select recipient, payload, attempts
        from email_outbox
        where id = ${id}::uuid and status = 'pending'
        for update skip locked
      `)
      if (claimed.rows.length === 0) return 'skipped'

      const row = claimed.rows[0]
      const attempts = Number(row.attempts)
      const recipient = row.recipient as string

      // A throwing renderEmail is non-retryable: a template bug throws
      // identically on every retry, so it must go terminal immediately with
      // the error preserved, and it must not take the rest of the batch
      // down — hence the try/catch scoped to just this row's transaction.
      let rendered: { subject: string; html: string; text: string }
      try {
        rendered = await renderEmail(row.payload as EmailPayload)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await tx.execute(sql`
          update email_outbox
          set status = 'failed', attempts = ${attempts + 1}, last_error = ${message}
          where id = ${id}::uuid
        `)
        return 'failed'
      }

      const result = await provider.send({
        to: recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      })

      if (result.ok) {
        await tx.execute(sql`
          update email_outbox
          set status = 'sent', sent_at = now(), provider_message_id = ${result.messageId},
              attempts = ${attempts + 1}, last_error = null
          where id = ${id}::uuid
        `)
        return 'sent'
      }

      // Indexed by the CURRENT attempt count, before incrementing: attempt 1
      // (attempts = 0 going in) waits BACKOFF_MINUTES[0] = 1 minute, not 5.
      const nextAttempts = attempts + 1
      if (result.retryable && nextAttempts < MAX_ATTEMPTS) {
        await tx.execute(sql`
          update email_outbox
          set attempts = ${nextAttempts},
              next_attempt_at = now() + make_interval(mins => ${BACKOFF_MINUTES[attempts]}),
              last_error = ${result.error}
          where id = ${id}::uuid
        `)
        return 'retrying'
      }

      await tx.execute(sql`
        update email_outbox
        set status = 'failed', attempts = ${nextAttempts}, last_error = ${result.error}
        where id = ${id}::uuid
      `)
      return 'failed'
    },
    { isolationLevel: 'read committed' },
  )
}

/**
 * Claim due rows, render, send, mark.
 *
 * ONE TRANSACTION PER ROW, not one for the batch. A batch-wide transaction
 * would hold every claimed row's lock for the duration of every HTTP call, so
 * one slow send would stall the queue — and a crash mid-batch would roll back
 * sends that already left Resend, producing duplicates on the retry.
 *
 * `for update skip locked` is what makes concurrent drains safe: two runs
 * never claim the same row and neither blocks the other. (An advisory lock
 * would serialize the whole queue; skip-locked is the right primitive for a
 * work queue, unlike preparePayout's per-owner lock.)
 */
export async function drainOutbox(provider: EmailProvider, limit = 25): Promise<DrainResult> {
  const due = await db.execute(sql`
    select id from email_outbox
    where status = 'pending' and next_attempt_at <= now()
    order by next_attempt_at
    limit ${limit}
  `)

  const result: DrainResult = { claimed: 0, sent: 0, retrying: 0, failed: 0 }

  for (const candidate of due.rows) {
    let outcome: RowOutcome
    try {
      outcome = await processRow(candidate.id as string, provider)
    } catch (error) {
      // Unreachable from either EmailProvider implementation shipped today --
      // fakeProvider and resendProvider both RETURN a `{ ok: false, ... }`
      // result rather than throwing, and a throwing renderEmail is already
      // caught INSIDE processRow's own transaction (see the try/catch around
      // `rendered = await renderEmail(...)` above). What CAN still throw here
      // is one of processRow's `tx.execute` calls itself -- e.g. a Supavisor
      // pooler connection dropped mid-transaction. Without this catch, that
      // single row's rejection would propagate out of `await processRow(...)`
      // uncaught, aborting this `for` loop and silently dropping every
      // remaining row in `due` for this tick. One bad row must cost one row,
      // not the batch: count it the same way a real `failed` outcome would be
      // counted for this tick's telemetry, log it, and move on. The row
      // itself is untouched in the database -- its own transaction rolled
      // back -- so it stays exactly as due as it was, and the next tick picks
      // it straight back up rather than losing it.
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[email/drain] row ${candidate.id} threw outside its own handling`, { message })
      result.claimed++
      result.failed++
      continue
    }
    if (outcome === 'skipped') continue
    result.claimed++
    result[outcome]++
  }

  return result
}
