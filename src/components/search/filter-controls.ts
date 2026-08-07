'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

/**
 * The single writer of `/search`'s URL, shared by every filter control on the
 * page (the map hero's search float, the sort select, the filter chip row).
 * Those controls used to live in one `FilterBar` component; the mockup's
 * layout splits them across three regions, so this hook is what keeps their
 * param semantics from drifting apart.
 *
 * Nothing here holds result state or fetches: the URL is the single source of
 * truth, which is what makes browser back/forward work correctly. Every
 * control's `value`/`defaultValue` reads from props (derived server-side from
 * the URL on the last render), never from state a control owns itself.
 *
 * `setParam` treats an empty string exactly like `null` (delete the param) —
 * this is the client-side twin of the `hour=""` fix in `parseSearchParams`:
 * it guarantees the UI can never itself re-introduce a `?hour=` (or any
 * other) empty-value param into the URL.
 */
export function useFilterParams() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const push = (next: URLSearchParams) => {
    router.push(`${pathname}?${next.toString()}`)
  }

  /**
   * Write several params in ONE navigation. Two back-to-back `setParam` calls
   * cannot substitute: both build their `URLSearchParams` from the same
   * render's `searchParams`, so the second push overwrites the first's change
   * instead of accumulating it. The time-range field needs exactly this — it
   * sets `hour` and clears a now-contradictory `until` in the same write.
   */
  const setParams = (entries: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(entries)) {
      if (value === null || value === '') {
        next.delete(key)
      } else {
        next.set(key, value)
      }
    }
    push(next)
  }

  const setParam = (key: string, value: string | null) => setParams({ [key]: value })

  /**
   * Choosing a city explicitly takes precedence over a previously-set
   * geolocation — otherwise lat/lng would silently keep overriding the newly
   * picked city.
   */
  const setCity = (slug: string) => {
    const next = new URLSearchParams(searchParams.toString())
    next.set('city', slug)
    next.delete('lat')
    next.delete('lng')
    push(next)
  }

  /** The mirror image of `setCity`: coords win, so the city param goes. */
  const setCoords = (lat: number, lng: number) => {
    const next = new URLSearchParams(searchParams.toString())
    next.set('lat', lat.toFixed(5))
    next.set('lng', lng.toFixed(5))
    next.delete('city')
    push(next)
  }

  /** Add/remove one value in a comma-joined multi-value param. */
  const toggleInList = (key: string, values: string[], value: string) => {
    const set = new Set(values)
    if (set.has(value)) {
      set.delete(value)
    } else {
      set.add(value)
    }
    setParam(key, Array.from(set).join(',') || null)
  }

  return { setParam, setParams, setCity, setCoords, toggleInList }
}

/** Compact bordered select/field, per branding.md's Controls tokens. */
export const selectClass =
  'h-[var(--btn-h-sm)] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-3 text-[13.5px] font-medium text-[var(--ink)] outline-none transition-colors focus:border-[var(--court)] motion-reduce:transition-none'

/**
 * Filter toggles. Deliberately `--btn-radius` (12px) and NOT the 999px pills
 * search-results.html draws for `.filter-chip`: branding.md's Controls rule
 * reserves pill shape for *non-interactive* chips/badges, "to distinguish
 * them from buttons", and these are buttons. branding.md outranks the
 * mockups, so the shape stays square-cornered.
 */
export const toggleBase =
  'h-[var(--btn-h-sm)] inline-flex items-center rounded-[var(--btn-radius)] border px-4 text-[13.5px] font-semibold whitespace-nowrap transition-colors motion-reduce:transition-none'
export const toggleActive = 'border-[var(--ink)] bg-[var(--ink)] text-white'
export const toggleInactive =
  'border-[var(--hairline)] bg-[var(--panel)] text-[var(--ink-soft)] hover:border-[var(--court)] hover:text-[var(--ink)]'
