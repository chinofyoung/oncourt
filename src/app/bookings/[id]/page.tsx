import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { requirePlayerPage } from '@/lib/auth/page-guards'
import { getBookingReceipt } from '@/lib/bookings/queries'
import { ConfirmingBanner } from './confirming-banner'
import { formatDateLabel, formatHourRange, formatPeso } from '@/lib/format'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A booking's receipt.
 *
 * requirePlayerPage, not requireUserPage: a receipt is a player artifact, and
 * an owner reaching one has nothing to see there either (getBookingReceipt
 * scopes by player_id, so it would return null and 404 anyway — the redirect
 * to /dashboard is the better answer).
 *
 * Both "no such booking" and "not your booking" render notFound(). That is
 * deliberate: a distinct 403 for someone else's id would confirm the row
 * exists. getBookingReceipt scopes by player_id in its where clause, so this
 * page never sees another player's row to begin with.
 *
 * The id is shape-checked before the query because a non-UUID string reaches a
 * ::uuid cast and raises 22P02 — a crawler hitting /bookings/foo would
 * otherwise 500 instead of 404.
 */
export default async function ReceiptPage(props: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ paid?: string }>
}) {
  const { id } = await props.params
  // `?paid=1` is set by the PayMongo success redirect. It is a HINT ABOUT
  // WHICH COPY TO SHOW ON A SUCCESSFUL RETURN AND NOTHING ELSE — it never
  // gates whether reconciliation runs (that's `awaitingConfirmation` below,
  // driven entirely by the booking's OWN `payments` row, not by this query
  // param) and it grants and confirms nothing itself: a player can lose it by
  // navigating away and coming back, or hand-type it on a genuinely untouched
  // hold, and either way it must change only which SENTENCE renders, never
  // which WRITE happens. `confirmed` is written EXCLUSIVELY by handlePaidEvent
  // (src/lib/payments/webhook.ts) — reached either by the webhook route on a
  // pushed delivery, or by ConfirmingBanner's own bounded reconciliation calls
  // on a pulled one (src/lib/payments/reconcile.ts).
  const { paid } = await props.searchParams
  const user = await requirePlayerPage(`/bookings/${id}`)
  if (!UUID_RE.test(id)) notFound()

  const receipt = await getBookingReceipt(id, user.id)
  if (!receipt) notFound()

  const hours = receipt.endHour - receipt.startHour
  const justPaid = paid === '1'
  const isPending = receipt.status === 'pending_payment'
  const isExpired = receipt.status === 'expired'
  // The real signal, from our own database: a `payments` row with a session
  // id means the player was actually sent to PayMongo at least once and the
  // outcome is (from our side) unknown — reconciliation must run whether or
  // not the player is still on the success-redirect tab. No such row means
  // this is a genuine untouched hold, which has nothing to reconcile and
  // never should call the provider.
  //
  // `!receipt.refundOwed` is the fix for the "paid for a slot that already
  // ended" dead end: handlePaidEvent (src/lib/payments/webhook.ts) can accept
  // a payment (status = 'paid') and still refuse to confirm the booking,
  // leaving it at `pending_payment` forever with `needs_refund = true` on the
  // payment row. That is a RESOLVED outcome — there is nothing left to poll
  // or reconcile — so it must not satisfy awaitingConfirmation, or
  // ConfirmingBanner would spin through its six polls and then tell a player
  // who is owed a refund to keep waiting for an email that is never coming.
  const awaitingConfirmation = isPending && receipt.hasCheckoutSession && !receipt.refundOwed
  const unpaidHold = isPending && !receipt.hasCheckoutSession
  // Same partition as unpaidHold/awaitingConfirmation above, the third leg:
  // a payments row exists (so hasCheckoutSession is true — a paid payment
  // always has a session id) and it is flagged needs_refund. Mutually
  // exclusive with both: refundOwed implies hasCheckoutSession, so it can
  // never coincide with unpaidHold, and it is explicitly carved out of
  // awaitingConfirmation above.
  //
  // Gated on `isPending || isExpired`, NOT on `isPending` alone: hold sweeps
  // in this codebase are lazy (src/lib/booking/hold.ts, src/lib/payments/
  // webhook.ts only expire a stale row when someone else reaches for the
  // same slot), so a booking handlePaidEvent already resolved as
  // needs_refund can sit at `pending_payment` and then flip to `expired`
  // — with no further write to `payments` — the moment another player books
  // that court hour. `refundOwed` reads the `payments` row, not
  // `bookings.status` (see getBookingReceipt), so it stays true across that
  // transition; without this OR, the banner below would vanish at exactly
  // that moment and leave the player looking at a charged total with no
  // explanation. Deliberately NOT extended to every status refundOwed can
  // theoretically coexist with (e.g. a double-charge on an already-confirmed
  // booking) — those are a different, out-of-scope story; this covers only
  // the "paid for a slot that already ended" dead end this flag exists for.
  const refundOwedVisible = (isPending || isExpired) && receipt.refundOwed

  return (
    <>
      <Nav variant="solid" />
      <main className="px-[max(24px,calc((100vw-1120px)/2))] pb-[72px] pt-10">
        <Link href="/bookings" className="text-sm font-semibold text-[var(--court)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2">
          ← Back to my bookings
        </Link>

        {awaitingConfirmation && <div className="mt-6"><ConfirmingBanner bookingId={receipt.id} /></div>}

        {/* The resolved counterpart to ConfirmingBanner above: payment
            genuinely went through, but the slot had already ended, so
            handlePaidEvent (src/lib/payments/webhook.ts) could not confirm
            the booking and flagged the payment needs_refund instead. Nothing
            is still in flight here — no poll, no webhook, no email — so this
            says so plainly rather than asking the player to keep waiting. No
            amount, timeline, or reference number is stated: none of those are
            ours to promise from this data.

            Survives the booking's own pending_payment -> expired transition
            (see refundOwedVisible above) and, for that reason, is checked
            AHEAD of the justPaid&&expired banner below and excludes itself
            from it — the two must never render together, since that banner's
            "may still confirm — refresh to check" is exactly the question
            this one has already answered. */}
        {refundOwedVisible && (
          <p
            role="status"
            className="mt-6 mb-6 max-w-[560px] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--band-off)] px-4 py-3 text-sm text-[var(--court-deep)]"
          >
            Payment received, but this slot had already ended by the time it
            went through, so the booking couldn&apos;t be confirmed. A refund
            is on its way — there&apos;s nothing else you need to do.
          </p>
        )}

        {justPaid && receipt.status === 'confirmed' && (
          <p
            role="status"
            className="mt-6 mb-6 max-w-[560px] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--band-off)] px-4 py-3 text-sm text-[var(--court-deep)]"
          >
            Payment confirmed — your court time is booked. See you on court.
          </p>
        )}

        {/* REVIEW FIX I-3: a player returning from PayMongo whose hold was
            swept before the webhook arrived otherwise saw this receipt as
            "expired" with a charged total and no explanation. This covers the
            remaining genuinely UNRESOLVED case: a session was started but
            handlePaidEvent has not (yet, or ever) recorded an outcome for it,
            so the page truly cannot tell "still confirming" from "lost for
            good" and says both.

            `!receipt.refundOwed` excludes the one case that is no longer
            unresolved: once needs_refund is set, the outcome IS known (paid,
            slot gone, refund owed), and refundOwedVisible above already
            covers it with the correct, non-conflicting copy. Without this
            carve-out the two banners would render together and flatly
            contradict each other — this one saying "refresh to check", the
            other saying the refund is already on its way. */}
        {justPaid && receipt.status === 'expired' && !receipt.refundOwed && (
          <p
            role="status"
            className="mt-6 mb-6 max-w-[560px] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--band-off)] px-4 py-3 text-sm text-[var(--court-deep)]"
          >
            Payment received, but this hold had already expired. It may still
            confirm in the next moment — refresh to check. If it stays
            &quot;expired,&quot; the slot was lost and a refund is on its way.
          </p>
        )}

        {/* Genuinely untouched: no `payments` row at all, so "not paid for
            yet" is honest — the player never reached PayMongo for this hold.
            A hold that DID reach PayMongo (hasCheckoutSession) never renders
            this; it renders awaitingConfirmation above instead, whose own
            copy ("confirming with the payment provider") is what's true
            once a session — resolved or not — actually exists. */}
        {unpaidHold && (
          <div className="mt-6 max-w-[560px]">
            <p className="text-sm text-[var(--ink-soft)]">
              These slots are held but not paid for yet. Holds last 15 minutes.
            </p>
            {/* The receipt has no other button, so branding.md's "never two
                lime buttons in one view" holds — this is the view's single
                primary action, and the dead end this slice exists to remove. */}
            <Link
              href={`/bookings/${receipt.id}/checkout`}
              className={`font-display mt-3 inline-flex h-[var(--btn-h)] items-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-5 text-[14px] font-bold text-[var(--ball-ink)] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2`}
            >
              Finish paying
            </Link>
          </div>
        )}

        <div className="mt-6 max-w-[560px] rounded-[20px] bg-[var(--panel)] p-8 shadow-[var(--shadow-sm)]">
          <span className="font-mono block text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
            Receipt
          </span>
          <h1 className="font-display mt-2 text-[26px] font-bold tracking-[-0.025em] text-[var(--ink)]">
            {receipt.branchName}
          </h1>
          <p className="mt-1 text-[14px] text-[var(--ink-soft)]">
            {receipt.courtName} ({receipt.environment}) · {receipt.branchAddress},{' '}
            {receipt.branchCity}
          </p>

          <dl className="mt-7 grid grid-cols-[auto_1fr] gap-x-8 gap-y-3 text-[14px]">
            <dt className="text-[var(--ink-soft)]">When</dt>
            <dd className="font-mono text-right text-[var(--ink)]">
              {formatDateLabel(receipt.date)} · {formatHourRange(receipt.startHour, receipt.endHour)}
            </dd>

            <dt className="text-[var(--ink-soft)]">Duration</dt>
            <dd className="font-mono text-right text-[var(--ink)]">
              {hours} {hours === 1 ? 'hour' : 'hours'}
            </dd>

            <dt className="text-[var(--ink-soft)]">Court fee</dt>
            <dd className="font-mono text-right text-[var(--ink)]">
              {formatPeso(receipt.courtFeeCentavos)}
            </dd>

            {/* Only shown when nonzero: the fee bearer is configurable
                (processor_fee_bearer), so a ₱0 line would be noise for the
                common case where the platform absorbs it. */}
            {receipt.transactionFeeCentavos > 0 && (
              <>
                <dt className="text-[var(--ink-soft)]">Transaction fee</dt>
                <dd className="font-mono text-right text-[var(--ink)]">
                  {formatPeso(receipt.transactionFeeCentavos)}
                </dd>
              </>
            )}

            <dt className="border-t border-[var(--hairline)] pt-3 font-semibold text-[var(--ink)]">
              Total charged
            </dt>
            <dd className="font-mono border-t border-[var(--hairline)] pt-3 text-right font-semibold text-[var(--ink)]">
              {formatPeso(receipt.totalChargedCentavos)}
            </dd>
          </dl>

          <p className="font-mono mt-6 text-[11px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
            Ref {receipt.id.slice(0, 8).toUpperCase()} · {receipt.status.replace('_', ' ')}
          </p>
        </div>
      </main>
      <Footer />
    </>
  )
}
