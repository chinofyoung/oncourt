import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  constraintNameOf,
  PG_DEADLOCK_DETECTED,
  PG_EXCLUSION_VIOLATION,
  PG_UNIQUE_VIOLATION,
  sqlStateOf,
} from '@/lib/db/sql-state'
import { reconcileSession } from '@/lib/payments/fees'
import { bearerFromSnapshot } from '@/lib/payments/queries'
import type { PaidEvent } from '@/lib/payments/provider'

/**
 * The unique index's own name (`provider_payment_id text unique` in
 * 20260807090000_payments.sql, so Postgres's default naming applies). Review
 * finding M-5: a bare SQLSTATE 23505 check would translate ANY future unique
 * violation on this table into "duplicate", which is only correct for THIS
 * index. Naming it explicitly is what keeps that translation scoped.
 */
const PAYMENTS_PROVIDER_PAYMENT_ID_UNIQUE = 'payments_provider_payment_id_key'

/**
 * jsonb (unlike json) cannot represent U+0000 at all — Postgres raises 22P05
 * ("unsupported Unicode escape sequence") the instant it tries, whether the
 * NUL arrives as a literal control byte or as the six-character `\u0000`
 * escape sequence a JSON-legal body can carry in any string field. Review
 * finding M-1: an untouched raw_event write on such a body would fail on
 * every retry, forever (the input is deterministic). Both shapes are stripped
 * before the cast — the raw bytes used for SIGNATURE VERIFICATION and EVENT
 * PARSING are never touched, only this stored copy.
 */
function sanitizeForJsonb(rawBody: string): string {
  return rawBody.replace(/\\u0000/gi, '').replace(/\u0000/g, '')
}

/**
 * Every terminal state this handler can reach. Returned to PayMongo in the
 * 200 body (its caller is already signature-authenticated) and, more
 * importantly, the seam the confirmation-email slice will branch on — nothing
 * is sent from inside the transaction, so a failing email can never break a
 * confirmed booking.
 */
export type WebhookOutcome =
  | 'confirmed'
  | 'confirmed_after_expiry'
  | 'duplicate'
  | 'unknown_session'
  | 'amount_mismatch'
  | 'slot_taken'
  | 'slot_elapsed'
  | 'double_charge'
  | 'not_payable'

/**
 * The only two outcomes that write to `bookings`. Everything else records the
 * payment, flags `needs_refund`, and leaves the booking exactly as it was —
 * so "does this branch confirm?" and "does this branch owe money back?" are
 * one question with one answer, asked in one place.
 */
const CONFIRMING_OUTCOMES = new Set<WebhookOutcome>(['confirmed', 'confirmed_after_expiry'])

/**
 * The only writer of `confirmed` in this application.
 *
 * ONE TRANSACTION, with the resolved payments row and the booking row both
 * locked `for update`, so two deliveries of two different payments for one
 * booking cannot interleave into two confirmations.
 *
 * THE PAYMENTS WRITE COMES FIRST. That ordering is the whole idempotency
 * story: a replayed payment raises 23505 on provider_payment_id, the
 * transaction rolls back, and the booking was never touched.
 *
 * Throws only for genuinely unexpected failures — including a 23P01 from the
 * expired-path race — because the Route Handler turns a throw into a 500 and
 * a 500 is what makes PayMongo retry. The retry is deterministic: nothing was
 * committed, and by then the slot is unambiguously taken.
 */
export async function handlePaidEvent(event: PaidEvent, rawBody: string): Promise<WebhookOutcome> {
  try {
    return await db.transaction(
      async (tx) => {
        // 1. Resolve OUR row by the event's session reference. This — not the
        //    booking — is what the paid amount is reconciled against.
        //
        //    REVIEW FIX I-1: `order by created_at asc, id asc` — the OLDEST
        //    row, always. The insert path below (step 4's `else` branch)
        //    writes the PAID amount, not a quote, into a new row's
        //    amount_centavos; if the anchor were instead the newest row, a
        //    first mismatched delivery would silently become the anchor for
        //    a second, and a THIRD delivery that happens to repeat that
        //    same wrong amount would be compared against it and wrongly
        //    pass. The oldest row is always the ORIGINAL quote written by
        //    startCheckout — the one amount every delivery must answer to,
        //    no matter how many mismatched attempts came before it.
        const sessionRows = await tx.execute(sql`
          select id, booking_id, provider_payment_id, payment_method,
                 amount_centavos, processor_fee_centavos
          from payments
          where provider_session_id = ${event.sessionId}
          order by created_at asc, id asc
          limit 1
          for update
        `)
        const sessionRow = sessionRows.rows[0]
        // An event for a checkout session this application never created.
        // payments.booking_id is `not null`, so there is nothing to attach a
        // record to — 200 and no write is the only honest answer.
        if (!sessionRow) {
          // REVIEW FIX I-3: this is money PayMongo says was paid, against a
          // session this application has no record of at all — no row, no
          // needs_refund flag, nothing to query later. The only trace of it
          // existing is this log line. Keyed by the two provider-issued ids
          // (opaque, not sensitive) — never the raw body, the signature, or
          // any secret.
          console.error('[payments/webhook] unknown_session — paid event for a session we never created', {
            sessionId: event.sessionId,
            paymentId: event.paymentId,
            amountCentavos: event.amountCentavos,
          })
          return 'unknown_session' as const
        }

        const bookingId = sessionRow.booking_id as string
        const quotedAmount = Number(sessionRow.amount_centavos)
        const quotedProcessorFee = Number(sessionRow.processor_fee_centavos)
        const quotedMethod = sessionRow.payment_method as string | null

        // 2. Lock the booking. The FK guarantees the row exists.
        //
        //    REVIEW FIX C-1: `ends_at <= now()` is read HERE, inside the same
        //    locked transaction, and compared in SQL — never a JS clock, which
        //    could be skewed from the database's. This is what the confirm
        //    gate below is built on.
        const bookingRows = await tx.execute(sql`
          select status::text as status, court_fee_centavos, platform_fee_centavos,
                 fee_config_snapshot, (ends_at <= now()) as slot_elapsed
          from bookings where id = ${bookingId}::uuid for update
        `)
        const booking = bookingRows.rows[0]
        const status = booking.status as string
        const slotElapsed = booking.slot_elapsed === true

        // 3. Decide, before writing anything.
        let outcome: WebhookOutcome
        if (event.amountCentavos !== quotedAmount) {
          // Compared against the amount WE quoted for THIS session — never the
          // booking's current total, which a later session may have replaced.
          outcome = 'amount_mismatch'
        } else if (slotElapsed && (status === 'pending_payment' || status === 'expired')) {
          // REVIEW FIX C-1: checked ONCE, ahead of both branches that would
          // otherwise confirm — rather than duplicated into each — because the
          // hole exists in BOTH: 'expired' is the wide, common window, but an
          // expired-but-unswept hold still reads as 'pending_payment' (see the
          // sweep below) and a late payment for ITS slot has the identical
          // problem in a narrower window. Never keep money for an unusable
          // slot, per the spec's binding ruling. Distinct from 'slot_taken'
          // (a DIFFERENT booking took the slot) — here nobody took it, it
          // simply passed. needs_refund is set below via the existing
          // CONFIRMING_OUTCOMES set-membership derivation, not a special case:
          // 'slot_elapsed' is absent from that set like every other
          // non-confirming outcome.
          outcome = 'slot_elapsed'
        } else if (status === 'pending_payment') {
          outcome = 'confirmed'
        } else if (status === 'expired') {
          // The exclusion constraint's predicate cannot call now(), so an
          // expired-but-unswept hold still reads as 'pending_payment' and
          // would wrongly block a legitimate late payment. Sweep the
          // OVERLAPPING stale rows first, exactly as src/lib/booking/hold.ts
          // step 4 does — narrowed to overlapping rows so this never takes
          // locks on bookings unrelated to this slot.
          await tx.execute(sql`
            update bookings set status = 'expired'
            where court_id = (select court_id from bookings where id = ${bookingId}::uuid)
              and status = 'pending_payment'
              and expires_at <= now()
              and slot && (select slot from bookings where id = ${bookingId}::uuid)
          `)
          // The literal predicate of bookings_no_overlap as rebuilt in
          // 20260805090100_branch_staff_and_blocks.sql — 'blocked' included,
          // because an owner's maintenance block occupies the slot too.
          const free = await tx.execute(sql`
            select not exists (
              select 1 from bookings other
              where other.court_id = (select court_id from bookings where id = ${bookingId}::uuid)
                and other.id <> ${bookingId}::uuid
                and other.slot && (select slot from bookings where id = ${bookingId}::uuid)
                and other.status in ('pending_payment', 'confirmed', 'completed', 'blocked')
            ) as slot_free
          `)
          outcome = free.rows[0].slot_free === true ? 'confirmed_after_expiry' : 'slot_taken'
        } else if (status === 'confirmed') {
          // Necessarily a DIFFERENT payment: a replay of the same one raises
          // 23505 below before this branch can act. A genuine double charge.
          outcome = 'double_charge'
        } else {
          // 'completed', 'blocked', 'refunded_manual' — record, flag, do not touch.
          outcome = 'not_payable'
        }

        const needsRefund = !CONFIRMING_OUTCOMES.has(outcome)

        // 4. Record the payment. FIRST, so a replay aborts before the booking
        //    is touched.
        if (sessionRow.provider_payment_id === null) {
          await tx.execute(sql`
            update payments set
              provider_payment_id = ${event.paymentId},
              status = 'paid',
              paid_at = now(),
              raw_event = ${sanitizeForJsonb(rawBody)}::jsonb,
              needs_refund = ${needsRefund},
              payment_method = coalesce(payment_method, ${event.paymentMethod})
            where id = ${sessionRow.id}::uuid
          `)
        } else {
          // This session was already claimed by some payment. Updating the row
          // would destroy a financial record, so record a NEW one. A replay of
          // the same payment still collides on the unique index below; a
          // genuinely second payment on one session is preserved rather than
          // lost. Unlike the update path there is no quote of its own here, so
          // this row records what was actually paid.
          await tx.execute(sql`
            insert into payments (
              booking_id, provider_session_id, provider_payment_id, payment_method,
              amount_centavos, processor_fee_centavos, status, needs_refund, paid_at, raw_event
            ) values (
              ${bookingId}::uuid, ${event.sessionId}, ${event.paymentId},
              ${event.paymentMethod ?? quotedMethod},
              ${event.amountCentavos}, ${quotedProcessorFee}, 'paid', ${needsRefund},
              now(), ${sanitizeForJsonb(rawBody)}::jsonb
            )
          `)
        }

        // 5. Confirm, if this is one of the two paths that may.
        if (CONFIRMING_OUTCOMES.has(outcome)) {
          // Derived from the two numbers THIS session recorded at quote time
          // plus the booking's own court fee, platform fee and bearer. Never
          // from processor_rates, which an admin may have edited since.
          const fees = reconcileSession({
            courtFeeCentavos: Number(booking.court_fee_centavos),
            platformFeeCentavos: Number(booking.platform_fee_centavos),
            bearer: bearerFromSnapshot(booking.fee_config_snapshot),
            amountCentavos: quotedAmount,
            processorFeeCentavos: quotedProcessorFee,
          })
          const confirmed = await tx.execute(sql`
            update bookings set
              status = 'confirmed',
              -- "set only while pending_payment": a confirmed booking carries
              -- no hold clock.
              expires_at = null,
              transaction_fee_centavos = ${fees.transactionFeeCentavos},
              total_charged_centavos   = ${fees.totalChargedCentavos},
              processor_fee_centavos   = ${fees.processorFeeCentavos},
              owner_net_centavos       = ${fees.ownerNetCentavos},
              fee_config_snapshot = fee_config_snapshot
                || jsonb_build_object('method', ${quotedMethod ?? event.paymentMethod}::text)
            where id = ${bookingId}::uuid
              and status = ${outcome === 'confirmed' ? 'pending_payment' : 'expired'}::booking_status
            returning id
          `)
          // Unreachable while the row is locked `for update`. If it ever
          // happens it is a genuine server error and deserves the 500 and the
          // retry, not a silent 200.
          if (confirmed.rows.length === 0) {
            throw new Error(`Booking ${bookingId} moved under a locked confirm`)
          }
        }

        return outcome
      },
      // Pinned explicitly rather than inheriting default_transaction_isolation,
      // matching src/lib/booking/hold.ts. Correct under READ COMMITTED because
      // both rows this function decides on are held `for update`.
      { isolationLevel: 'read committed' },
    )
  } catch (error) {
    // THE IDEMPOTENCY PRIMITIVE: provider_payment_id is unique, so a replayed
    // payment lands here with the transaction already rolled back and the
    // booking untouched. Already processed — 200 OK.
    //
    // REVIEW FIX M-5: scoped to THIS index by name, not just the SQLSTATE.
    // 23505 is the generic "unique violation" code — any future unique
    // constraint added to this table would raise the identical code, and a
    // bare code check would silently swallow a genuinely different collision
    // as if it were a payment replay.
    if (
      sqlStateOf(error) === PG_UNIQUE_VIOLATION &&
      constraintNameOf(error) === PAYMENTS_PROVIDER_PAYMENT_ID_UNIQUE
    ) {
      return 'duplicate'
    }

    // Everything else — including a 23P01 from a concurrent inserter winning
    // the expired-path race, or a 40P01 if that same race instead resolves as
    // a genuine wait-for cycle (a second, independent source of the identical
    // race — see src/lib/booking/hold.ts's own step-4 sweep comment, named
    // here for symmetry, REVIEW FIX M-6) — propagates to a 500 so PayMongo
    // retries. Deliberately NOT translated in place the way hold.ts maps both
    // codes to 'slot_taken': this transaction has ALSO written the payments
    // row by this point, and row 10 exists precisely so that write rolls back
    // too rather than being kept against a booking that was never confirmed.
    // The retry is deterministic: nothing was committed, and by then the slot
    // is unambiguously taken and lands on row 7.
    const code = sqlStateOf(error)
    const isKnownSlotRace = code === PG_EXCLUSION_VIOLATION || code === PG_DEADLOCK_DETECTED
    // REVIEW FIX I-3: the one place a genuine server error becomes a 500 —
    // logged with the two provider-issued ids and the SQLSTATE (never the raw
    // body, the signature, or any secret), so an ops-visible trail exists
    // before PayMongo's retry arrives.
    console.error('[payments/webhook] handlePaidEvent failed — rethrowing for a 500 retry', {
      sessionId: event.sessionId,
      paymentId: event.paymentId,
      sqlState: code,
      knownSlotRace: isKnownSlotRace,
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
