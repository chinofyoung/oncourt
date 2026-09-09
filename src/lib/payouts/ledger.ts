import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db'

export type OwnerLedger = {
  ownerId: string
  email: string
  businessName: string | null
  fullName: string | null
  /** Payable minus outstanding clawbacks. May be negative. */
  owedCentavos: number
  payableBookingCount: number
  clawbackBookingCount: number
  preparedCentavos: number
  paidCentavos: number
}

/**
 * Who counts as an owner for ledger purposes. Identical to the predicate
 * getAdminOwners() uses in src/lib/admin/owners.ts — branches.owner_id has no
 * role constraint, so an admin holding branches is a real owner of record and
 * can be owed money. Kept as a local fragment rather than an import, matching
 * this codebase's existing precedent for shared SQL fragments (see
 * REAL_BOOKING in src/lib/owner/queries.ts).
 */
const IS_OWNER = sql`
  p.role = 'owner'
  or (p.role = 'admin' and exists (select 1 from branches b where b.owner_id = p.id))
`

/**
 * THE owed computation, in one place.
 *
 *   owed = Σ owner_net_centavos over completed bookings with no 'payment' line
 *        − Σ owner_net_centavos over refunded_manual bookings that HAVE a
 *          'payment' line and no 'clawback' line yet
 *
 * `status = 'completed'` excludes owner blocks for free: complete_past_bookings()
 * (20260801110350_storage_and_cron.sql) only ever moves confirmed -> completed,
 * so a 'blocked' row can never reach the pool and no ₱0 line is ever written.
 *
 * Every sum is cast ::bigint and read through Number() — the driver returns
 * bigint as a string, and a string here would concatenate instead of add.
 */
async function ledgerRows(ownerFilter: SQL): Promise<OwnerLedger[]> {
  const result = await db.execute(sql`
    with owners as (
      select p.id, p.email, p.business_name, p.full_name
      from profiles p
      where (${IS_OWNER}) and ${ownerFilter}
    ),
    payable as (
      select b.owner_id, bk.owner_net_centavos as net
      from bookings bk
      join branches b on b.id = bk.branch_id
      where b.owner_id in (select id from owners)
        and bk.status = 'completed'
        -- The manual rail never enters the pool. OnCourt collected nothing on
        -- these bookings -- the player paid the owner directly -- so
        -- owner_net_centavos here is money the owner ALREADY HAS, not money we
        -- owe them. Without this the ledger would invent a debt for every
        -- completed manual booking.
        and bk.payment_mode = 'automated'
        and not exists (
          select 1 from payout_bookings pb
          where pb.booking_id = bk.id and pb.kind = 'payment'
        )
    ),
    clawback as (
      select b.owner_id, bk.owner_net_centavos as net
      from bookings bk
      join branches b on b.id = bk.branch_id
      where b.owner_id in (select id from owners)
        and bk.status = 'refunded_manual'
        -- No payment_mode filter here, and that is deliberate, not an
        -- oversight: a clawback requires an EXISTING 'payment' payout line
        -- below, and a manual booking (excluded from the payable CTE above)
        -- can never have one. So this arm is already unreachable for manual
        -- bookings without needing its own filter.
        and exists (
          select 1 from payout_bookings pb
          where pb.booking_id = bk.id and pb.kind = 'payment'
        )
        and not exists (
          select 1 from payout_bookings pb
          where pb.booking_id = bk.id and pb.kind = 'clawback'
        )
    ),
    totals as (
      select owner_id,
        coalesce(sum(net_centavos) filter (where status = 'pending'), 0) as prepared,
        coalesce(sum(net_centavos) filter (where status = 'paid'), 0) as paid
      from payouts
      where owner_id in (select id from owners)
      group by owner_id
    )
    select o.id, o.email, o.business_name, o.full_name,
      coalesce((select sum(net) from payable where owner_id = o.id), 0)::bigint as payable_net,
      coalesce((select count(*) from payable where owner_id = o.id), 0)::int as payable_count,
      coalesce((select sum(net) from clawback where owner_id = o.id), 0)::bigint as clawback_net,
      coalesce((select count(*) from clawback where owner_id = o.id), 0)::int as clawback_count,
      coalesce(t.prepared, 0)::bigint as prepared_centavos,
      coalesce(t.paid, 0)::bigint as paid_centavos
    from owners o
    left join totals t on t.owner_id = o.id
    order by coalesce(o.business_name, o.email), o.id
  `)

  return result.rows.map((row) => ({
    ownerId: row.id as string,
    email: row.email as string,
    businessName: (row.business_name as string | null) ?? null,
    fullName: (row.full_name as string | null) ?? null,
    owedCentavos: Number(row.payable_net) - Number(row.clawback_net),
    payableBookingCount: Number(row.payable_count),
    clawbackBookingCount: Number(row.clawback_count),
    preparedCentavos: Number(row.prepared_centavos),
    paidCentavos: Number(row.paid_centavos),
  }))
}

export async function getAllOwnerLedgers(): Promise<OwnerLedger[]> {
  return ledgerRows(sql`true`)
}

export async function getOwnerLedger(ownerId: string): Promise<OwnerLedger | null> {
  const rows = await ledgerRows(sql`p.id = ${ownerId}::uuid`)
  return rows[0] ?? null
}

export type PayoutLine = {
  bookingId: string
  kind: 'payment' | 'clawback'
  netCentavos: number
  /** A Manila calendar date (`YYYY-MM-DD`), ready for formatDateLabel(). */
  bookedOn: string
  branchName: string
  courtName: string
  /** True when this line's booking has since become refunded_manual. */
  bookingRefunded: boolean
}

export type PayoutRecord = {
  id: string
  periodStart: string
  periodEnd: string
  grossCentavos: number
  feeCentavos: number
  netCentavos: number
  status: 'pending' | 'paid'
  /** Manila date, null while pending. */
  paidOn: string | null
  note: string | null
  createdOn: string
  lines: PayoutLine[]
}

/**
 * An owner's payouts, newest first, each with its lines.
 *
 * Two queries stitched by id rather than one join: a join multiplies the
 * payout row by its line count and every money column would then need
 * de-duplicating before display. Same shape as getAdminOwners' follow-up
 * queries in src/lib/admin/owners.ts.
 *
 * `bookingRefunded` is why the lines join `bookings` at all — a pending payout
 * containing a since-refunded booking is the one thing the two-step flow
 * exists to let an admin catch before the money leaves.
 */
export async function getOwnerPayouts(ownerId: string): Promise<PayoutRecord[]> {
  const payouts = await db.execute(sql`
    select id, to_char(period_start, 'YYYY-MM-DD') as period_start,
           to_char(period_end, 'YYYY-MM-DD') as period_end,
           gross_centavos, fee_centavos, net_centavos, status::text as status,
           to_char(paid_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as paid_on,
           note,
           to_char(created_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as created_on
    from payouts
    where owner_id = ${ownerId}::uuid
    order by created_at desc, id
  `)
  if (payouts.rows.length === 0) return []

  const lines = await db.execute(sql`
    select pb.payout_id, pb.booking_id, pb.kind::text as kind, pb.net_centavos,
           to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as booked_on,
           br.name as branch_name, c.name as court_name,
           (bk.status = 'refunded_manual') as booking_refunded
    from payout_bookings pb
    join payouts p on p.id = pb.payout_id
    join bookings bk on bk.id = pb.booking_id
    join branches br on br.id = bk.branch_id
    join courts c on c.id = bk.court_id
    where p.owner_id = ${ownerId}::uuid
    order by bk.starts_at, pb.booking_id
  `)

  const byPayout = new Map<string, PayoutLine[]>()
  for (const row of lines.rows) {
    const list = byPayout.get(row.payout_id as string) ?? []
    list.push({
      bookingId: row.booking_id as string,
      kind: row.kind as 'payment' | 'clawback',
      netCentavos: Number(row.net_centavos),
      bookedOn: row.booked_on as string,
      branchName: row.branch_name as string,
      courtName: row.court_name as string,
      bookingRefunded: row.booking_refunded === true,
    })
    byPayout.set(row.payout_id as string, list)
  }

  return payouts.rows.map((row) => ({
    id: row.id as string,
    periodStart: row.period_start as string,
    periodEnd: row.period_end as string,
    grossCentavos: Number(row.gross_centavos),
    feeCentavos: Number(row.fee_centavos),
    netCentavos: Number(row.net_centavos),
    status: row.status as 'pending' | 'paid',
    paidOn: (row.paid_on as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    createdOn: row.created_on as string,
    lines: byPayout.get(row.id as string) ?? [],
  }))
}

/**
 * The owner behind a set of branches, or null when the set is empty or spans
 * more than one owner. More than one is not reachable today — branch_staff
 * grants come from a single owner — but returning null rather than picking
 * one means a future multi-owner grant hides the payout section instead of
 * showing someone another owner's money.
 */
export async function getBranchesOwnerId(branchIds: string[]): Promise<string | null> {
  if (branchIds.length === 0) return null
  const result = await db.execute(sql`
    select distinct owner_id from branches where id = any (${sql.param(branchIds)}::uuid[])
  `)
  return result.rows.length === 1 ? (result.rows[0].owner_id as string) : null
}

export type PayableBooking = {
  bookingId: string
  bookedOn: string
  branchName: string
  courtName: string
  netCentavos: number
}

/** The bookings a prepare right now would stamp. Read-only preview. */
export async function getPayablePool(ownerId: string): Promise<PayableBooking[]> {
  const result = await db.execute(sql`
    select bk.id,
           to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as booked_on,
           br.name as branch_name, c.name as court_name, bk.owner_net_centavos
    from bookings bk
    join branches br on br.id = bk.branch_id
    join courts c on c.id = bk.court_id
    where br.owner_id = ${ownerId}::uuid
      and bk.status = 'completed'
      -- Manual rail exclusion: see the payable CTE in ledgerRows above for
      -- the full reasoning.
      and bk.payment_mode = 'automated'
      and not exists (
        select 1 from payout_bookings pb
        where pb.booking_id = bk.id and pb.kind = 'payment'
      )
    order by bk.starts_at, bk.id
  `)
  return result.rows.map((row) => ({
    bookingId: row.id as string,
    bookedOn: row.booked_on as string,
    branchName: row.branch_name as string,
    courtName: row.court_name as string,
    netCentavos: Number(row.owner_net_centavos),
  }))
}
