'use client'

import Link from 'next/link'
import type { BranchSummary } from '@/lib/branches/queries'
import { BranchCard } from '@/components/ui/branch-card'
import { useCardHover } from './hover-context'

/**
 * search-results.html's `.card-grid`: three columns at 22px gaps, two below
 * 1100px, one below 700px. `'use client'` only so the cards can pair their
 * hover with the hero map's price pins through `useCardHover`.
 */
export function ResultsGrid({ branches }: { branches: BranchSummary[] }) {
  const { activeId, setActiveId } = useCardHover()

  if (branches.length === 0) {
    return (
      <div className="rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-14 text-center">
        <p className="font-display text-lg font-bold tracking-[-0.015em]">No courts here yet.</p>
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
    )
  }

  return (
    <div className="grid grid-cols-3 gap-[22px] max-[1100px]:grid-cols-2 max-[700px]:grid-cols-1">
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
  )
}
