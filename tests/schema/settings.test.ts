import { expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

test('platform_settings holds exactly one row and rejects a second', async () => {
  const rows = await db.execute(sql`select * from platform_settings`)
  expect(rows.rows).toHaveLength(1)

  await expect(
    db.execute(sql`insert into platform_settings (id) values (true)`),
  ).rejects.toThrow()
})

test('default fee config is 10 percent borne by the platform', async () => {
  const rows = await db.execute(sql`
    select default_platform_fee_mode, default_platform_fee_value,
           default_processor_fee_bearer, hold_duration_minutes
    from platform_settings
  `)
  expect(rows.rows[0]).toEqual({
    default_platform_fee_mode: 'percentage',
    default_platform_fee_value: 1000, // basis points
    default_processor_fee_bearer: 'platform',
    hold_duration_minutes: 15,
  })
})

test('fee mode and value must be set together', async () => {
  await expect(
    db.execute(sql`update platform_settings set default_platform_fee_value = null`),
  ).rejects.toThrow()
})

test('processor rates are seeded for the three payment methods', async () => {
  const rows = await db.execute(
    sql`select payment_method, percentage_bps, fixed_fee_centavos from processor_rates order by payment_method`,
  )
  expect(rows.rows).toEqual([
    { payment_method: 'card', percentage_bps: 350, fixed_fee_centavos: 1500 },
    { payment_method: 'gcash', percentage_bps: 223, fixed_fee_centavos: 0 },
    { payment_method: 'maya', percentage_bps: 200, fixed_fee_centavos: 0 },
  ])
})
