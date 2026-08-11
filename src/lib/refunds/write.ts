import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

export const MAX_REFUND_NOTE = 500

export type RefundResult =
  | { ok: true; bookingRefunded: boolean }
  | { ok: false; reason: 'already_recorded' }

/**
 * Bookkeeping, not a money movement: the admin performs the refund in the
 * provider's dashboard, then records it here.
 *
 * PAYMENT-SCOPED, not booking-scoped, and that is the whole design. The
 * webhook (src/lib/payments/webhook.ts:214) flags needs_refund on payments
 * whose booking is `expired` or still `pending_payment` — money that landed
 * for a slot no longer available. Those orphans have no owner credit to
 * reverse and no booking to flip, so a booking-scoped action would have
 * nothing to write for the case the webhook generates most often.
 *
 * Two statements, one transaction:
 *   1. Stamp the payment, guarded by `refunded_at is null and status = 'paid'`
 *      so a replay is a no-op rather than an overwrite of the original note,
 *      AND so a forged or stale paymentId can never reach the second
 *      statement. The `status = 'paid'` half is load-bearing, not defensive
 *      dead weight: an abandoned checkout's payment row can sit at
 *      `status = 'pending'` forever once a different session's payment
 *      confirms the same booking (src/lib/payments/checkout.ts:133 only opens
 *      a new session while `pending_payment`; src/lib/payments/reconcile.ts:
 *      74-76 only reconciles one while the booking is STILL
 *      `pending_payment`) — so that never-paid row's id is a real, reachable
 *      value a Server Action's caller can submit, not a hypothetical one. A
 *      `'use server'` action only ever gets a `paymentId` from `FormData`,
 *      which accepts any string regardless of what the page rendered; without
 *      this guard, submitting that id would stamp a payment that never took
 *      money as refunded and record a refund note against it — a fabricated
 *      financial record on a row where no money ever moved. (It would no
 *      longer also flip the booking: statement 2's `not exists` clause now
 *      catches that specific case, because the payment that really funded the
 *      booking is still `paid` and unrefunded. The two guards overlap here on
 *      purpose — this one is what keeps the payments row itself honest.) The
 *      UI-level gate (a payment only gets a refund form when it is paid and
 *      unrefunded) remains as the usability layer; this database-scoped
 *      UPDATE is the enforcement.
 *   2. Flip the booking, status-scoped to confirmed/completed AND scoped by
 *      the thing the flip actually depends on: that no OTHER live paid payment
 *      still covers this booking. Status alone is not that condition. Three of
 *      the webhook's flagged shapes put a `status = 'paid'`, `needs_refund`
 *      payment on a booking a DIFFERENT payment legitimately funded —
 *      `double_charge` (src/lib/payments/webhook.ts:208), `not_payable`
 *      (:211, which covers `completed`), and `amount_mismatch` (:161, decided
 *      before any status check, so it fires on an already-confirmed booking
 *      too). Refunding that duplicate under a status-only scope would flip a
 *      fully-paid booking to `refunded_manual`: it pulls the owner's
 *      legitimate owner_net out of the payable pool (or claws it back if
 *      already paid out) while the platform keeps the original payment, shows
 *      the player a refunded booking while their money is still held, and —
 *      worst — FREES THE SLOT, because bookings_no_overlap
 *      (20260801070328_bookings.sql:78) excludes `refunded_manual` from its
 *      predicate, so another player can book over a paid, confirmed slot.
 *      There is no un-refund path and no unstamp path, so there is no undo.
 *      With the `not exists` clause a duplicate refund is a booking no-op and
 *      a single-payment dispute still flips exactly as before.
 *      Zero rows here is therefore the EXPECTED outcome for BOTH an orphan
 *      (booking never confirmed) and a duplicate (booking still covered) —
 *      not a failure — which is what `bookingRefunded` reports back to the
 *      caller so the UI can say the right thing.
 *
 * Full refunds only in MVP: the amount refunded is the payment's own
 * amount_centavos. Partial refunds would add a refund_amount_centavos column.
 */
export async function recordPaymentRefund(
  paymentId: string,
  note: string,
): Promise<RefundResult> {
  const trimmed = note.trim().slice(0, MAX_REFUND_NOTE)

  return db.transaction(
    async (tx) => {
      const stamped = await tx.execute(sql`
        update payments
        set needs_refund = false, refunded_at = now(),
            refund_note = ${trimmed.length > 0 ? trimmed : null}
        where id = ${paymentId}::uuid and refunded_at is null and status = 'paid'
        returning booking_id
      `)
      if (stamped.rows.length === 0) {
        return { ok: false as const, reason: 'already_recorded' as const }
      }

      const bookingId = stamped.rows[0].booking_id as string
      const flipped = await tx.execute(sql`
        update bookings
        set status = 'refunded_manual'::booking_status
        where id = ${bookingId}::uuid
          and status in ('confirmed', 'completed')
          and not exists (
            select 1 from payments other
            where other.booking_id = ${bookingId}::uuid
              and other.id <> ${paymentId}::uuid
              and other.status = 'paid'
              and other.refunded_at is null
          )
        returning id
      `)

      return { ok: true as const, bookingRefunded: flipped.rows.length > 0 }
    },
    { isolationLevel: 'read committed' },
  )
}
