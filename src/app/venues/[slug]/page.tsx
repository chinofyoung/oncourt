import { notFound } from 'next/navigation'
import { AvailabilityGrid } from '@/components/availability-grid'
import { PhotoGallery } from '@/components/branch/photo-gallery'
import { ReviewList } from '@/components/branch/review-list'
import { BranchMap } from '@/components/branch/branch-map-dynamic'
import { AmenityChip } from '@/components/ui/amenity-chip'
import { Rating } from '@/components/ui/rating'
import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { getBranchDetail } from '@/lib/branches/queries'
import { loadBranchDay } from '@/lib/booking/availability'
import { isValidCalendarDate, manilaToday, shiftDay } from '@/lib/date-manila'
import { formatDateLabel, formatPriceFrom } from '@/lib/format'

// Colors/tokens reference the brand CSS variables in src/app/globals.css
// (mirroring design/branding.md, the design source of truth): --surface for
// the page background, --ink/--ink-soft for text, --panel/--hairline for
// cards and the date-nav pill, --court for the light-background focus ring.
//
// Layout: a 360px/1fr grid at >=980px (branding.md's stacking breakpoint) —
// a narrow left rail for venue identity (gallery, header, amenity chips,
// description, location) and a wider right column for the booking panel,
// ported from design/mockups/branch-page.html's `.page` grid. Reviews and
// the owner strip run full-width below, since a review list can grow much
// longer than the mockup's single "latest review" teaser card.
//
// `main` uses the px-[max(24px,calc((100vw-1120px)/2))] full-bleed padding
// pattern (matching src/app/search/page.tsx and Nav/Footer) rather than the
// previous `mx-auto max-w-[1120px]` — `main` is a direct child of `<body>`,
// which src/app/layout.tsx makes a `flex flex-col` container, and cross-axis
// auto margins on a flex item is exactly the pattern that caused a real
// 375px overflow bug in an earlier task on this plan. The padding-only
// pattern bounds content width without relying on margin:auto at all.
//
// DELIBERATELY NOT ported from the mockup: the dropped `--band-peak`
// rate-band tint on the availability grid's time spine. design/branding.md's
// "Availability grid" entry documents that tint as removed (the real data
// model has rate bands *per court*, so a shared tint column would be correct
// for at most one visible court) and states the built app
// (src/components/availability-grid.tsx) is authoritative wherever it and
// the mockup disagree. That component, the "Book a court" section below, and
// the date-nav/`?held=` handling are carried over verbatim from the previous
// version of this file.
//
// The location block renders a real single-pin Leaflet map (`BranchMap`,
// dynamically imported via `branch-map-dynamic.tsx` with `ssr: false` since
// Leaflet touches `window` at module scope) whenever real coordinates exist.
// It does NOT reuse `SearchMap`: that component is shaped for a multi-pin,
// hover/click-to-navigate results map (mandatory per-pin `priceCentavos`,
// `activeId` state lifted to a parent, marker click pushes to
// `/venues/${slug}` — which here would just navigate to itself). Contorting
// it for one static, non-interactive pin would fight its actual shape rather
// than reuse it cleanly, so `BranchMap` is its own small component that
// shares only the genuinely common plumbing (CARTO tile layer + duotone
// filter) via `src/components/map/map-base.tsx`. The flat `--band-off`
// dashed block ("Map location not available yet.") remains the fallback,
// but ONLY when lat/lng are null — a prior version of this page showed that
// same flat block unconditionally whenever lat/lng were non-null, which was
// the defect this fix round corrects.
export default async function BranchPage(props: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ date?: string; held?: string }>
}) {
  const { slug } = await props.params
  const { date, held } = await props.searchParams
  // Falls back to today rather than 404ing — a mistyped or stale `?date=`
  // is a harmless typo on a public page, not a broken resource.
  const day = date && isValidCalendarDate(date) ? date : manilaToday()

  const [detail, result] = await Promise.all([getBranchDetail(slug), loadBranchDay(slug, day)])
  if (!detail || !result) notFound()

  const isToday = day === manilaToday()

  return (
    <>
      <Nav variant="solid" />

      <main className="flex flex-col gap-8 bg-[var(--surface)] px-[max(24px,calc((100vw-1120px)/2))] py-10">
        {held && (
          <p
            role="status"
            className="rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--band-off)] px-4 py-3 text-sm text-[var(--court-deep)]"
          >
            Slot on hold — go ahead and pay to confirm it before the hold expires.
          </p>
        )}

        <div className="grid grid-cols-1 items-start gap-8 min-[980px]:grid-cols-[360px_1fr]">
          {/* ============ Left rail: venue identity ============ */}
          <section aria-label="Venue details" className="flex flex-col gap-4">
            <PhotoGallery photoPaths={detail.photoPaths} />

            <header className="flex flex-col gap-2">
              <p className="font-mono text-[11.5px] uppercase tracking-[.08em] text-[var(--ink-soft)]">
                {detail.city}
              </p>
              <h1 className="text-3xl font-bold leading-tight tracking-tight text-[var(--ink)]">
                {detail.name}
              </h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-[var(--ink-soft)]">
                <Rating average={detail.ratingAvg} count={detail.ratingCount} />
                <span>
                  {detail.address}, {detail.city}
                </span>
                {detail.minPriceCentavos !== null && (
                  <span className="font-mono text-[var(--ink)]">
                    {formatPriceFrom(detail.minPriceCentavos)}
                  </span>
                )}
              </div>
              {detail.amenities.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-2">
                  {detail.amenities.map((amenity) => (
                    <AmenityChip key={amenity} amenity={amenity} />
                  ))}
                </div>
              )}
            </header>

            {detail.description && (
              <article
                aria-label="About"
                className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
              >
                <h2 className="mb-2 text-[17px] font-bold text-[var(--ink)]">About</h2>
                <p className="text-sm text-[var(--ink-soft)]">{detail.description}</p>
              </article>
            )}

            <article
              aria-label="Location"
              className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
            >
              <h2 className="mb-2 text-[17px] font-bold text-[var(--ink)]">Where to find us</h2>
              {detail.lat !== null && detail.lng !== null ? (
                <BranchMap lat={detail.lat} lng={detail.lng} name={detail.name} />
              ) : (
                <div className="rounded-[10px] border border-dashed border-[var(--hairline)] bg-[var(--surface)] p-4 text-sm text-[var(--ink-soft)]">
                  Map location not available yet.
                </div>
              )}
              <p className="mt-2 text-sm text-[var(--ink-soft)]">
                {detail.address}, {detail.city}
              </p>
            </article>
          </section>

          {/* ============ Right: booking panel (verbatim) ============ */}
          <section aria-label="Book a court" className="min-w-0 flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-bold text-[var(--ink)]">Book a court</h2>
              <div className="flex items-center gap-2">
                <a
                  href={`/venues/${slug}?date=${shiftDay(day, -1)}`}
                  aria-label="Previous day"
                  className="flex h-[var(--btn-h-sm)] w-[var(--btn-h-sm)] items-center justify-center rounded-[var(--btn-radius)] border border-[var(--hairline)] text-[var(--ink-soft)] hover:border-[var(--court)] hover:text-[var(--court-deep)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-[3px]"
                >
                  ‹
                </a>
                <span className="font-semibold text-[var(--ink)]">{formatDateLabel(day)}</span>
                {isToday && (
                  <span className="rounded-full bg-[var(--ink)] px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[.06em] text-[var(--ball)]">
                    Today
                  </span>
                )}
                <a
                  href={`/venues/${slug}?date=${shiftDay(day, 1)}`}
                  aria-label="Next day"
                  className="flex h-[var(--btn-h-sm)] w-[var(--btn-h-sm)] items-center justify-center rounded-[var(--btn-radius)] border border-[var(--hairline)] text-[var(--ink-soft)] hover:border-[var(--court)] hover:text-[var(--court-deep)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-[3px]"
                >
                  ›
                </a>
              </div>
            </div>

            {result.grid.length === 0 ? (
              <p className="text-[var(--ink-soft)]">No approved courts at this branch yet.</p>
            ) : (
              <AvailabilityGrid
                grid={result.grid}
                branchId={result.branch.id as string}
                slug={slug}
                date={day}
              />
            )}
          </section>
        </div>

        <ReviewList
          reviews={detail.reviews}
          ratingAvg={detail.ratingAvg}
          ratingCount={detail.ratingCount}
        />

        {/* ============ Owner strip ============ */}
        <section
          aria-label="Hosted by"
          className="flex flex-wrap items-center justify-between gap-4 rounded-[20px] border border-[var(--hairline)] bg-[var(--panel)] p-5"
        >
          <div className="flex items-center gap-3">
            {/* No storage bucket exists for owner logos today (only
                branch-photos/court-photos are provisioned — see
                supabase/migrations/*_storage_and_cron.sql), so `logoPath`
                cannot be resolved to a URL by `photoUrl()`; this always
                renders the initial-letter badge rather than guess a bucket. */}
            <span
              aria-hidden
              className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--hairline)] bg-[var(--court)] text-sm font-semibold text-white"
            >
              {(detail.owner.businessName || 'O').charAt(0).toUpperCase()}
            </span>
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[.08em] text-[var(--ink-soft)]">
                Hosted by
              </p>
              <p className="font-semibold text-[var(--ink)]">
                {detail.owner.businessName || 'Court owner'}
              </p>
            </div>
          </div>
          {detail.owner.slug && (
            <a
              href={`/owners/${detail.owner.slug}`}
              className="inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-4 text-sm font-semibold text-[var(--ink)] hover:border-[var(--court)] hover:text-[var(--court-deep)]"
            >
              View profile
            </a>
          )}
        </section>
      </main>

      <Footer />
    </>
  )
}
