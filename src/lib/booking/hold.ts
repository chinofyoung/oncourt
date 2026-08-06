import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { manilaWeekday } from '@/lib/date-manila'
import { priceSlots, PricingError, type RateBand } from '@/lib/booking/pricing'
import {
  PG_DEADLOCK_DETECTED,
  PG_EXCLUSION_VIOLATION,
  sqlStateOf,
} from '@/lib/db/sql-state'

export const MAX_CONCURRENT_HOLDS = 3

export type CreateHoldInput = {
  courtId: string
  branchId: string
  playerId: string
  /** Calendar date in Asia/Manila, `YYYY-MM-DD`. */
  date: string
  startHour: number
  endHour: number
}

export type HoldResult =
  | { ok: true; bookingId: string; expiresAt: Date }
  | {
      ok: false
      reason:
        | 'slot_taken'
        | 'too_many_holds'
        | 'court_closed'
        // Additions beyond the brief (see task-8-report.md, fix round 1,
        // Important-1): a caller-supplied branchId that does not actually
        // own the court, and a court that exists but isn't approved for
        // bookings. Both are distinct from 'court_closed' (which means "not
        // open at this hour") on purpose, so a caller can tell the three
        // apart instead of getting the same code for unrelated failures.
        | 'invalid_branch'
        | 'court_unavailable'
        // Fix round 2, Finding 5: a `date` that isn't a real `YYYY-MM-DD`
        // calendar date (or that, combined with startHour/endHour, doesn't
        // form a valid instant). Returned instead of throwing — see the
        // guard in createHold below.
        | 'invalid_input'
    }

/**
 * Manila is UTC+8 with no DST, so a fixed offset is correct and stable.
 * Returns `undefined` — rather than throwing — when the underlying `Date`
 * parse fails outright. Callers must check for `undefined` before use; see
 * the explicit guard in `createHold`.
 *
 * Exactly what parses vs. fails, verified directly in Node (all for
 * `date = '2026-08-15'`):
 * - `hour` outside `0..24` (e.g. `-1`, `25`) → fails → `undefined`.
 * - `hour === 24` → **succeeds**, and is intentional, not a bug: it rolls
 *   over to `2026-08-16T00:00:00+08:00`, the astronomically correct
 *   Manila-midnight instant. `court_operating_hours.closes_hour` can
 *   legitimately be `24` (the fixtures use exactly that), so a hold running
 *   to closing time calls `manilaInstant(date, 24)` on every such request
 *   and must resolve to a real, valid `ends_at` — which it does.
 * - `date` not shaped `YYYY-MM-DD` (garbage text, an out-of-range month
 *   like `13`) → fails → `undefined`.
 * - `date` shaped correctly but naming a nonexistent day (e.g. `2026-02-30`)
 *   → does **NOT** fail: `Date` parsing silently normalizes that into March
 *   rather than failing, so it comes back as a valid instant on the wrong
 *   day rather than `undefined`. Out of scope for this function — see the
 *   guard comment in `createHold`.
 */
function manilaInstant(date: string, hour: number): string | undefined {
  const instant = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+08:00`)
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString()
}

export async function createHold(input: CreateHoldInput): Promise<HoldResult> {
  const { courtId, branchId, playerId, date, startHour, endHour } = input

  // Fix round 2, Finding 5: parse and validate the date/hours *before*
  // opening a transaction, and check explicitly for failure rather than
  // relying on the broad `catch` below to intercept a thrown RangeError.
  // `createHold`'s signature promises a `HoldResult`, never a throw, for
  // anything the caller can trigger by passing bad input — a `date` that
  // isn't `YYYY-MM-DD`, or whose components don't parse at all (garbage
  // text, an out-of-range month like 13, an hour outside 0-24 — see
  // `manilaInstant`'s docstring for why 24 itself is valid, not a typo),
  // must come back as `{ ok: false, reason: 'invalid_input' }`, not escape
  // as an unhandled RangeError. `manilaInstant` returns `undefined` and
  // `manilaWeekday` returns `NaN` (never `undefined` — it always returns a
  // `number`) instead of throwing, precisely so this check can be explicit
  // (`=== undefined` for the two instants, `Number.isNaN` for the weekday)
  // instead of a catch-all that would also risk swallowing an unrelated bug.
  //
  // This guard does NOT catch calendar-sanity problems where every field is
  // in range but the combination doesn't exist (e.g. 2026-02-30): the
  // underlying `Date` parsing/`Date.UTC` construction silently normalizes
  // those (Feb 30 becomes Mar 2) rather than failing, in both helpers.
  // Verified directly in Node — out of scope for "unparseable input"; Task
  // 9's Server Action is the right place for full calendar validation if
  // that's ever needed.
  const startsAt = manilaInstant(date, startHour)
  const endsAt = manilaInstant(date, endHour)
  const weekday = manilaWeekday(date)
  if (startsAt === undefined || endsAt === undefined || Number.isNaN(weekday)) {
    return { ok: false, reason: 'invalid_input' }
  }

  try {
    // Isolation level pinned explicitly (fix round 1, Important-2), rather
    // than leaving it to inherit `default_transaction_isolation`. Under READ
    // COMMITTED the lock-then-count sequence below is correct because each
    // statement takes its own fresh snapshot. Under REPEATABLE READ it would
    // silently break: the transaction's snapshot is fixed at the first
    // non-control statement — the pg_advisory_xact_lock call itself — and
    // that snapshot is taken *before* the lock is actually granted. A second
    // transaction for the same player that queues behind the lock and then
    // resumes would still see the pre-lock hold count from its earlier
    // snapshot, undercounting live holds and defeating
    // MAX_CONCURRENT_HOLDS. Every test in this file passes under READ
    // COMMITTED (the environment's live default) regardless — pinning it is
    // what keeps this correct if `default_transaction_isolation` is ever
    // changed at the role or database level.
    return await db.transaction(async (tx) => {
      // 1. Serialize this player's own concurrent attempts. Keyed on the
      //    player, so unrelated traffic is never serialized. A transaction-
      //    scoped lock (not session-scoped) so it can never leak into
      //    whatever the pooled connection runs next after this tx ends.
      //    Taken first, while holding nothing else, so this lock can never
      //    be one edge of a wait-for cycle with anything else in this
      //    function — deadlock-safe by construction.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'hold:' + playerId}))`)

      // 2. Look up the court itself. This is the source of truth for which
      //    branch it belongs to and whether it can be booked at all — the
      //    caller-supplied `branchId` is never trusted on its own (fix
      //    round 1, Important-1). A nonexistent court is treated the same
      //    as "not open at this hour": there is no court-hours row for it
      //    either, so the window check just below would reject it anyway.
      const courtRows = await tx.execute(sql`
        select branch_id, status from courts where id = ${courtId}::uuid
      `)
      const court = courtRows.rows[0]
      if (court) {
        if (court.branch_id !== branchId) {
          return { ok: false as const, reason: 'invalid_branch' as const }
        }
        // Addition beyond the brief (fix round 1, Important-1): the brief's
        // reference never checks this, so a hold could otherwise be taken
        // on a court still pending review, rejected, or suspended. Fixtures
        // only ever seed 'approved' courts, so this does not affect any
        // existing test.
        if (court.status !== 'approved') {
          return { ok: false as const, reason: 'court_unavailable' as const }
        }
      }

      // 3. The court must be open for the whole requested window.
      const hours = await tx.execute(sql`
        select opens_hour, closes_hour from court_operating_hours
        where court_id = ${courtId}::uuid and day_of_week = ${weekday}
      `)
      const window = hours.rows[0]
      if (!window || startHour < Number(window.opens_hour) || endHour > Number(window.closes_hour)) {
        return { ok: false as const, reason: 'court_closed' as const }
      }

      // 4. Expired holds that could actually block this exact slot must
      //    stop doing so. The exclusion constraint's predicate cannot call
      //    now() (index predicates must be immutable), so it can't tell a
      //    genuinely live hold from an expired-but-unswept one — it
      //    over-blocks instead. Sweeping inside this same transaction,
      //    before the insert, is what makes the check exact.
      //
      //    Narrowed to rows whose `slot` overlaps the requested range (fix
      //    round 1, Important-4): only overlapping rows can ever affect the
      //    exclusion constraint's decision on the insert below. Sweeping
      //    every stale row on the whole court took row locks on rows that
      //    have nothing to do with this request, which would otherwise
      //    serialize concurrent holds for *non-overlapping* slots on a busy
      //    court behind each other and put an unbounded UPDATE in the
      //    request path if the janitor (Task 10) ever fell behind.
      //
      //    This UPDATE is a second, independent source of 40P01 alongside
      //    the insert's exclusion check: two overlapping requests can each
      //    try to sweep the same stale row(s) in a different lock order.
      //    Either way the loser is mapped to 'slot_taken' below, which is
      //    deliberately coarse — a transaction that lost this race purely
      //    on sweep-lock ordering may find the slot genuinely free on
      //    retry. That's fail-safe (never double-sells), just not maximally
      //    precise; a bare retry from the caller resolves it.
      await tx.execute(sql`
        update bookings set status = 'expired'
        where court_id = ${courtId}::uuid
          and status = 'pending_payment'
          and expires_at <= now()
          and slot && tstzrange(${startsAt}::timestamptz, ${endsAt}::timestamptz, '[)')
      `)

      // 5. Hold ceiling. Safe to read-then-write because of the advisory
      //    lock taken in step 1 — no other transaction holding the same
      //    player's lock can be concurrently inserting a competing hold.
      //    Filters on expires_at > now() directly rather than trusting the
      //    (now slot-scoped) sweep above, which only ever touches this one
      //    court — this count spans every court the player might be
      //    holding, so it has to check expiry itself either way.
      const live = await tx.execute(sql`
        select count(*)::int as n from bookings
        where player_id = ${playerId}::uuid
          and status = 'pending_payment'
          and expires_at > now()
      `)
      if (Number(live.rows[0].n) >= MAX_CONCURRENT_HOLDS) {
        return { ok: false as const, reason: 'too_many_holds' as const }
      }

      // 6. Price from the court's bands and resolve the fee config.
      const bandRows = await tx.execute(sql`
        select start_hour, end_hour, price_centavos from court_rate_bands
        where court_id = ${courtId}::uuid
      `)
      const bands: RateBand[] = bandRows.rows.map((r) => ({
        startHour: Number(r.start_hour),
        endHour: Number(r.end_hour),
        priceCentavos: Number(r.price_centavos),
      }))
      const courtFee = priceSlots(bands, startHour, endHour)

      const feeRows = await tx.execute(sql`
        select
          coalesce(p.platform_fee_mode,     s.default_platform_fee_mode)     as mode,
          coalesce(p.platform_fee_value,    s.default_platform_fee_value)    as value,
          coalesce(p.processor_fee_bearer,  s.default_processor_fee_bearer)  as bearer,
          s.hold_duration_minutes as hold_minutes
        from platform_settings s
        join branches b on b.id = ${branchId}::uuid
        join profiles p on p.id = b.owner_id
      `)
      const fee = feeRows.rows[0]
      const mode = fee.mode as 'percentage' | 'flat'
      const value = Number(fee.value)
      const holdMinutes = Number(fee.hold_minutes)

      // Integer centavos throughout. Basis points -> centavos division is
      // rounded, never left as a float; the processor fee is 0 until the
      // payments slice, where the bearer rules are applied.
      const platformFee = mode === 'percentage' ? Math.round((courtFee * value) / 10_000) : value
      const transactionFee = 0
      const processorFee = 0
      const totalCharged = courtFee + transactionFee
      const ownerNet = courtFee - platformFee

      // 7. Insert. The exclusion constraint arbitrates against any
      //    concurrent booking of the same slot: the loser gets 23P01, or
      //    occasionally 40P01 if the two backends formed a genuine
      //    wait-for cycle that the deadlock detector had to break — both
      //    are caught identically below and mean "someone else took this
      //    slot."
      const inserted = await tx.execute(sql`
        insert into bookings (
          court_id, branch_id, player_id, starts_at, ends_at, status, expires_at,
          court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
          platform_fee_centavos, processor_fee_centavos, owner_net_centavos, fee_config_snapshot
        ) values (
          ${courtId}::uuid, ${branchId}::uuid, ${playerId}::uuid,
          ${startsAt}::timestamptz, ${endsAt}::timestamptz,
          'pending_payment', now() + make_interval(mins => ${holdMinutes}),
          ${courtFee}, ${transactionFee}, ${totalCharged},
          ${platformFee}, ${processorFee}, ${ownerNet},
          ${JSON.stringify({ mode, value, bearer: fee.bearer, holdMinutes })}::jsonb
        )
        returning id, expires_at
      `)

      const row = inserted.rows[0]
      return {
        ok: true as const,
        bookingId: row.id as string,
        expiresAt: new Date(row.expires_at as string),
      }
    }, { isolationLevel: 'read committed' })
  } catch (error) {
    const code = sqlStateOf(error)
    if (code === PG_EXCLUSION_VIOLATION || code === PG_DEADLOCK_DETECTED) {
      return { ok: false, reason: 'slot_taken' }
    }
    if (error instanceof PricingError) return { ok: false, reason: 'court_closed' }
    throw error
  }
}
