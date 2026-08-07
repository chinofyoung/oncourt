import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { MANILA_PARTS } from '@/lib/bookings/queries'
import { computeFees, isProcessorFeeBearer, type ProcessorFeeBearer } from '@/lib/payments/fees'
import { PAYMENT_METHODS, type PaymentMethodKey } from '@/lib/payments/methods'

export type CheckoutMethodQuote = {
  method: PaymentMethodKey
  label: string
  transactionFeeCentavos: number
  totalChargedCentavos: number
}

export type CheckoutView = {
  bookingId: string
  status: string
  expiresAt: string | null
  /** True when the hold is dead — expired clock OR any non-hold status. */
  expired: boolean
  branchName: string
  branchSlug: string
  branchAddress: string
  branchCity: string
  courtName: string
  environment: 'indoor' | 'outdoor'
  coverPhotoPath: string | null
  date: string
  startHour: number
  endHour: number
  courtFeeCentavos: number
  methods: CheckoutMethodQuote[]
}

/**
 * The bearer, read out of the hold's own snapshot.
 *
 * src/lib/booking/hold.ts always writes one, so the fallback is unreachable in
 * practice — but 'platform' is the documented global default, and a booking
 * with a malformed snapshot must render a checkout page rather than a stack
 * trace. Shared by the read and the write so they can never disagree about
 * what a booking's bearer is.
 */
export function bearerFromSnapshot(snapshot: unknown): ProcessorFeeBearer {
  const bearer = (snapshot as { bearer?: unknown } | null)?.bearer
  return isProcessorFeeBearer(bearer) ? bearer : 'platform'
}

/**
 * Everything /bookings/[id]/checkout renders, in one round trip plus one read
 * of the three-row `processor_rates` table.
 *
 * Scoped to its player IN THE WHERE CLAUSE, exactly like getBookingReceipt:
 * fetching by id and comparing player_id afterward would leak existence — a
 * stranger could tell a real booking id (403) from a fake one (404). Here both
 * are null.
 *
 * NOT restricted by status: the page has to be able to render "this hold
 * expired" and "this booking is already paid", and it needs the row to do it.
 * `expired` is computed against the SERVER clock, not the browser's.
 *
 * A method with no `processor_rates` row is dropped rather than shown
 * unpriced, and a rate row with no entry in PAYMENT_METHODS is not shown at
 * all — see the comment in src/lib/payments/methods.ts for why that list is a
 * code constant.
 */
export async function getCheckoutView(
  bookingId: string,
  playerId: string,
): Promise<CheckoutView | null> {
  const result = await db.execute(sql`
    select bk.id, bk.status::text as status, bk.expires_at,
           (bk.expires_at is null or bk.expires_at <= now()) as expired,
           bk.court_fee_centavos, bk.platform_fee_centavos, bk.fee_config_snapshot,
           c.name as court_name, c.environment,
           b.name as branch_name, b.slug as branch_slug,
           b.address as branch_address, b.city as branch_city,
           ph.storage_path as cover_photo_path,
           ${MANILA_PARTS}
    from bookings bk
    join courts c   on c.id = bk.court_id
    join branches b on b.id = bk.branch_id
    left join lateral (
      select bp.storage_path from branch_photos bp
      where bp.branch_id = b.id order by bp.sort_order, bp.id limit 1
    ) ph on true
    where bk.id = ${bookingId}::uuid and bk.player_id = ${playerId}::uuid
  `)

  const row = result.rows[0]
  if (!row) return null

  const rates = await db.execute(
    sql`select payment_method, percentage_bps, fixed_fee_centavos from processor_rates`,
  )
  const rateByMethod = new Map(
    rates.rows.map((rate) => [
      rate.payment_method as string,
      {
        percentageBps: Number(rate.percentage_bps),
        fixedFeeCentavos: Number(rate.fixed_fee_centavos),
      },
    ]),
  )

  const courtFeeCentavos = Number(row.court_fee_centavos)
  const platformFeeCentavos = Number(row.platform_fee_centavos)
  const bearer = bearerFromSnapshot(row.fee_config_snapshot)

  const methods: CheckoutMethodQuote[] = []
  for (const method of PAYMENT_METHODS) {
    const rate = rateByMethod.get(method.key)
    if (!rate) continue
    const breakdown = computeFees({ courtFeeCentavos, platformFeeCentavos, bearer, rate })
    methods.push({
      method: method.key,
      label: method.label,
      transactionFeeCentavos: breakdown.transactionFeeCentavos,
      totalChargedCentavos: breakdown.totalChargedCentavos,
    })
  }

  const status = row.status as string

  return {
    bookingId: row.id as string,
    status,
    expiresAt: row.expires_at ? new Date(row.expires_at as string).toISOString() : null,
    // A confirmed, completed or refunded booking is not payable either, and
    // the page renders the same "nothing to pay here" branch for all of them.
    expired: row.expired === true || status !== 'pending_payment',
    branchName: row.branch_name as string,
    branchSlug: row.branch_slug as string,
    branchAddress: row.branch_address as string,
    branchCity: row.branch_city as string,
    courtName: row.court_name as string,
    environment: row.environment as 'indoor' | 'outdoor',
    coverPhotoPath: (row.cover_photo_path as string | null) ?? null,
    date: row.date as string,
    startHour: Number(row.start_hour),
    endHour: Number(row.end_hour),
    courtFeeCentavos,
    methods,
  }
}
