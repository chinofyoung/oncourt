import Link from 'next/link'
import { requireAdminPage } from '@/lib/auth/page-guards'
import { getAdminCourts, type AdminCourtRow } from '@/lib/admin/queries'
import { SCHEDULE_BLOCK_MESSAGES } from '@/lib/admin/moderation'
import { COURT_ENVIRONMENT_LABELS } from '@/lib/listings/fields'
import { COURT_STATUS_LABELS } from '@/lib/listings/status'
import { formatDateLabel } from '@/lib/format'
import { ApprovalForms, StatusToggleForm } from './moderation-forms'

const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)] max-[560px]:p-5'
const KICKER = 'font-mono text-[10.5px] tracking-[.12em] text-[var(--ink-soft)] uppercase'
const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

/**
 * The approval queue, and the live-courts tab beside it.
 *
 * Two tabs over ONE query: getAdminCourts(['pending']) and
 * getAdminCourts(['approved', 'suspended']). A tab, not two routes, because
 * they are the same page doing the same job — moderating courts — and a fact
 * added to the card is a fact both tabs get.
 *
 * requireAdminPage again, even though the layout already ran it: App Router
 * cannot pass a layout's result to a page, and this page's own reads are
 * GLOBAL (see src/lib/admin/queries.ts). Gated by construction beats gated by
 * assumption.
 */
export default async function AdminApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  await requireAdminPage('/admin')
  const { tab } = await searchParams
  const live = tab === 'live'

  const courts = await getAdminCourts(live ? ['approved', 'suspended'] : ['pending'])

  return (
    <>
      <header className="mb-6">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          {live ? 'Live courts' : 'Approval queue'}
        </h1>
        <p className="mt-2 max-w-[620px] text-[15px] text-[var(--ink-soft)]">
          {live
            ? 'Every approved court, and the suspended ones. Suspending takes a court off search and its venue page immediately; the bookings already on it are untouched.'
            : 'Courts waiting on a decision, across every owner, oldest first. A court comes back here whenever its owner changes its hours, rates or environment.'}
        </p>
      </header>

      <nav aria-label="Queue filter" className="mb-6 flex gap-2">
        {[
          { href: '/admin', label: 'Pending', active: !live },
          { href: '/admin?tab=live', label: 'Approved & suspended', active: live },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={item.active ? 'page' : undefined}
            className={`font-display inline-flex h-[var(--btn-h-sm)] items-center rounded-full border px-4 text-[13.5px] font-semibold ${FOCUS_RING} ${
              item.active
                ? 'border-[var(--ink)] bg-[var(--ink)] text-[var(--ball)]'
                : 'border-[var(--hairline)] bg-[var(--panel)] text-[var(--ink-soft)] hover:border-[var(--court)] hover:text-[var(--ink)]'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {courts.length === 0 ? (
        <p className={EMPTY_PANEL}>
          {live ? 'No approved courts yet.' : 'Nothing is waiting for approval. Good.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {courts.map((court) => (
            <li key={court.id}>
              <CourtCard court={court} live={live} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function CourtCard({ court, live }: { court: AdminCourtRow; live: boolean }) {
  // The identical rule approveCourt() refuses on, phrased for the admin.
  const blockedReason =
    court.scheduleWarning === null ? null : SCHEDULE_BLOCK_MESSAGES[court.scheduleWarning]

  const facts = [
    {
      term: 'Court',
      detail: [COURT_ENVIRONMENT_LABELS[court.environment], court.surface]
        .filter(Boolean)
        .join(' · '),
    },
    { term: 'Hours', detail: court.hoursSummary },
    {
      term: 'Rates',
      detail: `${court.bandCount} ${court.bandCount === 1 ? 'band' : 'bands'}`,
    },
    {
      term: 'Photos',
      detail: `${court.photoCount} ${court.photoCount === 1 ? 'photo' : 'photos'}`,
    },
  ]

  return (
    <article className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-[18px] font-bold tracking-[-0.015em] text-[var(--ink)]">
            {court.name} — {court.branchName}
          </h2>
          <p className="mt-1 text-[13px] text-[var(--ink-soft)]">
            {/* An owner promoted by hand may have no business name yet, so the
                email is the fallback rather than an empty space. */}
            {court.ownerBusinessName ?? court.ownerEmail} · {court.branchCity}
          </p>
        </div>
        <div className="flex flex-none items-center gap-2.5">
          <span className="font-mono text-[12px] whitespace-nowrap text-[var(--ink-soft)]">
            {/* "Added", never "Submitted": courts.created_at is a creation
                date, and a re-queued court still carries its original one. */}
            Added {formatDateLabel(court.addedOn)}
          </span>
          <span className="font-mono rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[10.5px] tracking-[.06em] text-[var(--court-deep)] uppercase">
            {COURT_STATUS_LABELS[court.status]}
          </span>
        </div>
      </div>

      <dl className="font-mono mt-4 grid gap-2 text-[12.5px]">
        {facts.map((fact) => (
          <div key={fact.term} className="grid grid-cols-[84px_1fr] gap-2.5">
            <dt className={KICKER}>{fact.term}</dt>
            <dd className="text-[var(--ink)]">{fact.detail}</dd>
          </div>
        ))}
      </dl>

      {court.status === 'rejected' && court.rejectionReason && (
        <p className="mt-3 text-[13px] text-[var(--ink)]">
          <span className="font-semibold">Last reason:</span> {court.rejectionReason}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-[var(--hairline)] pt-4">
        {live ? (
          <StatusToggleForm
            courtId={court.id}
            kind={court.status === 'approved' ? 'suspend' : 'unsuspend'}
            // Only unsuspendCourt() is schedule-gated — suspend never is —
            // so a suspend row never receives a blockedReason.
            blockedReason={court.status === 'suspended' ? blockedReason : null}
          />
        ) : (
          <ApprovalForms courtId={court.id} blockedReason={blockedReason} />
        )}
        {/* The public branch page, so the whole venue can be judged rather
            than one row of facts. A pending court is not ON that page — public
            reads filter to approved — which is exactly the "here is the venue
            this belongs to" context the queue cannot fit. */}
        <Link
          href={`/venues/${court.branchSlug}`}
          className={`ml-auto text-[13.5px] font-semibold text-[var(--court)] hover:text-[var(--court-deep)] ${FOCUS_RING}`}
        >
          View branch &rarr;
        </Link>
      </div>
    </article>
  )
}
