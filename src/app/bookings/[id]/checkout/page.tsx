import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { requirePlayerPage } from '@/lib/auth/page-guards'
import { FOCUS_RING } from '@/app/dashboard/listings/form-ui'
import { formatDateLabel, formatHourRange } from '@/lib/format'
import { getCheckoutView } from '@/lib/payments/queries'
import { photoUrl } from '@/lib/photos'
import { CheckoutForm } from './checkout-form'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Pay for a hold.
 *
 * requirePlayerPage, not requireUserPage: roles are exclusive, and an owner or
 * admin can never hold a paid booking, so there is nothing here for them —
 * the redirect to /dashboard is a better answer than a 403.
 *
 * Both "no such booking" and "not your booking" render notFound(). Deliberate:
 * a distinct 403 for someone else's id would confirm the row exists.
 * getCheckoutView scopes by player_id in its WHERE clause, so this page never
 * sees another player's row to begin with. The id is shape-checked before the
 * query because a non-UUID reaches a ::uuid cast and would 500 instead of 404.
 *
 * AN EXPIRED (or already-paid) HOLD NEVER RENDERS A PAYABLE FORM. That branch
 * is decided on the server against the server clock, so a stale tab cannot
 * produce a Pay button for a dead hold.
 */
export default async function CheckoutPage(props: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ canceled?: string }>
}) {
  const { id } = await props.params
  const { canceled } = await props.searchParams
  const user = await requirePlayerPage(`/bookings/${id}/checkout`)
  if (!UUID_RE.test(id)) notFound()

  const view = await getCheckoutView(id, user.id)
  if (!view) notFound()

  const hours = view.endHour - view.startHour
  const coverUrl = photoUrl('branch-photos', view.coverPhotoPath)

  return (
    <>
      <Nav variant="solid" />
      <main className="px-[max(24px,calc((100vw-1120px)/2))] pt-6 pb-16">
        <Link
          href={`/venues/${view.branchSlug}`}
          className={`text-sm text-[var(--ink-soft)] hover:text-[var(--court)] ${FOCUS_RING}`}
        >
          ← Back to {view.branchName}
        </Link>

        {view.expired ? (
          <div className="mt-6 max-w-[560px] rounded-[20px] bg-[var(--panel)] p-8 shadow-[var(--shadow-sm)]">
            <span className="font-mono block text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
              Hold expired
            </span>
            <h1 className="font-display mt-2 text-[26px] font-bold tracking-[-0.025em] text-[var(--ink)]">
              These slots are no longer held
            </h1>
            <p className="mt-2 text-[14px] text-[var(--ink-soft)]">
              {view.status === 'pending_payment'
                ? 'Holds last 15 minutes. Nothing was charged — pick your slots again to start a new one.'
                : 'This booking is no longer awaiting payment. Check your bookings for its current status.'}
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href={`/venues/${view.branchSlug}`}
                className={`font-display inline-flex h-[var(--btn-h)] items-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-5 text-[14px] font-bold text-[var(--ball-ink)] ${FOCUS_RING}`}
              >
                Pick new slots
              </Link>
              <Link
                href="/bookings"
                className={`inline-flex h-[var(--btn-h)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-4 text-[14px] font-semibold text-[var(--ink)] hover:border-[var(--court)] ${FOCUS_RING}`}
              >
                My bookings
              </Link>
            </div>
          </div>
        ) : (
          <div className="mt-5">
            <CheckoutForm view={view} canceled={canceled === '1'}>
              {/* Server-rendered: the photo, the address and the date
                  formatting never enter the client bundle. */}
              <div className="flex gap-4">
                {coverUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={coverUrl}
                    alt=""
                    className="h-[104px] w-[104px] flex-none rounded-xl object-cover"
                  />
                )}
                <div>
                  <div className="font-display text-[17px] leading-[1.3] font-bold tracking-[-0.01em] text-[var(--ink)]">
                    {view.branchName} — {view.courtName} ({view.environment})
                  </div>
                  <div className="font-mono mt-1.5 text-[14px] text-[var(--ink)]">
                    {formatDateLabel(view.date)} · {formatHourRange(view.startHour, view.endHour)} ·{' '}
                    {hours} {hours === 1 ? 'hour' : 'hours'}
                  </div>
                  <div className="mt-1 text-[13px] text-[var(--ink-soft)]">
                    {view.branchAddress}, {view.branchCity}
                  </div>
                </div>
              </div>
            </CheckoutForm>
          </div>
        )}
      </main>
      <Footer />
    </>
  )
}
