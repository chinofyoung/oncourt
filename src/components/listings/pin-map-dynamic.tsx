'use client'

import dynamic from 'next/dynamic'

/**
 * `PinMap` touches `window` at module scope (via `leaflet`), so it cannot be
 * imported directly by anything that renders on the server. Same mechanism,
 * same shape as src/components/branch/branch-map-dynamic.tsx: dynamic-import
 * with `ssr: false` from a small client module and render that instead.
 *
 * The loading fallback is the same height as the map so nothing jumps when
 * the client bundle arrives.
 */
export const PinMap = dynamic(() => import('./pin-map').then((m) => m.PinMap), {
  ssr: false,
  loading: () => <div className="h-[240px] w-full rounded-[10px] bg-[var(--band-off)]" />,
})
