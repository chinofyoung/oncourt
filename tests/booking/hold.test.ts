import { expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { createHold, MAX_CONCURRENT_HOLDS } from '@/lib/booking/hold'
import { seedBranchWithCourts, seedPlayer } from '../helpers/fixtures'

const DATE = '2026-08-15'

test('creates a hold with an expiry from platform settings', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  const result = await createHold({
    courtId: courtIds[0], branchId, playerId, date: DATE, startHour: 18, endHour: 20,
  })

  expect(result.ok).toBe(true)
  if (!result.ok) return

  const row = await db.execute(sql`
    select status, court_fee_centavos, total_charged_centavos, platform_fee_centavos
    from bookings where id = ${result.bookingId}::uuid
  `)
  expect(row.rows[0]).toMatchObject({
    status: 'pending_payment',
    court_fee_centavos: 73000,   // 18:00 and 19:00 at 36500 each
    total_charged_centavos: 73000,
    platform_fee_centavos: 7300, // 10% default
  })

  const minutesOut = (result.expiresAt.getTime() - Date.now()) / 60_000
  expect(minutesOut).toBeGreaterThan(13)
  expect(minutesOut).toBeLessThan(16)
})

// Fix round 2, Finding 5: a malformed `date` must come back as a HoldResult,
// not escape as a thrown RangeError — Task 9 wires this to a Server Action
// fed by the browser, so a hand-crafted request can reach this path. Uses
// fabricated (non-existent) UUIDs for courtId/branchId/playerId: the
// invalid-input guard runs before any transaction or DB lookup, so this
// binds purely to date parsing, not to anything seeded.
test('rejects an unparseable date instead of throwing', async () => {
  const fakeId = '00000000-0000-0000-0000-000000000000'

  const garbage = await createHold({
    courtId: fakeId, branchId: fakeId, playerId: fakeId,
    date: 'not-a-date', startHour: 18, endHour: 19,
  })
  expect(garbage).toEqual({ ok: false, reason: 'invalid_input' })

  // Month 13 doesn't exist. Verified in isolation (outside this test) that
  // `new Date('2026-13-01T18:00:00+08:00')` is an Invalid Date rather than
  // rolling over — unlike day-of-month overflow (e.g. Feb 30, which the
  // platform's underlying Date parsing silently normalizes into March and
  // is out of scope for this guard, which targets genuinely unparseable
  // input, not calendar-sanity checking).
  const badMonth = await createHold({
    courtId: fakeId, branchId: fakeId, playerId: fakeId,
    date: '2026-13-01', startHour: 18, endHour: 19,
  })
  expect(badMonth).toEqual({ ok: false, reason: 'invalid_input' })
})

test('refuses a slot already held by someone else', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const first = await seedPlayer()
  const second = await seedPlayer()

  await createHold({
    courtId: courtIds[0], branchId, playerId: first, date: DATE, startHour: 18, endHour: 19,
  })
  const result = await createHold({
    courtId: courtIds[0], branchId, playerId: second, date: DATE, startHour: 18, endHour: 19,
  })

  expect(result).toEqual({ ok: false, reason: 'slot_taken' })
})

test('an expired hold no longer blocks the slot', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const first = await seedPlayer()
  const second = await seedPlayer()

  const held = await createHold({
    courtId: courtIds[0], branchId, playerId: first, date: DATE, startHour: 18, endHour: 19,
  })
  expect(held.ok).toBe(true)

  // Backdate the expiry rather than waiting 15 minutes.
  await db.execute(sql`
    update bookings set expires_at = now() - interval '1 minute'
    where court_id = ${courtIds[0]}::uuid and status = 'pending_payment'
  `)

  const result = await createHold({
    courtId: courtIds[0], branchId, playerId: second, date: DATE, startHour: 18, endHour: 19,
  })
  expect(result.ok).toBe(true)

  const expired = await db.execute(sql`
    select count(*)::int as n from bookings
    where court_id = ${courtIds[0]}::uuid and status = 'expired'
  `)
  expect(expired.rows[0].n).toBe(1)
})

test('refuses hours outside the court operating window', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  // Fixture courts open at 11:00.
  const result = await createHold({
    courtId: courtIds[0], branchId, playerId, date: DATE, startHour: 9, endHour: 10,
  })
  expect(result).toEqual({ ok: false, reason: 'court_closed' })
})

// Fix round 1, Important-1: the brief's reference trusts the caller-supplied
// `branchId` without checking it against the court, which would let a
// mismatched branchId compute fees/ownership from the wrong owner's profile
// (and previously crashed with an unguarded TypeError for a nonexistent
// branch, escaping as a 500 instead of a HoldResult). This binds to the
// court lookup added in hold.ts step 2: without it, courtIds[0] (which
// really belongs to branchA) combined with branchB's id would proceed all
// the way to a successful insert instead of being rejected.
test('rejects a branchId that does not actually own the court', async () => {
  const { courtIds: courtIdsA } = await seedBranchWithCourts(1)
  const { branchId: branchIdB } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  const result = await createHold({
    courtId: courtIdsA[0], branchId: branchIdB, playerId, date: DATE, startHour: 18, endHour: 19,
  })
  expect(result).toEqual({ ok: false, reason: 'invalid_branch' })
})

// Fix round 1, Important-1 (addition beyond the brief): a court that exists
// and belongs to the right branch, but was never approved, must still not
// be holdable. Binds to the `court.status !== 'approved'` check: without it,
// this would fall through to the operating-hours check (which the fixture
// satisfies) and succeed with ok:true.
test('rejects a hold on a court that is not approved', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await db.execute(sql`update courts set status = 'suspended' where id = ${courtIds[0]}::uuid`)

  const result = await createHold({
    courtId: courtIds[0], branchId, playerId, date: DATE, startHour: 18, endHour: 19,
  })
  expect(result).toEqual({ ok: false, reason: 'court_unavailable' })
})

// Fix round 1, Important-3: the operating-hours check and the manilaWeekday
// fix both need a test that only a *correct* weekday lookup can pass. DATE
// (2026-08-15) is a Saturday in Asia/Manila (day_of_week = 6) — verified
// independently via `new Date(Date.UTC(2026, 7, 15)).getUTCDay() === 6`, not
// via the function under test. Rate bands still cover 11-24 (fixture
// default), so if hold.ts either skipped the hours check entirely, or
// computed the wrong weekday and read the *unmodified* Sunday/Monday/etc.
// row (still opens_hour 11), the request would fall through to pricing (or
// pass the window check) and wrongly return ok:true instead of the
// court_closed this test asserts.
test('operating-hours check binds to the correct Manila weekday', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const courtId = courtIds[0]
  const saturday = 6

  await db.execute(sql`
    update court_operating_hours set opens_hour = 12
    where court_id = ${courtId}::uuid and day_of_week = ${saturday}
  `)

  const result = await createHold({
    courtId, branchId, playerId, date: DATE, startHour: 11, endHour: 12,
  })
  expect(result).toEqual({ ok: false, reason: 'court_closed' })
})

// Fix round 3, Important-1: `endHour = 24` is a real, reachable boundary —
// `court_operating_hours.closes_hour` can be 24 (the fixtures use exactly
// that for every day), so a "last slot of the day" booking calls
// `manilaInstant(date, 24)` on every such request. That call does not fail:
// `new Date('...T24:00:00+08:00')` rolls over to the next calendar day's
// midnight, which is the astronomically correct end-of-day instant — but
// nothing previously pinned that this resolves to a successful hold with
// the right stored `ends_at`, rather than being incidental.
test('a hold running to closing time (endHour = 24) succeeds and ends at the correct instant', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  const result = await createHold({
    courtId: courtIds[0], branchId, playerId, date: DATE, startHour: 23, endHour: 24,
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return

  const row = await db.execute(sql`
    select ends_at from bookings where id = ${result.bookingId}::uuid
  `)
  // 2026-08-16T00:00:00+08:00 (the next calendar day's Manila midnight) is
  // 2026-08-15T16:00:00.000Z — verified independently in Node, not via the
  // function under test.
  expect(new Date(row.rows[0].ends_at as string).toISOString()).toBe('2026-08-15T16:00:00.000Z')
})

test('CONCURRENCY: N simultaneous holds on one slot produce exactly one winner', async () => {
  // Timeout raised from the 5s default (fix round 3, Important-2): this test
  // does comparable round-trip-heavy work (8 players seeded, 8 concurrent
  // createHold calls) against the same hosted pooler as the ceiling test
  // below, which already needed the same bump — 5s left noticeably less
  // headroom here than intended, and is the best-supported explanation for
  // an earlier one-off timeout. No change to assertions or structure.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const players = await Promise.all(Array.from({ length: 8 }, () => seedPlayer()))

  const results = await Promise.all(
    players.map((playerId) =>
      createHold({
        courtId: courtIds[0], branchId, playerId, date: DATE, startHour: 18, endHour: 19,
      }),
    ),
  )

  expect(results.filter((r) => r.ok)).toHaveLength(1)
  expect(results.filter((r) => !r.ok && r.reason === 'slot_taken')).toHaveLength(7)

  const rows = await db.execute(sql`
    select count(*)::int as n from bookings
    where court_id = ${courtIds[0]}::uuid and status = 'pending_payment'
  `)
  expect(rows.rows[0].n).toBe(1)
}, 20_000)

test('CONCURRENCY: one player cannot exceed the hold ceiling under parallel requests', async () => {
  // This is what proves the per-player advisory lock works. Without it, each
  // request counts the same 0 existing holds and all of them insert.
  //
  // Timeout raised from the 5s default: seedBranchWithCourts(6) alone issues
  // ~54 sequential round trips (court + rate bands + 7 operating-hours rows,
  // times 6 courts) against the hosted Supabase pooler, not a local Postgres
  // — that setup cost, not createHold, is what needs the extra budget.
  const { branchId, courtIds } = await seedBranchWithCourts(6)
  const playerId = await seedPlayer()

  const results = await Promise.all(
    courtIds.map((courtId) =>
      createHold({ courtId, branchId, playerId, date: DATE, startHour: 18, endHour: 19 }),
    ),
  )

  expect(results.filter((r) => r.ok)).toHaveLength(MAX_CONCURRENT_HOLDS)
  expect(results.filter((r) => !r.ok && r.reason === 'too_many_holds'))
    .toHaveLength(courtIds.length - MAX_CONCURRENT_HOLDS)
}, 20_000)
