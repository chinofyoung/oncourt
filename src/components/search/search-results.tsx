'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import Link from 'next/link'
import type { BranchSummary } from '@/lib/branches/queries'
import { BranchCard } from '@/components/ui/branch-card'
import type { MapPin } from './search-map'

/**
 * Holds the single piece of genuinely client-side state on this page: which
 * card/pin is hovered. Everything else — filters, results, ordering — is
 * server-rendered from the URL by src/app/search/page.tsx.
 *
 * The map is dynamically imported with ssr: false because Leaflet touches
 * `window` at module scope and would crash the server render.
 */
const SearchMap = dynamic(() => import('./search-map').then((m) => m.SearchMap), {
  ssr: false,
  loading: () => <div className="h-full w-full rounded-[20px] bg-[var(--band-off)]" />,
})

export function SearchResults(props: { branches: BranchSummary[]; pins: MapPin[] }) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const { branches, pins } = props

  return (
    <div className="grid grid-cols-[1fr_400px] gap-8 max-[980px]:grid-cols-1">
      <div>
        {branches.length > 0 ? (
          <div className="grid grid-cols-2 gap-[22px] max-[700px]:grid-cols-1">
            {branches.map((branch) => (
              <BranchCard
                key={branch.id}
                branch={branch}
                showDistance
                active={branch.id === activeId}
                onHoverChange={setActiveId}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-14 text-center">
            <p className="font-display text-lg font-bold tracking-[-0.015em]">
              Walang court dito, pare.
            </p>
            <p className="mt-2 text-sm text-[var(--ink-soft)]">
              No courts match these filters yet. Try widening your search.
            </p>
            <Link
              href="/search"
              className="mt-4 inline-flex text-sm font-semibold text-[var(--court)] hover:text-[var(--court-deep)]"
            >
              Clear filters
            </Link>
          </div>
        )}
      </div>

      <div className="h-[240px] rounded-[20px] border border-[var(--hairline)] bg-[var(--band-off)] max-[980px]:hidden min-[980px]:sticky min-[980px]:top-[84px] min-[980px]:h-[calc(100vh-116px)]">
        <SearchMap pins={pins} activeId={activeId} onActiveChange={setActiveId} />
      </div>
    </div>
  )
}
