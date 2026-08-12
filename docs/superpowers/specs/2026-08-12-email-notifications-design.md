# Email Notifications (Resend) — Design Spec

**Date:** 2026-08-12
**Status:** Approved design, pending implementation plan
**Slice:** The product spec's Notifications table
(`docs/superpowers/specs/2026-07-31-pickleball-court-booking-platform-design.md`,
"Notifications (email, via Resend)")

## Why this slice

The product spec lists five lifecycle emails and names email notifications as
an MVP goal. **None of it exists.** There is no email module in `src/lib`, no
Resend dependency, and no `RESEND_API_KEY`. A player pays and gets nothing but
an on-screen confirmation; an owner learns about a booking only by opening the
dashboard; a court is approved or rejected and its owner is never told.

The five emails, from the product spec:

| Event | Recipient |
|---|---|
| Booking confirmed + receipt | Player |
| New booking | Owner |
| Day-of reminder | Player |
| Court approved / rejected (with reason) | Owner |
| Booking refund recorded | Player |

All five are in scope.

## Decisions

| Question | Decision |
|---|---|
| How the email gets sent | An `email_outbox` table written in the same transaction as the state change, drained by a separate worker. |
| What schedules the drainer | A `CRON_SECRET`-guarded Route Handler called by an external scheduler. |
| Template engine | React Email. |
| Provider seam | An `EmailProvider` interface with a Resend adapter and a recording fake, mirroring `PaymentProvider`. |
| Day-of reminder timing | One morning batch at a fixed Manila hour (07:00). |
| Failed-email visibility | A badged queue at `/admin/emails` with a retry action. |
| What the outbox row holds | A snapshot of the template's input data, rendered at drain time. |

### Why an outbox rather than a direct send

`webhook.ts:38-43` already anticipated email and drew the right line: nothing
that can fail on a third party may happen inside the confirming transaction.
A direct send after commit honours that, but loses the email with no record if
Resend is down or the process dies in the gap — and the player has already
paid.

The outbox moves the atomic boundary to the right place. "This booking is
confirmed" and "this player is owed a receipt" commit or fail **together**,
because an INSERT into a local table cannot hang on a third party. The send
then happens outside any transaction, where a failure is a retry rather than a
lost receipt.

This does not contradict `webhook.ts`'s comment — enqueue is not send. That
comment gets amended to draw the distinction rather than deleted.

### Why snapshot the data, not the rendered HTML

The row stores `kind` plus a JSONB payload of exactly the fields the template
needs, and the drainer renders. Two alternatives were rejected:

- **Render at enqueue** (store finished HTML) bakes a template bug into every
  pending row and makes rows fat.
- **Store only `{kind, booking_id}`** would make the drainer re-read data that
  may have changed since — a receipt could render from mutated state.

Snapshotting the *inputs* is the pattern this codebase already uses twice:
`bookings.fee_config_snapshot` and `payout_bookings.net_centavos` both exist so
later changes cannot rewrite history. A receipt shows what was true when
payment landed even if the booking is later refunded, and a template typo found
after enqueueing is still fixed by a retry.

## Schema

One migration, idempotent (`create table if not exists`; `do $$ … $$` blocks
checking `pg_type` for the enums). Inline table constraints inside
`create table if not exists` are idempotent for free.

### New enums

```sql
create type email_kind as enum (
  'booking_confirmed',  -- player: receipt
  'booking_new',        -- owner: someone booked your court
  'booking_reminder',   -- player: you play today
  'court_moderated',    -- owner: approved, or rejected with reason
  'refund_recorded'     -- player: your refund was processed
);

create type email_status as enum ('pending', 'sent', 'failed');
```

Both are brand-new types, so creating and using them in one migration file is
safe — the 55P04 restriction applies only to values added to an existing type
via `alter type … add value`. Same precedent as `payment_status` and
`payout_line_kind`.

### `email_outbox`

```sql
create table if not exists email_outbox (
  id uuid primary key default gen_random_uuid(),
  kind email_kind not null,

  -- Snapshotted, not joined at send time: a profile's email address can
  -- change, and a receipt must go where it was owed when it was owed.
  recipient text not null,

  -- Exactly what the template needs, snapshotted at enqueue. Typed in
  -- TypeScript as a discriminated union keyed on `kind`.
  payload jsonb not null,

  -- What this email is about. Both nullable: a booking email has no court_id,
  -- and a court-moderation email has no booking. No `on delete` clause
  -- (Postgres default NO ACTION / RESTRICT), matching every other FK in this
  -- schema.
  booking_id uuid references bookings (id),
  court_id uuid references courts (id),

  status email_status not null default 'pending',
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  provider_message_id text,

  created_at timestamptz not null default now(),
  sent_at timestamptz,

  -- sent iff timestamped, the same shape as payouts_paid_has_timestamp.
  constraint email_outbox_sent_has_timestamp
    check ((status = 'sent') = (sent_at is not null))
);
```

### Indexes

```sql
-- THE IDEMPOTENCY PRIMITIVE, for the booking-linked kinds it actually fits.
-- At most one receipt per booking, at most one owner-notification per
-- booking, at most one reminder per booking. Enqueue uses
-- `on conflict do nothing`, so a webhook replay is a no-op at the database
-- level rather than by care -- the same trick payments.provider_ref already
-- plays.
--
-- Partial, and TWO kinds are deliberately OUTSIDE it:
--   court_moderated: court_id carries no uniqueness, because a court can be
--     edited, requeued to pending, and approved again, and its owner should
--     hear each time.
--   refund_recorded: this kind is per-PAYMENT, not per-booking. A booking can
--     carry more than one paid payment (double_charge, not_payable, and
--     amount_mismatch all produce this shape), and refunding each one is its
--     own email -- refunding the payment that didn't fund the booking says
--     "your booking stands"; refunding the one that did says "your booking is
--     cancelled." Booking-scoped dedup would let the FIRST refund's row
--     silently swallow the second via `on conflict do nothing`, leaving the
--     player holding an email that asserts the opposite of what actually
--     happened. Idempotency for refunds does not live in this index at all --
--     it lives one layer up, in recordPaymentRefund's own
--     `refunded_at is null and status = 'paid'` guard, which a replay never
--     gets past.
create unique index if not exists email_outbox_booking_kind_idx
  on email_outbox (kind, booking_id)
  where booking_id is not null and kind <> 'refund_recorded';

-- The drain query's index. Partial on a mostly-not-pending column.
create index if not exists email_outbox_due_idx
  on email_outbox (next_attempt_at) where status = 'pending';

-- The admin queue.
create index if not exists email_outbox_failed_idx
  on email_outbox (created_at) where status = 'failed';

-- Index every FK explicitly; the partial unique index above leads on `kind`
-- and so does not serve a booking_id lookup.
create index if not exists email_outbox_booking_id_idx on email_outbox (booking_id);
create index if not exists email_outbox_court_id_idx on email_outbox (court_id);
```

### RLS

`enable row level security` with **zero policies**, like every other table. No
`force row level security`.

## Enqueue points

Every enqueue runs **inside the caller's existing transaction**, via
`enqueueEmail(tx, …)` which takes the transaction handle rather than opening
its own.

| Kind | Site | Condition |
|---|---|---|
| `booking_confirmed` | `src/lib/payments/webhook.ts` | inside the transaction, when `CONFIRMING_OUTCOMES.has(outcome)` |
| `booking_new` | same site, same condition | recipient is the branch owner |
| `court_moderated` | `src/lib/admin/write.ts` — `approveCourt` / `rejectCourt` | on a transition that updated a row |
| `refund_recorded` | `src/lib/refunds/write.ts` — `recordPaymentRefund` | on a successful refund where the booking has a `player_id` |
| `booking_reminder` | `/api/cron/enqueue-reminders` (GET or POST — see Scheduling) | confirmed bookings starting today, Manila |

Notes:

- **`court_moderated` covers both approve and reject.** One kind, with the
  outcome and the rejection reason in the payload — they are the same email
  with a different verdict, and splitting them would duplicate a template.
- **`suspendCourt` and `unsuspendCourt` deliberately do not email**, even
  though they live in the same module and it would be one line each. The
  product spec's table lists approval and rejection only. Suspension is an
  enforcement action an admin normally pairs with direct contact, and an
  automated "your court was suspended" with no explanation would be worse than
  silence. Wire two of the four transitions, not all four.
- **`booking_new` goes to the branch owner only.** Branch staff holding
  `view_bookings` are not emailed; the product spec's table says Owner, and
  per-staff notification preferences are a feature nobody has asked for.
- **`refund_recorded` fires even for an orphan payment** (one whose booking
  never confirmed). The player's money is being returned either way and they
  should hear about it; the payload carries whether the booking itself was
  cancelled.
- **Blocks are excluded** by the `player_id` condition — a `blocked` row has no
  player and no money.

## Scheduling

Two Route Handlers, each guarded by a bearer `CRON_SECRET` and each exported
under **both `GET` and `POST`** from a single shared handler function (one
implementation, two thin exports — not a copy):

- **`/api/cron/drain-email`** — every 1–2 minutes. Claims and sends.
- **`/api/cron/enqueue-reminders`** — daily at 07:00 Manila (23:00 UTC).
  Enqueues `booking_reminder` for every booking where `status = 'confirmed'`,
  `starts_at` falls on **today's Manila calendar date**, and
  **`starts_at > now()`**. The second condition is not redundant: seeded courts
  open at 11:00, but nothing stops an owner setting a 06:00 opening hour, and a
  "you play today" email for a session already underway is worse than none.

**Why both verbs are exported.** An earlier version of this spec documented
`POST` only. That was a self-contradiction: this same section already named
Vercel Cron as one of three interchangeable hosts, but **Vercel Cron invokes
its target with a GET request and cannot be configured to send POST.** On
that host a POST-only handler returns 405 while presenting a perfectly valid
bearer token — and the failure is silent, since nothing about a 405 shows up
as a drained email or a failed one: no emails ever drain, nothing ever reaches
`failed`, and the `/admin/emails` badge stays at zero, looking healthy rather
than broken. The bearer check in `cron-auth.ts` is method-agnostic, so
exporting `GET` alongside `POST` is purely additive. GitHub Actions,
cron-job.org, and a plain container cron can call either verb, so `POST`
stays exported too rather than being replaced — do not "tidy up" the `GET`
export away; that would silently break Vercel Cron specifically, with no
error anywhere to surface it.

Whatever the app is eventually hosted on calls these — Vercel Cron, GitHub
Actions, and cron-job.org are interchangeable, and now genuinely so. Locally,
a scratch script or `curl` (either verb) drains.

**`pg_cron` is deliberately not used**, even though it is installed and already
runs two jobs. Two reasons: it cannot make HTTP calls (`pg_net` is not
installed), and enqueueing reminders from SQL would mean building the JSONB
payload with `jsonb_build_object` — putting template-data assembly in the
database, against this project's rule that logic lives in TypeScript. Both
endpoints keep every payload in typed TypeScript.

A booking made after the morning batch gets no reminder. That is acceptable and
deliberate: the player just booked it.

## Modules

Six focused modules under `src/lib/email/`, following the existing read/write
module split:

- **`provider.ts`** — the interface, no implementation:

  ```ts
  export type EmailMessage = { to: string; subject: string; html: string; text: string }
  export type SendResult =
    | { ok: true; messageId: string }
    | { ok: false; retryable: boolean; error: string }
  export type EmailProvider = { send(msg: EmailMessage): Promise<SendResult> }
  ```

  `retryable` is the load-bearing field. It is what separates "Resend is down,
  try again in five minutes" from "that address is malformed, stop." The
  adapter classifies; the drainer obeys and never re-derives.

- **`resend.ts`** — the Resend adapter. Network errors, 5xx, and 429 are
  retryable; 4xx other than 429 is not.

- **`templates/`** — React Email components, one per kind, over a shared layout
  carrying the wordmark and footer. Every email renders a plain-text part as
  well as HTML; HTML-only mail is a spam-filter signal.

- **`render.ts`** — `renderEmail(payload) → { subject, html, text }`. (`kind`
  lives inside `payload` itself, as the discriminant of the union below — it
  is not a second argument.)

  The payload type is a **discriminated union keyed on `kind`**. This is what
  makes the whole design type-safe end to end: TypeScript enforces that every
  kind has a template and that every enqueue site passes the matching shape. A
  new kind without a template does not compile.

- **`outbox.ts`** — `enqueueEmail(tx, …)` plus the claim and status-transition
  queries.

- **`drain.ts`** — `drainOutbox(provider, limit)`.

The Route Handlers stay thin: verify `CRON_SECRET`, call the lib, return a
count. All logic and all SQL live under `src/lib/email/`.

## The drain loop

The shipped implementation is a **two-phase claim**, not the single batch-wide
`for update skip locked` an earlier version of this spec showed:

```
scan          → select id from email_outbox
                where status = 'pending' and next_attempt_at <= now()
                order by next_attempt_at
                limit ${limit}
                -- UNLOCKED. Just a list of candidate ids.

per candidate → one transaction per row:
  reselect      → select recipient, payload, attempts from email_outbox
                  where id = ${id} and status = 'pending'
                  for update skip locked
                  -- zero rows back means either currently locked by another
                  -- drain, OR already claimed-sent-and-committed by another
                  -- drain since the unlocked scan above ran. Both collapse to
                  -- the same "skip it" outcome.
  render        → renderEmail(payload)
  send          → provider.send(...)
  mark          → per outcome, below, in the SAME per-row transaction
```

**Why not one batch-wide `for update skip locked` claim.** That shape is the
double-send race this design closes, not a simplification of it: `for update
skip locked` only guards a row another transaction currently holds locked — it
says nothing about a row that was locked, sent, and committed by another drain
in the gap between one drain's scan and another's. Once that commit lands the
row is unlocked again, and a single unconditional batch claim would happily
re-claim and resend it. Re-checking `status = 'pending'` inside each row's own
transaction, immediately before that row's own `for update skip locked`, is
what makes "currently locked" and "already finished by someone else" collapse
into the identical, safe "zero rows back, skip it" outcome. One transaction
per row also means a slow send never holds a batch-wide lock, and a crash
mid-batch cannot roll back sends that already left Resend. Do not "simplify"
this back to a single batch claim — see `src/lib/email/drain.ts`'s own comment
on `processRow` for the same reasoning in code.

| Outcome | Effect |
|---|---|
| `ok: true` | `status = 'sent'`, `sent_at = now()`, `provider_message_id` |
| `ok: false, retryable: true` | `attempts + 1`; `next_attempt_at` per the ladder; `last_error`. At 5 attempts → `failed`. |
| `ok: false, retryable: false` | `status = 'failed'`, `last_error`, no further attempts |
| `renderEmail` throws | `status = 'failed'`, `last_error` — a template bug is not retryable |

Backoff ladder, by attempt number: **1m, 5m, 15m, 1h.** Fixed, not
computed — four values are clearer read as a list than derived from a formula.
`MAX_ATTEMPTS` (5) is **derived** from this list's length (`+ 1`, since the
5th and last attempt is always terminal and needs no wait of its own) rather
than a separate literal, specifically so the two cannot drift out of sync —
see `src/lib/email/drain.ts`'s comment on `BACKOFF_MINUTES` for the bug this
closes: an earlier version of this ladder carried a fifth, 6-hour entry that
was declared but structurally unreachable under this same terminal-attempt
rule, and a future change to `MAX_ATTEMPTS` alone (without a matching change
to the ladder) would have made the last real attempt's backoff lookup read
past the end of the array.

## Admin surface

**`/admin/emails`** — the sixth nav item, badged with the `failed` count
exactly as `/admin/refunds` is badged with flagged payments.

The list shows kind, recipient, attempts, last error, and when it was created,
newest first. Each row carries a **Retry** action resetting `status = 'pending'`,
`attempts = 0`, `next_attempt_at = now()`, so the next drain picks it up. The
action is status-scoped to `failed` — zero rows means "it already moved," the
shape every other write in this codebase uses.

Empty state reads as reassurance, not absence — an empty failed queue is the
good state.

No pagination, matching every other admin list.

## Error handling and edge cases

| Case | Behavior |
|---|---|
| Webhook replay | `on conflict do nothing` on `(kind, booking_id)` — no duplicate receipt, no error |
| Resend down when a booking confirms | Booking confirms normally; the row waits and retries |
| Process dies between commit and drain | Row is still `pending`; the next drain sends it |
| Two drains overlap | `skip locked` — each row claimed once, neither blocked |
| A template throws on one row | That row goes `failed`; the rest of the batch still sends |
| Malformed recipient address | Non-retryable → `failed` immediately, visible in `/admin/emails` |
| Booking refunded between reminder enqueue and send | Reminder still sends — the payload is a snapshot, and suppressing it would mean re-reading state at drain time, the design this spec rejects. The exposure is **minutes, not hours**: the batch enqueues at 07:00 and the drain runs every 1–2 minutes, so a refund lands inside that window only by coincidence. A refund *after* the reminder has sent is not this system's problem — the mail was already accurate when sent |
| Court re-approved after an edit | A second `court_moderated` row, deliberately — no uniqueness on `court_id` |
| `CRON_SECRET` missing or wrong | 401, nothing drained |

## Testing

Against the hosted Supabase project over the Supavisor session pooler (port
5432). The database is shared and persistent: tests must pass on repeated runs
and must not mutate seeded singletons.

**The recording fake provider is what makes this testable without touching
Resend.** Zero quota is consumed by the suite.

- **Templates** (`tests/email/render.test.ts`) — pure assertions on rendered
  output: the court name appears, money is formatted `₱`-style via
  `formatPeso`, the date renders in Manila time, the rejection reason appears
  in a rejection email and not an approval, and a `text` part exists and is
  non-empty for every kind.
- **Outbox** (`tests/email/outbox.test.ts`) — enqueue inside a transaction and
  roll back, proving atomicity; the unique index rejects a duplicate; `on
  conflict do nothing` makes a replay a no-op; a `court_moderated` pair for one
  court is permitted.
- **Drain** (`tests/email/drain.test.ts`) — claims only rows that are due;
  marks sent with a message id; a retryable failure increments `attempts` and
  pushes `next_attempt_at`; a non-retryable failure goes terminal in one step;
  the 5th attempt goes terminal; a throwing template goes terminal without
  taking the batch down.
- **Concurrency** — two parallel `drainOutbox` calls over one set of due rows;
  assert every row is sent exactly once and the fake recorded no duplicate.
- **Route guards** (`tests/email/routes.test.ts`) — both endpoints return 401
  for a missing and for a wrong `CRON_SECRET`.
- **Schema** (`tests/schema/email-outbox.test.ts`) — the sent/`sent_at`
  biconditional rejects both violating shapes; `attempts >= 0` holds.
- **Authorization** — the existing `tests/auth/action-coverage.test.ts` picks up
  the retry action automatically and must stay green.

Fixture teardown gains `email_outbox` — its `booking_id` and `court_id` are
RESTRICT, so it must be deleted before bookings. New FK-safe order:

```
email_outbox → payout_bookings → payouts → reviews → payments → bookings → auth.users
```

## Environment and ops

Three new server-only variables, added to `.env.local.example`:

- `RESEND_API_KEY`
- `CRON_SECRET`
- `EMAIL_FROM` — e.g. `OnCourt <bookings@oncourt.ph>`

**Domain verification is a launch gate, not a code problem.** Resend sends only
from a domain verified with SPF and DKIM records. Until that is done, sending
is limited to `onboarding@resend.dev` addressed to the account owner — fine for
building and testing this slice, blocking for real players. It also depends on
a domain decision the project has not made: the product spec calls "OnCourt" a
placeholder. `EMAIL_FROM` is config, so the code is indifferent.

**Free-tier limits** (verified 2026-08-12): 3,000 emails/month, **100/day**, 1
domain. At roughly three emails per booking the daily cap binds first, at ~33
bookings/day — and unevenly, since reminders fire as one morning batch. Pro is
$20/month for 50,000 and removes the daily cap. The trigger to upgrade is peak
daily sends, not monthly volume.

## Out of scope

- **Retry configuration in the UI.** The backoff ladder is a constant.
- **Email preferences / unsubscribe.** These are transactional, not marketing;
  no consent surface is required for them, and there is nothing else to opt out
  of yet.
- **Bounce and complaint handling.** Resend can webhook these back; there is no
  handler and no suppression list in this slice.
- **Delivery/open tracking.** `provider_message_id` is stored so a delivery can
  be traced in Resend's dashboard; nothing is ingested.
- **SMS.** Phase 2, unchanged.
- **Marketing email.** Different Resend product, different pricing, not an MVP
  goal.
- **Suppressing a reminder for a booking refunded after enqueue.** See the edge
  case table.
