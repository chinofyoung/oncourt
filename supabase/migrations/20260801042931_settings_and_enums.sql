-- Extensions used across the schema.
create extension if not exists btree_gist;  -- gist support for scalar = in exclusion constraints
create extension if not exists postgis;     -- branch geo search
create extension if not exists pg_cron;     -- hold janitor and completion sweep

-- Enum types. Created idempotently so `supabase db reset` and re-runs both work.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type user_role as enum ('player', 'owner', 'admin');
  end if;
  if not exists (select 1 from pg_type where typname = 'court_environment') then
    create type court_environment as enum ('indoor', 'outdoor');
  end if;
  if not exists (select 1 from pg_type where typname = 'court_status') then
    create type court_status as enum ('pending', 'approved', 'rejected', 'suspended');
  end if;
  if not exists (select 1 from pg_type where typname = 'booking_status') then
    create type booking_status as enum
      ('pending_payment', 'confirmed', 'completed', 'expired', 'refunded_manual');
  end if;
  if not exists (select 1 from pg_type where typname = 'payout_status') then
    create type payout_status as enum ('pending', 'paid');
  end if;
  if not exists (select 1 from pg_type where typname = 'platform_fee_mode') then
    create type platform_fee_mode as enum ('percentage', 'flat');
  end if;
  if not exists (select 1 from pg_type where typname = 'processor_fee_bearer') then
    create type processor_fee_bearer as enum ('player', 'owner', 'platform');
  end if;
end $$;

-- Singleton settings row. The boolean-PK-with-check trick makes a second row impossible.
create table if not exists platform_settings (
  id boolean primary key default true,
  default_platform_fee_mode platform_fee_mode not null default 'percentage',
  -- Dual-unit: basis points when mode is 'percentage', centavos when 'flat'.
  default_platform_fee_value integer not null default 1000,
  default_processor_fee_bearer processor_fee_bearer not null default 'platform',
  hold_duration_minutes integer not null default 15,
  updated_at timestamptz not null default now(),
  constraint platform_settings_singleton check (id),
  constraint platform_settings_fee_value_positive check (default_platform_fee_value > 0),
  constraint platform_settings_hold_positive check (hold_duration_minutes > 0)
);

insert into platform_settings (id) values (true) on conflict (id) do nothing;

-- Admin-editable so processor rate changes need no deploy.
create table if not exists processor_rates (
  payment_method text primary key,
  percentage_bps integer not null check (percentage_bps >= 0),
  fixed_fee_centavos integer not null default 0 check (fixed_fee_centavos >= 0),
  updated_at timestamptz not null default now()
);

insert into processor_rates (payment_method, percentage_bps, fixed_fee_centavos) values
  ('gcash', 223, 0),
  ('maya',  200, 0),
  ('card',  350, 1500)
on conflict (payment_method) do nothing;
