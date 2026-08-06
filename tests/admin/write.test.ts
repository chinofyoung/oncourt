import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'
import { MAX_REJECTION_REASON } from '@/lib/admin/moderation'
import { approveCourt, rejectCourt, suspendCourt, unsuspendCourt } from '@/lib/admin/write'

afterAll(teardownFixtures)

const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555'

/**
 * Every transition here is a status-scoped UPDATE, so "what is the status now"
 * is the whole assertion surface — plus, for reject, the reason it wrote.
 *
 * The fixture court is open 11-24 every day with bands 11-15 / 15-17 / 17-24:
 * an exact tiling, which is what makes it approvable. Tests that need an
 * un-approvable court break that tiling explicitly, so the reason a court is
 * refused is visible in the test rather than inherited from the fixture.
 */
async function setStatus(courtId: string, status: string, rejectionReason: string | null = null) {
  await db.execute(sql`
    update courts set status = ${status}::court_status, rejection_reason = ${rejectionReason}
    where id = ${courtId}::uuid
  `)
}

async function courtRow(courtId: string): Promise<{ status: string; rejectionReason: string | null }> {
  const result = await db.execute(sql`
    select status::text as status, rejection_reason from courts where id = ${courtId}::uuid
  `)
  return {
    status: result.rows[0].status as string,
    rejectionReason: (result.rows[0].rejection_reason as string | null) ?? null,
  }
}

// ------------------------------------------------------------------ approve

test('approveCourt approves a pending court whose bands tile its hours', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')

  await expect(approveCourt({ courtId: courtIds[0] })).resolves.toEqual({ ok: true })
  expect((await courtRow(courtIds[0])).status).toBe('approved')
})

test('approveCourt refuses a court whose bands leave a gap, and leaves it pending', async () => {
  // THE carried recommendation from Slice B's final review. Deleting the
  // middle band leaves 15-17 unpriced; approving it would put a court on the
  // market that throws "No rate band covers hour 15" out of priceSlots() in
  // the middle of a player's checkout.
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')
  await db.execute(sql`
    delete from court_rate_bands where court_id = ${courtIds[0]}::uuid and start_hour = 15
  `)

  await expect(approveCourt({ courtId: courtIds[0] })).resolves.toEqual({
    ok: false,
    reason: 'schedule_incomplete',
    warning: 'bands_do_not_tile',
  })
  expect((await courtRow(courtIds[0])).status).toBe('pending')
})

test('approveCourt refuses a court with no operating hours at all', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')
  await db.execute(sql`delete from court_operating_hours where court_id = ${courtIds[0]}::uuid`)

  await expect(approveCourt({ courtId: courtIds[0] })).resolves.toEqual({
    ok: false,
    reason: 'schedule_incomplete',
    warning: 'no_open_day',
  })
  expect((await courtRow(courtIds[0])).status).toBe('pending')
})

test('approveCourt refuses a court with hours but no rates', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')
  await db.execute(sql`delete from court_rate_bands where court_id = ${courtIds[0]}::uuid`)

  await expect(approveCourt({ courtId: courtIds[0] })).resolves.toEqual({
    ok: false,
    reason: 'schedule_incomplete',
    warning: 'no_bands',
  })
  expect((await courtRow(courtIds[0])).status).toBe('pending')
})

test('approveCourt reports stale for a court that is no longer pending', async () => {
  // Two admins with the queue open, one clicks after the other. The second
  // gets a sentence, not a second write and not an error page.
  const { courtIds } = await seedBranchWithCourts(2)
  await setStatus(courtIds[0], 'approved')
  await setStatus(courtIds[1], 'suspended')

  for (const courtId of courtIds) {
    await expect(approveCourt({ courtId })).resolves.toEqual({ ok: false, reason: 'stale' })
  }
  expect((await courtRow(courtIds[0])).status).toBe('approved')
  expect((await courtRow(courtIds[1])).status).toBe('suspended')
})

test('approveCourt reports stale for a court id that does not exist', async () => {
  await expect(approveCourt({ courtId: UNKNOWN_ID })).resolves.toEqual({
    ok: false,
    reason: 'stale',
  })
})

// ------------------------------------------------------------------- reject

test('rejectCourt requires a reason and writes nothing without one', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')

  for (const reason of ['', '   ', '\n\t ']) {
    await expect(rejectCourt({ courtId: courtIds[0], reason })).resolves.toEqual({
      ok: false,
      reason: 'empty_reason',
    })
  }
  expect(await courtRow(courtIds[0])).toEqual({ status: 'pending', rejectionReason: null })
})

test('rejectCourt refuses a reason past the length limit', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')

  await expect(
    rejectCourt({ courtId: courtIds[0], reason: 'x'.repeat(MAX_REJECTION_REASON + 1) }),
  ).resolves.toEqual({ ok: false, reason: 'reason_too_long' })
  expect((await courtRow(courtIds[0])).status).toBe('pending')

  // The boundary itself is allowed.
  await expect(
    rejectCourt({ courtId: courtIds[0], reason: 'x'.repeat(MAX_REJECTION_REASON) }),
  ).resolves.toEqual({ ok: true })
})

test('rejectCourt stores the trimmed reason and moves the court to rejected', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'pending')

  await expect(
    rejectCourt({ courtId: courtIds[0], reason: '  Add a photo showing the whole court.  ' }),
  ).resolves.toEqual({ ok: true })
  expect(await courtRow(courtIds[0])).toEqual({
    status: 'rejected',
    rejectionReason: 'Add a photo showing the whole court.',
  })
})

test('rejectCourt reports stale for a court that is not pending', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'approved')

  await expect(
    rejectCourt({ courtId: courtIds[0], reason: 'Too late.' }),
  ).resolves.toEqual({ ok: false, reason: 'stale' })
  expect(await courtRow(courtIds[0])).toEqual({ status: 'approved', rejectionReason: null })
})

// ------------------------------------------------------- suspend / unsuspend

test('suspendCourt takes an approved court off the market', async () => {
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'approved')

  await expect(suspendCourt({ courtId: courtIds[0] })).resolves.toEqual({ ok: true })
  expect((await courtRow(courtIds[0])).status).toBe('suspended')
})

test('suspendCourt reports stale for anything that is not approved', async () => {
  const { courtIds } = await seedBranchWithCourts(3)
  await setStatus(courtIds[0], 'pending')
  await setStatus(courtIds[1], 'rejected', 'Blurry photos.')
  await setStatus(courtIds[2], 'suspended')

  for (const courtId of courtIds) {
    await expect(suspendCourt({ courtId })).resolves.toEqual({ ok: false, reason: 'stale' })
  }
})

test('suspendCourt never touches the court’s bookings', async () => {
  // Spec: "Suspending never touches bookings." A suspended court disappears
  // from every public surface because those reads filter to approved — the
  // bookings already taken on it are financial records and stay exactly as
  // they are.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  await setStatus(courtIds[0], 'approved')
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId,
    startsAt: manilaHour('2026-09-14', 12),
    status: 'confirmed',
  })

  await expect(suspendCourt({ courtId: courtIds[0] })).resolves.toEqual({ ok: true })

  const booking = await db.execute(sql`
    select status::text as status, total_charged_centavos
    from bookings where id = ${bookingId}::uuid
  `)
  expect(booking.rows).toHaveLength(1)
  expect(booking.rows[0].status).toBe('confirmed')
  expect(Number(booking.rows[0].total_charged_centavos)).toBe(30000)
})

test('unsuspendCourt puts a suspended court straight back on the market', async () => {
  // Back to `approved`, NOT back to `pending`: an unsuspension reverses an
  // admin's own decision about a court that was already approved once. Sending
  // it through the queue again would make the admin re-approve their own undo.
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'suspended')

  await expect(unsuspendCourt({ courtId: courtIds[0] })).resolves.toEqual({ ok: true })
  expect((await courtRow(courtIds[0])).status).toBe('approved')
})

test('unsuspendCourt refuses a suspended court whose schedule went stale while off the market', async () => {
  // requeueCourtSql's predicate is `status in ('approved', 'rejected')`, so a
  // suspended court never re-queues — an owner can still edit its hours and
  // bands while it is suspended, and nothing stops that edit from breaking
  // the tiling. Unsuspending without re-checking would hand the market back a
  // court that throws "No rate band covers hour 15" out of priceSlots().
  const { courtIds } = await seedBranchWithCourts(1)
  await setStatus(courtIds[0], 'suspended')
  await db.execute(sql`
    delete from court_rate_bands where court_id = ${courtIds[0]}::uuid and start_hour = 15
  `)

  await expect(unsuspendCourt({ courtId: courtIds[0] })).resolves.toEqual({
    ok: false,
    reason: 'schedule_incomplete',
    warning: 'bands_do_not_tile',
  })
  expect((await courtRow(courtIds[0])).status).toBe('suspended')
})

test('unsuspendCourt reports stale for anything that is not suspended', async () => {
  const { courtIds } = await seedBranchWithCourts(3)
  await setStatus(courtIds[0], 'pending')
  await setStatus(courtIds[1], 'approved')
  await setStatus(courtIds[2], 'rejected', 'Blurry photos.')

  for (const courtId of courtIds) {
    await expect(unsuspendCourt({ courtId })).resolves.toEqual({ ok: false, reason: 'stale' })
  }
})
