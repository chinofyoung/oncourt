-- pending_verification occupies the slot -- that is the entire point of the
-- state. Without this the owner-review window would leave the slot bookable
-- and the platform would double-sell it.
--
-- Rebuilt rather than altered: an exclusion constraint's predicate cannot be
-- changed in place.
--
-- The guard sniffs the LIVE DEFINITION for 'pending_verification' rather than
-- merely checking that the constraint exists -- an existence check would see
-- the OLD constraint and skip the rebuild, shipping the invariant missing with
-- no error. It also makes every re-apply a true no-op instead of dropping and
-- rebuilding a GiST index. conrelid-qualified because constraint names are
-- unique per table, not per database. This is the exact shape
-- 20260805090100_branch_staff_and_blocks.sql used to add 'blocked'; read its
-- comment.
--
-- 'expired' and 'refunded_manual' stay out: they do not occupy the slot.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass
      and conname = 'bookings_no_overlap'
      and pg_get_constraintdef(oid) like '%pending_verification%'
  ) then
    alter table bookings drop constraint if exists bookings_no_overlap;
    alter table bookings add constraint bookings_no_overlap
      exclude using gist (court_id with =, slot with &&)
      where (status in ('pending_payment', 'pending_verification',
                        'confirmed', 'completed', 'blocked'));
  end if;
end $$;

-- The cron janitor knew only pending_payment. A manual booking's expires_at is
-- the owner's review deadline, so the same rule applies: past its deadline,
-- the slot goes back on sale.
--
-- This function does NOT enqueue email. email_outbox.payload is `jsonb not
-- null` and is typed by an exhaustive discriminated union in
-- src/lib/email/payload.ts -- renderEmail switches over it so that a kind
-- without a template does not compile. A SQL function hand-building that jsonb
-- would bypass the one guarantee that file exists to provide, and a malformed
-- payload would only surface as a permanently-failing row in the drainer.
-- Notifying the player that their review window lapsed is handled in the app
-- (see the booking-page states in Task 14), not from here.
create or replace function expire_stale_holds() returns void
language sql
as $$
  update bookings set status = 'expired'
  where status in ('pending_payment', 'pending_verification')
    and expires_at <= now();
$$;

-- CREATE OR REPLACE preserves a function's existing ACL, but re-issue the
-- revoke so the grant state is stated in the file that last defined it.
revoke all on function expire_stale_holds() from public, anon, authenticated, service_role;
