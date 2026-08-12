-- Review finding on Task 6: email_outbox_booking_kind_idx
-- (20260812000000_email_outbox.sql) deduped every booking-linked kind by
-- (kind, booking_id) -- correct for booking_confirmed/booking_new/
-- booking_reminder (at most one of each per booking), but WRONG for
-- refund_recorded, which is per-PAYMENT, not per-booking.
--
-- recordPaymentRefund's own doc comment (src/lib/refunds/write.ts) names three
-- webhook shapes -- double_charge, not_payable, amount_mismatch -- that put a
-- flagged, paid payment on a booking a DIFFERENT payment legitimately funded.
-- Refund the stray payment first: bookingRefunded is false, and the email
-- correctly says the booking stands. Refund the real payment later: the
-- booking genuinely flips to refunded_manual -- but with the old index, that
-- second refund_recorded row for the SAME booking_id collided with the first
-- on (kind, booking_id) and `on conflict do nothing` silently dropped it. The
-- player is never told their booking was cancelled, and the one refund email
-- they do hold asserts the opposite.
--
-- This is safe to loosen because refund idempotency does not live in this
-- index at all -- it lives one layer up, in recordPaymentRefund's own guard
-- (`refunded_at is null and status = 'paid'`), which returns
-- 'already_recorded' on zero rows and never reaches the enqueue on a replay.
-- Excluding refund_recorded from this index does not reopen that door: two
-- DIFFERENT payments on one booking now correctly produce two emails, and a
-- replayed refund of the SAME payment still produces zero.
drop index if exists email_outbox_booking_kind_idx;

create unique index if not exists email_outbox_booking_kind_idx
  on email_outbox (kind, booking_id)
  where booking_id is not null and kind <> 'refund_recorded';
