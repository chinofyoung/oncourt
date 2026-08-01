create table if not exists branches (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles (id) on delete cascade,
  name text not null,
  slug text not null unique,
  description text,
  address text not null,
  city text not null,
  location geography(Point, 4326),
  amenities text[] not null default '{}',
  contact_phone text,
  contact_email text,
  created_at timestamptz not null default now()
);

create index if not exists branches_owner_id_idx on branches (owner_id);
create index if not exists branches_location_gix on branches using gist (location);
create index if not exists branches_city_idx on branches (city);

create table if not exists courts (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  name text not null,
  environment court_environment not null,
  surface text,
  status court_status not null default 'pending',
  rejection_reason text,
  created_at timestamptz not null default now()
);

create index if not exists courts_branch_id_idx on courts (branch_id);
-- Public reads always filter to approved courts.
create index if not exists courts_branch_approved_idx on courts (branch_id) where status = 'approved';

create table if not exists branch_photos (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id) on delete cascade,
  storage_path text not null,
  sort_order integer not null default 0
);
create index if not exists branch_photos_branch_id_idx on branch_photos (branch_id);

create table if not exists court_photos (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references courts (id) on delete cascade,
  storage_path text not null,
  sort_order integer not null default 0
);
create index if not exists court_photos_court_id_idx on court_photos (court_id);

-- integer (not smallint) so int4range() in the exclusion constraint needs no cast.
create table if not exists court_rate_bands (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references courts (id) on delete cascade,
  start_hour integer not null check (start_hour >= 0 and start_hour < 24),
  end_hour integer not null check (end_hour > 0 and end_hour <= 24),
  price_centavos integer not null check (price_centavos > 0),
  constraint court_rate_bands_hour_order check (end_hour > start_hour)
);
create index if not exists court_rate_bands_court_id_idx on court_rate_bands (court_id);

-- The DATABASE prevents overlapping bands; APPLICATION code prevents gaps
-- (the "bands must fully cover operating hours" rule lives in TypeScript,
-- where it is straightforward to test).
-- Qualified by conrelid, not just conname (Task 7 review finding: pg_constraint
-- is a global catalog, so an unqualified conname match would be satisfied by
-- a same-named constraint on any other table, silently skipping this ALTER
-- and shipping court_rate_bands with no exclusion constraint on a fresh build).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.court_rate_bands'::regclass
      and conname = 'court_rate_bands_no_overlap'
  ) then
    alter table court_rate_bands add constraint court_rate_bands_no_overlap
      exclude using gist (court_id with =, int4range(start_hour, end_hour) with &&);
  end if;
end $$;

create table if not exists court_operating_hours (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references courts (id) on delete cascade,
  day_of_week integer not null check (day_of_week between 0 and 6),
  opens_hour integer not null check (opens_hour >= 0 and opens_hour < 24),
  closes_hour integer not null check (closes_hour > 0 and closes_hour <= 24),
  constraint court_operating_hours_order check (closes_hour > opens_hour),
  constraint court_operating_hours_unique_day unique (court_id, day_of_week)
);
create index if not exists court_operating_hours_court_id_idx on court_operating_hours (court_id);

alter table branches              enable row level security;
alter table courts                enable row level security;
alter table branch_photos         enable row level security;
alter table court_photos          enable row level security;
alter table court_rate_bands      enable row level security;
alter table court_operating_hours enable row level security;
