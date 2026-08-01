-- Storage buckets. Public read; writes go through server code that verifies
-- the caller owns the branch/court. Tables store storage_path, never a URL.
insert into storage.buckets (id, name, public) values
  ('branch-photos', 'branch-photos', true),
  ('court-photos',  'court-photos',  true)
on conflict (id) do nothing;

-- No policies added on storage.objects. RLS on storage.objects is
-- Supabase-managed (Supabase enables it on the table itself, not this
-- migration), and with zero policies here access through the Data API/
-- Storage API is denied by default for both buckets -- consistent with this
-- project's project-wide deny-by-default rule for tables we do not own
-- either. Uploads happen through server code using the service role (which
-- bypasses RLS), never through the browser -- so no policy is needed for the
-- app to function. Public *read* of files already uploaded is served by the
-- bucket's own `public = true` flag (a Storage-level concept, independent of
-- storage.objects RLS), which is why the buckets are created with
-- `public: true` above rather than via a SELECT policy.

-- Cosmetic janitor only. Hold correctness does NOT depend on this running:
-- expiry is computed (expires_at <= now()), and the hold transaction expires
-- stale rows itself (src/lib/booking/hold.ts, step 4). This exists so the UI
-- and reports show no phantom holds. Matches hold.ts's own sweep predicate
-- exactly (status = 'pending_payment' and expires_at <= now()) so the two
-- never disagree about what counts as expired -- this one is just unscoped
-- to any particular court/slot, since it runs in the background rather than
-- inside a single hold request.
create or replace function expire_stale_holds()
returns void
language sql
as $$
  update bookings set status = 'expired'
  where status = 'pending_payment' and expires_at <= now();
$$;

-- Makes finished bookings reviewable. 'confirmed' rows whose slot has ended
-- cannot overlap anything: the exclusion constraint keys on `slot`, an
-- immutable value computed once from starts_at/ends_at at insert time, and
-- this function only ever changes `status`, never `slot`. So a `confirmed`
-- row moving to `completed` never contends with the exclusion constraint --
-- 'completed' is already in its blocking set alongside 'pending_payment' and
-- 'confirmed' (see the bookings migration), so this transition never grows
-- or shrinks who else could book that slot; it is a same-blocking-set,
-- unrelated-window move that cannot create an overlap the constraint would
-- have rejected.
create or replace function complete_past_bookings()
returns void
language sql
as $$
  update bookings set status = 'completed'
  where status = 'confirmed' and ends_at <= now();
$$;

-- Belt-and-suspenders alongside the default-privilege revoke that already
-- covers every future postgres-owned function in public (see
-- 20260801044615_revoke_data_api_grants.sql) -- explicit here so this
-- migration does not rely on reading that one to know these are locked
-- down. service_role is included too, matching that migration's revoke list.
revoke all on function expire_stale_holds() from public, anon, authenticated, service_role;
revoke all on function complete_past_bookings() from public, anon, authenticated, service_role;

-- Re-registering a job with the same name replaces its schedule/command
-- rather than duplicating it, so this is idempotent across repeated applies.
select cron.schedule('expire-stale-holds', '* * * * *', $$select expire_stale_holds()$$);
select cron.schedule('complete-past-bookings', '*/5 * * * *', $$select complete_past_bookings()$$);
