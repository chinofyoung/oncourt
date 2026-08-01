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
