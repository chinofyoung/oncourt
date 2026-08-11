import Link from 'next/link'
import { requireAdminPage } from '@/lib/auth/page-guards'
import { getAllOwnerLedgers } from '@/lib/payouts/ledger'
import { StatCard } from '@/components/dashboard/stat-card'
import { formatPeso } from '@/lib/format'
import { PrepareForm } from './payout-forms'

// No `outline-none` base utility — branding.md's Controls/Focus entry: in
// Tailwind v4 pairing it with the focus utilities is NOT a no-op, it pins
// `--tw-outline-style: none` ungated and silently kills the ring.
const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

/**
 * The payout ledger, one row per owner.
 *
 * requireAdminPage again, even though the layout already ran it: App Router
 * cannot hand a layout's result to a page, and this page's own read
 * (getAllOwnerLedgers) is global across every owner — gated by construction
 * beats gated by assumption, the same rule src/app/admin/page.tsx states.
 *
 * Echoes src/app/dashboard/earnings/page.tsx's table markup exactly (same
 * wrapper, same font-mono right-aligned money cells, same header row
 * classes) rather than inventing a second money-table shape.
 *
 * owedCentavos can legitimately be negative — an owner who was paid out and
 * then had a booking refunded owes the platform back, and that balance nets
 * off automatically the next time a payout is prepared (preparePayout()
 * writes nothing when net <= 0, so a negative balance just sits there until
 * enough new payable bookings absorb it). The caption below says so, and a
 * negative amount renders muted rather than in alarm-colored ink.
 */
export default async function AdminPayoutsPage() {
  await requireAdminPage('/admin/payouts')
  const ledgers = await getAllOwnerLedgers()

  const totalOwed = ledgers.reduce((sum, l) => sum + Math.max(l.owedCentavos, 0), 0)
  const totalPrepared = ledgers.reduce((sum, l) => sum + l.preparedCentavos, 0)
  const totalPaid = ledgers.reduce((sum, l) => sum + l.paidCentavos, 0)

  return (
    <>
      <header className="mb-6">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Payouts
        </h1>
        <p className="mt-2 max-w-[620px] text-[15px] text-[var(--ink-soft)]">
          Every owner, and what they&rsquo;re currently owed — including owners with nothing
          owed yet. Preparing a payout stamps its bookings and locks the amount — no money moves
          until it&rsquo;s marked paid.
        </p>
      </header>

      <div className="mb-6 grid grid-cols-3 gap-4 max-[980px]:grid-cols-1">
        <StatCard kicker="Owed" value={formatPeso(totalOwed)} />
        <StatCard kicker="Prepared" value={formatPeso(totalPrepared)} />
        <StatCard kicker="Paid all time" value={formatPeso(totalPaid)} />
      </div>

      {ledgers.length === 0 ? (
        <p className={EMPTY_PANEL}>No owners yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-[20px] bg-[var(--panel)] shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <caption className="caption-top px-5 pt-4 pb-1 text-left text-[13px] text-[var(--ink-soft)]">
              A negative Owed balance means this owner was overpaid — a booking they were already
              paid out for was later refunded — and it nets off automatically the next time a
              payout is prepared.
            </caption>
            <thead>
              <tr className="font-mono border-b border-[var(--hairline)] text-[11px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                <th className="py-3 pr-4 pl-5 font-normal">Owner</th>
                <th className="py-3 pr-4 text-right font-normal">Bookings</th>
                <th className="py-3 pr-4 text-right font-normal">Owed</th>
                <th className="py-3 pr-4 text-right font-normal">Prepared</th>
                <th className="py-3 pr-4 text-right font-normal">Paid</th>
                <th className="py-3 pr-5 font-normal">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {ledgers.map((l) => (
                <tr key={l.ownerId} className="border-b border-[var(--hairline)] last:border-b-0">
                  <td className="py-4 pr-4 pl-5 text-[13.5px] text-[var(--ink)]">
                    <Link
                      href={`/admin/payouts/${l.ownerId}`}
                      className={`font-semibold text-[var(--court)] hover:text-[var(--court-deep)] ${FOCUS_RING}`}
                    >
                      {/* Business name, then real name, then the address they
                          signed up with — the same precedence as the owners
                          directory's displayName() (src/app/admin/owners/
                          page.tsx:25) and this slice's own detail page. An
                          owner promoted by hand has no business name; dropping
                          fullName here showed them as an email in this list
                          and as their name one click later. */}
                      {l.businessName ?? l.fullName ?? l.email}
                    </Link>
                  </td>
                  <td className="font-mono py-4 pr-4 text-right text-[13.5px] text-[var(--ink)]">
                    {l.payableBookingCount}
                  </td>
                  <td
                    className={`font-mono py-4 pr-4 text-right text-[13.5px] whitespace-nowrap ${
                      l.owedCentavos < 0 ? 'text-[var(--ink-soft)]' : 'text-[var(--ink)]'
                    }`}
                  >
                    {formatPeso(l.owedCentavos)}
                  </td>
                  <td className="font-mono py-4 pr-4 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                    {formatPeso(l.preparedCentavos)}
                  </td>
                  <td className="font-mono py-4 pr-4 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                    {formatPeso(l.paidCentavos)}
                  </td>
                  <td className="py-4 pr-5 pl-4">
                    <PrepareForm ownerId={l.ownerId} disabled={l.owedCentavos <= 0} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
