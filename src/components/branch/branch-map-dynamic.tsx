'use client'

import dynamic from 'next/dynamic'

/**
 * `BranchMap` touches `window` at module scope (via `leaflet`), and
 * `src/app/venues/[slug]/page.tsx` that renders it is a Server Component —
 * so it can't import `BranchMap` directly. Same reasoning, same pattern as
 * `SearchMap`'s dynamic import in
 * `src/components/search/map-hero.tsx`: dynamic-import with
 * `ssr: false` from a small client module, and render that here instead.
 *
 * The loading fallback matches the flat `--band-off` block page.tsx renders
 * in the map column of the identity/About band whenever coordinates are
 * missing, so there's no layout flash while the client bundle loads.
 * `h-full w-full` (not a fixed pixel height) so the fallback fills the same
 * `h-full max-[980px]:aspect-square` wrapper the real map does — stretched
 * to match the identity/About column at `>=980px`, square below it (see
 * branch-map.tsx's comment for the full mechanism) — a fixed-height flash
 * swapping to a full-height map would itself be a layout jump.
 */
export const BranchMap = dynamic(() => import('./branch-map').then((m) => m.BranchMap), {
  ssr: false,
  loading: () => <div className="h-full w-full rounded-[10px] bg-[var(--band-off)]" />,
})
