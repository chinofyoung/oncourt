import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { requireUserPage } from '@/lib/auth/page-guards'
import { getBookingReceipt } from '@/lib/bookings/queries'
import { formatDateLabel, formatHourRange, formatPeso } from '@/lib/format'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A booking's receipt.
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
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requireUserPage(`/bookings/${id}`)
  if (!UUID_RE.test(id)) notFound()

  const receipt = await getBookingReceipt(id, user.id)
  if (!receipt) notFound()

  const hours = receipt.endHour - receipt.startHour

  return (
    <>
      <Nav variant="solid" />
      <main className="px-[max(24px,calc((100vw-1120px)/2))] pb-[72px] pt-10">
        <Link href="/bookings" className="text-sm font-semibold text-[var(--court)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2">
          ← Back to my bookings
        </Link>

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
