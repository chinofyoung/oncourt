create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  avatar_url text,
  role user_role not null default 'player',
  phone text,
  business_name text,
  business_logo_path text,
  slug text unique,
  -- Per-owner fee overrides. All null means "inherit platform_settings".
  -- platform_fee_value is dual-unit: basis points when mode is 'percentage',
  -- centavos when 'flat'. Always read the pair together.
  platform_fee_mode platform_fee_mode,
  platform_fee_value integer,
  processor_fee_bearer processor_fee_bearer,
  created_at timestamptz not null default now(),
  constraint profiles_fee_override_pair check (
    (platform_fee_mode is null and platform_fee_value is null)
    or (platform_fee_mode is not null and platform_fee_value is not null and platform_fee_value > 0)
  )
);
-- id is both the primary key and the FK to auth.users(id): the primary key's
-- own btree index already covers lookups and joins on this column, so no
-- separate index is needed for the foreign key.

alter table profiles enable row level security;  -- zero policies, see Task 3

-- Create the profile on signup. SECURITY DEFINER is genuinely required here:
-- the trigger runs in the auth system's context and must insert into public.
-- It is safe because it takes no user-controlled arguments, is not callable as
-- an API endpoint, and lives behind an auth.users trigger.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end $$;

-- Not callable by API roles even though it lives in public.
revoke all on function handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
