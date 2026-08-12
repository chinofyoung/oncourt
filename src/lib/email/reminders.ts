import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { enqueueEmail } from './outbox'
import type { BookingEmailFacts } from './payload'

/**
 * Called once a day (07:00 Manila / 23:00 UTC per the design spec's
 * Scheduling section) by /api/cron/enqueue-reminders (GET or POST — see that
 * route's own comment for why both verbs are exported).
 *
 * Selects every CONFIRMED booking whose `starts_at` falls on today's Manila
 * calendar date AND has not started yet, joins it to the court, branch, and
 * player facts the `booking_reminder` template needs, and enqueues one email
 * per booking.
 *
 * TWO CONDITIONS, NOT ONE: `starts_at > now()` is not redundant with the date
 * filter. Seeded courts open at 11:00, but nothing stops an owner setting a
 * 06:00 opening hour, and a "you play today" email for a session already
 * underway is worse than none. Both are evaluated in SQL against the
 * database's own clock — never a JS Date — the same reasoning
 * src/lib/payments/webhook.ts's handlePaidEvent applies to `ends_at <= now()`.
 *
 * SAFE TO RETRY: email_outbox_booking_kind_idx is a partial unique index on
 * (kind, booking_id), and enqueueEmail's `on conflict do nothing` makes a
 * second run of this same day's batch a no-op at the database level — no
 * duplicate reminder, no error. `enqueued` counts every booking THIS RUN
 * found eligible and attempted to enqueue, not rows actually inserted (this
 * function has no visibility into which attempts were deduped); on a retried
 * run that number is the same as the first run's, while the outbox itself
 * gains no new rows.
 *
 * Built in TypeScript, not `jsonb_build_object` in SQL — the whole reason this
 * is a Route Handler rather than a `pg_cron` job (design spec, "Scheduling").
 */
export async function enqueueDayOfReminders(): Promise<{ enqueued: number }> {
  const rows = await db.execute(sql`
    select
      bk.id as booking_id,
      to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as booked_on,
      extract(hour from (bk.starts_at at time zone 'Asia/Manila'))::int as start_hour,
      case
        when (bk.ends_at at time zone 'Asia/Manila')
             = date_trunc('day', bk.ends_at at time zone 'Asia/Manila')
          then 24
        else extract(hour from (bk.ends_at at time zone 'Asia/Manila'))::int
      end as end_hour,
      bk.total_charged_centavos,
      br.name as branch_name, c.name as court_name,
      player.email as player_email, player.full_name as player_name
    from bookings bk
    join courts c on c.id = bk.court_id
    join branches br on br.id = bk.branch_id
    join profiles player on player.id = bk.player_id
    where bk.status = 'confirmed'
      and to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD')
        = to_char(now() at time zone 'Asia/Manila', 'YYYY-MM-DD')
      and bk.starts_at > now()
  `)

  let enqueued = 0
  for (const row of rows.rows) {
    const bookingId = row.booking_id as string
    const facts: BookingEmailFacts = {
      playerName: row.player_name as string | null,
      branchName: row.branch_name as string,
      courtName: row.court_name as string,
      bookedOn: row.booked_on as string,
      startHour: Number(row.start_hour),
      endHour: Number(row.end_hour),
      totalChargedCentavos: Number(row.total_charged_centavos),
      bookingId,
    }
    await enqueueEmail(db, {
      payload: { kind: 'booking_reminder', booking: facts },
      recipient: row.player_email as string,
      bookingId,
    })
    enqueued++
  }

  return { enqueued }
}
