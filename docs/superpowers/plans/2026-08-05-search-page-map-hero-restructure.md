# Search Page Map-Hero Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Do NOT create a git worktree or a new branch for this plan — work directly in the main
> working directory on the current branch.** This overrides this skill's usual worktree setup
> step; the user's global CLAUDE.md forbids worktrees for this project.

**Goal:** Restructure `/search` to match the full-bleed map-hero composition in
`design/mockups/search-results.html`, replacing the current side-by-side
results-grid/sticky-map layout. Layout/structure only — no change to any data query, URL param
semantics, or search behavior.

**Architecture:** `src/app/search/page.tsx` stays a Server Component. It renders `<Nav
variant="solid" />` (untouched), then a `HoverProvider` client context wrapping a full-bleed
`MapHero` (client) and `<main>` (mostly server-rendered: section head, `FilterChips`,
`ResultsGrid`). `MapHero` and `ResultsGrid` both consume `HoverContext` for the
hovered-card/pin pairing instead of one giant client component owning both, since they now
live in separate regions of the page. `filter-bar.tsx`'s three logical pieces (search-float
fields, sort select, filter chips) become three small client components, all sharing one
`useSearchNav()` hook so the URL-writing semantics (`setParam`'s empty-string-deletes-param
rule, choosing a city clearing `lat`/`lng`) can't drift apart across files. `filter-bar.tsx`
and `search-results.tsx` are deleted once superseded.

**Tech Stack:** Next.js (App Router, TS), Tailwind v4 utility classes with this codebase's CSS
custom properties (`var(--ink)`, `var(--btn-h-sm)`, etc.), Leaflet (via the existing
`search-map.tsx`, untouched apart from one className edit).

**Spec:** `design/mockups/search-results.html` (target layout) + `design/branding.md` (tokens,
source of truth for any conflict with the mockup).

## Global Constraints

- **Read `design/branding.md` before touching any styling.** Solid colors only, no gradients/
  glows. Cards `border-radius: 20px`. Buttons/controls: `--control-h` 56px, `--btn-h` 48px,
  `--btn-h-sm` 38px, `--btn-radius` 12px (ONE radius for every button and input field — pill
  shape `999px` is reserved for **non-interactive** chips/badges only). Mono font for times,
  prices, uppercase kickers. **All user-facing copy is English only** — no Taglish.
- **Full-bleed padding formula**, used verbatim everywhere a section needs the 1120px content
  column: `px-[max(24px,calc((100vw-1120px)/2))]` (or `left-[max(24px,calc((100vw-1120px)/2))]`
  for absolutely-positioned overlays at the same left edge). Do not introduce a different
  formula or a hardcoded pixel value anywhere this appears in the mockup.
- **No new CSS files, no inline `<style>`** except the one already inside `search-map.tsx`
  (leave that one exactly as-is). Tailwind v4 utility classes + existing CSS custom properties
  only, matching the styling idiom already used in `filter-bar.tsx` / `search-map.tsx` /
  `branch-card.tsx` / `src/app/page.tsx`.
- **Keep filter toggles/chips at `--btn-radius` (12px), NOT the mockup's 999px pills.** The
  mockup's `.filter-chip` is a 999px pill; branding.md reserves that shape for non-interactive
  chips/badges, and these are interactive buttons/selects that write to the URL. Note this
  deliberate mockup deviation in a code comment at the point it applies.
- **No lime (`--ball`) button on this page.** The mockup's lime "Update search" button exists
  because its search-float fields are static display text with nothing to submit; every field
  here is a live control that already writes to the URL on change, so there is nothing to
  submit and no button replaces it. "Use my location" keeps its current light-bordered
  treatment (border + `--panel` bg + `--ink` text), just resized to `--control-h` height so it
  sits flush inside the float.
- **Accessibility — preserve exactly, do not regress:**
  - The `aria-live="polite" aria-atomic="true"` wrapper around the result count must remain a
    **stable node** (no `key`, not inside a conditional) so a `router.push` re-render updates
    the text in place instead of unmounting/remounting the live region. It now wraps the `<h2>`
    in the section head (the count moved into the h2's text — see Task 4).
  - Keep every `sr-only` label, `aria-pressed`, and `role="group"` + `aria-label` from the
    current `filter-bar.tsx` on every control that keeps its current visual treatment (sort
    select, environment toggles, max-price select, amenity toggles).
  - Exception, by design: the search-float's three fields (Where/Date/Time) get a **visible**
    mono uppercase label above each control (matching the mockup's `.sf-label`), replacing their
    old `sr-only` label. This is a strict accessibility improvement (a visible, programmatically
    associated label beats an invisible one) — not a regression, and not something to flag.
  - Keep `motion-reduce:` guards on every transition that has one today.
- **Stacking order:** the mockup gives `.search-float` `z-index: 950` so it can float above its
  own sticky nav (z-60) while scrolling. Do NOT copy that value. Instead: the absolutely
  positioned map wrapper inside `MapHero` gets `z-0` (forming a stacking context that contains
  Leaflet's own internal panes — tile/marker/popup panes — so they can never escape it), and
  the search-float + hero-note get `z-10` (enough to sit above the map, without outranking
  `<Nav>`). Add a short code comment at the map wrapper explaining why 950 wasn't copied.
- **Responsive, mockup's own media queries — the page must never scroll sideways at any width:**
  - `≤980px`: hero → `height: auto`, flex column; map → static/relative `320px` block;
    search-float → `position: static`, `margin: 16px <left-offset> 0`, `--shadow-sm`,
    `flex-wrap: wrap` with row-gap, fields `flex: 1 1 auto` (unchanged height/padding); hero-note
    → static, `margin: 12px <left-offset> 0`, `width: fit-content`. Nav's center links already
    hide below 980px — no change needed there.
  - `≤560px`: drop the search-float fields' `border-left` divider.
  - `≤1100px`: card grid → 2 columns. `≤700px`: card grid → 1 column.
- **Do not touch** `src/lib/branches/queries.ts`, `src/lib/search/params.ts`,
  `src/components/site/nav.tsx`, `src/components/site/footer.tsx`, or anything under
  `supabase/`.
- **`search-map.tsx`**: the ONLY change permitted is removing `rounded-[20px] overflow-hidden`
  from its own root container's className (the hero now owns radius/overflow). Do not touch its
  effects, `invalidateSize()` calls, `fitBounds`, `syncActiveClass`, or any of its deps-array
  comments — they document real, previously-fixed bugs.
- **Verification, every task:** `npx tsc --noEmit` and `npx eslint <touched files>` must be
  clean (or unchanged from pre-existing warnings — note any pre-existing issue you did not
  introduce). `npm run test` is DB-backed and unrelated to this plan — skip it.
- **Do not run any state-changing git command** (no add/commit/branch/stash/checkout) unless a
  task step explicitly says to commit. Read-only `git status`/`diff` is fine.
- **Do not create git worktrees.**
- **Commit after every task**, with the exact `git add` paths given in that task's final step.

---

### Task 1: Shared client infrastructure — hover context + URL-param hook

**Files:**
- Create: `src/components/search/hover-context.tsx`
- Create: `src/components/search/use-search-nav.ts`

**Why first:** every other new component in this plan (Tasks 2–4) imports one or both of these.

**Interfaces produced:**
- `HoverProvider({ children })` — client component, wraps a subtree in `HoverContext`.
- `useHover(): { activeId: string | null; setActiveId: (id: string | null) => void }` — throws
  if called outside a `HoverProvider`.
- `useSearchNav(): { setParam: (key: string, value: string | null) => void; setCity: (value:
  string) => void; useMyLocation: () => void }` — client hook wrapping `useRouter`/`usePathname`/
  `useSearchParams`.

- [ ] **Step 1: Create `src/components/search/hover-context.tsx`**

  ```tsx
  'use client'

  import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

  /**
   * The single piece of genuinely client-side state on the /search page: which
   * card/pin is hovered. Everything else — filters, results, ordering — is
   * server-rendered from the URL by src/app/search/page.tsx.
   *
   * Previously this lived as a plain useState inside search-results.tsx, which
   * owned both the map column and the card grid in one client component. The
   * map-hero layout splits those into separate regions of the page (a
   * full-bleed map hero above <main>, a card grid inside it), so the shared
   * state moves up into a context that MapHero and ResultsGrid can each
   * independently subscribe to — without collapsing the whole page into one
   * giant client component.
   */
  type HoverContextValue = {
    activeId: string | null
    setActiveId: (id: string | null) => void
  }

  const HoverContext = createContext<HoverContextValue | null>(null)

  export function HoverProvider({ children }: { children: ReactNode }) {
    const [activeId, setActiveId] = useState<string | null>(null)
    const value = useMemo(() => ({ activeId, setActiveId }), [activeId])
    return <HoverContext.Provider value={value}>{children}</HoverContext.Provider>
  }

  export function useHover(): HoverContextValue {
    const ctx = useContext(HoverContext)
    if (!ctx) {
      throw new Error('useHover must be used within a HoverProvider')
    }
    return ctx
  }
  ```

- [ ] **Step 2: Create `src/components/search/use-search-nav.ts`**

  ```ts
  'use client'

  import { usePathname, useRouter, useSearchParams } from 'next/navigation'

  /**
   * Single source of truth for how every search-page control writes to the
   * URL. The URL (via useSearchParams) is the only state these controls own —
   * every control's value/defaultValue reads from props (derived server-side
   * from the URL on the last render), which is what makes browser
   * back/forward work correctly.
   *
   * Shared by SearchFloat, SortSelect, and FilterChips — previously all three
   * lived in one file (filter-bar.tsx) sharing one closure over
   * router/pathname/searchParams. Splitting them into separate components
   * without factoring this out would risk each one re-implementing (and
   * silently drifting from) these two semantics:
   *
   * - setParam treats an empty string the same as null (delete the param)
   *   everywhere, on purpose — this is the client-side twin of the hour=""
   *   fix in src/lib/search/params.ts's parser: it guarantees these
   *   components can never themselves re-introduce a `?hour=` (or any other)
   *   empty-value param into the URL.
   * - Choosing a city explicitly takes precedence over a previously-set
   *   geolocation — setCity clears lat/lng in the same navigation, otherwise
   *   they'd silently keep overriding the newly picked city.
   */
  export function useSearchNav() {
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()

    const setParam = (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString())
      if (value === null || value === '') {
        next.delete(key)
      } else {
        next.set(key, value)
      }
      router.push(`${pathname}?${next.toString()}`)
    }

    const setCity = (value: string) => {
      const next = new URLSearchParams(searchParams.toString())
      next.set('city', value)
      next.delete('lat')
      next.delete('lng')
      router.push(`${pathname}?${next.toString()}`)
    }

    const useMyLocation = () => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const next = new URLSearchParams(searchParams.toString())
          next.set('lat', position.coords.latitude.toFixed(5))
          next.set('lng', position.coords.longitude.toFixed(5))
          next.delete('city')
          router.push(`${pathname}?${next.toString()}`)
        },
        // Permission denied is a no-op: the city picker stays in charge and
        // the page never depends on geolocation.
        () => {},
      )
    }

    return { setParam, setCity, useMyLocation }
  }
  ```

- [ ] **Step 3: Verify**

  Run `npx tsc --noEmit` and `npx eslint src/components/search/hover-context.tsx
  src/components/search/use-search-nav.ts`. Both files are new and currently unused by anything
  — that's expected at this point in the plan, not an error.

- [ ] **Step 4: Commit**

  `git add src/components/search/hover-context.tsx src/components/search/use-search-nav.ts`

---

### Task 2: Split `filter-bar.tsx` into `SearchFloat` / `SortSelect` / `FilterChips`

**Depends on:** Task 1 (`useSearchNav`).

**Files:**
- Create: `src/components/search/search-float.tsx`
- Create: `src/components/search/sort-select.tsx`
- Create: `src/components/search/filter-chips.tsx`
- Edit: `src/components/search/search-map.tsx` (one className change)
- Delete: `src/components/search/filter-bar.tsx`

**Before deleting `filter-bar.tsx`:** confirm nothing outside `src/app/search/page.tsx` imports
it — `grep -rn "from '@/components/search/filter-bar'\|from '\./filter-bar'" src` should return
only `src/app/search/page.tsx` (which Task 4 rewrites; until then it's fine for the import to be
briefly stale — Task 4 removes it in the same plan).

- [ ] **Step 1: Create `src/components/search/search-float.tsx`**

  ```tsx
  'use client'

  import { CITIES } from '@/lib/geo/cities'
  import { manilaToday } from '@/lib/date-manila'
  import { formatHour } from '@/lib/format'
  import { useSearchNav } from './use-search-nav'

  /** Valid start hours for a 1-hour slot (mirrors home.html's hero form). */
  const HOUR_OPTIONS = Array.from({ length: 17 }, (_, i) => i + 7)

  /**
   * The "float-card field pattern" from src/app/page.tsx's home hero (a mono
   * label above a bare, transparent control, dividers between fields) — same
   * idea here, light-panel colors instead of the hero's on-photo white/glass
   * ones. Ported into design/mockups/search-results.html's `.search-float`,
   * but every field here is a LIVE control (not the mockup's static `.sf-val`
   * text) because these write straight to the URL — see MapHero's header
   * comment for why there is no "Update search" submit button to match.
   *
   * Visible mono labels (not sr-only) replace FilterBar's old sr-only labels
   * for these three fields specifically, matching the mockup's `.sf-label` —
   * a strict accessibility improvement (a visible, associated label beats an
   * invisible one), not a regression. Every other control ported from
   * FilterBar (sort, environment toggles, max price, amenities — see
   * SortSelect/FilterChips) keeps its original sr-only-label/aria-pressed/
   * role="group" treatment unchanged.
   */
  export function SearchFloat({
    citySlug,
    date,
    hour,
    usingCoords,
  }: {
    citySlug: string
    date: string
    hour: number | undefined
    usingCoords: boolean
  }) {
    const { setParam, setCity, useMyLocation } = useSearchNav()

    const fieldClass = 'flex h-[var(--control-h)] flex-none flex-col justify-center px-4 max-[980px]:flex-auto'
    const dividerClass = 'border-l border-[var(--hairline)] max-[560px]:border-l-0'
    const labelClass = 'font-mono text-[10px] tracking-[.14em] text-[var(--ink-soft)] uppercase'
    const valueClass = 'bg-transparent text-[14.5px] font-semibold text-[var(--ink)] outline-none'

    return (
      <div className="absolute bottom-6 left-[max(24px,calc((100vw-1120px)/2))] z-10 flex items-stretch gap-1 rounded-[20px] bg-[var(--panel)] p-4 shadow-[var(--shadow-lg)] max-[980px]:static max-[980px]:mx-[max(24px,calc((100vw-1120px)/2))] max-[980px]:mt-4 max-[980px]:mb-0 max-[980px]:flex-wrap max-[980px]:gap-y-2.5 max-[980px]:shadow-[var(--shadow-sm)]">
        <div className={fieldClass}>
          <label className={labelClass} htmlFor="filter-city">
            Where
          </label>
          <select
            id="filter-city"
            value={usingCoords ? '' : citySlug}
            onChange={(e) => setCity(e.target.value)}
            className={valueClass}
          >
            {usingCoords && <option value="">Near me</option>}
            {CITIES.map((city) => (
              <option key={city.slug} value={city.slug}>
                {city.name}
              </option>
            ))}
          </select>
        </div>

        <div className={`${fieldClass} ${dividerClass}`}>
          <label className={labelClass} htmlFor="filter-date">
            Date
          </label>
          <input
            id="filter-date"
            type="date"
            value={date}
            min={manilaToday()}
            onChange={(e) => setParam('date', e.target.value)}
            className={valueClass}
          />
        </div>

        <div className={`${fieldClass} ${dividerClass}`}>
          <label className={labelClass} htmlFor="filter-hour">
            Time
          </label>
          <select
            id="filter-hour"
            value={hour ?? ''}
            onChange={(e) => setParam('hour', e.target.value)}
            className={valueClass}
          >
            <option value="">Any time</option>
            {HOUR_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {formatHour(h)}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={useMyLocation}
          className="ml-2 inline-flex h-[var(--control-h)] flex-none items-center whitespace-nowrap rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-4 text-[13.5px] font-semibold text-[var(--ink)] transition-colors hover:border-[var(--court)] motion-reduce:transition-none"
        >
          Use my location
        </button>
      </div>
    )
  }
  ```

- [ ] **Step 2: Create `src/components/search/sort-select.tsx`**

  ```tsx
  'use client'

  import { useSearchNav } from './use-search-nav'

  /**
   * Ported from FilterBar's sort <select> into its own file so it can sit in
   * the section head next to the result-count h2, matching
   * design/mockups/search-results.html's `.sort-btn` position. Still a real
   * <select> (not the mockup's plain button+chevron) since a native select is
   * what actually offers the three sort options; styled to match .sort-btn's
   * proportions and colors.
   */
  export function SortSelect({ sort }: { sort: 'distance' | 'price' | 'rating' }) {
    const { setParam } = useSearchNav()

    return (
      <>
        <label className="sr-only" htmlFor="filter-sort">
          Sort
        </label>
        <select
          id="filter-sort"
          value={sort}
          onChange={(e) => setParam('sort', e.target.value)}
          className="h-[var(--btn-h-sm)] shrink-0 rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-4 text-[13.5px] font-semibold text-[var(--ink-soft)] outline-none transition-colors hover:border-[var(--court)] hover:text-[var(--ink)] motion-reduce:transition-none"
        >
          <option value="distance">Sort: Distance</option>
          <option value="price">Sort: Price</option>
          <option value="rating">Sort: Rating</option>
        </select>
      </>
    )
  }
  ```

- [ ] **Step 3: Create `src/components/search/filter-chips.tsx`**

  ```tsx
  'use client'

  import { formatPeso } from '@/lib/format'
  import { AMENITY_LABELS, AMENITY_SLUGS } from '@/components/ui/amenity-chip'
  import { useSearchNav } from './use-search-nav'

  /**
   * Same vocabulary as AMENITY_VOCAB in src/lib/search/params.ts — both import
   * AMENITY_SLUGS from amenity-chip.tsx, the single source of truth, so the
   * server-side enforcement list and this client-side display order can't
   * drift apart.
   */
  const AMENITIES = AMENITY_SLUGS

  const MAX_PRICE_OPTIONS = [20_000, 30_000, 50_000]

  const selectClass =
    'h-[var(--btn-h-sm)] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-3 text-[13.5px] font-medium text-[var(--ink)] outline-none transition-colors focus:border-[var(--court)] motion-reduce:transition-none'

  const toggleBase =
    'h-[var(--btn-h-sm)] inline-flex items-center rounded-[var(--btn-radius)] border px-4 text-[13.5px] font-semibold whitespace-nowrap transition-colors motion-reduce:transition-none'
  const toggleActive = 'border-[var(--ink)] bg-[var(--ink)] text-white'
  const toggleInactive =
    'border-[var(--hairline)] bg-[var(--panel)] text-[var(--ink-soft)] hover:border-[var(--court)] hover:text-[var(--ink)]'

  /**
   * design/mockups/search-results.html's `.chip-row` renders these as 999px
   * pills (`.filter-chip`). Deliberately NOT copied: branding.md's Controls
   * rule reserves 999px pills for non-interactive chips/badges, and these are
   * interactive buttons/selects that change the URL — so they keep
   * FilterBar's original --btn-radius (12px), same as every other button on
   * this page.
   */
  export function FilterChips({
    environment,
    maxPriceCentavos,
    amenities,
  }: {
    environment: 'indoor' | 'outdoor' | undefined
    maxPriceCentavos: number | undefined
    amenities: string[]
  }) {
    const { setParam } = useSearchNav()

    const toggleEnvironment = (env: 'indoor' | 'outdoor') => {
      setParam('env', environment === env ? null : env)
    }

    const toggleAmenity = (amenity: string) => {
      const set = new Set(amenities)
      if (set.has(amenity)) {
        set.delete(amenity)
      } else {
        set.add(amenity)
      }
      setParam('amenities', Array.from(set).join(',') || null)
    }

    return (
      <div className="mb-7 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Environment" className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => toggleEnvironment('indoor')}
            aria-pressed={environment === 'indoor'}
            className={`${toggleBase} ${environment === 'indoor' ? toggleActive : toggleInactive}`}
          >
            Indoor
          </button>
          <button
            type="button"
            onClick={() => toggleEnvironment('outdoor')}
            aria-pressed={environment === 'outdoor'}
            className={`${toggleBase} ${environment === 'outdoor' ? toggleActive : toggleInactive}`}
          >
            Outdoor
          </button>
        </div>

        <label className="sr-only" htmlFor="filter-max-price">
          Max price
        </label>
        <select
          id="filter-max-price"
          value={maxPriceCentavos ?? ''}
          onChange={(e) => setParam('max', e.target.value)}
          className={selectClass}
        >
          <option value="">Any price</option>
          {MAX_PRICE_OPTIONS.map((centavos) => (
            <option key={centavos} value={centavos}>
              ≤ {formatPeso(centavos)}/hr
            </option>
          ))}
        </select>

        <span aria-hidden className="mx-1 h-5 w-px bg-[var(--hairline)]" />

        <div role="group" aria-label="Amenities" className="flex flex-wrap items-center gap-2">
          {AMENITIES.map((amenity) => (
            <button
              key={amenity}
              type="button"
              onClick={() => toggleAmenity(amenity)}
              aria-pressed={amenities.includes(amenity)}
              className={`${toggleBase} ${amenities.includes(amenity) ? toggleActive : toggleInactive}`}
            >
              {AMENITY_LABELS[amenity] ?? amenity}
            </button>
          ))}
        </div>
      </div>
    )
  }
  ```

- [ ] **Step 4: Edit `src/components/search/search-map.tsx`**

  In the returned JSX (near the end of the file), find the root `<div>`'s className:

  ```tsx
  className={`${MAP_SCOPE_CLASS} oncourt-search-map h-full w-full rounded-[20px] overflow-hidden`}
  ```

  Change it to drop the radius/overflow (the map-hero parent now owns square corners and
  clipping):

  ```tsx
  className={`${MAP_SCOPE_CLASS} oncourt-search-map h-full w-full`}
  ```

  This is the ONLY change to this file. Leave every effect, ref, comment, and the `<style>`
  block untouched.

- [ ] **Step 5: Delete `src/components/search/filter-bar.tsx`**

  After confirming (per the grep above) that only `page.tsx` imports it.

- [ ] **Step 6: Verify**

  `npx tsc --noEmit` will show `src/app/search/page.tsx` still importing the now-deleted
  `FilterBar` — that's expected until Task 4 rewrites it; note it in your report rather than
  working around it. Run `npx eslint` on the files this task touched/added
  (`search-float.tsx`, `sort-select.tsx`, `filter-chips.tsx`, `search-map.tsx`) and confirm no
  new errors on those specific files.

- [ ] **Step 7: Commit**

  `git add src/components/search/search-float.tsx src/components/search/sort-select.tsx src/components/search/filter-chips.tsx src/components/search/search-map.tsx` and record the deletion (`git add -u src/components/search/filter-bar.tsx` or equivalent for the removed file).

---

### Task 3: Build `MapHero` and `ResultsGrid`

**Depends on:** Task 1 (`HoverProvider`/`useHover`), Task 2 (`SearchFloat`).

**Files:**
- Create: `src/components/search/map-hero.tsx`
- Create: `src/components/search/results-grid.tsx`
- Delete: `src/components/search/search-results.tsx`

**Before deleting `search-results.tsx`:** confirm (`grep -rn "from '@/components/search/search-results'\|from '\./search-results'" src`) that only `page.tsx` imports it — same situation as Task 2, fine to leave that one import stale until Task 4.

- [ ] **Step 1: Create `src/components/search/results-grid.tsx`**

  ```tsx
  'use client'

  import Link from 'next/link'
  import type { BranchSummary } from '@/lib/branches/queries'
  import { BranchCard } from '@/components/ui/branch-card'
  import { useHover } from './hover-context'

  /**
   * Card grid + empty state, split out of the old search-results.tsx (which
   * also owned the map column before the map-hero layout moved the map above
   * <main> into MapHero). Both components now read/write the same hover
   * state through HoverContext instead of a shared useState the parent owned
   * directly.
   */
  export function ResultsGrid({ branches }: { branches: BranchSummary[] }) {
    const { activeId, setActiveId } = useHover()

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
  ```

  Note the empty-state headline: `No courts here yet.` — plain English, replacing the old
  `"Walang court dito, pare."`, which violated branding.md's English-only copy rule.

- [ ] **Step 2: Create `src/components/search/map-hero.tsx`**

  ```tsx
  'use client'

  import dynamic from 'next/dynamic'
  import { useHover } from './hover-context'
  import { SearchFloat } from './search-float'
  import type { MapPin } from './search-map'

  /**
   * Full-bleed map hero, ported from design/mockups/search-results.html's
   * `.map-hero` — replacing the side-by-side results-grid/sticky-map layout
   * page.tsx used before. The map is dynamically imported with ssr: false
   * because Leaflet touches `window` at module scope and would crash the
   * server render; the loading fallback fills the same footprint so the hero
   * doesn't jump when the real map mounts.
   */
  const SearchMap = dynamic(() => import('./search-map').then((m) => m.SearchMap), {
    ssr: false,
    loading: () => <div className="h-full w-full bg-[var(--band-off)]" />,
  })

  export function MapHero(props: {
    pins: MapPin[]
    heroNote: string
    citySlug: string
    date: string
    hour: number | undefined
    usingCoords: boolean
  }) {
    const { activeId, setActiveId } = useHover()

    return (
      <section
        aria-label="Map of courts near you"
        className="relative h-[460px] overflow-hidden max-[980px]:flex max-[980px]:h-auto max-[980px]:flex-col max-[980px]:overflow-visible"
      >
        {/*
          The mockup gives .search-float z-index: 950 — high enough to float
          over its own sticky nav (z-index: 60) while scrolling. Copying that
          here would let the float sit above <Nav>, which must stay on top of
          everything. Instead: this map wrapper gets z-0, forming a stacking
          context that contains Leaflet's own internal panes (tile/marker/
          popup panes, z-200 through z-700 — all relative to THIS wrapper, so
          they can never escape it) — and the float/hero-note below get z-10,
          just enough to sit above the map without needing to outrank the nav.
        */}
        <div className="absolute inset-0 z-0 max-[980px]:relative max-[980px]:h-[320px]">
          <SearchMap pins={props.pins} activeId={activeId} onActiveChange={setActiveId} />
        </div>

        <div className="absolute top-4 left-[max(24px,calc((100vw-1120px)/2))] z-10 rounded-full bg-[var(--panel)] px-3.5 py-2 font-mono text-[12.5px] text-[var(--ink-soft)] shadow-[var(--shadow-sm)] max-[980px]:static max-[980px]:mt-3 max-[980px]:ml-[max(24px,calc((100vw-1120px)/2))] max-[980px]:w-fit">
          {props.heroNote}
        </div>

        <SearchFloat
          citySlug={props.citySlug}
          date={props.date}
          hour={props.hour}
          usingCoords={props.usingCoords}
        />
      </section>
    )
  }
  ```

- [ ] **Step 3: Delete `src/components/search/search-results.tsx`**

- [ ] **Step 4: Verify**

  `npx tsc --noEmit` will still show `page.tsx` importing the now-deleted `SearchResults` —
  expected until Task 4. Run `npx eslint` on `map-hero.tsx` and `results-grid.tsx` specifically
  and confirm no new errors on those files.

- [ ] **Step 5: Commit**

  `git add src/components/search/map-hero.tsx src/components/search/results-grid.tsx` and
  record the deletion of `search-results.tsx`.

---

### Task 4: Rewrite `src/app/search/page.tsx`

**Depends on:** Tasks 1–3 (every new component this file imports).

**Files:**
- Edit: `src/app/search/page.tsx`

- [ ] **Step 1: Replace the file's contents**

  ```tsx
  import { Nav } from '@/components/site/nav'
  import { Footer } from '@/components/site/footer'
  import { HoverProvider } from '@/components/search/hover-context'
  import { MapHero } from '@/components/search/map-hero'
  import { SortSelect } from '@/components/search/sort-select'
  import { FilterChips } from '@/components/search/filter-chips'
  import { ResultsGrid } from '@/components/search/results-grid'
  import { searchBranches } from '@/lib/branches/queries'
  import { parseSearchParams } from '@/lib/search/params'
  import { cityBySlug } from '@/lib/geo/cities'
  import { formatDateLabel, formatHour } from '@/lib/format'

  /**
   * Ported from design/mockups/search-results.html's full-bleed `.map-hero` +
   * results section. This page used to deliberately deviate from that mockup
   * with a side-by-side results-grid/sticky-map layout (see git history for
   * the previous version of this comment) — that layout is now replaced with
   * the mockup's composition: a full-bleed Leaflet map hero above <main>,
   * overlaid with a live search float and a date/time summary pill, followed
   * by a section head (kicker + result count + sort), a filter chip row, and
   * the card grid.
   *
   * `MapHero` (src/components/search/map-hero.tsx) and `ResultsGrid`
   * (src/components/search/results-grid.tsx) share the hovered-card/pin id
   * through HoverContext (src/components/search/hover-context.tsx) instead of
   * both living in one client component, since they're now in separate
   * regions of the page — this file itself stays a Server Component.
   */
  export default async function SearchPage(props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>
  }) {
    const parsed = parseSearchParams(await props.searchParams)
    const results = await searchBranches(parsed.filters)

    const pins = results
      .filter((b) => b.lat !== null && b.lng !== null)
      .map((b) => ({
        id: b.id,
        name: b.name,
        slug: b.slug,
        lat: b.lat!,
        lng: b.lng!,
        priceCentavos: b.minPriceCentavos,
      }))

    const heroNote = `${formatDateLabel(parsed.date)} · ${
      parsed.hour !== undefined ? formatHour(parsed.hour) : 'Any time'
    }`

    const count = results.length
    const countLabel = count === 1 ? 'court' : 'courts'
    const locationLabel = parsed.usingCoords ? 'near you' : `in ${cityBySlug(parsed.citySlug).name}`

    return (
      <>
        <Nav variant="solid" />

        <HoverProvider>
          <MapHero
            pins={pins}
            heroNote={heroNote}
            citySlug={parsed.citySlug}
            date={parsed.date}
            hour={parsed.hour}
            usingCoords={parsed.usingCoords}
          />

          <main className="px-[max(24px,calc((100vw-1120px)/2))] pt-8 pb-[72px]">
            <div className="mb-5 flex items-baseline gap-4">
              <div className="flex-1">
                <span className="font-mono mb-2 block text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
                  Results
                </span>
                {/* `router.push` from these controls is a client-side RSC
                    re-render, not a full page load, so this text updates
                    silently for a screen-reader user unless announced
                    explicitly. This wrapper is a stable node — no `key`, not
                    inside any conditional — so React updates the text in
                    place instead of unmounting/remounting the live region (an
                    unmount/remount may not get announced by screen readers).
                    `aria-atomic` re-reads the whole phrase instead of just the
                    changed digit. */}
                <div aria-live="polite" aria-atomic="true">
                  <h2 className="font-display text-[30px] font-bold tracking-[-0.025em]">
                    {count} {countLabel} {locationLabel}
                  </h2>
                </div>
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
        </HoverProvider>

        <Footer />
      </>
    )
  }
  ```

- [ ] **Step 2: Verify**

  Run, and paste real output for:
  - `npx tsc --noEmit`
  - `npm run lint`

  Both must be clean. If either surfaces an error, fix it before reporting DONE — do not report
  DONE with a known type or lint error in a file this plan touched.

- [ ] **Step 3: Manual sanity pass**

  Confirm by reading the diff (not by running the dev server, unless you want to spot-check
  visually — not required): the h2 text is singular for 1 result ("1 court near you" / "1 court
  in <city>"), plural otherwise; the aria-live wrapper has no `key` and isn't inside a
  conditional; `FilterBar`/`SearchResults` are no longer imported anywhere.

- [ ] **Step 4: Commit**

  `git add src/app/search/page.tsx`

---

## Deviations to flag, not fix

While implementing, you may notice `src/components/site/nav.tsx`'s `solid` variant is not
actually `position: sticky` or `z-60` in the current codebase (only the mockup's `.nav` is). The
brief this plan is based on described it as already sticky/z-60. **Do not modify `nav.tsx`** —
it's explicitly out of scope for this plan. Note the discrepancy in your task report; it doesn't
change anything about the z-0/z-10 stacking scheme in Task 3, which holds regardless of whether
Nav is sticky.
