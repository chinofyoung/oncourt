import type L from 'leaflet'

/**
 * design/branding.md, "Maps" — shared primitives for every Leaflet map in
 * this codebase (currently `SearchMap` and `BranchMap`). Single source of
 * truth for the CARTO tile layer, the inline SVG duotone filter, and the
 * CSS rule that applies it, so the two consumers can never silently drift
 * apart the way this project has already been bitten three times by exactly
 * that kind of duplication (see this project's shared `syncActiveClass`
 * helper in `search-map.tsx` and `approvedPricedCourtsCte()` in
 * `src/lib/branches/queries.ts` for the same pattern elsewhere).
 *
 * Every value below is transcribed verbatim from branding.md's "Maps"
 * entry, which was written to be reproducible from the doc alone.
 *
 * The two-tone look comes from an inline SVG duotone filter applied to
 * `.leaflet-tile-pane`: a `feColorMatrix` reduces the tile image to
 * luminance, feeding a `feComponentTransfer` whose per-channel lookup
 * tables remap that luminance into two brand tones (dark tile values ->
 * --court-deep, light tile values -> --band-off).
 *
 * Markers live in Leaflet's marker pane, a SIBLING of the tile pane, so the
 * filter never touches them — they stay untinted. That is the whole reason
 * this is a pane-scoped filter and not a container-level overlay.
 *
 * WARNING (from branding.md): container-level blend-mode overlays do NOT
 * work with Leaflet — `.leaflet-map-pane` sits at z-index 400 on the map
 * container, so any overlay is either fully below the map or fully above
 * the markers and can never tint just the tiles. Do not "simplify" this
 * into an overlay.
 *
 * Every consumer MUST apply `MAP_SCOPE_CLASS` to its Leaflet container so
 * `MAP_DUOTONE_STYLE`'s `.leaflet-tile-pane` rule is scoped to that
 * instance's tile pane only — it must never leak onto some other Leaflet
 * instance that might be mounted elsewhere on the same page.
 */

export const MAP_TILE_URL = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'

/** Adds the CARTO Positron ("light_all") tile layer to `map` and returns it. */
export function addDuotoneTileLayer(map: L.Map, leaflet: typeof L): L.TileLayer {
  return leaflet
    .tileLayer(MAP_TILE_URL, {
      subdomains: 'abcd',
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    })
    .addTo(map)
}

/** Scoping class every Leaflet container must carry — see module comment. */
export const MAP_SCOPE_CLASS = 'oncourt-map'

/** The exact pane-scoped filter rule from branding.md's "Maps" entry. */
export const MAP_DUOTONE_STYLE = `.${MAP_SCOPE_CLASS} .leaflet-tile-pane { filter: url(#duotone) contrast(1.06); }`

/**
 * Inline SVG `<defs>` for the `#duotone` filter referenced by
 * `MAP_DUOTONE_STYLE` above. Exact tableValues, transcribed from
 * branding.md: feFuncR `0.078 0.918`, feFuncG `0.239 0.949`, feFuncB
 * `0.173 0.894`.
 */
export function DuotoneFilterDefs() {
  return (
    <svg width="0" height="0" aria-hidden style={{ position: 'absolute' }}>
      <filter id="duotone" colorInterpolationFilters="sRGB">
        <feColorMatrix
          type="matrix"
          values="
            .2126 .7152 .0722 0 0
            .2126 .7152 .0722 0 0
            .2126 .7152 .0722 0 0
            0 0 0 1 0"
        />
        <feComponentTransfer>
          <feFuncR type="table" tableValues="0.078 0.918" />
          <feFuncG type="table" tableValues="0.239 0.949" />
          <feFuncB type="table" tableValues="0.173 0.894" />
        </feComponentTransfer>
      </filter>
    </svg>
  )
}
