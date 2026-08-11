-- The payouts ledger, and the refund records the webhook's needs_refund flag
-- has had nowhere to land since 20260807090000_payments.sql shipped.
--
-- SAFE TO CREATE AND USE payout_line_kind IN THIS ONE FILE. `supabase db push`
-- wraps each migration in a single transaction, and Postgres forbids *using*
-- an enum value added by `alter type ... add value` in that same transaction
-- (55P04) -- which is why 'blocked' needed its own file in
-- 20260805090000_booking_status_blocked.sql. That restriction does NOT apply
-- to a brand-new type: `create type ... as enum` followed by a column of that
-- type in the same transaction is fine, exactly as payment_status already
-- does. Do not split this file.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'payout_line_kind') then
    create type payout_line_kind as enum ('payment', 'clawback');
  end if;
end $$;

-- payout_status ('pending', 'paid') already exists from
-- 20260801042931_settings_and_enums.sql and is reused as-is.
create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),

  -- No `on delete` clause (Postgres default: NO ACTION / RESTRICT), matching
  -- payments.booking_id and bookings' own FKs. An owner with a payout history
  -- must not silently vanish.
  owner_id uuid not null references profiles (id),

  -- DERIVED at prepare time from the Manila dates of this payout's 'payment'
  -- lines -- NOT admin input. The lines are the truth about what this payout
  -- covers; these two are a display label. Clawback lines are excluded from
  -- the calculation because a clawback can be from any earlier period and
  -- would stretch the label to mean nothing.
  period_start date not null,
  period_end date not null,

  -- Snapshots, integer centavos, computed at prepare time from the covered
  -- bookings. NOT derivable from payout_bookings, which stores only net per
  -- line. Stored so a historical payout reads correctly without re-deriving
  -- it from bookings that may have moved since -- the same reasoning that
  -- makes every booking snapshot its own amounts.
  --   gross = sum(total_charged_centavos), payment lines +, clawback lines -
  --   net   = sum(owner_net_centavos),     same signs
  --   fee   = gross - net
  -- No check constraints on gross/fee: they are derived, and net > 0 below is
  -- the load-bearing gate on the row. gross and fee are SIGNED adjustments and
  -- may legitimately be NEGATIVE -- when an owner's fee rate changes between a
  -- clawed-back booking and the bookings absorbing it, the clawback's negative
  -- gross can outweigh the payment lines' while net stays correct and
  -- positive; a check constraint here would reject that payout and leave the
  -- clawback permanently unabsorbable, with the owner unpayable and no escape
  -- hatch.
  gross_centavos integer not null,
  fee_centavos integer not null,
  net_centavos integer not null,

  status payout_status not null default 'pending',
  paid_at timestamptz,

  -- The transfer reference (GCash / bank), recorded at mark-paid.
  note text,

  created_at timestamptz not null default now(),

  constraint payouts_period_ordered check (period_end >= period_start),

  -- > 0, not >= 0: you never record a payout of nothing. If owed comes out
  -- zero or negative you do not pay this period; the negative rides forward
  -- as a standing adjustment against the next one.
  constraint payouts_net_positive check (net_centavos > 0),

  -- The two-step flow's invariant, in the database rather than in the action:
  -- paid if and only if timestamped.
  constraint payouts_paid_has_timestamp check ((status = 'paid') = (paid_at is not null))
);

create index if not exists payouts_owner_id_idx on payouts (owner_id);

create table if not exists payout_bookings (
  booking_id uuid not null references bookings (id),
  kind payout_line_kind not null,
  payout_id uuid not null references payouts (id),

  -- Positive on a 'payment' line, negative on a 'clawback' line. Snapshotted
  -- rather than joined back to bookings.owner_net_centavos at read time: a
  -- payout is a historical record and must not move when anything upstream
  -- changes.
  net_centavos integer not null,

  -- THE INVARIANT: a booking can be paid at most once and clawed back at most
  -- once. Deliberately not unique(booking_id) alone -- that would leave a
  -- refunded booking unable to carry its own reversal. booking_id needs no
  -- separate index: it is this key's leading column.
  primary key (booking_id, kind)
);

create index if not exists payout_bookings_payout_id_idx on payout_bookings (payout_id);

-- Refund records live on payments, not on bookings: the thing being refunded
-- is a payment. This is what lets ONE action handle both refund shapes -- a
-- disputed booking (confirmed/completed, flips to refunded_manual) and an
-- orphan payment whose booking never confirmed (expired/pending_payment, no
-- status flip, no ledger effect). See src/lib/payments/webhook.ts:214, which
-- flags exactly those orphans. bookings gains no columns.
alter table payments add column if not exists refunded_at timestamptz;
alter table payments add column if not exists refund_note text;

-- Deny-by-default, like every other table: the publishable key ships in the
-- browser and must never reach these. Do NOT add policies, and do NOT use
-- `force row level security` (it would subject the owner role to those
-- non-existent policies and break the app).
alter table payouts enable row level security;
alter table payout_bookings enable row level security;
