-- The payments audit trail, and the idempotency primitive the webhook needs.
--
-- SAFE TO CREATE AND USE payment_status IN THIS ONE FILE. `supabase db push`
-- wraps each migration file in a single transaction, and Postgres forbids
-- *using* an enum value added by `alter type ... add value` in that same
-- transaction (55P04) -- which is why 'blocked' needed its own file in
-- 20260805090000_booking_status_blocked.sql. That restriction does NOT apply
-- to a brand-new type: `create type ... as enum` followed by a column of that
-- type in the same transaction is fine. Do not split this file.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'payment_status') then
    create type payment_status as enum ('pending', 'paid', 'failed');
  end if;
end $$;

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),

  -- NOT unique, and NO `on delete` clause (Postgres default: NO ACTION /
  -- RESTRICT), matching reviews.booking_id and bookings' own FKs. Not unique
  -- because a player may abandon one checkout session and start another, and
  -- each attempt is part of the audit trail. RESTRICT because a booking with
  -- a payment against it must not silently vanish -- deleting one is an
  -- explicit decision this schema does not make for you. Consequence:
  -- tests/helpers/fixtures.ts must delete payments BEFORE bookings.
  booking_id uuid not null references bookings (id),

  provider text not null default 'paymongo',

  -- The checkout session we created. The webhook's ONLY lookup key: the paid
  -- amount is reconciled against the amount THIS session quoted, never against
  -- the booking's current total_charged_centavos (a player who returns to
  -- checkout and picks a different method gets a second session, and for the
  -- 'player' bearer the two sessions legitimately quote different amounts).
  provider_session_id text,

  -- THE IDEMPOTENCY PRIMITIVE. A replayed webhook for the same payment raises
  -- 23505, which the handler translates to "already processed, 200 OK".
  -- Nullable because a session row exists before any payment does. `unique`
  -- also provides this column's index.
  provider_payment_id text unique,

  -- FK to the admin-editable rate table, so a method we cannot price cannot be
  -- recorded. Indexed explicitly below (Postgres does not index FKs for you).
  payment_method text references processor_rates (payment_method),

  -- Integer centavos, never floats and deliberately not numeric (PayMongo
  -- denominates in centavos, and numeric comes back from the driver as a
  -- string). amount_centavos is what we QUOTED for this session and is the
  -- anchor the webhook reconciles the paid amount against;
  -- processor_fee_centavos is what that session's rate implied, recorded at
  -- quote time so a later admin edit to processor_rates can never rewrite a
  -- booking's money columns after the fact.
  amount_centavos integer not null check (amount_centavos >= 0),
  processor_fee_centavos integer not null default 0 check (processor_fee_centavos >= 0),

  status payment_status not null default 'pending',

  -- Set when a payment lands for a slot that is no longer available, when the
  -- paid amount does not match what that session quoted, or when a booking was
  -- already confirmed by a DIFFERENT payment (a genuine double charge).
  -- Queryable by admin; the refund screen itself ships with the payouts work.
  needs_refund boolean not null default false,

  -- The last webhook payload, verbatim, for audit. The enum above is OUR view
  -- of this row; the provider's vocabulary lives here.
  raw_event jsonb,

  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists payments_booking_id_idx on payments (booking_id);
create index if not exists payments_payment_method_idx on payments (payment_method);
create index if not exists payments_provider_session_id_idx on payments (provider_session_id);
-- Partial: the admin refund query wants only the flagged few, and a partial
-- index on a mostly-false boolean is a fraction of the size of a full one.
create index if not exists payments_needs_refund_idx on payments (needs_refund)
  where needs_refund;

-- Deny-by-default, like every other table: the publishable key ships in the
-- browser and must never reach this table. Do NOT add policies, and do NOT
-- use `force row level security` (it would subject the owner role to those
-- non-existent policies and break the app).
alter table payments enable row level security;
