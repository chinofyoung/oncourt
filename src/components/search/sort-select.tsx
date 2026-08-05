'use client'

import { useFilterParams } from './filter-controls'

/**
 * search-results.html's `.sort-btn`, in the section head to the right of the
 * results count. A real `<select>` rather than the mockup's button-that-opens-
 * nothing, styled to match it.
 */
export function SortSelect({ sort }: { sort: 'distance' | 'price' | 'rating' }) {
  const { setParam } = useFilterParams()

  return (
    <>
      <label className="sr-only" htmlFor="filter-sort">
        Sort
      </label>
      <select
        id="filter-sort"
        value={sort}
        onChange={(e) => setParam('sort', e.target.value)}
        className="h-[var(--btn-h-sm)] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-4 text-[13.5px] font-semibold whitespace-nowrap text-[var(--ink-soft)] transition-colors hover:border-[var(--court)] hover:text-[var(--ink)] focus:border-[var(--court)] motion-reduce:transition-none"
      >
        <option value="distance">Sort: Distance</option>
        <option value="price">Sort: Price</option>
        <option value="rating">Sort: Rating</option>
      </select>
    </>
  )
}
