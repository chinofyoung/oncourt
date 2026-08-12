import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { EmailPayload } from './payload'

/**
 * Structurally minimal so both `db` and a Drizzle transaction handle satisfy
 * it — the same type and the same reasoning as SqlExecutor in
 * src/lib/admin/settings.ts, verified there against drizzle-orm 0.45.2.
 */
export type SqlExecutor = { execute: typeof db.execute }

/**
 * Enqueue an email inside the CALLER'S transaction.
 *
 * `exec` is a parameter, not a captured `db`, and that is the entire design:
 * the enqueue must join the transaction that made the state change, so
 * "booking confirmed" and "receipt owed" commit or fail together. Passing `db`
 * here from inside a transaction would open a second connection and defeat it.
 *
 * `on conflict do nothing` against email_outbox_booking_kind_idx makes a
 * webhook replay a no-op at the DATABASE level rather than by care. It is
 * unconditional rather than kind-specific because the index is partial —
 * a row with a null booking_id (court_moderated) is not covered by it and so
 * can never conflict.
 *
 * This targetless form is only sound while email_outbox has exactly one
 * unique constraint (email_outbox_booking_kind_idx). A future migration
 * adding a second unique index/constraint on this table would silently
 * swallow violations of THAT one too — revisit this `on conflict` clause
 * (give it an explicit target, or a second statement) if that ever happens.
 */
export async function enqueueEmail(
  exec: SqlExecutor,
  input: {
    payload: EmailPayload
    recipient: string
    bookingId?: string | null
    courtId?: string | null
  },
): Promise<void> {
  await exec.execute(sql`
    insert into email_outbox (kind, recipient, payload, booking_id, court_id)
    values (
      ${input.payload.kind}::email_kind,
      ${input.recipient},
      ${JSON.stringify(input.payload)}::jsonb,
      ${input.bookingId ?? null}::uuid,
      ${input.courtId ?? null}::uuid
    )
    on conflict do nothing
  `)
}

/** Just the number, for the /admin nav badge. */
export async function getFailedEmailCount(): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as count from email_outbox where status = 'failed'
  `)
  return Number(result.rows[0].count)
}

export type FailedEmail = {
  id: string
  kind: string
  recipient: string
  attempts: number
  lastError: string | null
  createdOn: string
}

/**
 * The /admin/emails work list. NO LIMIT: this is the queue of emails that
 * never reached a paying customer, and a silent truncation would read as
 * "that's all of them" when it isn't — same reasoning as getFailedEmailCount
 * having no cap either. `email_outbox_failed_idx` (created_at where status =
 * 'failed') serves this query and the ordering both.
 *
 * `created_on` follows this codebase's one calendar-date convention
 * (to_char(... at time zone 'Asia/Manila', 'YYYY-MM-DD'), same as
 * src/lib/owner/reviews.ts's created_on) rather than handing back the raw
 * timestamptz, so the page can render it with formatDateLabel like every
 * other admin list.
 */
export async function getFailedEmails(): Promise<FailedEmail[]> {
  const result = await db.execute(sql`
    select id, kind, recipient, attempts, last_error,
           to_char(created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as created_on
    from email_outbox
    where status = 'failed'
    order by created_at desc
  `)
  return result.rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as string,
    recipient: row.recipient as string,
    attempts: Number(row.attempts),
    lastError: (row.last_error as string | null) ?? null,
    createdOn: row.created_on as string,
  }))
}

export type RetryResult = { ok: true } | { ok: false; reason: 'already_moved' }

/**
 * Requeue a failed row for another attempt by the next drain.
 *
 * STATUS-SCOPED UPDATE (`where id = ? and status = 'failed'`), the same shape
 * every other write in this codebase uses: `returning id` + `rows.length`,
 * never `rowCount` — an UPDATE with no `returning` reports zero rows
 * regardless of what it touched, which would make every successful retry
 * wrongly report failure. Zero rows here means the row already moved (sent by
 * a drain that ran in between, or retried already), not that the id was
 * wrong — the same "already handled" reading recordPaymentRefund's
 * already_recorded and retryEmailAction's guard both give.
 */
export async function retryEmail(id: string): Promise<RetryResult> {
  const result = await db.execute(sql`
    update email_outbox
    set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
    where id = ${id}::uuid and status = 'failed'
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'already_moved' }
}
