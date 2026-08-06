import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { PG_UNIQUE_VIOLATION, sqlStateOf } from '@/lib/db/sql-state'
import { hasAnyPermission, type StaffPermissions } from '@/lib/staff/permissions'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * Deliberately loose: one `@` with something either side and a dot in the
 * domain. The database is the real authority on whether an address exists —
 * addBranchStaff looks it up and refuses what it cannot find — so this only
 * has to reject input that is obviously not an address at all, and must not
 * reject the valid-but-unusual ones a stricter pattern would.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Matches the slug shape used everywhere else in this app (branches.slug, /owners/<slug>). */
const SLUG_RE = /^[a-z0-9-]+$/
const MAX_BUSINESS_NAME_LENGTH = 120

/**
 * Exported for tests; src/app/dashboard/staff/actions.ts is the only production
 * caller. Returns the address as typed (trimmed) rather than lowercased — the
 * lookup is case-insensitive in SQL, and echoing the typed value back in an
 * error message is friendlier than echoing a mangled one.
 */
export function parseStaffEmail(formData: FormData): string | null {
  const email = String(formData.get('email') ?? '').trim()
  return EMAIL_RE.test(email) ? email : null
}

/** Shape-checked because it reaches a `::uuid` cast (22P02 otherwise). */
export function parseStaffId(formData: FormData): string | null {
  const staffId = String(formData.get('staffId') ?? '')
  return UUID_RE.test(staffId) ? staffId : null
}

export type AddStaffResult =
  | { ok: true; staffId: string }
  | {
      ok: false
      reason: 'no_such_user' | 'not_a_player' | 'already_staff' | 'no_permission_selected'
    }

/**
 * Grants an existing player account staff access to one branch.
 *
 * "Existing accounts only, by exact email" — there is no pending-invite state
 * in this product (see the spec's Out of scope), so someone who has never
 * signed in cannot be staffed: the profiles row is created by the auth trigger,
 * not by this function.
 *
 * The email match is EXACT on the whole address — never a prefix, substring, or
 * search, so a staff directory cannot be enumerated by typing letters — and
 * case-insensitive, because Google returns lowercase addresses while the person
 * typing a colleague's address types whatever they type.
 *
 * `role = 'player'` is required: an owner is a business account and can never be
 * someone else's staff, and an admin is not staffable either. There is no DB
 * constraint for this on purpose (a role can change later) — promoteToOwner
 * below owns that edge by deleting the grants — so this check is the
 * enforcement, which is exactly the TypeScript-is-the-security-boundary design
 * this project uses everywhere.
 *
 * The lookup happens twice, on purpose: a separate friendly-reason SELECT first
 * (to tell "no account with that address" apart from "that account is not a
 * player" for the person filling in the form), then the role condition again
 * inside the INSERT ... SELECT itself. That second check alone narrows but does
 * not close the race: under READ COMMITTED a plain (non-locking) SELECT reads
 * the last *committed* row version and does not wait on a concurrent
 * transaction's in-progress UPDATE, so a promoteToOwner that commits its role
 * flip after this statement's snapshot was taken but before it read the row
 * could still be missed. The `for update` clause on the SELECT is what actually
 * closes it: it forces this statement to wait for and then re-read any row a
 * concurrent promoteToOwner has locked, so it always sees that transaction's
 * final, committed role — never a stale 'player' snapshot. branch_staff_unique
 * remains the authority on duplicates and its 23505 is translated below.
 *
 * `branchId` comes from the caller's guarded context (requireOwnerOf), never
 * from unvalidated input.
 */
export async function addBranchStaff(input: {
  branchId: string
  email: string
  permissions: StaffPermissions
}): Promise<AddStaffResult> {
  // Checked before any SQL: branch_staff_some_permission would raise 23514,
  // and this keeps "revoke" a DELETE rather than an all-false UPDATE.
  if (!hasAnyPermission(input.permissions)) return { ok: false, reason: 'no_permission_selected' }

  // Friendly-reason lookup only — distinguishes "no account with that address"
  // from "found, but not a player" for the UI. This is NOT the security
  // boundary: see the INSERT ... SELECT below, whose `for update` lock is what
  // actually closes the TOCTOU window against a concurrent promoteToOwner —
  // re-checking `role = 'player'` alone, without the lock, only narrows it.
  // `order by created_at, id limit 1` makes the pick deterministic if
  // profiles.email ever collides case-insensitively — nothing enforces
  // uniqueness across case folding — which is unreachable today because the
  // only auth path is Google, one normalized address per account.
  const profile = await db.execute(sql`
    select id, role from profiles where lower(email) = lower(${input.email})
    order by created_at, id limit 1
  `)
  const target = profile.rows[0]
  if (!target) return { ok: false, reason: 'no_such_user' }
  if (target.role !== 'player') return { ok: false, reason: 'not_a_player' }

  try {
    // INSERT ... SELECT carries the `role = 'player'` condition into the write
    // itself (the same eligibility-inside-the-write pattern as
    // insertReviewIfEligible), and `for update` is what makes that condition
    // race-proof rather than merely narrowing the window: it locks the target
    // profiles row, so a concurrent promoteToOwner's role-flip UPDATE either
    // commits first (and this SELECT then blocks, re-reads the row post-commit,
    // and correctly sees role = 'owner' -> zero rows -> not_a_player) or this
    // statement locks the row first (and promoteToOwner's UPDATE blocks behind
    // it instead). Either order, the two can never both succeed. `for update`
    // inside an INSERT ... SELECT is valid Postgres — the locking clause
    // attaches to the SELECT that sources the INSERT.
    const result = await db.execute(sql`
      insert into branch_staff (
        branch_id, user_id, view_bookings, block_slots, manage_courts, view_earnings
      )
      select
        ${input.branchId}::uuid, id,
        ${input.permissions.view_bookings}, ${input.permissions.block_slots},
        ${input.permissions.manage_courts}, ${input.permissions.view_earnings}
      from profiles
      where id = ${target.id as string}::uuid and role = 'player'
      for update
      returning id
    `)
    if (result.rows.length === 0) return { ok: false, reason: 'not_a_player' }
    return { ok: true, staffId: result.rows[0].id as string }
  } catch (error) {
    // branch_staff_unique (branch_id, user_id) is the authority on "one row per
    // person per branch", so a duplicate is a normal outcome to report rather
    // than an exception to propagate.
    if (sqlStateOf(error) === PG_UNIQUE_VIOLATION) return { ok: false, reason: 'already_staff' }
    throw error
  }
}

export type UpdateStaffResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'no_permission_selected' }

/**
 * Replaces a grant's whole permission set.
 *
 * A REPLACE, not a merge: an unchecked HTML checkbox submits nothing at all, so
 * a partial update would silently keep permissions the owner had just cleared.
 * The edit form always renders and submits all four.
 *
 * `branch_id` is in the WHERE clause, not compared after a read. The action
 * above it guards `requireOwnerOf(branchId)` on a submitted branch id, so an
 * owner who passes their own branch id with someone else's staffId must write
 * nothing — which is what this scoping guarantees.
 */
export async function updateBranchStaff(input: {
  staffId: string
  branchId: string
  permissions: StaffPermissions
}): Promise<UpdateStaffResult> {
  if (!hasAnyPermission(input.permissions)) return { ok: false, reason: 'no_permission_selected' }

  const result = await db.execute(sql`
    update branch_staff set
      view_bookings = ${input.permissions.view_bookings},
      block_slots   = ${input.permissions.block_slots},
      manage_courts = ${input.permissions.manage_courts},
      view_earnings = ${input.permissions.view_earnings}
    where id = ${input.staffId}::uuid and branch_id = ${input.branchId}::uuid
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'not_found' }
}

export type RevokeStaffResult = { ok: true } | { ok: false; reason: 'not_found' }

/**
 * Removes a grant entirely. A DELETE, not an all-false UPDATE — the
 * branch_staff_some_permission CHECK would reject the latter, and a row that
 * grants nothing would still list the person on the staff page.
 *
 * Branch-scoped in the WHERE clause for the same reason as updateBranchStaff.
 * Idempotent: a second revoke reports not_found rather than throwing, so a
 * double-submit is harmless.
 */
export async function revokeBranchStaff(input: {
  staffId: string
  branchId: string
}): Promise<RevokeStaffResult> {
  const result = await db.execute(sql`
    delete from branch_staff
    where id = ${input.staffId}::uuid and branch_id = ${input.branchId}::uuid
    returning id
  `)
  return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'not_found' }
}

export type PromoteResult =
  | { ok: true; revokedGrants: number }
  | { ok: false; reason: 'no_such_user' | 'already_owner' | 'slug_taken' | 'invalid_input' }

/**
 * Vets a player into an owner: flips the role, sets the business fields, and
 * DELETES every branch_staff row they held.
 *
 * NOT DEAD CODE, despite having no UI in this slice. The admin screen that will
 * call this belongs to the admin-panel slice (see the spec's Out of scope), but
 * the rule is specified and pinned here because that grant-revocation side
 * effect is the thing that keeps "a user is never simultaneously an owner and
 * someone's staff" true. tests/staff/write.test.ts is its caller for now.
 *
 * Self-serve promotion is gone: an owner account is no longer granted by
 * submitting a first listing (the parent spec's rule, amended 2026-08-05).
 *
 * `role = 'player'` is required in the WHERE clause, which makes this both
 * non-demoting and non-repeating: an admin passing through would otherwise lose
 * their admin role, and re-promoting an owner would overwrite a business_name
 * and slug they may since have edited.
 *
 * One transaction, so a promoted user can never be left holding grants: the
 * role flip and the revocation commit together or not at all.
 */
export async function promoteToOwner(input: {
  userId: string
  businessName: string
  slug: string
}): Promise<PromoteResult> {
  const businessName = input.businessName.trim()
  if (businessName.length === 0 || businessName.length > MAX_BUSINESS_NAME_LENGTH) {
    return { ok: false, reason: 'invalid_input' }
  }
  // The slug appears in /owners/<slug>, so it follows the same shape rule as
  // branches.slug. Validated here rather than left to the UNIQUE constraint,
  // which only catches collisions, not malformed values.
  if (!SLUG_RE.test(input.slug)) return { ok: false, reason: 'invalid_input' }

  try {
    return await db.transaction(async (tx) => {
      const updated = await tx.execute(sql`
        update profiles set
          role = 'owner',
          business_name = ${businessName},
          slug = ${input.slug}
        where id = ${input.userId}::uuid and role = 'player'
        returning id
      `)

      if (updated.rows.length === 0) {
        // Distinguish "no such profile" from "already not a player" — an admin
        // screen needs to say which.
        const exists = await tx.execute(sql`
          select 1 from profiles where id = ${input.userId}::uuid
        `)
        return exists.rows.length > 0
          ? { ok: false as const, reason: 'already_owner' as const }
          : { ok: false as const, reason: 'no_such_user' as const }
      }

      // The rule: a user is never simultaneously an owner and someone's staff.
      // In the same transaction as the role flip, so the two can never diverge.
      const revoked = await tx.execute(sql`
        delete from branch_staff where user_id = ${input.userId}::uuid returning id
      `)

      return { ok: true as const, revokedGrants: revoked.rows.length }
    })
  } catch (error) {
    // profiles.slug is UNIQUE and shows up in public /owners/<slug> URLs.
    if (sqlStateOf(error) === PG_UNIQUE_VIOLATION) return { ok: false, reason: 'slug_taken' }
    throw error
  }
}
