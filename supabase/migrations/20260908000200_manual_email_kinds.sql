-- Same 55P04 rule as the file before this one.
--
-- manual_proof_submitted -> owner: the only thing that tells an owner there is
--   something waiting in their review queue.
-- manual_proof_rejected  -> player: carries the owner's rejection_reason.
-- manual_review_expired  -> player: the review window ran out unreviewed.
alter type email_kind add value if not exists 'manual_proof_submitted';
alter type email_kind add value if not exists 'manual_proof_rejected';
alter type email_kind add value if not exists 'manual_review_expired';
