-- Its own file, containing nothing else: Postgres refuses to use a new enum
-- value in the same transaction that added it (55P04), and supabase db push
-- wraps each file in one transaction. Same reason
-- 20260805090000_booking_status_blocked.sql stands alone.
--
-- 'pending_verification' means: the player says they paid the owner directly
-- and uploaded proof; the owner has not yet confirmed. It HOLDS THE SLOT --
-- 20260908000300 adds it to bookings_no_overlap.
alter type booking_status add value if not exists 'pending_verification';
