import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireAdminPage } from '@/lib/auth/page-guards'
import {
  getOwnerLedger,
  getOwnerPayouts,
  getPayablePool,
  type OwnerLedger,
  type PayableBooking,
  type PayoutLine,
  type PayoutRecord,
} from '@/lib/payouts/ledger'
import { formatDateLabel, formatPeso } from '@/lib/format'
import { MarkPaidForm } from '../payout-forms'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const NAV_LINK =
  `inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3 text-[13px] font-semibold text-[var(--ink)] hover:border-[var(--court)] ${FOCUS_RING}`

// Panel recipe (branding.md's Cards entry): white, 20px radius, --shadow-sm,
// no border. Matches src/app/admin/owners/page.tsx's CARD, not the entity-card
// skeleton — this hosts a form and static facts, not a link elsewhere.
const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)] max-[560px]:p-5'

const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

/** Business name, then real name, then the address they signed up with. Same
 *  precedence as src/app/admin/owners/page.tsx's displayName(). */
function displayName(ledger: OwnerLedger): string {
  return ledger.businessName ?? ledger.fullName ?? ledger.email
}

/** `Aug 1` alone when a payout's stamped bookings all fall on one Manila day,
 *  `Aug 1 – Aug 3` otherwise. Same collapse-when-equal shape as
 *  formatPriceRange() in src/lib/format.ts. */
function periodLabel(payout: PayoutRecord): string {
  return payout.periodStart === payout.periodEnd
    ? formatDateLabel(payout.periodStart)
    : `${formatDateLabel(payout.periodStart)} – ${formatDateLabel(payout.periodEnd)}`
}

/** The payment lines whose booking has since been refunded — the one thing
 *  the two-step flow exists to let an admin catch before paying. Clawback
 *  lines are excluded: a clawback IS the correction, not a thing to warn
 *  about. */
function refundedPaymentLines(payout: PayoutRecord): PayoutLine[] {
  return payout.lines.filter((line) => line.bookingRefunded && line.kind === 'payment')
}

export default async function AdminPayoutDetailPage({
  params,
}: {
  params: Promise<{ ownerId: string }>
}) {
  await requireAdminPage('/admin/payouts')
  const { ownerId } = await params
  // Shape-checked before it reaches getOwnerLedger's `::uuid` cast, which
  // would otherwise raise 22P02 — a stale link, a typo, or a crawler probing
  // /admin/* would 500 instead of 404. Same precedent as the UUID_RE check in
  // src/app/bookings/[id]/page.tsx.
  if (!UUID_RE.test(ownerId)) notFound()

  const ledger = await getOwnerLedger(ownerId)
  if (!ledger) notFound()

  const [payouts, pool] = await Promise.all([getOwnerPayouts(ownerId), getPayablePool(ownerId)])
  const pending = payouts.filter((p) => p.status === 'pending')
  const paid = payouts.filter((p) => p.status === 'paid')
  const poolTotal = pool.reduce((sum, b) => sum + b.netCentavos, 0)
  // Derived rather than queried a second time: getPayablePool and the ledger's
  // `payable` CTE share a predicate, so poolTotal IS the ledger's payable sum
  // and the remainder is exactly the outstanding clawback. Deriving it this way
  // means the two numbers below cannot drift from the list page's Owed column —
  // Owed is read straight off the same OwnerLedger that page reads.
  const clawbackCentavos = poolTotal - ledger.owedCentavos

  return (
    <>
      <Link href="/admin/payouts" className={NAV_LINK}>
        &larr; All owners
      </Link>

      <header className="mt-4 mb-8">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          {displayName(ledger)}
        </h1>
        <p className="mt-2 text-[13px] text-[var(--ink-soft)]">{ledger.email}</p>
      </header>

      <div className="flex flex-col gap-8">
        <section>
          <h2 className="font-display mb-3 text-[18px] font-bold text-[var(--ink)]">
            Awaiting transfer
          </h2>
          {pending.length === 0 ? (
            <p className={EMPTY_PANEL}>Nothing waiting on a transfer right now.</p>
          ) : (
            <ul className="flex flex-col gap-4">
              {pending.map((payout) => {
                const refunded = refundedPaymentLines(payout)
                const overpayCentavos = refunded.reduce((sum, line) => sum + line.netCentavos, 0)

                return (
                  <li key={payout.id}>
                    <article className={CARD}>
                      <div className="flex flex-wrap items-baseline justify-between gap-3">
                        <h3 className="font-display text-[16px] font-bold text-[var(--ink)]">
                          {periodLabel(payout)}
                        </h3>
                        <span className="font-mono text-[12.5px] text-[var(--ink-soft)]">
                          {payout.lines.length} {payout.lines.length === 1 ? 'line' : 'lines'}
                        </span>
                      </div>
                      <p className="font-mono mt-2 text-[24px] font-bold text-[var(--ink)]">
                        {formatPeso(payout.netCentavos)}
                      </p>

                      {refunded.length > 0 && (
                        // Deliberately loud: soft unsaturated orange
                        // (--slot-booked / --slot-booked-ink), the same
                        // "needs attention" tokens the availability grid
                        // already uses for a booked cell, rather than a new
                        // color. This is the single most important piece of
                        // UI on this page — the whole reason prepare and
                        // mark-paid are two separate steps.
                        <div
                          role="alert"
                          className="mt-4 rounded-[var(--btn-radius)] border border-[var(--slot-booked-ink)]/30 bg-[var(--slot-booked)] px-4 py-3 text-[13px] text-[var(--slot-booked-ink)]"
                        >
                          <p className="font-semibold">
                            {refunded.length} {refunded.length === 1 ? 'booking' : 'bookings'} in
                            this payout {refunded.length === 1 ? 'has' : 'have'} since been
                            refunded. Paying it will overpay by {formatPeso(overpayCentavos)}; the
                            amount is clawed back on the next payout.
                          </p>
                          <ul className="mt-2 flex flex-col gap-1 text-[12.5px]">
                            {refunded.map((line) => (
                              <li key={line.bookingId}>
                                {formatDateLabel(line.bookedOn)} · {line.branchName} ·{' '}
                                {line.courtName} · {formatPeso(line.netCentavos)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <MarkPaidForm payoutId={payout.id} ownerId={ownerId} />
                    </article>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section>
          <h2 className="font-display mb-3 text-[18px] font-bold text-[var(--ink)]">
            Payout history
          </h2>
          {paid.length === 0 ? (
            <p className={EMPTY_PANEL}>No payouts recorded yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-[20px] bg-[var(--panel)] shadow-[var(--shadow-sm)]">
              <table className="w-full min-w-[560px] border-collapse text-left">
                <thead>
                  <tr className="font-mono border-b border-[var(--hairline)] text-[11px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                    <th className="py-3 pr-4 pl-5 font-normal">Period</th>
                    <th className="py-3 pr-4 text-right font-normal">Net</th>
                    <th className="py-3 pr-4 text-right font-normal">Paid on</th>
                    <th className="py-3 pr-5 font-normal">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {paid.map((payout) => (
                    <tr key={payout.id} className="border-b border-[var(--hairline)] last:border-b-0">
                      <td className="py-4 pr-4 pl-5 text-[13.5px] text-[var(--ink)]">
                        {periodLabel(payout)}
                      </td>
                      <td className="font-mono py-4 pr-4 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                        {formatPeso(payout.netCentavos)}
                      </td>
                      <td className="font-mono py-4 pr-4 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                        {payout.paidOn ? formatDateLabel(payout.paidOn) : '—'}
                      </td>
                      <td className="py-4 pr-5 text-[13px] text-[var(--ink-soft)]">
                        {payout.note ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h2 className="font-display mb-3 text-[18px] font-bold text-[var(--ink)]">
            Payable now
          </h2>
          {/* An owner with no payable bookings but an outstanding clawback
              still gets the table: "Nothing payable right now" alone would
              hide the very reason the list page shows them a negative Owed
              and refuses to prepare. */}
          {pool.length === 0 && clawbackCentavos === 0 ? (
            <p className={EMPTY_PANEL}>Nothing payable right now.</p>
          ) : (
            <div className="overflow-x-auto rounded-[20px] bg-[var(--panel)] shadow-[var(--shadow-sm)]">
              <table className="w-full min-w-[560px] border-collapse text-left">
                <thead>
                  <tr className="font-mono border-b border-[var(--hairline)] text-[11px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                    <th className="py-3 pr-4 pl-5 font-normal">Date</th>
                    <th className="py-3 pr-4 font-normal">Branch</th>
                    <th className="py-3 pr-4 font-normal">Court</th>
                    <th className="py-3 pr-5 text-right font-normal">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {pool.map((booking: PayableBooking) => (
                    <tr key={booking.bookingId} className="border-b border-[var(--hairline)] last:border-b-0">
                      <td className="py-4 pr-4 pl-5 text-[13.5px] text-[var(--ink)]">
                        {formatDateLabel(booking.bookedOn)}
                      </td>
                      <td className="py-4 pr-4 text-[13.5px] text-[var(--ink)]">
                        {booking.branchName}
                      </td>
                      <td className="py-4 pr-4 text-[13.5px] text-[var(--ink)]">
                        {booking.courtName}
                      </td>
                      <td className="font-mono py-4 pr-5 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                        {formatPeso(booking.netCentavos)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {/* Labelled "Owed", and showing the SAME number as the list
                    page's Owed column, because the two pages showing different
                    figures for one owner's money is worse than no total at all:
                    owedCentavos is payable MINUS outstanding clawbacks
                    (src/lib/payouts/ledger.ts), so an owner carrying one used
                    to read "Total ₱270" here while the list said "-₱270" and
                    disabled Prepare — the one number that looked actionable,
                    with none of the context for why nothing could be done. The
                    subtotal-and-adjustment breakdown appears only when there IS
                    an adjustment; otherwise the foot stays the single row it
                    was. */}
                <tfoot>
                  {clawbackCentavos !== 0 && (
                    <>
                      <tr className="border-t border-[var(--hairline)]">
                        <td className="py-4 pr-4 pl-5 text-[13.5px] text-[var(--ink)]" colSpan={3}>
                          Subtotal
                        </td>
                        <td className="font-mono py-4 pr-5 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                          {formatPeso(poolTotal)}
                        </td>
                      </tr>
                      <tr className="border-t border-[var(--hairline)]">
                        <td
                          className="py-4 pr-4 pl-5 text-[13.5px] text-[var(--ink-soft)]"
                          colSpan={3}
                        >
                          Outstanding adjustment · {ledger.clawbackBookingCount}{' '}
                          {ledger.clawbackBookingCount === 1 ? 'booking' : 'bookings'} refunded
                          after being paid out
                        </td>
                        <td className="font-mono py-4 pr-5 text-right text-[13.5px] whitespace-nowrap text-[var(--ink-soft)]">
                          {formatPeso(-clawbackCentavos)}
                        </td>
                      </tr>
                    </>
                  )}
                  <tr className="border-t border-[var(--hairline)] font-semibold">
                    <td className="py-4 pr-4 pl-5 text-[13.5px] text-[var(--ink)]" colSpan={3}>
                      Owed
                    </td>
                    <td className="font-mono py-4 pr-5 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                      {formatPeso(ledger.owedCentavos)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  )
}
