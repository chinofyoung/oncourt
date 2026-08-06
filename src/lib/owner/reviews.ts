import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

/**
 * The reviews players left on a scoped set of branches — /dashboard/reviews.
 *
 * A separate module from src/lib/owner/queries.ts on purpose: that one is
 * organised around bookings and money and shares four SQL fragments about
 * booking status and booking hours, none of which a reviews read uses.
 *
 * Read-only. Replies, moderation and deletion are out of scope for this slice
 * (they need a migration); there is deliberately no write in this file.
 */

/**
 * No pagination this slice. One hundred is comfortably more than a busy branch
 * accumulates in a season, the page says so out loud when it is hit, and a
 * cap is what keeps a five-branch owner's page from becoming an unbounded
 * render. Exported so the test asserts the real number rather than a copy.
 */
export const OWNER_REVIEWS_LIMIT = 100

export type OwnerReviewRow = {
  id: string
  rating: number
  body: string | null
  courtName: string
  branchId: string
  branchName: string
  playerName: string
  /** `YYYY-MM-DD` in Manila — feed straight to formatDateLabel(). */
  createdOn: string
}

export type OwnerReviewsPage = { reviews: OwnerReviewRow[]; capped: boolean }

export async function getOwnerReviews(
  branchIds: string[],
  filters: { branchId?: string } = {},
): Promise<OwnerReviewsPage> {
  // Belt-and-braces on top of the scope list: the `any` clause already makes
  // an unscoped branch id return nothing, so a forged ?branch= can only ever
  // narrow, never widen.
  const branchFilter = filters.branchId ? sql`and b.id = ${filters.branchId}::uuid` : sql``

  // LIMIT + 1 is how `capped` is answered without a second count(*) round
  // trip: if the extra row came back, there is more than the page shows.
  const result = await db.execute(sql`
    select rv.id, rv.rating::int as rating,
      -- btrim's default trim set is a plain space only, so a whitespace-only
      -- body containing a tab or newline would survive trimming and fail to
      -- collapse to null. Trim the full whitespace class explicitly (these
      -- are literal control characters in this JS template literal, not a
      -- Postgres E'' escape string).
      nullif(btrim(rv.body, ' \t\n\r\v\f'), '') as body,
      c.name as court_name,
      b.id as branch_id, b.name as branch_name,
      coalesce(pr.full_name, split_part(pr.email, '@', 1)) as player_name,
      to_char(rv.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as created_on
    from reviews rv
    join branches b  on b.id = rv.branch_id
    -- reviews carries no court_id, so the court comes through the booking.
    -- Both joins are INNER and safe to be: booking_id and player_id are NOT
    -- NULL with FKs, and bookings.court_id is NOT NULL too.
    join bookings bk on bk.id = rv.booking_id
    join courts c    on c.id = bk.court_id
    join profiles pr on pr.id = rv.player_id
    where b.id = any (${sql.param(branchIds)}::uuid[])
      ${branchFilter}
    -- Newest first, with the id as a deterministic tiebreak: two reviews can
    -- share a created_at, and an unstable order would reshuffle the page on
    -- every render.
    order by rv.created_at desc, rv.id desc
    limit ${OWNER_REVIEWS_LIMIT + 1}
  `)

  const capped = result.rows.length > OWNER_REVIEWS_LIMIT
  const reviews = result.rows.slice(0, OWNER_REVIEWS_LIMIT).map((row) => ({
    id: row.id as string,
    // Coerced out of the driver, like every numeric column in this codebase.
    rating: Number(row.rating),
    // Already nullif'd in SQL, so a whitespace-only body is null here too and
    // the page renders no paragraph at all rather than an empty one.
    body: (row.body as string | null) ?? null,
    courtName: row.court_name as string,
    branchId: row.branch_id as string,
    branchName: row.branch_name as string,
    playerName: row.player_name as string,
    createdOn: row.created_on as string,
  }))

  return { reviews, capped }
}
