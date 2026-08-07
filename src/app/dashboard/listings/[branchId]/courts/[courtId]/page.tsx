import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { getListingCourt } from '@/lib/listings/queries'
import { COURT_STATUS_BANNERS } from '@/lib/listings/status'
import { BANDS_FAILURE_MESSAGES, HOURS_FAILURE_MESSAGES } from '@/lib/listings/schedule'
import { formatHour, formatHourRange, formatPeso } from '@/lib/format'
import { CourtFieldsForm, OperatingHoursForm, RateBandsForm } from './court-forms'
import { PhotoManager } from '../../../photo-forms'

const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One court: its status, its fields, its week, and its prices.
 *
 * FOUR access checks, not three. The usual dashboard guard and the
 * manage_courts scope cover the branch in the URL; the fourth —
 * `court.branchId === branchId` — is what stops a session from pairing its
 * OWN branch id with a foreign court id in the path and reading a court it
 * has no claim on. The write actions are immune to this by construction (they
 * resolve the branch from the court row), but this page is a read and needs
 * its own check.
 */
export default async function CourtDetailPage({
  params,
}: {
  params: Promise<{ branchId: string; courtId: string }>
}) {
  const { branchId, courtId } = await params
  const access = await requireDashboardPage('/dashboard/listings')

  if (!UUID_RE.test(branchId) || !UUID_RE.test(courtId)) notFound()
  if (!branchIdsWith(access, 'manage_courts').includes(branchId)) notFound()

  const court = await getListingCourt(courtId)
  if (!court || court.branchId !== branchId) notFound()

  const banner = COURT_STATUS_BANNERS[court.status]
  const warning =
    court.scheduleWarning === null
      ? null
      : court.scheduleWarning === 'no_open_day' || court.scheduleWarning === 'invalid_window'
        ? HOURS_FAILURE_MESSAGES[court.scheduleWarning]
        : BANDS_FAILURE_MESSAGES[court.scheduleWarning]

  return (
    <>
      <header className="mb-6">
        <Link
          href={`/dashboard/listings/${branchId}`}
          className={`font-mono mb-2 inline-block text-[11px] tracking-[.12em] text-[var(--court)] uppercase ${FOCUS_RING}`}
        >
          &larr; {court.branchName}
        </Link>
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          {court.name}
        </h1>
      </header>

      {/* Informational banner, flat --band-off per branding.md. Rendered for
          every status, including approved: "this is live, and these edits
          will take it off the market" is information an owner needs before
          they touch the forms, not after. */}
      <section
        aria-label="Approval status"
        className="mb-6 rounded-[20px] bg-[var(--band-off)] px-5 py-4"
      >
        <h2 className="font-mono text-[11px] tracking-[.14em] text-[var(--court-deep)] uppercase">
          {banner.title}
        </h2>
        <p className="mt-1.5 text-[13.5px] text-[var(--ink)]">{banner.body}</p>
        {court.status === 'rejected' && court.rejectionReason && (
          <p className="mt-2 text-[13.5px] text-[var(--ink)]">
            <span className="font-semibold">Reason:</span> {court.rejectionReason}
          </p>
        )}
        {warning && (
          <p role="status" className="mt-2 text-[13.5px] font-medium text-[var(--ink)]">
            {warning}
          </p>
        )}
      </section>

      {/* Identity pair: name/surface/environment beside the gallery that
          shows what the court looks like. Even fr/fr split per
          branding.md's "plain card grids" default — neither side has a
          natural minmax cap the way the branch form's map column does.
          items-start so a short "Court details" card doesn't get stretched
          to match a tall photo gallery. Collapses to one column at 980px in
          plain document order (no CSS `order`): details, then photos. */}
      <div className="mb-6 grid grid-cols-2 items-start gap-6 max-[980px]:grid-cols-1 max-[980px]:gap-4">
        <section aria-label="Court details" className={CARD}>
          <h2 className="font-display mb-4 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
            Court details
          </h2>
          <CourtFieldsForm
            courtId={court.id}
            defaults={{ name: court.name, environment: court.environment, surface: court.surface }}
          />
        </section>

        <section aria-label="Court photos" className={CARD}>
          <h2 className="font-display mb-1 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
            Court photos
          </h2>
          <p className="mb-4 text-[12.5px] text-[var(--ink-soft)]">
            Photo changes do not send this court back for approval.
          </p>
          {/* canManage is unconditionally true here: reaching this page already
              required manage_courts on this branch. */}
          <PhotoManager kind="court" targetId={court.id} photos={court.photos} canManage />
        </section>
      </div>

      {/* Schedule pair: this is the pairing that actually earns the
          two-column layout, not just space-filling. Rate bands are
          validated as tiles covering exactly [min(opens), max(closes)]
          across the open days (validateRateBands in
          src/lib/listings/schedule.ts, surfaced above as the "rates don't
          cover your hours" scheduleWarning). Stacked full-width, fixing a
          coverage mismatch meant scrolling between two cards to compare
          them; side by side, an owner can see the hours envelope and the
          bands that are supposed to tile it at the same time. Same even
          fr/fr split and 980px collapse as the pair above, in document
          order: hours, then rates. */}
      <div className="grid grid-cols-2 items-start gap-6 max-[980px]:grid-cols-1 max-[980px]:gap-4">
        <section aria-label="Opening hours" className={CARD}>
          <h2 className="font-display mb-1 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
            Opening hours
          </h2>
          <p className="mb-4 text-[12.5px] text-[var(--ink-soft)]">
            One window per day. Closing at {formatHour(24)} means midnight.
          </p>
          <OperatingHoursForm courtId={court.id} days={court.days} />
        </section>

        <section aria-label="Rates" className={CARD}>
          <h2 className="font-display mb-1 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
            Rates
          </h2>
          {court.bands.length > 0 && (
            <p className="font-mono mb-4 text-[11.5px] text-[var(--ink-soft)]">
              {court.bands
                .map(
                  (band) =>
                    `${formatHourRange(band.startHour, band.endHour)} ${formatPeso(band.priceCentavos)}`,
                )
                .join('  ·  ')}
            </p>
          )}
          <RateBandsForm courtId={court.id} bands={court.bands} />
        </section>
      </div>
    </>
  )
}
