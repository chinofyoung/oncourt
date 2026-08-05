import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { CardHoverProvider } from '@/components/search/hover-context'
import { MapHero } from '@/components/search/map-hero'
import { SortSelect } from '@/components/search/sort-select'
import { FilterChips } from '@/components/search/filter-chips'
import { ResultsGrid } from '@/components/search/results-grid'
import { searchBranches } from '@/lib/branches/queries'
import { cityBySlug } from '@/lib/geo/cities'
import { parseSearchParams } from '@/lib/search/params'

/**
 * Ported from design/mockups/search-results.html, including its `.map-hero`:
 * a full-bleed 460px Leaflet band under the solid nav, carrying the
 * where/date/time fields floating over its bottom-left corner, then the
 * results below in the 1120px column — section head (kicker + count + sort),
 * filter chips, and a three-up card grid.
 *
 * This replaces an earlier layout that skipped the hero and put the map in a
 * sticky right-hand column beside a two-up grid. Card↔pin hover pairing
 * survived the move via `CardHoverProvider`: the map and the cards are now in
 * separate page regions, so the shared `activeId` lives in context instead of
 * in a component that would have had to wrap the entire page.
 *
 * Deliberate departures from the mockup, both because branding.md outranks it:
 * the filter chips keep `--btn-radius` rather than becoming 999px pills (pills
 * are for non-interactive badges), and the float carries no lime button
 * (nothing to submit — the fields write straight to the URL). See the
 * comments at those call sites.
 */
export default async function SearchPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const parsed = await props.searchParams.then(parseSearchParams)
  const results = await searchBranches(parsed.filters)

  const count = `${results.length} ${results.length === 1 ? 'court' : 'courts'}`
  const heading = parsed.usingCoords
    ? `${count} near you`
    : `${count} in ${cityBySlug(parsed.citySlug).name}`

  return (
    <CardHoverProvider>
      <Nav variant="solid" />

      <MapHero
        pins={results
          .filter((b) => b.lat !== null && b.lng !== null)
          .map((b) => ({
            id: b.id,
            name: b.name,
            slug: b.slug,
            lat: b.lat!,
            lng: b.lng!,
            priceCentavos: b.minPriceCentavos,
          }))}
        citySlug={parsed.citySlug}
        date={parsed.date}
        hour={parsed.hour}
        usingCoords={parsed.usingCoords}
      />

      <main className="px-[max(24px,calc((100vw-1120px)/2))] pt-8 pb-[72px]">
        <div className="mb-5 flex items-baseline gap-4">
          {/* A filter change is a client-side RSC re-render, not a full page
              load, so this heading updates silently for a screen-reader user
              unless announced explicitly. This wrapper is a stable node — no
              `key`, not inside any conditional — so React updates the text in
              place instead of unmounting/remounting the live region (an
              unmount/remount may not get announced at all). `aria-atomic`
              re-reads the whole phrase instead of just the changed digit. */}
          <div aria-live="polite" aria-atomic="true" className="flex-1">
            <span className="font-mono mb-2 block text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
              Results
            </span>
            <h2 className="font-display text-[30px] font-bold tracking-[-0.025em]">{heading}</h2>
          </div>

          <SortSelect sort={parsed.sort} />
        </div>

        <FilterChips
          environment={parsed.environment}
          maxPriceCentavos={parsed.maxPriceCentavos}
          amenities={parsed.amenities}
        />

        <ResultsGrid branches={results} />
      </main>

      <Footer />
    </CardHoverProvider>
  )
}
