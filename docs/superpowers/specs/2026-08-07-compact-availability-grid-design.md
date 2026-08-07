# Compact availability grid — design

Date: 2026-08-07
Scope: `src/components/availability-grid.tsx`, `src/app/globals.css`, `design/branding.md`

## Problem

The "Book a court" grid wastes vertical and horizontal space.

- Each hour row is 46px tall (a 38px `--btn-h-sm` chip inside a `p-1` cell).
  A 15-hour day is ~690px of scrolling before the summary bar.
- Every open cell repeats the price, even when every court charges the same
  for that hour.
- The table is `w-full min-w-[640px]`. On a single-court branch the browser
  hands all leftover width to the first column, so the TIME spine renders
  ~340px wide and the court's slot chip stretches to ~800px.

Reference: a competitor grid with ~34px rows, price shown once per row in the
time column, plain state chips, and a legend.

## Non-goals

Explicitly unchanged by this work:

- Which hours render. Elapsed hours still render (they are **not** hidden or
  collapsed behind a toggle — decided against; see "Rejected" below).
- The four `CellState` values and their semantics
  (`open` / `booked` / `closed` / `past`), including the reasoning in
  `availability-grid.tsx`'s header comment for why `past` is distinct from
  both `closed` and `booked`.
- Selection behavior: one court at a time, consecutive hours only.
- The summary bar, the `canBook` owner/admin treatment, the `createHoldAction`
  form and all its hidden inputs.
- Every `aria-label`. A blank open cell must still announce
  `"<Court> at 7 PM, ₱400"` exactly as it does today.
- No row grouping by period (Morning/Afternoon/Evening). Header rows cost the
  vertical space this work is reclaiming.
- No data-layer change to `src/lib/booking/availability.ts` — no SQL, no query,
  no change to `GridCell` / `GridColumn` / `buildAvailabilityGrid`.

  `spinePriceCentavos` ships as a pure export in its **own** module,
  `src/lib/booking/spine-price.ts`, whose only import is
  `import type { GridCell } from './availability'` (erased at compile time).

  Two constraints force exactly this placement, and both were learned the hard
  way during implementation:

  1. It cannot live inside the component. The project has no React test setup
     (no jsdom, no testing-library), so it would be untestable.
  2. It cannot live in `availability.ts`. That file has a top-level
     `import { db } from '@/db'`, and `src/db/index.ts` starts with
     `import 'server-only'`. `availability-grid.tsx` is a `'use client'`
     component, and its previous import from that module was **type-only**, so
     it was erased. Turning it into a value import dragged `pg` and
     `server-only` into the client bundle and made `/venues/<slug>` return 500
     with *"You're importing a module that depends on server-only."*
     `npx tsc --noEmit` and `npx eslint` both pass in that state — only loading
     the page catches it.

## Design

### 1. Row density

| | before | after |
|---|---|---|
| slot chip height | `--btn-h-sm` (38px) | `--slot-h` (30px) |
| cell vertical padding | `p-1` (4px) | `py-0.5` (2px) |
| row height | 46px | 34px |
| 15-hour day | ~690px | ~510px |

A new control token `--slot-h: 30px` is added to `src/app/globals.css`
alongside the existing `--control-h` / `--btn-h` / `--btn-h-sm`. Slot cells stop
using `--btn-h-sm`; that token keeps its other consumers (icon buttons, nav
pill) untouched.

Cell text drops to `text-[10px]` mono for the `booked` / `past` / `closed`
labels, and `text-[11px]` mono for a price printed inside a cell.

### 2. Price moves to the time spine when it is unambiguous

Computed per row, in the component:

> Let `openPrices` be the set of `priceCentavos` across the row's cells whose
> state is `'open'`. If `openPrices` has exactly one distinct value and at
> least one member, that value is the row's **spine price**.

- Row has a spine price → the time spine renders `7 AM` and, right-aligned on
  the **same line**, `₱400` in muted mono. Open cells in that row render with
  no text.
- Row has no spine price (open cells disagree, or there are no open cells) →
  the spine renders the time alone, and open cells print their own price
  exactly as today.

Both kinds of row can appear in one grid; the decision is per row, never per
grid.

**Why only `open` cells feed the check.** `buildAvailabilityGrid` sets
`priceCentavos: band?.priceCentavos ?? 0`, so a closed cell carries a
meaningless `0` that would defeat any naive all-cells comparison. `booked` and
`past` cells carry a real band price but render the words "Booked" / "Past",
never a number — so a spine price would not be describing them either. Scoping
the rule to `open` cells makes the spine price mean exactly one thing: *this is
what the bookable cells in this row cost.*

This does not reintroduce the rate-band tint that `design/branding.md` and
`availability-grid.tsx` document as deliberately dropped. That was dropped
because a single shared tint column asserted a band structure that per-court
rate bands do not guarantee. Here the shared value is only rendered when the
component has verified the visible open cells actually agree.

### 3. Cell states carry the distinction visually

Open cells can now be blank, so state must read without text. The existing
treatments already differ enough and are kept as-is:

- `open` — `--hairline` border on `--surface`, hover `--court` border
- `booked` — flat `--booked` fill, no border, label "Booked"
- `past` — dashed `--hairline` border, transparent, `opacity-70`, label "Past"
- `closed` — no border, transparent, `opacity-50`, label "—"
- selected — lime with 1.5px ink border and the court-corner tick marks

A single-line legend is added below the table and above the summary bar:
Available / Selected / Booked / Past / Closed, each a small swatch reusing the
state's own treatment plus a label. It costs ~24px once and is what makes a
blank open cell legible. Legend swatches are decorative (`aria-hidden`); the
labels are real text.

### 4. Horizontal sizing

- Drop the leftover-width problem at the source: the time spine `<th>`/`<td>`
  get `w-px whitespace-nowrap` (the standard CSS-table shrink-to-fit idiom)
  and `px-3` instead of `px-4`. The column becomes exactly as wide as
  `12 PM  ₱450` needs, and no wider.
- Court columns absorb all remaining width, and the chip fills its column.

  A `max-w-[168px] mx-auto` cap on the chip was specified here, implemented,
  and then **removed after browser verification**: on the one-court branch it
  left a small pill stranded in ~460px of blank column on every row, which
  reads as a broken layout rather than a deliberate one. It also solved a
  problem the user never raised — their complaint was the time column, not the
  chip. A full-width chip is the better affordance for "this hour is
  available," and the shrink-to-fit spine is what actually reclaims the width.
- The table stays `w-full`. The static `min-w-[640px]` is replaced by a
  min-width derived from the court count — `112px` per court, applied as an
  inline `style={{ minWidth: ... }}` since the value is dynamic — so a one- or
  two-court branch never forces horizontal scroll while a seven-court branch
  still does. Sticky-left spine, sticky header row,
  and `overflow-x-auto` on the wrapper are all retained — per
  `design/branding.md`'s Layout rule, wide grids scroll inside their own
  container and the page never scrolls sideways.

### 5. branding.md updates (same turn, per CLAUDE.md)

- **Controls** section: add `--slot-h: 30px` to the token block, and amend the
  `--btn-h-sm` comment so "slot cells" no longer lists under it.
- **Availability grid** component entry: document the shrink-to-fit time
  spine, the conditional spine price (with the `open`-cells-only rule and why),
  the blank open cell, the legend, and the 30px row density. The existing
  paragraph explaining why the rate-band *tint* was dropped stays — the new
  text must not read as reversing it.

## Testing

There is no existing test file for this component and this is a presentational
change, so verification is:

1. `npx tsc --noEmit` and `npx next lint` clean.
2. `npx vitest run` — full suite still green (no data-layer change expected to
   affect it; confirm rather than assume).
3. Browser check on a public venue page (unauthenticated, so `canBook` is
   false and the summary bar shows the sign-in path — the grid itself renders
   fully): confirm row height, a uniform-price row showing `₱` in the spine
   with blank open cells, spine column width tracking its content, and the
   legend. Screenshot to `docs/screenshots/`.

A venue with per-court rate bands may not exist in the shared hosted database.
If no mixed-price row can be produced from real data, verify the fallback by
temporarily forcing the branch in the component during the browser check, then
reverting — and say so in the report rather than claiming it was verified
against real data.

## Rejected

- **Hiding or collapsing elapsed hours.** The largest single space win (12
  rows on the reported screenshot), but the user chose to keep them and
  compact instead — a player can still see what the day's earlier hours cost.
- **Always putting price in the spine** (what the reference does). Shows one
  court's price as if it were every court's on branches with per-court rate
  bands.
- **Period grouping rows.** Adds ~3 rows of height to a change whose purpose
  is removing height.
