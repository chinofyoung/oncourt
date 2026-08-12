-- The email outbox. Every lifecycle email is enqueued here inside the same
-- transaction as the state change that owes it, then sent by a separate
-- drainer.
--
-- WHY A TABLE RATHER THAN A DIRECT SEND: src/lib/payments/webhook.ts:38-43
-- already drew the right line -- nothing that can fail on a third party may
-- happen inside the confirming transaction. A direct send after commit honours
-- that but loses the email with no record if Resend is down or the process
-- dies in the gap, and the player has already paid. An INSERT into a local
-- table cannot hang on a third party, so "this booking is confirmed" and "this
-- player is owed a receipt" can commit or fail together.
--
-- SAFE TO CREATE AND USE BOTH ENUMS IN THIS ONE FILE: the 55P04 restriction
-- applies to values added to an EXISTING type via `alter type ... add value`,
-- not to a brand-new `create type`. Same precedent as payment_status
-- (20260807090000_payments.sql) and payout_line_kind
-- (20260811000000_payouts_and_refunds.sql). Do not split this file.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'email_kind') then
    create type email_kind as enum (
      'booking_confirmed',  -- player: receipt
      'booking_new',        -- owner: someone booked your court
      'booking_reminder',   -- player: you play today
      'court_moderated',    -- owner: approved, or rejected with reason
      'refund_recorded'     -- player: your refund was processed
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'email_status') then
    create type email_status as enum ('pending', 'sent', 'failed');
  end if;
end $$;

create table if not exists email_outbox (
  id uuid primary key default gen_random_uuid(),
  kind email_kind not null,

  -- Snapshotted, not joined at send time: a profile's email address can
  -- change, and a receipt must go where it was owed when it was owed.
  recipient text not null,

  -- Exactly what the template needs, snapshotted at enqueue. Typed in
  -- TypeScript as a discriminated union keyed on `kind` (src/lib/email/
  -- payload.ts), which is what makes "every kind has a template and every
  -- enqueue site passes the matching shape" a compile-time guarantee.
  --
  -- Snapshotting the INPUTS rather than the rendered HTML is the pattern this
  -- codebase already uses twice (bookings.fee_config_snapshot,
  -- payout_bookings.net_centavos): a receipt shows what was true when payment
  -- landed even if the booking is later refunded, AND a template typo found
  -- after enqueueing is still fixed by a retry.
  payload jsonb not null,

  -- What this email is about. Both nullable: a booking email has no court_id,
  -- a court-moderation email has no booking. No `on delete` clause (Postgres
  -- default NO ACTION / RESTRICT), matching every other FK in this schema.
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

-- THE IDEMPOTENCY PRIMITIVE. At most one receipt per booking, at most one
-- reminder per booking. Enqueue uses `on conflict do nothing`, so a webhook
-- replay is a no-op at the DATABASE level rather than by care -- the same
-- trick payments.provider_ref already plays.
--
-- Partial, and court_moderated is deliberately OUTSIDE it: court_id carries no
-- uniqueness, because a court can be edited, requeued to pending, and approved
-- again, and its owner should hear each time.
create unique index if not exists email_outbox_booking_kind_idx
  on email_outbox (kind, booking_id) where booking_id is not null;

-- The drain query. Partial on a column that is mostly not 'pending'.
create index if not exists email_outbox_due_idx
  on email_outbox (next_attempt_at) where status = 'pending';

-- The /admin/emails queue.
create index if not exists email_outbox_failed_idx
  on email_outbox (created_at) where status = 'failed';

-- Index every FK explicitly. The partial unique index above leads on `kind`
-- and so does not serve a booking_id lookup.
create index if not exists email_outbox_booking_id_idx on email_outbox (booking_id);
create index if not exists email_outbox_court_id_idx on email_outbox (court_id);

-- Deny-by-default, like every other table: the publishable key ships in the
-- browser and must never reach this table. Do NOT add policies, and do NOT use
-- `force row level security`.
alter table email_outbox enable row level security;
