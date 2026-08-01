import { expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

test('connects to the local Supabase Postgres', async () => {
  const result = await db.execute(sql`select 1 as one`)
  expect(result.rows[0]).toEqual({ one: 1 })
})

test('required extensions are available to install', async () => {
  const result = await db.execute(
    sql`select name from pg_available_extensions where name in ('btree_gist', 'postgis', 'pg_cron') order by name`,
  )
  expect(result.rows.map((r) => r.name)).toEqual(['btree_gist', 'pg_cron', 'postgis'])
})
