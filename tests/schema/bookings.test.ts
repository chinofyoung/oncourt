import { expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { Client } from 'pg'
import { db } from '@/db'
import { manilaHour, seedBranchWithCourts, seedPlayer } from '../helpers/fixtures'

const FEES = {
  courtFee: 26500, txFee: 0, total: 26500, platformFee: 2650, processorFee: 0, ownerNet: 23850,
}

async function insertBooking(opts: {
  courtId: string; branchId: string; playerId: string
  startHour: number; endHour: number
  status?: string; expiresAt?: Date | null; date?: string
}) {
  const date = opts.date ?? '2026-08-15'
  return db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status, expires_at,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos, fee_config_snapshot
    ) values (
      ${opts.courtId}::uuid, ${opts.branchId}::uuid, ${opts.playerId}::uuid,
      ${manilaHour(date, opts.startHour).toISOString()}::timestamptz,
      ${manilaHour(date, opts.endHour).toISOString()}::timestamptz,
      ${opts.status ?? 'confirmed'}::booking_status,
      ${opts.expiresAt ? opts.expiresAt.toISOString() : null}::timestamptz,
      ${FEES.courtFee}, ${FEES.txFee}, ${FEES.total},
      ${FEES.platformFee}, ${FEES.processorFee}, ${FEES.ownerNet}, '{}'::jsonb
    ) returning id, slot::text as slot
  `)
}

test('the slot range is generated from starts_at and ends_at', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  const result = await insertBooking({
    courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 20,
  })
  // Half-open interval: inclusive start, exclusive end.
  expect(result.rows[0].slot).toMatch(/^\[.*\)$/)
})

test('overlapping bookings on the same court are rejected', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await insertBooking({ courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 20 })

  // drizzle-orm 0.45.2's db.execute() wraps the driver's pg error in a
  // DrizzleQueryError and only sets it as `.cause` (it doesn't spread pg's
  // `code`/`constraint`/etc. onto the outer rejection), so the SQLSTATE has
  // to be asserted on `cause`, not the rejection itself. Confirmed against
  // node_modules/drizzle-orm/errors.js and pg-core/session.js (see Task 6).
  await expect(
    insertBooking({ courtId: courtIds[0], branchId, playerId, startHour: 19, endHour: 21 }),
  ).rejects.toMatchObject({ cause: { code: '23P01' } })
})

test('adjacent bookings are allowed — half-open bounds are load-bearing', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await insertBooking({ courtId: courtIds[0], branchId, playerId, startHour: 17, endHour: 18 })
  await insertBooking({ courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 19 })

  const result = await db.execute(
    sql`select count(*)::int as n from bookings where court_id = ${courtIds[0]}::uuid`,
  )
  expect(result.rows[0].n).toBe(2)
})

test('the same hour on a different court is allowed', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  const playerId = await seedPlayer()

  await insertBooking({ courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 19 })
  await insertBooking({ courtId: courtIds[1], branchId, playerId, startHour: 18, endHour: 19 })

  // Scoped to this test's own two courts, not a bare `select count(*) from
  // bookings` — the shared DB already holds rows from every other test, so
  // an unscoped count only ever grows and `>= 2` would pass vacuously.
  const result = await db.execute(sql`
    select count(*)::int as n from bookings
    where court_id in (${courtIds[0]}::uuid, ${courtIds[1]}::uuid)
  `)
  expect(result.rows[0].n).toBe(2)
})

test('expired and refunded bookings do not block the slot', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await insertBooking({
    courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 19, status: 'expired',
  })
  await insertBooking({
    courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 19,
    status: 'refunded_manual',
  })
  // A live booking can still take the slot.
  await insertBooking({ courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 19 })

  const result = await db.execute(sql`
    select count(*)::int as n from bookings
    where court_id = ${courtIds[0]}::uuid and status = 'confirmed'
  `)
  expect(result.rows[0].n).toBe(1)
})

// Review finding (Critical): the original 8 tests never exercised
// 'pending_payment' or 'completed' individually — swapping either out of
// the constraint's `where` predicate left all 8 green. A 15-minute hold
// that stops holding is exactly the failure this table exists to prevent
// (two players both reach PayMongo for the same slot, both pay, only the
// second `confirmed` write gets arbitrated — after money has moved twice).
test('a live pending_payment hold blocks an overlapping booking', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000)

  await insertBooking({
    courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 19,
    status: 'pending_payment', expiresAt,
  })

  await expect(
    insertBooking({ courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 19 }),
  ).rejects.toMatchObject({ cause: { code: '23P01' } })
})

test('a completed booking blocks an overlapping booking', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await insertBooking({
    courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 19, status: 'completed',
  })

  await expect(
    insertBooking({ courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 19 }),
  ).rejects.toMatchObject({ cause: { code: '23P01' } })
})

// Review finding (Important-3): nothing previously inspected the catalog,
// so a silently-absent (or silently-narrowed) constraint would make the
// behavioural tests above merely pass differently rather than fail loudly.
// This pins the constraint's exact shape — gist, the right two columns/
// operators, and the full predicate — independent of any particular
// row-level behaviour.
//
// Updated by 20260805090100_branch_staff_and_blocks.sql: the predicate now
// also lists 'blocked', so a block occupies the slot exactly like a paid
// booking. tests/schema/blocks.test.ts covers the block-vs-booking exclusion
// behaviourally; this test stays the one place the exact rendered definition
// is pinned.
test('the bookings_no_overlap constraint has the exact expected shape', async () => {
  const result = await db.execute(sql`
    select pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'public.bookings'::regclass and conname = 'bookings_no_overlap'
  `)
  expect(result.rows).toHaveLength(1)
  expect(result.rows[0].def).toBe(
    "EXCLUDE USING gist (court_id WITH =, slot WITH &&) WHERE " +
      "((status = ANY (ARRAY['pending_payment'::booking_status, " +
      "'confirmed'::booking_status, 'completed'::booking_status, " +
      "'blocked'::booking_status])))",
  )
})

// Review finding (Important-4): every real lifecycle transition is an
// UPDATE, not an INSERT, and the subtlest is the late-payment re-confirm at
// spec:277 — booking A expires, its slot is resold to B as `confirmed`,
// then A's payment lands late and a webhook tries to flip A back to
// `confirmed`. Postgres enforces exclusion constraints on UPDATE just as it
// does on INSERT (the new row version has to satisfy them too), but that
// guarantee was previously unproven for this table.
test('re-confirming an expired booking after its slot was resold is rejected', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  const original = await insertBooking({
    courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 19, status: 'expired',
  })
  const originalId = original.rows[0].id as string

  // The slot gets resold to a live booking while the first is expired.
  await insertBooking({ courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 19 })

  // A late-arriving payment webhook tries to re-confirm the original,
  // now-superseded booking. It must be rejected, not silently double-book.
  await expect(
    db.execute(sql`update bookings set status = 'confirmed' where id = ${originalId}::uuid`),
  ).rejects.toMatchObject({ cause: { code: '23P01' } })
})

test('a pending_payment booking must carry an expiry', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await expect(
    insertBooking({
      courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 19,
      status: 'pending_payment', expiresAt: null,
    }),
  ).rejects.toThrow()
})

test('ends_at must be after starts_at', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  // Review finding (Important-1): a reversed span (end before start) never
  // reaches the `bookings_time_order` CHECK at all — tstzrange(x, y, '[)')
  // with x > y throws "range lower bound must be less than or equal to
  // range upper bound" (SQLSTATE 22000) during generated-column tuple
  // formation, before ExecConstraints runs. Asserting the specific SQLSTATE
  // (not a bare `.rejects.toThrow()`) documents that this test proves the
  // generated column's own range construction rejects it, not the CHECK.
  await expect(
    insertBooking({ courtId: courtIds[0], branchId, playerId, startHour: 20, endHour: 18 }),
  ).rejects.toMatchObject({ cause: { code: '22000' } })
})

// Review finding (Important-1, continued): what the CHECK uniquely catches
// is ends_at === starts_at. tstzrange(x, x, '[)') is a legal *empty* range —
// construction does not throw — and an empty range never overlaps anything,
// so bookings_no_overlap cannot catch a zero-length booking either. Without
// bookings_time_order, a zero-minute booking that occupies no slot but
// still carries a charge would be silently accepted.
test('a zero-length booking is rejected by the time-order check', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()

  await expect(
    insertBooking({ courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 18 }),
  ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'bookings_time_order' } })
})

// Not in the brief — added because the exclusion constraint's entire purpose
// is to survive concurrent racers. The shared `db` export (src/db/index.ts)
// is itself a `pg.Pool` (default `max: 10`), so two concurrent `db.execute`
// calls could in principle land on two different pooled backends too — but
// relying on that would make "two distinct connections" an accident of pool
// internals (pool size, checkout order, idle-connection reuse) rather than
// something this test controls directly. Using two explicit, hand-
// constructed `pg.Client` instances instead makes the two racing
// connections unambiguous and deterministic: each is its own TCP
// connection, its own backend PID, its own transaction, opened and driven
// by this test alone, so Postgres itself — not JS scheduling or pool
// behaviour — decides who wins.
//
// Review finding (cheap fix): the ranges below (18-20 vs 19-21) overlap but
// are not identical. Racing two identical ranges would also be satisfied by
// a plain unique index on (court_id, slot) — proving only "no exact
// duplicate," not "no overlap." Distinct-but-overlapping ranges prove both
// "exactly one winner" and "overlap, not mere equality, is what's caught."
test('concurrent overlapping inserts on the same court: exactly one wins', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const courtId = courtIds[0]

  const insertSql = `
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos, fee_config_snapshot
    ) values ($1, $2, $3, $4, $5, 'confirmed', $6, $7, $8, $9, $10, $11, '{}'::jsonb)
    returning id
  `
  const paramsFor = (startHour: number, endHour: number) => [
    courtId, branchId, playerId,
    manilaHour('2026-09-01', startHour).toISOString(),
    manilaHour('2026-09-01', endHour).toISOString(),
    FEES.courtFee, FEES.txFee, FEES.total, FEES.platformFee, FEES.processorFee, FEES.ownerNet,
  ]

  const clientA = new Client({ connectionString: process.env.DATABASE_URL })
  const clientB = new Client({ connectionString: process.env.DATABASE_URL })
  await clientA.connect()
  await clientB.connect()

  try {
    const results = await Promise.allSettled([
      clientA.query(insertSql, paramsFor(18, 20)),
      clientB.query(insertSql, paramsFor(19, 21)),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    // If the constraint did not exist, both would fulfill and this would
    // fail here — the assertion genuinely binds to the constraint's effect.
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    // Two racing, overlapping-but-not-identical inserts against a GiST
    // exclusion constraint resolve one of two documented ways depending on
    // exact timing: either backend can win the index check outright and
    // reject the other immediately (23P01), OR both backends can end up
    // waiting on each other's not-yet-committed candidate tuple, which
    // Postgres's deadlock detector then breaks by aborting one (40P01).
    // Observed both outcomes across repeated runs of this exact test.
    // Either way exactly one row survives, which the two assertions above
    // already established — this one only pins which SQLSTATE explains it.
    expect(['23P01', '40P01']).toContain((rejected[0] as PromiseRejectedResult).reason.code)
  } finally {
    await clientA.end()
    await clientB.end()
  }
})

// Final whole-branch review, MUST FIX #2: bookings.court_id/branch_id/
// player_id carry no `on delete` clause (Postgres default NO ACTION), while
// every FK above this table in the schema (profiles -> auth.users,
// branches.owner_id -> profiles, courts.branch_id -> branches) CASCADEs.
// That is a deliberate choice, not an oversight left over from three tasks
// disagreeing — bookings are financial records and must not vanish because
// someone deleted an account. These two tests pin the actual, intended
// behavior (rejection, not silent cascade) so it is documented by a test
// rather than by omission — see the migration's trailing comment on the
// `bookings` table for the full rationale.
test('deleting a player with an existing booking is rejected, not cascaded', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await insertBooking({ courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 19 })

  // bookings.player_id -> profiles has no `on delete`: deleting the
  // auth.users row cascades into profiles (profiles.id -> auth.users ON
  // DELETE CASCADE), and that cascaded profiles delete is what bookings'
  // RESTRICT actually blocks.
  await expect(
    db.execute(sql`delete from auth.users where id = ${playerId}::uuid`),
  ).rejects.toMatchObject({ cause: { code: '23503' } })

  // The booking, the player, and the branch/court under it must all still
  // exist — the delete above was fully rejected, not partially applied.
  const result = await db.execute(
    sql`select count(*)::int as n from bookings where player_id = ${playerId}::uuid`,
  )
  expect(result.rows[0].n).toBe(1)
})

test('deleting a branch owner with an existing booking under their court is rejected, not cascaded', async () => {
  const { ownerId, branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await insertBooking({ courtId: courtIds[0], branchId, playerId, startHour: 18, endHour: 19 })

  // bookings.court_id -> courts has no `on delete` either: deleting the
  // owner's auth.users row would otherwise cascade auth.users -> profiles ->
  // branches -> courts (all CASCADE), and it is that cascaded courts delete
  // bookings' RESTRICT blocks.
  await expect(
    db.execute(sql`delete from auth.users where id = ${ownerId}::uuid`),
  ).rejects.toMatchObject({ cause: { code: '23503' } })

  const result = await db.execute(
    sql`select count(*)::int as n from bookings where court_id = ${courtIds[0]}::uuid`,
  )
  expect(result.rows[0].n).toBe(1)
})
