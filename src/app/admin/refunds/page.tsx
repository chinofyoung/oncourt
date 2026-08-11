import { requireAdminPage } from '@/lib/auth/page-guards'
import {
  findRefundCandidates,
  getFlaggedRefunds,
  type RefundCandidate,
  type RefundPayment,
} from '@/lib/refunds/queries'
import { formatDateLabel, formatPeso } from '@/lib/format'
import { RecordRefundForm } from './refund-forms'

// Declared locally, not imported from src/app/dashboard/listings/form-ui.tsx:
// that module is 'use client', and importing it into a Server Component would
// pull it into the client bundle for a handful of strings. Same reasoning as
// src/app/admin/layout.tsx and src/app/dashboard/reviews/page.tsx.
//
// No `outline-none` base utility — branding.md's Controls/Focus entry: in
// Tailwind v4 pairing it with the focus utilities is NOT a no-op, it pins
// `--tw-outline-style: none` ungated and silently kills the ring.
const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)] max-[560px]:p-5'

const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

const CHIP =
  'font-mono shrink-0 rounded-full border border-[var(--hairline)] bg-[var(--surface)] px-2 py-0.5 text-[10px] tracking-[.1em] text-[var(--ink-soft)] uppercase'

const FIELD =
  `h-[var(--btn-h-sm)] w-full rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2.5 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-soft)] ${FOCUS_RING}`

// Identical classes to BORDERED_BUTTON in form-ui.tsx, copied rather than
// imported for the same client-bundle reason as FIELD/FOCUS_RING above. This
// page already has RecordRefundForm's own BORDERED_BUTTON per payment row, so
// this plain GET form's Search button matches that same non-lime choice —
// branding.md permits only one lime button per view, and this page repeats
// its refund form once per payment.
const BUTTON =
  `inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3.5 text-[13px] font-semibold whitespace-nowrap text-[var(--ink)] hover:border-[var(--court)] ${FOCUS_RING}`

/** `pending_payment` -> `Pending payment`. The enum's own words, not new copy
 *  invented per status — this is a support tool and every status (including
 *  ones a player never sees, like `blocked`) has to be shown honestly. */
function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ')
}

/**
 * The one card shape both sections render, so the queue and the lookup can
 * never drift apart on layout.
 *
 * `showForm` is a caller-supplied predicate rather than a hardcoded rule,
 * because the two sections gate on genuinely different things, both
 * deliberate: the flagged queue offers a form ONLY for the specific payment
 * the webhook flagged (`needsRefund`) — a double-charge's original,
 * legitimate confirming payment must never grow a stray "Record refund"
 * button next to the duplicate that actually needs one. The lookup section is
 * a general support tool with no such query-side filter, so it offers a form
 * for every payment that is simply paid and not yet refunded, flagged or not
 * — a plain dispute refund (never auto-flagged) has to be reachable from
 * here. A payment failing BOTH checks (unpaid, or already refunded) still
 * lists with its amount, method and state — no form — so "there is nothing to
 * return" is something the admin sees, not something a missing button implies.
 */
function CandidateCard({
  candidate,
  showForm,
}: {
  candidate: RefundCandidate
  showForm: (payment: RefundPayment) => boolean
}) {
  return (
    <article className={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-[16px] font-bold text-[var(--ink)]">
            {formatDateLabel(candidate.bookedOn)} · {candidate.branchName} · {candidate.courtName}
          </h3>
          <p className="mt-1 text-[13px] text-[var(--ink-soft)]">
            {candidate.playerName ? `${candidate.playerName} · ` : ''}
            {candidate.playerEmail ?? 'No player on this booking'}
          </p>
        </div>
        <span className={CHIP}>{statusLabel(candidate.bookingStatus)}</span>
      </div>

      <p className="font-mono mt-3 text-[13px] text-[var(--ink-soft)]">
        Total charged {formatPeso(candidate.totalChargedCentavos)}
      </p>

      {candidate.payments.length === 0 ? (
        <p className="mt-3 text-[13px] text-[var(--ink-soft)]">No payments recorded on this booking.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-4 border-t border-[var(--hairline)] pt-3">
          {candidate.payments.map((payment) => (
            <li key={payment.paymentId}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono text-[13.5px] text-[var(--ink)]">
                  {formatPeso(payment.amountCentavos)}
                  {payment.paymentMethod ? ` · ${payment.paymentMethod}` : ''}
                </span>
                <span className={CHIP}>{statusLabel(payment.status)}</span>
              </div>
              {payment.refundedOn && (
                <p className="mt-1 text-[12.5px] text-[var(--ink-soft)]">
                  Refunded {formatDateLabel(payment.refundedOn)}
                  {payment.refundNote ? ` — ${payment.refundNote}` : ''}
                </p>
              )}
              {showForm(payment) && <RecordRefundForm paymentId={payment.paymentId} />}
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

/**
 * The refund queue: what the webhook flagged, plus a lookup for the dispute
 * path. src/lib/payments/webhook.ts has set needs_refund since the payments
 * slice shipped; this page is the first thing that ever reads it.
 *
 * requireAdminPage again, even though the layout already ran it: App Router
 * cannot hand a layout's result to a page, and this page's own reads
 * (getFlaggedRefunds, findRefundCandidates) are global — gated by
 * construction beats gated by assumption, the same rule every other /admin/*
 * page states.
 *
 * The lookup is a plain GET form, not a Server Action: its result is a read,
 * and a URL an admin can share with a teammate or reload after a page
 * refresh is the right shape for support work.
 */
export default async function AdminRefundsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  await requireAdminPage('/admin/refunds')
  const { q } = await searchParams
  const query = (q ?? '').trim()

  const [flagged, matches] = await Promise.all([
    getFlaggedRefunds(),
    query.length > 0 ? findRefundCandidates(query) : Promise.resolve([]),
  ])

  return (
    <>
      <header className="mb-8">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Refunds
        </h1>
        <p className="mt-2 max-w-[640px] text-[15px] text-[var(--ink-soft)]">
          Money that was taken and needs to go back. Recording a refund here is bookkeeping — send
          the refund in GCash, Maya, or the card processor&rsquo;s own dashboard first, then record
          it here so the ledger and the booking catch up.
        </p>
      </header>

      <section className="mb-10">
        <h2 className="font-display mb-2 text-[18px] font-bold text-[var(--ink)]">
          Flagged by the system
        </h2>
        <p className="max-w-[640px] text-[14px] text-[var(--ink-soft)]">
          Payments the payment webhook flagged on its own — money that landed for a slot that was
          no longer available, that didn&rsquo;t match what checkout quoted, or that double-charged
          a booking a different payment already confirmed.
        </p>

        {flagged.length === 0 ? (
          <p className={`mt-4 ${EMPTY_PANEL}`}>
            Nothing flagged. Every payment taken so far matches a confirmed booking.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-4">
            {flagged.map((candidate) => (
              <li key={candidate.bookingId}>
                <CandidateCard candidate={candidate} showForm={(payment) => payment.needsRefund} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="font-display mb-2 text-[18px] font-bold text-[var(--ink)]">
          Find a booking
        </h2>
        <p className="max-w-[640px] text-[14px] text-[var(--ink-soft)]">
          For a dispute a player emailed in about. Search by their email address, or by the
          booking ID from the receipt.
        </p>

        <form
          method="get"
          action="/admin/refunds"
          aria-label="Find a booking to refund"
          className="mt-4 flex max-w-[480px] gap-2"
        >
          <input
            type="text"
            name="q"
            defaultValue={query}
            placeholder="Player email or booking ID"
            aria-label="Player email or booking ID"
            className={FIELD}
          />
          <button type="submit" className={BUTTON}>
            Search
          </button>
        </form>

        {query.length > 0 && matches.length === 0 && (
          <p className="mt-4 text-[13.5px] text-[var(--ink-soft)]">
            No booking matches that email or ID.
          </p>
        )}

        {matches.length > 0 && (
          <ul className="mt-4 flex flex-col gap-4">
            {matches.map((candidate) => (
              <li key={candidate.bookingId}>
                <CandidateCard
                  candidate={candidate}
                  showForm={(payment) => payment.status === 'paid' && payment.refundedOn === null}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
