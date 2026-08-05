import Link from 'next/link'
import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { StatCard } from '@/components/dashboard/stat-card'
import { requireUserPage } from '@/lib/auth/page-guards'
import { getPlayerDashboard } from '@/lib/bookings/queries'
import { formatDateLabel, formatHourRange, formatPeso } from '@/lib/format'
import { photoUrl } from '@/lib/photos'
import { ReviewForm } from './review-form'

const TABS = ['upcoming', 'past', 'reviews'] as const
type Tab = (typeof TABS)[number]

const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

/** `endHour - startHour` is always a whole number of hours: both come from
 * `extract(hour from ...)::int` in src/lib/bookings/queries.ts. */
function formatDurationHours(startHour: number, endHour: number): string {
  const hours = endHour - startHour
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

/**
 * Tabs are URL state (?tab=), not client state. Each tab is a fresh server
 * render, so data cannot go stale inside a hidden panel, the view is
 * linkable, and it survives a reload. It also keeps this page entirely off
 * the client bundle.
 */
export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const user = await requireUserPage('/bookings')
  const { tab: rawTab } = await searchParams
  const tab: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : 'upcoming'

  const { stats, upcoming, past, reviews } = await getPlayerDashboard(user.id)

  return (
    <>
      <Nav variant="solid" />
      {/* Full-bleed padding formula, not `mx-auto max-w-[1120px]` — see
          src/app/page.tsx:158 for why: `body` is `flex flex-col`, and an auto
          cross-axis margin on a flex item disables `align-self: stretch`. */}
      <main className="px-[max(24px,calc((100vw-1120px)/2))] pb-[72px]">
        <header className="pt-8 pb-7">
          <span className="font-mono mb-2.5 block text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
            Player · {user.email}
          </span>
          <h1 className="font-display text-[38px] font-bold tracking-[-0.03em] text-[var(--ink)] max-[560px]:text-[30px]">
            My bookings
          </h1>
          <p className="mt-2 max-w-[520px] text-[15px] text-[var(--ink-soft)]">
            Your court time, receipts, and reviews in one place.
          </p>
        </header>

        <div className="mb-8 grid grid-cols-4 gap-4 max-[980px]:grid-cols-2">
          <StatCard kicker="Upcoming" value={String(stats.upcomingCount)} />
          <StatCard kicker="Hours played this month" value={String(stats.hoursPlayedThisMonth)} />
          <StatCard kicker="Courts visited" value={String(stats.courtsVisited)} />
          <StatCard kicker="Total spent" value={formatPeso(stats.totalSpentCentavos)} />
        </div>

        <nav aria-label="Bookings" className="mb-7 flex gap-7 border-b border-[var(--hairline)]">
          {TABS.map((t) => {
            const active = tab === t
            const label =
              t === 'upcoming'
                ? `Upcoming (${upcoming.length})`
                : t === 'past'
                  ? `Past (${past.length})`
                  : `My reviews (${reviews.length})`
            return (
              <Link
                key={t}
                href={`/bookings?tab=${t}`}
                aria-current={active ? 'page' : undefined}
                className={`font-display -mb-px border-b-2 pb-3 text-[14.5px] font-semibold whitespace-nowrap ${FOCUS_RING} ${
                  active
                    ? 'border-[var(--ink)] text-[var(--ink)]'
                    : 'border-transparent text-[var(--ink-soft)] hover:text-[var(--ink)]'
                }`}
              >
                {label}
              </Link>
            )
          })}
        </nav>

        {tab === 'upcoming' && (
          <section aria-label="Upcoming bookings">
            {upcoming.length > 0 ? (
              <div className="flex flex-col gap-4">
                {upcoming.map((booking) => (
                  <article
                    key={booking.id}
                    className="flex gap-5 rounded-[20px] bg-[var(--panel)] p-4 shadow-[var(--shadow-sm)] max-[560px]:flex-col"
                  >
                    {photoUrl('branch-photos', booking.coverPhotoPath) && (
                      <img
                        src={photoUrl('branch-photos', booking.coverPhotoPath)!}
                        alt=""
                        className="h-[104px] w-[132px] shrink-0 rounded-[14px] object-cover max-[560px]:w-full"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-display text-[17px] font-bold tracking-[-0.015em] text-[var(--ink)]">
                        {booking.branchName} — {booking.courtName} ({booking.environment})
                      </div>
                      <div className="font-mono mt-1.5 text-[12.5px] text-[var(--ink-soft)]">
                        {formatDateLabel(booking.date)} ·{' '}
                        {formatHourRange(booking.startHour, booking.endHour)}
                      </div>
                      <div className="mt-1 text-[13.5px] text-[var(--ink-soft)]">
                        {booking.branchAddress}, {booking.branchCity}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <span className="font-mono text-[15px] font-semibold text-[var(--ink)]">
                        {formatPeso(booking.totalChargedCentavos)}
                      </span>
                      <span className="rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[11px] font-semibold text-[var(--court-deep)]">
                        {booking.status === 'confirmed' ? 'Confirmed' : 'Completed'}
                      </span>
                      <Link
                        href={`/bookings/${booking.id}`}
                        className={`inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3.5 text-[13px] font-semibold text-[var(--ink)] hover:border-[var(--court)] ${FOCUS_RING}`}
                      >
                        View receipt
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className={EMPTY_PANEL}>
                No upcoming bookings —{' '}
                <Link href="/search" className={`font-semibold text-[var(--court)] hover:text-[var(--court-deep)] ${FOCUS_RING}`}>
                  find a court
                </Link>{' '}
                and book your next game.
              </p>
            )}

            <p className="mt-4 text-[13px] text-[var(--ink-soft)]">
              Bookings are final — no cancellations. Contact the venue if something comes up.
            </p>
          </section>
        )}

        {tab === 'past' && (
          <section aria-label="Past bookings">
            {past.length > 0 ? (
              <div className="overflow-x-auto rounded-[20px] bg-[var(--panel)] shadow-[var(--shadow-sm)]">
                <table className="w-full min-w-[640px] border-collapse text-left">
                  <thead>
                    <tr className="font-mono border-b border-[var(--hairline)] text-[11px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                      <th className="py-3 pr-4 pl-5 font-normal">Date</th>
                      <th className="py-3 pr-4 font-normal">Venue</th>
                      <th className="py-3 pr-4 font-normal">Duration</th>
                      <th className="py-3 pr-4 text-right font-normal">Amount</th>
                      <th className="py-3 pr-5 text-right font-normal">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {past.map((booking) => (
                      <tr key={booking.id} className="border-b border-[var(--hairline)] last:border-b-0">
                        <td className="font-mono py-4 pr-4 pl-5 text-[12.5px] whitespace-nowrap text-[var(--ink-soft)]">
                          {formatDateLabel(booking.date)}
                        </td>
                        <td className="py-4 pr-4">
                          <div className="font-display text-[14.5px] font-semibold text-[var(--ink)]">
                            {booking.branchName}
                          </div>
                          <div className="mt-0.5 text-[12.5px] text-[var(--ink-soft)]">
                            {booking.courtName} ({booking.environment})
                          </div>
                        </td>
                        <td className="py-4 pr-4 text-[13px] whitespace-nowrap text-[var(--ink-soft)]">
                          {formatDurationHours(booking.startHour, booking.endHour)}
                        </td>
                        <td className="font-mono py-4 pr-4 text-right text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                          {formatPeso(booking.totalChargedCentavos)}
                        </td>
                        <td className="py-4 pr-5 text-right">
                          <div className="flex flex-col items-end gap-2">
                            <Link
                              href={`/bookings/${booking.id}`}
                              className={`text-[13px] font-semibold text-[var(--court)] hover:text-[var(--court-deep)] ${FOCUS_RING}`}
                            >
                              View receipt
                            </Link>
                            {booking.hasReview ? (
                              <div className="flex items-center gap-1.5">
                                <span
                                  aria-hidden
                                  className="h-[7px] w-[7px] rounded-full bg-[var(--ball)] outline outline-[1.5px] outline-[var(--ink)]"
                                />
                                <span className="text-[12px] font-medium text-[var(--ink)]">Reviewed</span>
                              </div>
                            ) : (
                              <ReviewForm bookingId={booking.id} />
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className={EMPTY_PANEL}>No past bookings yet.</p>
            )}
          </section>
        )}

        {tab === 'reviews' && (
          <section aria-label="My reviews">
            {reviews.length > 0 ? (
              <div className="flex flex-col gap-4">
                {reviews.map((review) => (
                  <article
                    key={review.id}
                    className="rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="font-display text-[16px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                          {review.branchName}
                        </div>
                        <div className="mt-0.5 text-[12.5px] text-[var(--ink-soft)]">
                          {review.courtName}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-[11.5px] text-[var(--ink-soft)]">
                          {formatDateLabel(review.createdAt.slice(0, 10))}
                        </div>
                        <div className="mt-1.5 flex items-center justify-end gap-1.5 text-[14px] font-semibold text-[var(--ink)]">
                          <span
                            aria-hidden
                            className="h-[7px] w-[7px] rounded-full bg-[var(--ball)] outline outline-[1.5px] outline-[var(--ink)]"
                          />
                          {review.rating.toFixed(1)}
                        </div>
                      </div>
                    </div>
                    {review.body && (
                      <p className="mt-3.5 text-[14.5px] text-[var(--ink)]">{review.body}</p>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <p className={EMPTY_PANEL}>
                No reviews yet — you can review a court after you&apos;ve played.
              </p>
            )}
          </section>
        )}
      </main>
      <Footer />
    </>
  )
}
