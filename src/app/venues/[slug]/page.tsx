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
import { getOptionalUser } from '@/lib/auth/guards'
import { isValidCalendarDate, manilaToday, shiftDay } from '@/lib/date-manila'
import { formatDateLabel, formatPriceFrom } from '@/lib/format'
import { photoUrl } from '@/lib/photos'
import { LOGO_BUCKET } from '@/lib/owner/settings'

// Colors/tokens reference the brand CSS variables in src/app/globals.css
// (mirroring design/branding.md, the design source of truth): --surface for
// the page background, --ink/--ink-soft for text, --panel/--hairline for
// cards and the date-nav pill, --court for the light-background focus ring.
//
// Layout, current shape: `Nav variant="solid"`, then a flat `main` stack —
// photo gallery, (identity + About beside a map stretched to match its
// height), Book a court, Reviews — each getting the full 1120px content
// column. Nothing on this page bleeds to the viewport edges, and nothing on
// it is boxed in a card except Book a court's own grid and Reviews.
//
// Revision history that matters for anyone reading this file cold, because
// this page has been through six different shapes in one day and the
// reasoning for dropping each one is what stops it from getting reinvented:
//
// 1. First shape: a 360px left rail (photo grid, name, rating, amenities,
//    About card, map) beside a squeezed ~720px booking grid.
// 2. Second shape: the lead photo became a full-bleed backdrop with the
//    venue's identity (name, rating, address, price, chips) rendered AS TEXT
//    ON TOP of it, inside a dark rgba(6,20,13,.68) scrim, with `Nav
//    variant="overlay"` floating transparently above — mirroring
//    src/app/page.tsx's home hero. Built, gated clean, visually verified —
//    then rejected by the user: no text over photos, at all.
// 3. Third shape: the identity block moved below the photo, but the photo
//    itself stayed a full-bleed banner (no text, no scrim, `Nav
//    variant="solid"`). Also rejected: the user wanted the gallery to stop
//    bleeding to the viewport edges entirely.
// 4. Fourth shape: the gallery moved inside `main`'s 1120px column, back to
//    roughly its ORIGINAL 2fr/1fr grid shape (lead + thumbnails) from shape
//    1 — just 1120px wide instead of 360px — with every photo clickable into
//    a lightbox (see src/components/branch/photo-gallery.tsx's own doc
//    comment). Identity stayed a standalone `<header>`, and About/the map sat
//    in their own bordered cards below it.
// 5. Identity and the standalone About card are gone as separate elements —
//    merged into ONE plain left column (no
//    rounded-[20px]/bg-panel/shadow/padding "container") beside the map:
//    city kicker, name, hosted-by row, rating/address/price row, amenity
//    chips, then the About description text, in that order. The map's own
//    card wrapper is gone too, down to just the box BranchMap fills. Also
//    rejected by the same visual-review round: two boxed panels reading as
//    separate "sections" when they're one continuous introduction to the
//    venue.
// 6. **This shape:** the map went from a fixed square (an `aspect-square`
//    wrapper around `BranchMap`, unconditionally) to a rectangle that
//    matches the left column's height at `>=980px`, by explicit user
//    instruction. The square broke down under a long About description:
//    stress-testing it by forcing the left column to 678px left the map
//    stuck at 537×537, because Chrome does not apply CSS Grid's stretch
//    alignment to a box with a preferred aspect ratio. The "Location" grid
//    item itself carries no height/aspect-ratio utility, so at `>=980px`
//    (the two-column row) the grid's default `align-items: stretch` gives
//    it the row's full height directly. Its map wrapper is
//    `h-full max-[980px]:aspect-square` — `h-full` resolves against that
//    stretched height at `>=980px`, and `BranchMap`'s own `h-full w-full`
//    container fills the wrapper in turn. Below `980px` the identity/About
//    and map columns stack (`min-[980px]:grid-cols-2` no longer applies),
//    so "Location" is alone in its own auto-sized grid row with nothing to
//    stretch against — measured at 0px height when `aspect-square` was
//    simply dropped everywhere, a real regression this shape found and
//    fixed by scoping `aspect-square` to `max-[980px]:` on the wrapper
//    instead: `h-full` then computes to `auto` (Location's own height is
//    indefinite there), letting `aspect-square` derive a height from the
//    wrapper's own definite width instead, restoring the pre-existing
//    mobile square. The no-coordinates fallback keeps its own `h-[220px]`
//    cap rather than either behavior — see the inline comment beside the
//    grid below.
//
// docs/superpowers/specs/2026-08-12-venue-page-hero-design.md records the
// design history that led here — it is SUPERSEDED, describing two rejected
// intermediate shapes (the text-over-photo overlay hero, then the
// fixed-height full-bleed banner) rather than what actually shipped. Read it
// as a record of what was tried and rejected, not as a description of the
// current page — THIS comment is the authoritative account of what ships.
// It has not been re-baselined to match shape 6 above; per explicit
// instruction it will be re-baselined once after the visuals settle rather
// than amended repeatedly in place.
//
// Section order inside `main` puts identity+About+map BEFORE "Book a court"
// — reversed from an earlier version of this file, which put the booking
// grid first. Purely a content-order call from the same visual-review round
// that produced shapes 3-5 above, not a functional change.
//
// The address renders exactly ONCE, in the rating/address/price row — an
// earlier version of this section (shape 4) also carried a standalone
// address line under the map, which read as a duplicate once identity and
// About merged into the same column. Amenity chips live in this same left
// column (not a separate card), since they describe the whole venue rather
// than being "about" prose specifically.
//
// `main` uses the px-[max(24px,calc((100vw-1120px)/2))] full-bleed padding
// pattern (matching src/app/search/page.tsx and Nav/Footer) rather than the
// previous `mx-auto max-w-[1120px]` — `main` is a direct child of `<body>`,
// which src/app/layout.tsx makes a `flex flex-col` container, and cross-axis
// auto margins on a flex item is exactly the pattern that caused a real
// 375px overflow bug in an earlier task on this plan. The padding-only
// pattern bounds content width without relying on margin:auto at all.
// Section rhythm inside `main` is branding.md:55's documented 72px / 56px
// mobile — every direct child of `main`'s `flex flex-col gap-[72px]`
// (including the gallery now) gets that same rhythm for free.
//
// DELIBERATELY NOT ported from the mockup: the dropped `--band-peak`
// rate-band tint on the availability grid's time spine. design/branding.md's
// "Availability grid" entry documents that tint as removed (the real data
// model has rate bands *per court*, so a shared tint column would be correct
// for at most one visible court) and states the built app
// (src/components/availability-grid.tsx) is authoritative wherever it and
// the mockup disagree. That component, the "Book a court" section below, and
// the date-nav handling are carried over verbatim from the previous
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
// filter) via `src/components/map/map-base.tsx`. `BranchMap`'s container is
// `h-full w-full` (was a fixed 120px), which now resolves against its
// immediate wrapper's height rather than an unconditional `aspect-square` —
// that wrapper is `h-full max-[980px]:aspect-square`, stretching to match
// the "Location" grid item's row at `>=980px` and falling back to a
// width-derived square below it, since a single-column "Location" has no
// row to stretch against there — see branch-map.tsx's own comment and
// shape 6 above for the full mechanism and why the unconditional square was
// dropped. The flat `--band-off` dashed block ("Map location not available
// yet.") remains the fallback, but ONLY when lat/lng are null, and it keeps
// its own height cap at every breakpoint rather than stretching or going
// square (see the inline comment beside the grid below).
export default async function BranchPage(props: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ date?: string }>
}) {
  const { slug } = await props.params
  const { date } = await props.searchParams
  // Falls back to today rather than 404ing — a mistyped or stale `?date=`
  // is a harmless typo on a public page, not a broken resource.
  const day = date && isValidCalendarDate(date) ? date : manilaToday()

  const [detail, result] = await Promise.all([getBranchDetail(slug), loadBranchDay(slug, day)])
  if (!detail || !result) notFound()

  const isToday = day === manilaToday()

  // Signed-out visitors keep the CTA: clicking it redirects to /login and
  // returns them here, which is the funnel. Only a signed-in non-player has
  // the CTA withdrawn, because for them it can never succeed.
  //
  // <Nav> already calls getOptionalUser() on every page, so this adds no
  // dynamic-rendering cost that was not already paid.
  const viewer = await getOptionalUser()
  const canBook = viewer === null || viewer.role === 'player'
  const ownerLogoUrl = photoUrl(LOGO_BUCKET, detail.owner.logoPath)

  return (
    <>
      <Nav variant="solid" />

      <main className="flex flex-col gap-[72px] bg-[var(--surface)] px-[max(24px,calc((100vw-1120px)/2))] py-[72px] max-[560px]:gap-14 max-[560px]:py-14">
        <PhotoGallery photoPaths={detail.photoPaths} name={detail.name} />

        {/* ============ Identity + About, beside the map ============ */}
        {/* No standalone identity header and no card chrome here anymore —
            both were tried and both were explicitly reversed after visual
            review. The left column is plain content directly on --surface
            (no rounded-[20px]/bg-panel/shadow/padding "container"): city
            kicker, name, hosted-by, rating/address/price, chips, then the
            About description text, in that order. The right column drops
            its card wrapper too, down to just the map. At `>=980px` the map
            is deliberately a RECTANGLE that matches the left column's
            height, not a square: the "Location" div below carries no
            height/aspect-ratio utility of its own, so the grid's default
            `align-items: stretch` gives it the row's height directly (the
            row height being whatever the left column's content needs, e.g.
            a long About description). "Location" must stay free of any
            `aspect-ratio`/fixed-height class for that to work — Chrome does
            not apply stretch alignment to a box with a preferred aspect
            ratio, which is exactly why an earlier `aspect-square` wrapper
            here forced the map to hold at 537×537 even when the left
            column grew taller. The map wrapper just below is
            `h-full max-[980px]:aspect-square`: `h-full` is what actually
            resolves against "Location"'s stretched height at `>=980px` and
            passes it to `BranchMap`'s own `h-full w-full` container
            (branch-map.tsx) — a plain wrapper with no explicit height
            would NOT inherit "Location"'s stretched height on its own
            (a block box's `auto` height is content-sized, not
            parent-sized, even when the parent's own height is definite).
            Below `980px` the columns stack and "Location" is alone in its
            own auto-sized grid row, with no sibling to stretch against —
            `h-full` there resolves to `auto` (nothing definite to be a
            percentage OF), so `max-[980px]:aspect-square` takes over
            instead, deriving a height from the wrapper's own (definite,
            block-derived) width and restoring the square the map always
            had on narrow screens. The no-coordinates fallback is the one
            branch that does neither: it is plain text, not a map, and
            inheriting either the stretched row height or a square derived
            from column width turned one line of copy into a dashed void
            (half a page at `>=980px`, or awkwardly tall on mobile), so it
            keeps its own `h-[220px]` cap regardless of breakpoint — see the
            fallback branch below. gap-8 (not the 72px section rhythm)
            because this is one band, not two major sections. The address
            renders ONCE, in the rating row — an earlier version of this
            pairing also put it in a "Location" card under the map, which
            duplicated it in the same column once the two were merged.
            Both columns carry a landmark (`aria-label`) again here —
            removing the card *chrome* in the visual-review round above
            didn't require removing the *semantics* a screen-reader user
            navigates by; restoring it costs nothing visually. */}
        <div className="grid gap-8 min-[980px]:grid-cols-2">
          <section aria-label="Venue details" className="flex flex-col gap-3">
            <p className="font-mono text-[11.5px] uppercase tracking-[.08em] text-[var(--ink-soft)]">
              {detail.city}
            </p>
            <h1 className="max-w-[18ch] text-[44px] font-bold leading-[1.05] tracking-tight text-[var(--ink)] max-[980px]:text-[38px]">
              {detail.name}
            </h1>

            {/* Compact "Hosted by" row, directly under the venue name. Same
                logo/fallback logic and the same `detail.owner.slug` guard as
                the page's old bottom-of-page owner strip; only the chrome
                shrank to an inline row (28px logo, no card/border, plain text
                link) instead of a full-width bordered card with a button. */}
            <div className="flex flex-wrap items-center gap-2.5">
              {ownerLogoUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element -- the
                   bucket is public and this is an already-sized upload; the
                   same call src/app/owners/[slug]/page.tsx makes. */
                <img
                  src={ownerLogoUrl}
                  alt={`${detail.owner.businessName || 'Court owner'} logo`}
                  className="h-7 w-7 shrink-0 rounded-full border border-[var(--hairline)] object-cover"
                />
              ) : (
                <span
                  aria-hidden
                  className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--hairline)] bg-[var(--court)] text-[11px] font-semibold text-white"
                >
                  {(detail.owner.businessName || 'O').charAt(0).toUpperCase()}
                </span>
              )}
              <span className="font-mono text-[11px] uppercase tracking-[.08em] text-[var(--ink-soft)]">
                Hosted by
              </span>
              <span className="font-semibold text-[var(--ink)]">
                {detail.owner.businessName || 'Court owner'}
              </span>
              {detail.owner.slug && (
                <a
                  href={`/owners/${detail.owner.slug}`}
                  className="text-sm font-semibold text-[var(--court)] hover:text-[var(--court-deep)]"
                >
                  View profile
                </a>
              )}
            </div>

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
            {detail.description && (
              <p className="text-sm text-[var(--ink-soft)]">{detail.description}</p>
            )}
          </section>

          <div aria-label="Location" role="region">
            {detail.lat !== null && detail.lng !== null ? (
              <div className="h-full max-[980px]:aspect-square">
                <BranchMap lat={detail.lat} lng={detail.lng} name={detail.name} />
              </div>
            ) : (
              <div className="flex h-[220px] items-center justify-center rounded-[10px] border border-dashed border-[var(--hairline)] bg-[var(--surface)] p-4 text-center text-sm text-[var(--ink-soft)]">
                Map location not available yet.
              </div>
            )}
          </div>
        </div>

        {/* ============ Book a court (verbatim) ============ */}
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
              canBook={canBook}
            />
          )}
        </section>

        <ReviewList
          reviews={detail.reviews}
          ratingAvg={detail.ratingAvg}
          ratingCount={detail.ratingCount}
        />
      </main>

      <Footer />
    </>
  )
}
