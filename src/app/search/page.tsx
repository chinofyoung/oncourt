import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { FilterBar } from '@/components/search/filter-bar'
import { SearchResults } from '@/components/search/search-results'
import { searchBranches } from '@/lib/branches/queries'
import { parseSearchParams } from '@/lib/search/params'

/**
 * Ported from design/mockups/search-results.html's results grid and filter
 * chip row — NOT its `.map-hero` section. That mockup renders a full-bleed
 * Leaflet map above the results as a hero; this page instead uses a
 * side-by-side two-column layout (results list + a sticky map column), owned
 * end-to-end by `<SearchResults>` (`src/components/search/search-results.tsx`)
 * — that component renders both columns, the empty state, and mounts the
 * real Leaflet map (`search-map.tsx`) into the right column. Below 980px the
 * map column is hidden entirely (`max-[980px]:hidden`).
 */
export default async function SearchPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const parsed = parseSearchParams(await props.searchParams)
  const results = await searchBranches(parsed.filters)

  return (
    <>
      <Nav variant="solid" />

      <main className="px-[max(24px,calc((100vw-1120px)/2))] pt-8 pb-[72px]">
        <div className="mb-5">
          <FilterBar {...parsed} />
        </div>

        {/* `router.push` from FilterBar is a client-side RSC re-render, not a
            full page load, so this text updates silently for a screen-reader
            user unless announced explicitly. This wrapper is a stable node —
            no `key`, not inside any conditional — so React updates the text
            in place instead of unmounting/remounting the live region (an
            unmount/remount may not get announced by screen readers).
            `aria-atomic` re-reads the whole phrase instead of just the
            changed digit. */}
        <div aria-live="polite" aria-atomic="true">
          <p className="font-mono mb-4 text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
            {results.length} court {results.length === 1 ? 'venue' : 'venues'}
          </p>
        </div>

        <SearchResults
          branches={results}
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
        />
      </main>

      <Footer />
    </>
  )
}
