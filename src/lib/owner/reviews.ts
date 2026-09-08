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
 *
 * Grouped and capped PER BRANCH, not globally. This page used to render a
 * single flat, newest-first list under one global `LIMIT 101` — honest for a
 * flat list, because "the 100 most recent things players said" is a true
 * sentence about the page as a whole. The moment the page groups results
 * under a branch heading, a global cap stops being honest about any ONE
 * branch: a busy branch can fill the whole 100, and a quiet branch then
 * renders under its own heading with zero reviews — which reads as "nobody
 * has reviewed this branch" when in truth it just has older ones that lost
 * out to a busier sibling. So each in-scope branch gets its own newest-N
 * window and its own capped flag; there is no longer a single global count
 * of "the reviews" to be honest or dishonest about.
 *
 * Branches with zero reviews still get a group here — via a LEFT JOIN from
 * `branches` (scoped to the caller's branchIds) onto the ranked review rows,
 * not left for the caller to backfill. Two reasons: (1) the caller's own
 * branch names (e.g. /dashboard/reviews/page.tsx's `access.branches`) are a
 * coincidence of that one call site, not something every caller of this
 * function is guaranteed to have lying around; making "does this branch have
 * a group" true unconditionally is a cheaper contract to depend on than
 * "true, provided the caller also merges in the branches it knows about". (2)
 * A second round trip to re-fetch branch names/ids this function's own query
 * already touches would be pure waste — the LEFT JOIN gets it in one. The
 * result: every id passed in `branchIds` (after `filters.branchId` narrows
 * it) comes back as exactly one group, reviewed or not.
 */

/**
 * No pagination this slice. One hundred is comfortably more than a busy
 * branch accumulates in a season, the page says so out loud when it is hit,
 * and a cap is what keeps a five-branch owner's page from becoming an
 * unbounded render. Exported so the test asserts the real number rather than
 * a copy. Applied per branch (see module doc above), not across the whole
 * result set.
 */
export const OWNER_REVIEWS_LIMIT = 100

export type OwnerReviewRow = {
  id: string
  rating: number
  body: string | null
  courtName: string
  branchId: string
  playerName: string
  /** `YYYY-MM-DD` in Manila — feed straight to formatDateLabel(). */
  createdOn: string
}

export type OwnerReviewGroup = {
  branchId: string
  branchName: string
  reviews: OwnerReviewRow[]
  /** True when this branch has more reviews than the ones returned here. */
  capped: boolean
}

/**
 * One group per branch id passed in (narrowed by `filters.branchId` when
 * set) — including a branch with zero reviews, which comes back with an
 * empty `reviews` array rather than being absent. See the module doc for why
 * that seeding happens here rather than in the caller.
 */
export type OwnerReviewsPage = { groups: OwnerReviewGroup[] }

export async function getOwnerReviews(
  branchIds: string[],
  filters: { branchId?: string } = {},
): Promise<OwnerReviewsPage> {
  // Belt-and-braces on top of the scope list: the `any` clause already makes
  // an unscoped branch id return nothing, so a forged ?branch= can only ever
  // narrow, never widen. Applied twice below — once inside `ranked` so an
  // out-of-scope branch's reviews are never even ranked, and again on the
  // outer `branches` scan so an out-of-scope branch doesn't get a group at
  // all (empty or otherwise).
  const branchFilter = filters.branchId ? sql`and b.id = ${filters.branchId}::uuid` : sql``

  // LIMIT + 1 is how `capped` is answered without a second count(*) round
  // trip: if the extra row came back, there is more than the branch's group
  // shows. Computed PER BRANCH via a window function rather than one global
  // LIMIT — row_number() partitioned by branch and ordered the same
  // newest-first way, so each branch's own row 101 (if it exists) is what
  // marks that branch, and only that branch, as capped.
  const result = await db.execute(sql`
    with ranked as (
      select rv.id, rv.rating::int as rating,
        -- btrim's default trim set is a plain space only, so a whitespace-only
        -- body containing a tab or newline would survive trimming and fail to
        -- collapse to null. Trim the full whitespace class explicitly (these
        -- are literal control characters in this JS template literal, not a
        -- Postgres E'' escape string).
        nullif(btrim(rv.body, ' \t\n\r\v\f'), '') as body,
        c.name as court_name,
        b.id as branch_id,
        coalesce(pr.full_name, split_part(pr.email, '@', 1)) as player_name,
        to_char(rv.created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as created_on,
        row_number() over (
          partition by b.id
          order by rv.created_at desc, rv.id desc
        ) as rn
      from reviews rv
      -- reviews carries no court_id, so the court comes through the booking.
      -- Both joins are INNER and safe to be: booking_id and player_id are NOT
      -- NULL with FKs, and bookings.court_id is NOT NULL too.
      join branches b  on b.id = rv.branch_id
      join bookings bk on bk.id = rv.booking_id
      join courts c    on c.id = bk.court_id
      join profiles pr on pr.id = rv.player_id
      where b.id = any (${sql.param(branchIds)}::uuid[])
        ${branchFilter}
    )
    -- The LEFT JOIN that seeds a zero-review branch with a group: branches
    -- is the driving table here (not ranked), so a branch with no matching
    -- row in ranked still produces one output row, with every ranked
    -- column null. The rn cap lives in the JOIN condition, not a WHERE
    -- clause after the join — a WHERE would evaluate "null <= 101" to
    -- unknown and silently drop the very branches this join exists to keep.
    select b.id as branch_id, b.name as branch_name,
      ranked.id as review_id, ranked.rating, ranked.body, ranked.court_name,
      ranked.player_name, ranked.created_on
    from branches b
    left join ranked
      on ranked.branch_id = b.id and ranked.rn <= ${OWNER_REVIEWS_LIMIT + 1}
    where b.id = any (${sql.param(branchIds)}::uuid[])
      ${branchFilter}
    -- Newest first within a branch (the window above already ordered rn by
    -- rv.created_at desc, rv.id desc, so re-stating that tiebreak here would
    -- be redundant); branch name first so one branch's rows arrive contiguous
    -- with each other rather than interleaved.
    order by b.name, ranked.rn
  `)

  // One bucket per branch, in first-seen (== branch-name) order, filling in
  // real review rows only where `review_id` is non-null — a null there is
  // the LEFT JOIN's "this branch matched nothing" row, not a review to keep.
  const branchOrder: string[] = []
  const buckets = new Map<string, { branchName: string; rows: (typeof result.rows)[number][] }>()
  for (const row of result.rows) {
    const branchId = row.branch_id as string
    let bucket = buckets.get(branchId)
    if (!bucket) {
      bucket = { branchName: row.branch_name as string, rows: [] }
      buckets.set(branchId, bucket)
      branchOrder.push(branchId)
    }
    if (row.review_id !== null) bucket.rows.push(row)
  }

  const groups: OwnerReviewGroup[] = branchOrder.map((branchId) => {
    const { branchName, rows } = buckets.get(branchId)!
    const capped = rows.length > OWNER_REVIEWS_LIMIT
    const reviews = rows.slice(0, OWNER_REVIEWS_LIMIT).map((row) => ({
      id: row.review_id as string,
      // Coerced out of the driver, like every numeric column in this codebase.
      rating: Number(row.rating),
      // Already nullif'd in SQL, so a whitespace-only body is null here too and
      // the page renders no paragraph at all rather than an empty one.
      body: (row.body as string | null) ?? null,
      courtName: row.court_name as string,
      branchId,
      playerName: row.player_name as string,
      createdOn: row.created_on as string,
    }))
    return { branchId, branchName, reviews, capped }
  })

  return { groups }
}
