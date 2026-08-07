import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { MANILA_PARTS } from '@/lib/bookings/queries'
import { formatDateLabel, formatHourRange } from '@/lib/format'
import { computeFees } from '@/lib/payments/fees'
import { isPaymentMethod } from '@/lib/payments/methods'
import { bearerFromSnapshot } from '@/lib/payments/queries'
import { PaymentProviderError, type PaymentProvider } from '@/lib/payments/provider'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type StartCheckoutResult =
  | { ok: true; checkoutUrl: string; paymentRowId: string }
  | { ok: false; reason: 'stale_hold' | 'unknown_method' | 'provider_unavailable' }

/**
 * Turns a live hold into a payable PayMongo checkout session.
 *
 * ZERO ROWS IS `stale_hold`, never an error and never "not found". A booking
 * that expired under the player's cursor, one that belongs to somebody else,
 * and one that never existed are the same answer to the same question: the
 * hold is gone, start again. Distinguishing them would be an existence oracle
 * for no user benefit. Ownership and liveness are BOTH in the WHERE clause, so
 * there is no read-then-write race and no place for a check to be forgotten.
 *
 * THE PROVIDER CALL IS OUTSIDE THE TRANSACTION. Holding a row lock across an
 * external HTTP request is how a slow payment processor becomes a database
 * incident. The consequence is accepted: if the hold dies in the gap, we have
 * created a session that is simply never paid and expires on PayMongo's side.
 * The alternative — deleting the player's hold because a later step raced —
 * would be worse.
 *
 * `provider` is a parameter, not the imported singleton, so this whole path is
 * testable against a fake with no network.
 */
export async function startCheckout(input: {
  bookingId: string
  playerId: string
  paymentMethod: string
  provider: PaymentProvider
  siteUrl: string
}): Promise<StartCheckoutResult> {
  const { bookingId, playerId, paymentMethod, provider } = input

  // Shape-checked before anything reaches a `::uuid` cast (22P02 otherwise).
  // A forged id and a vanished hold are the same answer.
  if (!UUID_RE.test(bookingId) || !UUID_RE.test(playerId)) {
    return { ok: false, reason: 'stale_hold' }
  }
  // The closed set is the gate. A method not in it never reaches SQL, and
  // never reaches PayMongo's payment_method_types either.
  if (!isPaymentMethod(paymentMethod)) return { ok: false, reason: 'unknown_method' }

  const rateRows = await db.execute(sql`
    select percentage_bps, fixed_fee_centavos from processor_rates
    where payment_method = ${paymentMethod}
  `)
  const rateRow = rateRows.rows[0]
  if (!rateRow) return { ok: false, reason: 'unknown_method' }
  const rate = {
    percentageBps: Number(rateRow.percentage_bps),
    fixedFeeCentavos: Number(rateRow.fixed_fee_centavos),
  }

  const bookingRows = await db.execute(sql`
    select bk.court_fee_centavos, bk.platform_fee_centavos, bk.fee_config_snapshot,
           c.name as court_name, c.environment,
           b.name as branch_name,
           ${MANILA_PARTS}
    from bookings bk
    join courts c   on c.id = bk.court_id
    join branches b on b.id = bk.branch_id
    where bk.id = ${bookingId}::uuid
      and bk.player_id = ${playerId}::uuid
      and bk.status = 'pending_payment'
      and bk.expires_at > now()
  `)
  const booking = bookingRows.rows[0]
  if (!booking) return { ok: false, reason: 'stale_hold' }

  // courtFee and platformFee come from the hold — already computed and
  // snapshotted. A price change must never rewrite a live hold, so nothing
  // here recomputes them; only the processor fee, which depends on the
  // just-chosen method, is new.
  const fees = computeFees({
    courtFeeCentavos: Number(booking.court_fee_centavos),
    platformFeeCentavos: Number(booking.platform_fee_centavos),
    bearer: bearerFromSnapshot(booking.fee_config_snapshot),
    rate,
  })

  const startHour = Number(booking.start_hour)
  const endHour = Number(booking.end_hour)
  const hours = endHour - startHour
  const origin = input.siteUrl.replace(/\/$/, '')

  let session
  try {
    session = await provider.createCheckoutSession({
      bookingId,
      amountCentavos: fees.totalChargedCentavos,
      paymentMethod,
      lineName: `${booking.branch_name as string} — ${booking.court_name as string} (${booking.environment as string})`,
      description: `${formatDateLabel(booking.date as string)} · ${formatHourRange(startHour, endHour)} · ${hours} ${hours === 1 ? 'hour' : 'hours'}`,
      successUrl: `${origin}/bookings/${bookingId}?paid=1`,
      cancelUrl: `${origin}/bookings/${bookingId}/checkout?canceled=1`,
    })
  } catch (error) {
    // The hold survives so the player can try again. Anything that is not a
    // provider failure is a real bug and must not be swallowed.
    if (error instanceof PaymentProviderError) return { ok: false, reason: 'provider_unavailable' }
    throw error
  }

  return db.transaction(
    async (tx) => {
      // Status-scoped and liveness-scoped, exactly like the read above: zero
      // rows means the hold moved or died between the read and now.
      const updated = await tx.execute(sql`
        update bookings set
          transaction_fee_centavos = ${fees.transactionFeeCentavos},
          total_charged_centavos   = ${fees.totalChargedCentavos},
          processor_fee_centavos   = ${fees.processorFeeCentavos},
          owner_net_centavos       = ${fees.ownerNetCentavos},
          -- The method, and ONLY the method. Deliberately not the rate: a
          -- later session on a different method would leave a stale \`rate\`
          -- key contradicting the recorded method. The rate that matters is
          -- recorded per session on the payments row below.
          fee_config_snapshot = fee_config_snapshot || jsonb_build_object('method', ${paymentMethod}::text)
        where id = ${bookingId}::uuid
          and player_id = ${playerId}::uuid
          and status = 'pending_payment'
          and expires_at > now()
        returning id
      `)
      if (updated.rows.length === 0) return { ok: false as const, reason: 'stale_hold' as const }

      // amount_centavos and processor_fee_centavos are what we QUOTED for
      // THIS session. The webhook reconciles the paid amount against the
      // first and derives the booking's money columns from both — never by
      // re-reading the admin-editable processor_rates table.
      const inserted = await tx.execute(sql`
        insert into payments (
          booking_id, provider_session_id, payment_method,
          amount_centavos, processor_fee_centavos, status
        ) values (
          ${bookingId}::uuid, ${session.sessionId}, ${paymentMethod},
          ${fees.totalChargedCentavos}, ${fees.processorFeeCentavos}, 'pending'
        )
        returning id
      `)

      return {
        ok: true as const,
        checkoutUrl: session.checkoutUrl,
        paymentRowId: inserted.rows[0].id as string,
      }
    },
    // Pinned explicitly rather than inheriting default_transaction_isolation,
    // matching src/lib/booking/hold.ts and src/lib/blocks/write.ts.
    { isolationLevel: 'read committed' },
  )
}
