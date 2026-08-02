'use client'

import dynamic from 'next/dynamic'

/**
 * `BranchMap` touches `window` at module scope (via `leaflet`), and
 * `src/app/venues/[slug]/page.tsx` that renders it is a Server Component —
 * so it can't import `BranchMap` directly. Same reasoning, same pattern as
 * `SearchMap`'s dynamic import in
 * `src/components/search/search-results.tsx`: dynamic-import with
 * `ssr: false` from a small client module, and render that here instead.
 *
 * The loading fallback matches the flat `--band-off` block this replaces in
 * page.tsx's "Where to find us" section, so there's no layout flash while
 * the client bundle loads.
 */
export const BranchMap = dynamic(() => import('./branch-map').then((m) => m.BranchMap), {
  ssr: false,
  loading: () => <div className="h-[120px] w-full rounded-[10px] bg-[var(--band-off)]" />,
})
