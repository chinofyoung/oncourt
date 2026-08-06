import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  manilaHour,
  seedBlock,
  seedBooking,
  seedBranchWithCourts,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'
import {
  branchIdOfBlock,
  branchIdOfCourt,
  createBlock,
  deleteBlock,
  parseBlockId,
  parseBlockInput,
} from '@/lib/blocks/write'
import { createHold } from '@/lib/booking/hold'

afterAll(teardownFixtures)

const DATE = '2027-01-14'
const UUID = '11111111-2222-3333-4444-555555555555'

function form(entries: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.set(key, value)
  return data
}

test('parseBlockInput accepts a valid submission and trims the note', () => {
  expect(
    parseBlockInput(
      form({ courtId: UUID, date: DATE, startHour: '9', endHour: '11', note: '  Resurfacing  ' }),
    ),
  ).toEqual({ courtId: UUID, date: DATE, startHour: 9, endHour: 11, note: 'Resurfacing' })
})

test('parseBlockInput normalizes an empty or whitespace note to null', () => {
  // The DB coalesce treats a blank note as absent when labelling the cell;
  // storing '' and then rendering 'Blocked' would be two representations of
  // one state.
  for (const note of ['', '   ']) {
    expect(
      parseBlockInput(form({ courtId: UUID, date: DATE, startHour: '9', endHour: '10', note }))
        ?.note,
    ).toBeNull()
  }
})

test('parseBlockInput rejects a non-UUID court id', () => {
  // Without this the id reaches a ::uuid cast and Postgres raises 22P02, which
  // would escape as an unhandled exception rather than a form error.
  expect(
    parseBlockInput(form({ courtId: 'not-a-uuid', date: DATE, startHour: '9', endHour: '10' })),
  ).toBeNull()
})

test('parseBlockInput rejects a shape-valid but nonexistent calendar date', () => {
  // isValidCalendarDate's job: `2027-02-30` passes a YYYY-MM-DD regex and then
  // silently normalizes to March 2 inside Date parsing, landing the block on
  // the wrong day instead of erroring. Same rule createHoldAction applies.
  expect(
    parseBlockInput(form({ courtId: UUID, date: '2027-02-30', startHour: '9', endHour: '10' })),
  ).toBeNull()
  expect(
    parseBlockInput(form({ courtId: UUID, date: 'tomorrow', startHour: '9', endHour: '10' })),
  ).toBeNull()
})

test('parseBlockInput rejects hour ranges the exclusion constraint could not represent', () => {
  // endHour <= startHour reaches tstzrange(start, end, '[)') reversed, which
  // Postgres rejects with 22000 — unrecognized by any catch below.
  const bad = [
    { startHour: '11', endHour: '9' },
    { startHour: '9', endHour: '9' },
    { startHour: '-1', endHour: '2' },
    { startHour: '9', endHour: '25' },
    { startHour: '9.5', endHour: '10' },
    { startHour: 'nine', endHour: 'ten' },
  ]
  for (const hours of bad) {
    expect(parseBlockInput(form({ courtId: UUID, date: DATE, ...hours }))).toBeNull()
  }
})

test('parseBlockInput rejects an over-long note', () => {
  expect(
    parseBlockInput(
      form({ courtId: UUID, date: DATE, startHour: '9', endHour: '10', note: 'x'.repeat(201) }),
    ),
  ).toBeNull()
})

test('parseBlockId accepts a UUID and rejects anything else', () => {
  expect(parseBlockId(form({ blockId: UUID }))).toBe(UUID)
  expect(parseBlockId(form({ blockId: 'nope' }))).toBeNull()
  expect(parseBlockId(new FormData())).toBeNull()
})

test('branchIdOfCourt returns the court\'s real branch, and null for a stranger id', async () => {
  // This is what makes the action's guard trustworthy: the branch it checks
  // access against comes from the database, never from the submitted form.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  await expect(branchIdOfCourt(courtIds[0])).resolves.toBe(branchId)
  await expect(branchIdOfCourt(crypto.randomUUID())).resolves.toBeNull()
})

test('branchIdOfBlock resolves only blocked rows', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(2)
  const player = await seedPlayer()
  const blockId = await seedBlock({
    courtId: courtIds[0],
    branchId,
    createdBy: ownerId,
    startsAt: manilaHour(DATE, 12),
  })
  const bookingId = await seedBooking({
    courtId: courtIds[1],
    branchId,
    playerId: player,
    startsAt: manilaHour(DATE, 12),
    status: 'confirmed',
  })

  await expect(branchIdOfBlock(blockId)).resolves.toBe(branchId)
  // A paid booking is NOT a block, so the delete path can never reach one —
  // deleting a financial record is not what this feature does.
  await expect(branchIdOfBlock(bookingId)).resolves.toBeNull()
  await expect(branchIdOfBlock(crypto.randomUUID())).resolves.toBeNull()
})

test('createBlock writes a blocked row with zero money and a null snapshot', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)

  const result = await createBlock({
    courtId: courtIds[0],
    branchId,
    createdBy: ownerId,
    date: DATE,
    startHour: 13,
    endHour: 15,
    note: 'Resurfacing',
  })
  expect(result).toMatchObject({ ok: true })

  const rows = await db.execute(sql`
    select status::text as status, player_id, created_by, note, fee_config_snapshot,
      total_charged_centavos, owner_net_centavos, platform_fee_centavos,
      to_char(starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD HH24') as starts,
      to_char(ends_at   at time zone 'Asia/Manila', 'YYYY-MM-DD HH24') as ends
    from bookings where id = ${(result as { ok: true; blockId: string }).blockId}::uuid
  `)
  expect(rows.rows[0]).toMatchObject({
    status: 'blocked',
    player_id: null,
    created_by: ownerId,
    note: 'Resurfacing',
    fee_config_snapshot: null,
    total_charged_centavos: 0,
    owner_net_centavos: 0,
    platform_fee_centavos: 0,
    starts: `${DATE} 13`,
    ends: `${DATE} 15`,
  })
})

test('createBlock accepts a block outside the court\'s operating hours', async () => {
  // Deliberate: maintenance happens when the venue is shut. The fixtures open
  // at 11, so hour 8 is closed — and blocking it must still work, unlike a
  // paid hold, which createHold refuses with 'court_closed'.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)

  await expect(
    createBlock({
      courtId: courtIds[0],
      branchId,
      createdBy: ownerId,
      date: DATE,
      startHour: 8,
      endHour: 9,
      note: null,
    }),
  ).resolves.toMatchObject({ ok: true })
})

test('createBlock refuses a court that is not approved', async () => {
  // A block on a pending/suspended court would render nowhere: the grid and
  // getScheduleCourts both list approved courts only, so the row would be
  // invisible while still occupying the slot.
  const { branchId, ownerId } = await seedBranchWithCourts(1)
  const pending = await db.execute(sql`
    insert into courts (branch_id, name, environment, status)
    values (${branchId}::uuid, 'Court Pending', 'outdoor', 'pending')
    returning id
  `)

  await expect(
    createBlock({
      courtId: pending.rows[0].id as string,
      branchId,
      createdBy: ownerId,
      date: DATE,
      startHour: 16,
      endHour: 17,
      note: null,
    }),
  ).resolves.toEqual({ ok: false, reason: 'court_unavailable' })
})

test('createBlock reports slot_taken over an existing paid booking', async () => {
  // 23P01 from bookings_no_overlap, translated. The constraint is the
  // authority — no check-then-insert race.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: manilaHour(DATE, 18),
    hours: 2,
    status: 'confirmed',
  })

  await expect(
    createBlock({
      courtId: courtIds[0],
      branchId,
      createdBy: ownerId,
      date: DATE,
      startHour: 19,
      endHour: 21,
      note: null,
    }),
  ).resolves.toEqual({ ok: false, reason: 'slot_taken' })
})

test('createBlock reports slot_taken over an existing block', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  await seedBlock({
    courtId: courtIds[0],
    branchId,
    createdBy: ownerId,
    startsAt: manilaHour(DATE, 21),
    hours: 2,
  })

  await expect(
    createBlock({
      courtId: courtIds[0],
      branchId,
      createdBy: ownerId,
      date: DATE,
      startHour: 22,
      endHour: 23,
      note: null,
    }),
  ).resolves.toEqual({ ok: false, reason: 'slot_taken' })
})

test('createBlock succeeds over an expired-but-unswept hold', async () => {
  // The exclusion constraint's predicate cannot call now() (index predicates
  // must be immutable), so a dead hold still blocks the slot until something
  // sweeps it. createHold sweeps inside its own transaction for exactly this
  // reason; createBlock must too, or an owner cannot reclaim a slot whose
  // checkout was abandoned until the once-a-minute cron catches up.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const holdId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: manilaHour(DATE, 9),
    status: 'pending_payment',
  })
  await db.execute(
    sql`update bookings set expires_at = now() - interval '1 minute' where id = ${holdId}::uuid`,
  )

  await expect(
    createBlock({
      courtId: courtIds[0],
      branchId,
      createdBy: ownerId,
      date: DATE,
      startHour: 9,
      endHour: 10,
      note: null,
    }),
  ).resolves.toMatchObject({ ok: true })

  const hold = await db.execute(
    sql`select status::text as status from bookings where id = ${holdId}::uuid`,
  )
  expect(hold.rows[0].status).toBe('expired')
})

test('createBlock reports slot_taken over a LIVE hold', async () => {
  // The other side of the sweep: a checkout genuinely in progress must not be
  // stolen out from under the player.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: manilaHour(DATE, 10),
    status: 'pending_payment',
  })

  await expect(
    createBlock({
      courtId: courtIds[0],
      branchId,
      createdBy: ownerId,
      date: DATE,
      startHour: 10,
      endHour: 11,
      note: null,
    }),
  ).resolves.toEqual({ ok: false, reason: 'slot_taken' })
})

test('createBlock reports invalid_input for an unparseable date or hour', async () => {
  // createBlock promises a CreateBlockResult, never a throw, for anything a
  // caller can pass. parseBlockInput catches these first in production; this
  // pins the library's own contract.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)

  await expect(
    createBlock({
      courtId: courtIds[0],
      branchId,
      createdBy: ownerId,
      date: 'not-a-date',
      startHour: 9,
      endHour: 10,
      note: null,
    }),
  ).resolves.toEqual({ ok: false, reason: 'invalid_input' })
})

test('deleteBlock frees the slot and lets the same hours be booked', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const blockId = await seedBlock({
    courtId: courtIds[0],
    branchId,
    createdBy: ownerId,
    startsAt: manilaHour(DATE, 11),
  })

  await expect(deleteBlock(blockId)).resolves.toEqual({ ok: true })

  // The slot is genuinely free: the exclusion constraint accepts a booking on
  // the same hours, which a surviving block would refuse with 23P01.
  await expect(
    seedBooking({
      courtId: courtIds[0],
      branchId,
      playerId: player,
      startsAt: manilaHour(DATE, 11),
      status: 'confirmed',
    }),
  ).resolves.toBeTypeOf('string')
})

test('deleteBlock reports not_found for an unknown id and refuses a paid booking', async () => {
  // The status filter in the WHERE clause is the guarantee, not a prior read:
  // the parent spec's "no DELETE on bookings" hardening note is carved out for
  // `blocked` rows only, and a paid booking is a financial record.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: manilaHour(DATE, 20),
    status: 'confirmed',
  })

  await expect(deleteBlock(crypto.randomUUID())).resolves.toEqual({
    ok: false,
    reason: 'not_found',
  })
  await expect(deleteBlock(bookingId)).resolves.toEqual({ ok: false, reason: 'not_found' })

  const still = await db.execute(sql`select 1 from bookings where id = ${bookingId}::uuid`)
  expect(still.rows).toHaveLength(1)
})

test('deleting the same block twice is reported, not thrown', async () => {
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const blockId = await seedBlock({
    courtId: courtIds[0],
    branchId,
    createdBy: ownerId,
    startsAt: manilaHour(DATE, 22),
  })

  await expect(deleteBlock(blockId)).resolves.toEqual({ ok: true })
  await expect(deleteBlock(blockId)).resolves.toEqual({ ok: false, reason: 'not_found' })
})

test('CONCURRENCY: N simultaneous createBlock calls on one slot produce exactly one winner', async () => {
  // Mirrors tests/booking/hold.test.ts's "N simultaneous holds on one slot"
  // (same N = 8): the exclusion constraint is the only arbiter, so N racing
  // inserts for the identical court/slot must yield exactly one survivor and
  // N-1 translated 23P01s, never a crash and never two blocked rows.
  const N = 8
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)

  const results = await Promise.all(
    Array.from({ length: N }, () =>
      createBlock({
        courtId: courtIds[0],
        branchId,
        createdBy: ownerId,
        date: DATE,
        startHour: 6,
        endHour: 7,
        note: null,
      }),
    ),
  )

  expect(results.filter((r) => r.ok)).toHaveLength(1)
  expect(results.filter((r) => !r.ok && r.reason === 'slot_taken')).toHaveLength(N - 1)

  const rows = await db.execute(sql`
    select count(*)::int as n from bookings
    where court_id = ${courtIds[0]}::uuid and status = 'blocked'
  `)
  expect(rows.rows[0].n).toBe(1)
}, 20_000)

test('CONCURRENCY: createBlock and createHold racing for the same slot produce exactly one winner', async () => {
  // The cross-module case: bookings_no_overlap arbitrates between the two
  // functions identically to how it arbitrates within one of them. Hours
  // chosen inside the fixture's operating window (11..24) so createHold's own
  // 'court_closed' check can never be the reason either side loses — the only
  // possible outcome is a race decided by the exclusion constraint.
  const { branchId, courtIds, ownerId } = await seedBranchWithCourts(1)
  const player = await seedPlayer()

  const [blockResult, holdResult] = await Promise.all([
    createBlock({
      courtId: courtIds[0],
      branchId,
      createdBy: ownerId,
      date: DATE,
      startHour: 13,
      endHour: 14,
      note: null,
    }),
    createHold({
      courtId: courtIds[0],
      branchId,
      playerId: player,
      date: DATE,
      startHour: 13,
      endHour: 14,
    }),
  ])

  const winners = [blockResult.ok, holdResult.ok].filter(Boolean)
  expect(winners).toHaveLength(1)
  if (!blockResult.ok) expect(blockResult.reason).toBe('slot_taken')
  if (!holdResult.ok) expect(holdResult.reason).toBe('slot_taken')

  const rows = await db.execute(sql`
    select count(*)::int as n from bookings
    where court_id = ${courtIds[0]}::uuid and status in ('blocked', 'pending_payment')
  `)
  expect(rows.rows[0].n).toBe(1)
}, 20_000)
