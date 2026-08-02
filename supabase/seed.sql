-- Local development / Definition-of-Done fixture: one owner, one branch
-- (`smash-zone-marikina`, the slug the plan's Definition of Done names),
-- three courts with rate bands and operating hours. Deterministic ids so
-- links are stable across repeated applies (this shared DB has no
-- `supabase db reset`, so this file may run more than once — every insert
-- below is idempotent via `on conflict ... do nothing`).
--
-- Deviation from the task brief's literal ids: the brief's reference SQL
-- uses owner id 11111111-1111-1111-1111-111111111111, branch id
-- 22222222-2222-2222-2222-222222222222, and court ids
-- 33333333-3333-3333-3333-333333333331/32/33. Task 9's hand-seeded
-- verification branch already occupies exactly those ids in this shared,
-- persistent database (owner `task9-owner@oncourt.test`, branch
-- `task9-verify-smash-zone`, courts "Court 1"/"Court 2") -- confirmed live
-- before writing this file. Using the brief's ids verbatim would silently
-- no-op the branch insert (`on conflict (id) do nothing` against the
-- already-existing row) and never create `smash-zone-marikina` at all,
-- while also bleeding this seed's business_name/slug update onto Task 9's
-- owner profile. Both would defeat the Definition of Done item this seed
-- exists for and corrupt Task 9's fixture, which the task brief explicitly
-- says not to delete or disturb. Using a distinct id pattern (all-`a`/`b`/
-- `c` instead of all-`1`/`2`/`3`) avoids the collision while keeping every
-- other value (slugs, names, prices, hours) exactly as the brief specifies.
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
values (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'owner@oncourt.test',
  '{"full_name": "Smash Zone Owner", "avatar_url": null}'::jsonb
) on conflict (id) do nothing;

update profiles
set role = 'owner', business_name = 'Smash Zone', slug = 'smash-zone', phone = '+639170000000'
where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

insert into branches (id, owner_id, name, slug, description, address, city, location, amenities)
values (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'Smash Zone – Marikina', 'smash-zone-marikina',
  'Three covered courts with parking and showers.',
  '12 Bayan-Bayanan Ave', 'Marikina',
  st_setsrid(st_makepoint(121.1029, 14.6507), 4326)::geography,
  array['parking', 'showers', 'rentals']
) on conflict (id) do nothing;

-- Deviation from the brief: its DO block names the plpgsql loop variable
-- `court_id`, identical to the `court_id` column in every table inserted
-- into below. That is a genuine bug, not a style nit -- confirmed live: the
-- final `on conflict (court_id, day_of_week) do nothing` fails with
-- Postgres error 42702 "column reference \"court_id\" is ambiguous" (the
-- ON CONFLICT target list resolves against the DO block's own variable
-- namespace too, not just the table's columns). Renamed the variable to
-- `v_court_id` throughout so the column reference is unambiguous; nothing
-- else about the block's structure or values changed.
do $$
declare
  court_ids uuid[] := array[
    'cccccccc-cccc-cccc-cccc-ccccccccccc1',
    'cccccccc-cccc-cccc-cccc-ccccccccccc2',
    'cccccccc-cccc-cccc-cccc-ccccccccccc3'
  ];
  v_court_id uuid;
  idx integer := 0;
  day integer;
begin
  foreach v_court_id in array court_ids loop
    idx := idx + 1;

    insert into courts (id, branch_id, name, environment, status)
    values (v_court_id, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            'Court ' || idx,
            case when idx = 3 then 'outdoor'::court_environment else 'indoor'::court_environment end,
            'approved')
    on conflict (id) do nothing;

    insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos) values
      (v_court_id, 11, 15, 26500),
      (v_court_id, 15, 17, 31500),
      (v_court_id, 17, 24, 36500)
    on conflict do nothing;

    for day in 0..6 loop
      insert into court_operating_hours (court_id, day_of_week, opens_hour, closes_hour)
      values (v_court_id, day, 11, 24)
      on conflict (court_id, day_of_week) do nothing;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Public browse demo content: 3 owners -> 9 branches -> ~27 courts, joining
-- the pre-existing Smash Zone owner/branch for 10 branches total.
--
-- Id prefixes 'd'/'e'/'f' are chosen to avoid two existing occupants of this
-- shared, persistent database: 'a'/'b'/'c' (the Smash Zone seed above) and
-- '1'/'2'/'3' (Task 9's hand-seeded verification fixtures). A collision here
-- would silently no-op against `on conflict (id) do nothing` rather than
-- error, so the wrong id produces missing data, not a failed seed.
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data) values
  ('dddddddd-dddd-dddd-dddd-ddddddddddd1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'rally@oncourt.test',
   '{"full_name": "Rally Republic"}'::jsonb),
  ('dddddddd-dddd-dddd-dddd-ddddddddddd2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dinkhaus@oncourt.test',
   '{"full_name": "Dink Haus"}'::jsonb),
  ('dddddddd-dddd-dddd-dddd-ddddddddddd3', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'kitchen@oncourt.test',
   '{"full_name": "The Kitchen MNL"}'::jsonb)
on conflict (id) do nothing;

update profiles set role = 'owner', business_name = 'Rally Republic',
       slug = 'rally-republic', phone = '+639170000001'
where id = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';

update profiles set role = 'owner', business_name = 'Dink Haus',
       slug = 'dink-haus', phone = '+639170000002'
where id = 'dddddddd-dddd-dddd-dddd-ddddddddddd2';

update profiles set role = 'owner', business_name = 'The Kitchen MNL',
       slug = 'the-kitchen-mnl', phone = '+639170000003'
where id = 'dddddddd-dddd-dddd-dddd-ddddddddddd3';

insert into branches (id, owner_id, name, slug, description, address, city, location, amenities) values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', 'dddddddd-dddd-dddd-dddd-ddddddddddd1',
   'Rally Republic – Quezon City', 'rally-republic-quezon-city',
   'Four indoor courts with aircon and a pro shop, right off Tomas Morato.',
   '88 Tomas Morato Ave', 'Quezon City',
   st_setsrid(st_makepoint(121.0437, 14.6760), 4326)::geography,
   array['parking', 'aircon', 'pro-shop', 'lockers']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2', 'dddddddd-dddd-dddd-dddd-ddddddddddd1',
   'Rally Republic – Makati', 'rally-republic-makati',
   'Two indoor courts in Poblacion. Walk-ins welcome after 9 PM.',
   '5 Kalayaan Ave', 'Makati',
   st_setsrid(st_makepoint(121.0244, 14.5547), 4326)::geography,
   array['aircon', 'showers', 'cafe']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3', 'dddddddd-dddd-dddd-dddd-ddddddddddd1',
   'Rally Republic – Pasig', 'rally-republic-pasig',
   'Three courts beside Kapitolyo. Free parking on weekends.',
   '21 East Capitol Dr', 'Pasig',
   st_setsrid(st_makepoint(121.0851, 14.5764), 4326)::geography,
   array['parking', 'rentals', 'cafe']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee4', 'dddddddd-dddd-dddd-dddd-ddddddddddd1',
   'Rally Republic – Taguig', 'rally-republic-taguig',
   'Rooftop courts in BGC with night lights.',
   '32 8th Ave, BGC', 'Taguig',
   st_setsrid(st_makepoint(121.0509, 14.5176), 4326)::geography,
   array['night-lights', 'showers', 'lockers']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee5', 'dddddddd-dddd-dddd-dddd-ddddddddddd2',
   'Dink Haus – Mandaluyong', 'dink-haus-mandaluyong',
   'Warehouse conversion with three cushioned indoor courts.',
   '14 Shaw Blvd', 'Mandaluyong',
   st_setsrid(st_makepoint(121.0359, 14.5794), 4326)::geography,
   array['parking', 'aircon', 'rentals', 'showers']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee6', 'dddddddd-dddd-dddd-dddd-ddddddddddd2',
   'Dink Haus – San Juan', 'dink-haus-san-juan',
   'Two courts near Greenhills. Paddle rentals included.',
   '9 Ortigas Ave', 'San Juan',
   st_setsrid(st_makepoint(121.0355, 14.6019), 4326)::geography,
   array['rentals', 'cafe']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee7', 'dddddddd-dddd-dddd-dddd-ddddddddddd2',
   'Dink Haus – Parañaque', 'dink-haus-paranaque',
   'Covered outdoor courts near BF Homes.',
   '77 Aguirre Ave', 'Parañaque',
   st_setsrid(st_makepoint(121.0198, 14.4793), 4326)::geography,
   array['parking', 'night-lights']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee8', 'dddddddd-dddd-dddd-dddd-ddddddddddd3',
   'The Kitchen MNL – Caloocan', 'the-kitchen-mnl-caloocan',
   'Three outdoor courts with night lights and a canteen.',
   '4 Samson Rd', 'Caloocan',
   st_setsrid(st_makepoint(120.9676, 14.6507), 4326)::geography,
   array['parking', 'night-lights', 'cafe']),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee9', 'dddddddd-dddd-dddd-dddd-ddddddddddd3',
   'The Kitchen MNL – Marikina', 'the-kitchen-mnl-marikina',
   'Two indoor courts along the riverbanks.',
   '3 J.P. Rizal St', 'Marikina',
   st_setsrid(st_makepoint(121.0980, 14.6350), 4326)::geography,
   array['parking', 'showers', 'lockers'])
on conflict (id) do nothing;

do $$
declare
  specs jsonb := '[
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1", "prefix": "ffffffff-ffff-ffff-ffff-f0000000000", "courts": 4, "env": "indoor",  "base": 32000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2", "prefix": "ffffffff-ffff-ffff-ffff-f1000000000", "courts": 2, "env": "indoor",  "base": 38000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3", "prefix": "ffffffff-ffff-ffff-ffff-f2000000000", "courts": 3, "env": "indoor",  "base": 28000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee4", "prefix": "ffffffff-ffff-ffff-ffff-f3000000000", "courts": 2, "env": "outdoor", "base": 30000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee5", "prefix": "ffffffff-ffff-ffff-ffff-f4000000000", "courts": 3, "env": "indoor",  "base": 34000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee6", "prefix": "ffffffff-ffff-ffff-ffff-f5000000000", "courts": 2, "env": "indoor",  "base": 30000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee7", "prefix": "ffffffff-ffff-ffff-ffff-f6000000000", "courts": 3, "env": "outdoor", "base": 22000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee8", "prefix": "ffffffff-ffff-ffff-ffff-f7000000000", "courts": 3, "env": "outdoor", "base": 20000},
    {"branch": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee9", "prefix": "ffffffff-ffff-ffff-ffff-f8000000000", "courts": 2, "env": "indoor",  "base": 26000}
  ]'::jsonb;
  spec jsonb;
  -- NOT named court_id: a plpgsql variable of that name collides with the
  -- column in `on conflict (court_id, day_of_week)` and raises 42702
  -- "column reference is ambiguous". Same trap the block above documents.
  v_court_id uuid;
  idx integer;
  day integer;
  base integer;
begin
  for spec in select * from jsonb_array_elements(specs) loop
    base := (spec->>'base')::integer;
    for idx in 1..(spec->>'courts')::integer loop
      v_court_id := ((spec->>'prefix') || idx::text)::uuid;

      insert into courts (id, branch_id, name, environment, status)
      values (v_court_id, (spec->>'branch')::uuid, 'Court ' || idx,
              (spec->>'env')::court_environment, 'approved')
      on conflict (id) do nothing;

      -- Off-peak / mid / peak. Bands must not overlap
      -- (court_rate_bands_no_overlap is a GiST exclusion constraint) and
      -- end_hour <= 24.
      insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos) values
        (v_court_id,  7, 15, base),
        (v_court_id, 15, 18, base + 5000),
        (v_court_id, 18, 23, base + 9000)
      on conflict do nothing;

      for day in 0..6 loop
        insert into court_operating_hours (court_id, day_of_week, opens_hour, closes_hour)
        values (v_court_id, day, 7, 23)
        on conflict (court_id, day_of_week) do nothing;
      end loop;
    end loop;
  end loop;
end $$;

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data) values
  ('dddddddd-dddd-dddd-dddd-dddddddddde1', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'mika@oncourt.test', '{"full_name": "Mika Reyes"}'::jsonb),
  ('dddddddd-dddd-dddd-dddd-dddddddddde2', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'jomar@oncourt.test', '{"full_name": "Jomar Cruz"}'::jsonb),
  ('dddddddd-dddd-dddd-dddd-dddddddddde3', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'ash@oncourt.test', '{"full_name": "Ash Villanueva"}'::jsonb)
on conflict (id) do nothing;

-- One completed booking + review per (branch, player), placed on distinct
-- past hours so bookings_no_overlap can never fire. Booking ids are derived
-- deterministically from the branch and player index, so re-running no-ops.
do $$
declare
  players uuid[] := array[
    'dddddddd-dddd-dddd-dddd-dddddddddde1',
    'dddddddd-dddd-dddd-dddd-dddddddddde2',
    'dddddddd-dddd-dddd-dddd-dddddddddde3'
  ];
  ratings jsonb := '{
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1": [5, 5, 4],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2": [4, 5],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3": [4, 4, 3],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee4": [5],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee5": [5, 4, 5],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee6": [3, 4],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee7": [4],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee8": [3, 3],
    "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee9": [5, 4]
  }'::jsonb;
  bodies text[] := array[
    'Malinis ang courts and the lights are great at night.',
    'Booked last minute, walang hassle. Balik kami next week.',
    'Solid surface, friendly staff. Parking fills up fast though.'
  ];
  v_branch text;
  v_ratings jsonb;
  v_court_id uuid;
  v_player uuid;
  v_booking_id uuid;
  v_starts timestamptz;
  i integer;
begin
  for v_branch, v_ratings in select key, value from jsonb_each(ratings) loop
    select id into v_court_id from courts
      where branch_id = v_branch::uuid and status = 'approved'
      order by name limit 1;

    for i in 0..jsonb_array_length(v_ratings) - 1 loop
      v_player := players[i + 1];
      v_booking_id := md5(v_branch || v_player::text)::uuid;
      v_starts := timestamptz '2026-06-01 12:00:00+08' + (i || ' days')::interval;

      insert into bookings (
        id, court_id, branch_id, player_id, starts_at, ends_at, status,
        court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
        platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
        fee_config_snapshot
      ) values (
        v_booking_id, v_court_id, v_branch::uuid, v_player,
        v_starts, v_starts + interval '1 hour', 'completed',
        30000, 0, 30000, 3000, 0, 27000, '{"seed": true}'::jsonb
      ) on conflict (id) do nothing;

      insert into reviews (booking_id, branch_id, player_id, rating, body)
      values (v_booking_id, v_branch::uuid, v_player,
              (v_ratings->>i)::smallint, bodies[i + 1])
      on conflict (booking_id) do nothing;
    end loop;
  end loop;
end $$;
