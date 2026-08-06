import type { BandsFailure, HoursFailure } from '@/lib/listings/schedule'

/**
 * The vocabulary of a court moderation decision: what can go wrong, and what
 * we say about it.
 *
 * PURE — no database, no session — for the same reason src/lib/listings/
 * status.ts is: the queue page renders these strings, and a Server Component
 * and a Server Action must be able to import them from the same place. The SQL
 * lives next door in ./write.ts.
 */

/**
 * Long enough for a real explanation with a couple of specifics, short enough
 * that the column (plain `text`, no constraint) never holds a pasted document.
 * Enforced here rather than by the database, which has no opinion.
 */
export const MAX_REJECTION_REASON = 500

export type CourtModerationFailure = 'stale' | 'empty_reason' | 'reason_too_long'

/**
 * `schedule_incomplete` carries its warning so the admin is told WHICH way the
 * court is not ready, using the same HoursFailure/BandsFailure vocabulary the
 * owner's own court page uses. It is a separate arm of the union rather than a
 * fifth CourtModerationFailure because only that one failure has a payload,
 * and an optional field would let a caller forget to render it.
 */
export type CourtModerationResult =
  | { ok: true }
  | { ok: false; reason: CourtModerationFailure }
  | { ok: false; reason: 'schedule_incomplete'; warning: HoursFailure | BandsFailure }

export const MODERATION_FAILURE_MESSAGES: Record<CourtModerationFailure, string> = {
  // Deliberately the same sentence whether the court changed status under the
  // admin's cursor or was deleted outright. Both mean "reload"; distinguishing
  // them would be a row-existence oracle that helps nobody.
  stale: 'That court has already moved on — reload the queue to see where it is now.',
  empty_reason: 'Say why you are rejecting it. The owner sees this and has to act on it.',
  reason_too_long: `Keep the reason under ${MAX_REJECTION_REASON} characters.`,
}

/**
 * Why a court cannot be approved yet, in the admin's voice.
 *
 * NOT a reuse of HOURS_FAILURE_MESSAGES/BANDS_FAILURE_MESSAGES: those are
 * written to the owner who is filling in the form ("Open the court on at least
 * one day of the week"), and an admin reading that in a queue would think it
 * was an instruction to them. Same five reasons, same rule, different reader.
 */
export const SCHEDULE_BLOCK_MESSAGES: Record<HoursFailure | BandsFailure, string> = {
  no_open_day: "This court has no opening hours yet, so it can't go live.",
  invalid_window: "This court's opening hours don't form a usable week, so it can't go live.",
  no_bands: "This court has no rates yet, so it can't go live.",
  invalid_band: "This court's rates aren't usable, so it can't go live.",
  bands_do_not_tile:
    "This court's rates don't cover its opening hours exactly, so it can't go live.",
}
