import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  getPlatformSettings,
  updateOwnerFeeOverride,
  updatePlatformSettings,
} from '@/lib/admin/settings'
import { seedBranchWithCourts, seedOwner, seedPlayer, teardownFixtures } from '../helpers/fixtures'

afterAll(teardownFixtures)

/** Thrown to roll a transaction back after asserting inside it. */
const ROLLBACK = new Error('rollback')

async function feeColumns(userId: string) {
  const result = await db.execute(sql`
    select platform_fee_mode::text as mode, platform_fee_value as value,
           processor_fee_bearer::text as bearer
    from profiles where id = ${userId}::uuid
  `)
  return result.rows[0]
}

test('getPlatformSettings returns numbers, not strings', async () => {
  const settings = await getPlatformSettings()
  expect(typeof settings.feeValue).toBe('number')
  expect(typeof settings.holdDurationMinutes).toBe('number')
  expect(['percentage', 'flat']).toContain(settings.feeMode)
  expect(['player', 'owner', 'platform']).toContain(settings.processorFeeBearer)
  expect(settings.updatedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

test('updatePlatformSettings writes every field, verified inside a rolled-back transaction', async () => {
  // platform_settings is a SEEDED SINGLETON in a shared, persistent database,
  // and tests/booking/hold.test.ts reads it concurrently to price a hold. A
  // mutate-then-restore test has a real window where that test computes the
  // wrong fee. Running inside a transaction we roll back means no concurrent
  // reader ever sees the value, under read-committed isolation.
  const before = await getPlatformSettings()

  await expect(
    db.transaction(async (tx) => {
      const stampBefore = await tx.execute(sql`select updated_at from platform_settings`)

      const result = await updatePlatformSettings(
        {
          feeMode: 'flat',
          feeValue: 4321,
          processorFeeBearer: 'owner',
          holdDurationMinutes: 7,
        },
        tx,
      )
      expect(result).toEqual({ ok: true })

      const after = await tx.execute(sql`
        select default_platform_fee_mode::text as mode, default_platform_fee_value as value,
               default_processor_fee_bearer::text as bearer, hold_duration_minutes, updated_at
        from platform_settings
      `)
      expect(after.rows[0].mode).toBe('flat')
      expect(Number(after.rows[0].value)).toBe(4321)
      expect(after.rows[0].bearer).toBe('owner')
      expect(Number(after.rows[0].hold_duration_minutes)).toBe(7)
      expect(new Date(after.rows[0].updated_at as string).getTime()).toBeGreaterThan(
        new Date(stampBefore.rows[0].updated_at as string).getTime(),
      )

      throw ROLLBACK
    }),
  ).rejects.toBe(ROLLBACK)

  // Not redundant with the rollback: this is what proves the test is safe to
  // run against a shared database, and it fails loudly if updatePlatformSettings
  // is ever changed to ignore its executor argument.
  expect(await getPlatformSettings()).toEqual(before)
})

test('updatePlatformSettings rejects out-of-range input without touching the database', async () => {
  const before = await getPlatformSettings()
  const valid = {
    feeMode: 'percentage' as const,
    feeValue: 1000,
    processorFeeBearer: 'platform' as const,
    holdDurationMinutes: 15,
  }

  expect(await updatePlatformSettings({ ...valid, feeValue: 0 })).toEqual({
    ok: false,
    reason: 'invalid_fee',
  })
  expect(await updatePlatformSettings({ ...valid, feeValue: -1 })).toEqual({
    ok: false,
    reason: 'invalid_fee',
  })
  expect(await updatePlatformSettings({ ...valid, feeValue: 10001 })).toEqual({
    ok: false,
    reason: 'invalid_fee',
  })
  expect(await updatePlatformSettings({ ...valid, feeValue: 10.5 })).toEqual({
    ok: false,
    reason: 'invalid_fee',
  })
  expect(await updatePlatformSettings({ ...valid, holdDurationMinutes: 0 })).toEqual({
    ok: false,
    reason: 'invalid_hold',
  })
  // Final whole-branch review, item #4: MIN_HOLD_MINUTES was raised from 1 to
  // 5 (the live platform default) — a PayMongo redirect cannot reliably
  // complete in under a minute or two, so a shorter hold dies mid-payment and
  // generates manual-refund work continuously. 4 is below the NEW floor but
  // was accepted under the old one, so this specifically exercises the raised
  // floor rather than just re-proving 0 is still rejected either way.
  expect(await updatePlatformSettings({ ...valid, holdDurationMinutes: 4 })).toEqual({
    ok: false,
    reason: 'invalid_hold',
  })
  expect(await updatePlatformSettings({ ...valid, holdDurationMinutes: 121 })).toEqual({
    ok: false,
    reason: 'invalid_hold',
  })

  // 10001 is fine in FLAT mode — ₱100.01 — which is exactly what the
  // conditional constraint exists to allow.
  expect(await getPlatformSettings()).toEqual(before)
})

test('updatePlatformSettings refuses a flat fee at or above the cheapest approved court rate', async () => {
  // Final whole-branch review, MUST-FIX #1: a flat fee at or above a court's
  // cheapest hourly rate makes owner_net negative (src/lib/booking/hold.ts).
  // seedBranchWithCourts seeds rate bands at 26500/31500/36500 centavos on a
  // fresh, approved court, which guarantees at least one real approved court
  // exists platform-wide for this test run — without it, a platform with zero
  // approved courts would let `cheapestApprovedRateCentavos` return `null`
  // and the guard would trivially allow anything, proving nothing.
  //
  // The probed value (MAX_FLAT_FEE_CENTAVOS itself, ₱10,000/hr) is not this
  // fixture's own 26500 — this is the shared, persistent platform-wide query
  // (no owner scoping), so another test's leftover court could set the real
  // minimum lower than 26500. ₱10,000/hr is comfortably above any real
  // pickleball court's rate anywhere on this database, so the refusal itself
  // is deterministic; only the exact cheapestRateCentavos echoed back is
  // provably bounded (it can only be pulled down by this fixture, never up).
  await seedBranchWithCourts(1)
  const before = await getPlatformSettings()

  await expect(
    db.transaction(async (tx) => {
      const result = await updatePlatformSettings(
        { feeMode: 'flat', feeValue: 1_000_000, processorFeeBearer: 'platform', holdDurationMinutes: 5 },
        tx,
      )
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).toBe('flat_fee_exceeds_cheapest_rate')
      if (result.reason === 'flat_fee_exceeds_cheapest_rate') {
        expect(result.cheapestRateCentavos).toBeGreaterThan(0)
        expect(result.cheapestRateCentavos).toBeLessThanOrEqual(26500)
      }
      throw ROLLBACK
    }),
  ).rejects.toBe(ROLLBACK)

  expect(await getPlatformSettings()).toEqual(before)
})

test('updatePlatformSettings accepts a flat fee comfortably below the cheapest rate', async () => {
  await seedBranchWithCourts(1)
  const before = await getPlatformSettings()

  await expect(
    db.transaction(async (tx) => {
      // ₱1 is comfortably below any real court's cheapest hourly rate.
      const result = await updatePlatformSettings(
        { feeMode: 'flat', feeValue: 100, processorFeeBearer: 'platform', holdDurationMinutes: 5 },
        tx,
      )
      expect(result).toEqual({ ok: true })
      throw ROLLBACK
    }),
  ).rejects.toBe(ROLLBACK)

  // Same self-policing check as the sibling test above: proves this test is
  // safe to run against the shared database, and fails loudly if this case
  // is ever changed to call updatePlatformSettings without `tx`.
  expect(await getPlatformSettings()).toEqual(before)
})

test('the percentage ceiling is a real constraint, and it is conditional', async () => {
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`
        update platform_settings
        set default_platform_fee_mode = 'percentage', default_platform_fee_value = 10001
        where id
      `)
    }),
  ).rejects.toThrow()

  // The same number under 'flat' must succeed — otherwise the constraint is a
  // blanket cap and would forbid a ₱100.01 flat fee.
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`
        update platform_settings
        set default_platform_fee_mode = 'flat', default_platform_fee_value = 10001
        where id
      `)
      throw ROLLBACK
    }),
  ).rejects.toBe(ROLLBACK)
})

test('updateOwnerFeeOverride sets, replaces and clears an override', async () => {
  const ownerId = await seedOwner()

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: 'percentage',
      feeValue: 1500,
      processorFeeBearer: 'owner',
    }),
  ).toEqual({ ok: true })
  expect(await feeColumns(ownerId)).toEqual({ mode: 'percentage', value: 1500, bearer: 'owner' })

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: 'flat',
      feeValue: 25000,
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: true })
  expect(await feeColumns(ownerId)).toEqual({ mode: 'flat', value: 25000, bearer: null })

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: null,
      feeValue: null,
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: true })
  expect(await feeColumns(ownerId)).toEqual({ mode: null, value: null, bearer: null })
})

test('the bearer override is independent of the fee pair', async () => {
  const ownerId = await seedOwner()
  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: null,
      feeValue: null,
      processorFeeBearer: 'player',
    }),
  ).toEqual({ ok: true })
  expect(await feeColumns(ownerId)).toEqual({ mode: null, value: null, bearer: 'player' })
})

test('updateOwnerFeeOverride refuses an unpaired or out-of-range fee', async () => {
  const ownerId = await seedOwner()

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: 'percentage',
      feeValue: null,
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: false, reason: 'unpaired_fee' })

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: null,
      feeValue: 1500,
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: false, reason: 'unpaired_fee' })

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: 'percentage',
      feeValue: 10001,
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: false, reason: 'invalid_fee' })

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: 'percentage',
      feeValue: 0,
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: false, reason: 'invalid_fee' })

  expect(await feeColumns(ownerId)).toEqual({ mode: null, value: null, bearer: null })
})

test('a player can never be given a fee override', async () => {
  const playerId = await seedPlayer()

  expect(
    await updateOwnerFeeOverride(playerId, {
      feeMode: 'percentage',
      feeValue: 1500,
      processorFeeBearer: 'owner',
    }),
  ).toEqual({ ok: false, reason: 'no_such_owner' })

  // Both halves matter: a guard that returns the right word while still
  // writing the row is not a guard. An override left on a player's profile
  // would sit invisible and inert until they were promoted, then take effect.
  expect(await feeColumns(playerId)).toEqual({ mode: null, value: null, bearer: null })
})

test('updateOwnerFeeOverride refuses a flat fee at or above that owner’s own cheapest rate', async () => {
  // Owner-scoped equivalent of the platform-wide guard above. Deterministic,
  // unlike the platform-wide test: this guard joins through
  // branches.owner_id, so a freshly seeded owner's own courts are the ONLY
  // rows the query can see, regardless of what any other test has seeded
  // elsewhere on this shared, persistent database. seedBranchWithCourts's
  // cheapest band is exactly 26500.
  const { ownerId } = await seedBranchWithCourts(1)

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: 'flat',
      feeValue: 26500, // meets the cheapest band exactly — 'at or above', not just 'above'
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: false, reason: 'flat_fee_exceeds_cheapest_rate', cheapestRateCentavos: 26500 })

  // Refused means untouched: still inheriting, not silently written anyway.
  expect(await feeColumns(ownerId)).toEqual({ mode: null, value: null, bearer: null })
})

test('updateOwnerFeeOverride accepts a flat fee comfortably below that owner’s cheapest rate', async () => {
  const { ownerId } = await seedBranchWithCourts(1)

  expect(
    await updateOwnerFeeOverride(ownerId, {
      feeMode: 'flat',
      feeValue: 5000,
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: true })
  expect(await feeColumns(ownerId)).toEqual({ mode: 'flat', value: 5000, bearer: null })
})

test('updateOwnerFeeOverride ignores OTHER owners’ courts when checking the cheapest rate', async () => {
  // Proves the join is actually scoped by b.owner_id, not "any approved
  // court on the platform" with the owner_id clause silently doing nothing.
  // Owner B gets an artificially cheap rate band (8-9 AM, an hour neither of
  // seedBranchWithCourts's default bands cover, so no overlap) that would
  // trip up an unscoped query; owner A's own check must never see it.
  const { ownerId: ownerA } = await seedBranchWithCourts(1)
  const { courtIds: courtIdsB } = await seedBranchWithCourts(1)
  await db.execute(sql`
    insert into court_rate_bands (court_id, start_hour, end_hour, price_centavos)
    values (${courtIdsB[0]}::uuid, 8, 9, 100)
  `)

  // 5000 is comfortably below owner A's own real cheapest band (26500) but
  // ABOVE the 100-centavo band just planted on owner B's court. If the join
  // ever regressed to "any approved court on the platform" instead of "this
  // owner's own", this would wrongly refuse.
  expect(
    await updateOwnerFeeOverride(ownerA, {
      feeMode: 'flat',
      feeValue: 5000,
      processorFeeBearer: null,
    }),
  ).toEqual({ ok: true })
})
