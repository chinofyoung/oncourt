'use client'

import type { ListingFormState } from './actions'

/**
 * The control classes every listings form shares.
 *
 * A single module rather than a copy per file: six forms across four files
 * would otherwise carry six copies of the same eight strings, and the one
 * that mattered most — FOCUS_RING — is exactly the one that got dropped four
 * times in the previous slice's review. design/branding.md is the source for
 * every value here: --btn-h-sm 38px controls, --btn-radius 12px, display font
 * at weight 700 on buttons, mono uppercase kickers for labels.
 */
export const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

export const LABEL =
  'font-mono mb-1 block text-[10.5px] tracking-[.12em] text-[var(--ink-soft)] uppercase'

export const FIELD =
  `h-[var(--btn-h-sm)] w-full rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2.5 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-soft)] ${FOCUS_RING}`

export const TEXTAREA =
  `w-full rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2.5 py-2 text-[13px] leading-[1.55] text-[var(--ink)] placeholder:text-[var(--ink-soft)] ${FOCUS_RING}`

export const CHECKBOX = `h-4 w-4 shrink-0 accent-[var(--court)] ${FOCUS_RING}`

export const CHECK_LABEL =
  'inline-flex cursor-pointer items-center gap-1.5 text-[12.5px] text-[var(--ink)]'

/**
 * branding.md's primary: lime background, --ball-ink text. NEVER two of these
 * in one view — where a control repeats per row, use DARK_BUTTON (the
 * alternative primary) or BORDERED_BUTTON instead.
 */
export const LIME_BUTTON =
  `font-display inline-flex h-[var(--btn-h)] items-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-5 text-[14px] font-bold text-[var(--ball-ink)] transition-[filter] duration-150 hover:brightness-[1.06] disabled:opacity-60 motion-reduce:transition-none ${FOCUS_RING}`

export const DARK_BUTTON =
  `font-display inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] bg-[var(--ink)] px-4 text-[13px] font-bold text-[var(--ball)] transition-[filter] duration-150 hover:brightness-[1.25] disabled:opacity-60 motion-reduce:transition-none ${FOCUS_RING}`

export const BORDERED_BUTTON =
  `inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3.5 text-[13px] font-semibold whitespace-nowrap text-[var(--ink)] hover:border-[var(--court)] disabled:opacity-60 ${FOCUS_RING}`

/**
 * Renders whatever a listings action returned. `role="alert"` for failures so
 * a screen reader announces them without the user hunting for the change;
 * `role="status"` for successes, which are polite by comparison.
 */
export function FormMessage({ state }: { state: ListingFormState }) {
  if (!state) return null
  return 'error' in state ? (
    <p role="alert" className="mt-2 text-[12.5px] font-medium text-[var(--ink)]">
      {state.error}
    </p>
  ) : (
    <p role="status" className="mt-2 text-[12.5px] font-medium text-[var(--court)]">
      {state.message}
    </p>
  )
}
