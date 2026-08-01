import 'server-only'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')

// Not exported: final whole-branch review, ALSO FIX #11 — nothing outside
// this module ever imported `pool` (verified: grepped every `from '@/db'`
// import in src/ and tests/), so it was dead surface area, not a load-
// bearing part of this module's API. The Pool instance itself is still kept
// here, not removed — `drizzle(pool, ...)` below needs it, and a future
// graceful-shutdown/teardown path may too.
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const db = drizzle(pool, { casing: 'snake_case' })
