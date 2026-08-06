import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

/**
 * The court's real branch, read from the database.
 *
 * This is what makes a court-scoped action's guard trustworthy. If the form
 * supplied a branchId, an attacker would choose one value for
 * requireBranchAccess and the write would use another — a confused deputy.
 * Reading it here means the guard and the write always refer to the same
 * branch, and it is why none of the court actions has an `invalid_branch`
 * failure reason at all.
 *
 * Moved out of src/lib/blocks/write.ts (where it started) when the listings
 * slice needed the same primitive: `manage_courts` writes resolve their
 * branch exactly like `block_slots` writes do, and two copies of the one
 * function whose duplication is a security bug is not a trade worth making.
 *
 * `courtId` must already be UUID-shaped — it reaches a `::uuid` cast, and a
 * malformed value raises 22P02 rather than returning null. Every caller
 * shape-checks first.
 */
export async function branchIdOfCourt(courtId: string): Promise<string | null> {
  const result = await db.execute(sql`
    select branch_id from courts where id = ${courtId}::uuid
  `)
  return (result.rows[0]?.branch_id as string | undefined) ?? null
}
