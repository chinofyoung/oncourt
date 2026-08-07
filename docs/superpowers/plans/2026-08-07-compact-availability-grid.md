# Compact Availability Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Book a court" availability grid space-efficient — ~34px rows instead of 46px, price shown once per row in a shrink-to-fit time column when every open cell agrees, and no more 800px-wide slot chips on single-court branches.

**Architecture:** One new pure export in `src/lib/booking/availability.ts` (`spinePriceCentavos`) decides per row whether a single price describes all open cells. `src/components/availability-grid.tsx` consumes it to render the price in the time spine and blank the open cells for that row, falling back to today's per-cell prices otherwise. Density and table-sizing changes are pure Tailwind class edits in the same component, plus one new `--slot-h` token.

**Tech Stack:** Next.js App Router, TypeScript, Tailwind v4, vitest (node environment, hosted Supabase).

## Global Constraints

- **Read `design/branding.md` before any styling change.** It is the design source of truth.
- **Update `design/branding.md` in the same task as any branding/design-system change** (tokens, sizing, component treatment). Tasks 2 and 3 each carry their own branding.md edit; do not batch them into a separate doc task.
- Solid colors only. **No gradients** of any kind.
- All user-facing copy is **English only**.
- Money is integer centavos. Never floats. Format via the component's existing `formatPeso`.
- **Do NOT run any state-changing git command** — no `git add`, `commit`, `branch`, `checkout`, `stash`, `push`. Read-only `git status` / `diff` / `log` is fine. The user commits their own work. There are therefore **no commit steps in this plan**; each task ends at a verified, uncommitted working state.
- Tests run against a **shared, persistent hosted database**. Do not mutate seeded singleton rows; tests must pass on repeated runs.
- Run vitest in the **foreground**, never backgrounded.
- Do not create git worktrees. Work in the main working directory.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/booking/availability.ts` | Modify (add one export) | Gains pure `spinePriceCentavos(cells)`. No SQL, query, or type change. |
| `tests/booking/availability.test.ts` | Modify (append tests) | Unit coverage for `spinePriceCentavos`, using the existing `INPUT` fixture. |
| `src/app/globals.css` | Modify (~line 26) | Adds `--slot-h: 30px` control token. |
| `src/components/availability-grid.tsx` | Modify | Density, table sizing, spine price rendering, legend. |
| `design/branding.md` | Modify (2 sections) | Controls token block (Task 2); Availability grid component entry (Task 3). |

---

## Task 1: `spinePriceCentavos` pure helper

**Files:**
- Modify: `src/lib/booking/availability.ts` (add export near `buildAvailabilityGrid`)
- Test: `tests/booking/availability.test.ts` (append)

**Interfaces:**
- Consumes: existing `GridCell` type — `{ hour: number; priceCentavos: number; state: CellState }`, `CellState = 'open' | 'booked' | 'closed' | 'past'`.
- Produces: `export function spinePriceCentavos(cells: GridCell[]): number | null`. Task 3 imports this by name from `@/lib/booking/availability`.

**Why this rule.** `buildAvailabilityGrid` writes `priceCentavos: band?.priceCentavos ?? 0`, so a `closed` cell carries a meaningless `0`. `booked` and `past` cells carry a real band price but render the words "Booked" / "Past", never a number. Scoping to `open` cells makes the returned value mean exactly one thing: *what the bookable cells in this row cost.*

- [ ] **Step 1: Write the failing tests**

Append to `tests/booking/availability.test.ts`. Note the file's existing `INPUT` fixture: `c1` charges 26500 for hours 11–14 and 36500 for 15–23; `c2` charges 26500 for 11–23 but only *operates* 14–19, so hours 11–13 and 20–23 are `closed` for `c2`. Also add `spinePriceCentavos` to the existing import on line 4.

```ts
test('spinePriceCentavos returns the shared price when every open cell agrees', () => {
  const grid = buildAvailabilityGrid(INPUT)
  // Hour 14: c1 open at 26500, c2 open at 26500.
  const row = grid.map((col) => col.cells.find((c) => c.hour === 14)!)
  expect(spinePriceCentavos(row)).toBe(26500)
})

test('spinePriceCentavos returns null when open cells disagree', () => {
  const grid = buildAvailabilityGrid(INPUT)
  // Hour 15: c1 crosses into its 36500 band, c2 is still 26500.
  const row = grid.map((col) => col.cells.find((c) => c.hour === 15)!)
  expect(spinePriceCentavos(row)).toBeNull()
})

test('spinePriceCentavos ignores closed cells and their placeholder zero price', () => {
  const grid = buildAvailabilityGrid(INPUT)
  // Hour 11: c1 open at 26500; c2 closed, carrying priceCentavos 0.
  const row = grid.map((col) => col.cells.find((c) => c.hour === 11)!)
  expect(row.find((c) => c.state === 'closed')!.priceCentavos).toBe(0)
  expect(spinePriceCentavos(row)).toBe(26500)
})

test('spinePriceCentavos ignores booked cells even when their price differs', () => {
  // c1 hours 18-19 are occupied. Give c2 a different price so that counting
  // the booked cell would change the answer, and confirm it does not.
  const grid = buildAvailabilityGrid({
    ...INPUT,
    rateBands: {
      c1: [{ startHour: 11, endHour: 24, priceCentavos: 99900 }],
      c2: [{ startHour: 11, endHour: 24, priceCentavos: 26500 }],
    },
  })
  const row = grid.map((col) => col.cells.find((c) => c.hour === 18)!)
  expect(row.find((c) => c.state === 'booked')).toBeDefined()
  expect(spinePriceCentavos(row)).toBe(26500)
})

test('spinePriceCentavos returns null when a row has no open cells', () => {
  expect(spinePriceCentavos([])).toBeNull()
  expect(
    spinePriceCentavos([
      { hour: 9, priceCentavos: 0, state: 'closed' },
      { hour: 9, priceCentavos: 26500, state: 'past' },
    ]),
  ).toBeNull()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/booking/availability.test.ts
```

Expected: fails to compile / `spinePriceCentavos is not a function` — the export does not exist yet.

- [ ] **Step 3: Implement**

Add to `src/lib/booking/availability.ts`, immediately after `buildAvailabilityGrid`:

```ts
/**
 * The single price that describes every bookable cell in one grid row, or
 * `null` when no such price exists.
 *
 * Only `open` cells count. A `closed` cell carries `priceCentavos: 0` from
 * buildAvailabilityGrid's `band?.priceCentavos ?? 0` fallback — a placeholder,
 * not a rate — and `booked`/`past` cells render "Booked"/"Past" rather than a
 * number, so neither is described by a price shown in the time spine.
 *
 * Returns null when open cells disagree (courts can define different rate
 * bands for the same hour) or when the row has no open cells at all. The
 * availability grid falls back to printing each open cell's own price in that
 * case, so a shared price is only ever displayed once it has been verified.
 */
export function spinePriceCentavos(cells: GridCell[]): number | null {
  let price: number | null = null
  for (const cell of cells) {
    if (cell.state !== 'open') continue
    if (price === null) price = cell.priceCentavos
    else if (price !== cell.priceCentavos) return null
  }
  return price
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/booking/availability.test.ts
```

Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

---

## Task 2: Row density and table sizing

**Files:**
- Modify: `src/app/globals.css:26` area (token block)
- Modify: `src/components/availability-grid.tsx`
- Modify: `design/branding.md` (Controls section only)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: a `--slot-h` CSS custom property; the shrink-to-fit spine markup that Task 3 renders the price into.

**Do not change in this task:** cell text content, cell state logic, `aria-label`s, selection behavior, the summary bar.

- [ ] **Step 1: Add the `--slot-h` token**

In `src/app/globals.css`, in the block containing `--btn-h-sm: 38px;` (~line 26), add below it:

```css
  --slot-h: 30px; /* availability-grid slot cells (denser than --btn-h-sm) */
```

Leave `--btn-h-sm: 38px` exactly as-is — it has ~15 other consumers across `src/app` and `src/components` (form fields, nav pills, icon buttons) that must not shrink.

- [ ] **Step 2: Shrink the slot chip**

In `src/components/availability-grid.tsx`, in the cell `<button>`'s class array (currently line ~198), change the first entry from:

```
'relative h-[var(--btn-h-sm)] w-full rounded-[var(--btn-radius)] border font-mono text-xs font-medium transition-colors',
```

to:

```
'relative mx-auto h-[var(--slot-h)] w-full max-w-[168px] rounded-[var(--btn-radius)] border font-mono text-[10px] font-medium transition-colors',
```

`max-w-[168px] mx-auto` is what stops a single-court branch stretching one chip across the whole card. Keep the second entry (the `focus-visible:` line) and every state branch below it unchanged.

- [ ] **Step 3: Tighten the cell padding**

Same file, the slot `<td>` (currently line ~167): change `className="p-1 text-center"` to `className="px-1 py-0.5 text-center"`.

- [ ] **Step 4: Make the time spine shrink to its content**

Same file, the row-header `<th scope="row">` (currently line ~158): change `px-4 py-1` to `w-px px-3 py-0.5`. It already has `whitespace-nowrap`; keep it — `w-px` + `whitespace-nowrap` is the CSS-table idiom that collapses a column to exactly its content width.

Apply the same width treatment to the column header so the two agree: on the `<th scope="col">` reading "Time" (currently line ~128), change `p-3 pl-4` to `w-px px-3 py-2` and add `whitespace-nowrap`.

- [ ] **Step 5: Replace the static table min-width with a court-count-derived one**

Same file, the `<table>` (currently line ~123). Change:

```tsx
<table className="w-full min-w-[640px] border-collapse text-sm">
```

to:

```tsx
<table
  className="w-full border-collapse text-sm"
  // Derived from the court count rather than a fixed 640px: a one- or
  // two-court branch should never force horizontal scroll, while a
  // seven-court branch still should. The spine is shrink-to-fit and sits
  // outside this budget.
  style={{ minWidth: `${props.grid.length * 112}px` }}
>
```

- [ ] **Step 6: Tighten the column header**

Same file, the per-court `<th scope="col">` (currently line ~136): change `p-3` to `px-2 py-2`, and on the environment chip inside it (currently line ~141) change `mt-1 ... px-2 py-0.5` to `mt-0.5 ... px-1.5 py-0`.

- [ ] **Step 7: Update `design/branding.md` — Controls section**

In the ```css token block under `## Controls`, add after the `--btn-h-sm` line:

```css
--slot-h: 30px;      /* availability-grid slot cells */
```

And amend the `--btn-h-sm` comment on the line above from `/* compact controls (icon buttons, slot cells, nav pill) */` to `/* compact controls (icon buttons, form fields, nav pill) */` — slot cells now have their own token and are no longer described by this one.

- [ ] **Step 8: Verify**

```bash
npx tsc --noEmit && npx eslint
```

Expected: both clean.

---

## Task 3: Spine price, blank open cells, and legend

**Files:**
- Modify: `src/components/availability-grid.tsx`
- Modify: `design/branding.md` (Availability grid component entry)

**Interfaces:**
- Consumes: `spinePriceCentavos(cells: GridCell[]): number | null` from `@/lib/booking/availability` (Task 1); the shrink-to-fit spine markup from Task 2.
- Produces: nothing downstream.

- [ ] **Step 1: Import the helper**

In `src/components/availability-grid.tsx`, change the existing type-only import on line 4:

```tsx
import type { GridColumn } from '@/lib/booking/availability'
```

to:

```tsx
import { spinePriceCentavos } from '@/lib/booking/availability'
import type { GridCell, GridColumn } from '@/lib/booking/availability'
```

- [ ] **Step 2: Compute the row's cells and spine price once per row**

Inside the `hours.map((hour) => ...)` body (currently line ~154), before the returned `<tr>`, add:

```tsx
const rowCells: GridCell[] = props.grid.map((court) => court.cells.find((c) => c.hour === hour)!)
const spinePrice = spinePriceCentavos(rowCells)
```

Then in the `props.grid.map(...)` below it, replace `const cell = court.cells.find((c) => c.hour === hour)!` with `const cell = rowCells[courtIndex]` and change that map's signature to `(court, courtIndex) => {`. This removes a repeated `.find()` per cell.

- [ ] **Step 3: Render the price in the spine**

Replace the row-header `<th scope="row">`'s body — currently just `{formatHour(hour)}` — with:

```tsx
<span className="flex items-baseline gap-3">
  <span>{formatHour(hour)}</span>
  {spinePrice !== null && (
    <span className="ml-auto text-[var(--ink-soft)]">{formatPeso(spinePrice)}</span>
  )}
</span>
```

Both on one line, so the spine gains no height.

- [ ] **Step 4: Blank the open cell when the spine carries its price**

In the cell `<button>`'s children (currently lines ~215-221), change the `open` branch so it renders nothing when the spine already shows the price. The full expression becomes:

```tsx
{cell.state === 'open'
  ? spinePrice !== null
    ? null
    : formatPeso(cell.priceCentavos)
  : cell.state === 'booked'
    ? 'Booked'
    : cell.state === 'past'
      ? 'Past'
      : '—'}
```

**Leave the `aria-label` on that same button completely unchanged.** It must still announce the full price (`${court.courtName} at ${formatHour(hour)}, ${formatPeso(cell.priceCentavos)}`) even when the visible cell is blank — that is the whole reason a screen reader user is not harmed by this change.

- [ ] **Step 5: Add the legend**

Between the closing `</div>` of the `overflow-x-auto` table wrapper and the `{error && ...}` block (currently line ~231), insert:

```tsx
{/* A row whose price sits in the time spine renders its open cells blank, so
    fill and border are what distinguish the four states. This legend is what
    makes that legible; the swatches repeat each state's own treatment. */}
<ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-[var(--hairline)] px-4 py-2 font-mono text-[10px] uppercase tracking-[.08em] text-[var(--ink-soft)]">
  {[
    { label: 'Available', className: 'border-[var(--hairline)] bg-[var(--surface)]' },
    { label: 'Selected', className: 'border-[1.5px] border-[var(--ink)] bg-[var(--ball)]' },
    { label: 'Booked', className: 'border-transparent bg-[var(--booked)]' },
    { label: 'Past', className: 'border-dashed border-[var(--hairline)] bg-transparent' },
    { label: 'Closed', className: 'border-transparent bg-transparent opacity-50' },
  ].map((item) => (
    <li key={item.label} className="flex items-center gap-1.5">
      <span aria-hidden className={`h-3 w-5 rounded-[4px] border ${item.className}`} />
      {item.label}
    </li>
  ))}
</ul>
```

- [ ] **Step 6: Update the component's header comment**

The block comment at the top of `availability-grid.tsx` documents the component's design decisions and is currently accurate about per-cell prices. Add a paragraph after the existing `past` paragraph:

```
// Price placement: a row whose `open` cells all quote the same price shows
// that price ONCE in the time spine (see spinePriceCentavos in
// src/lib/booking/availability.ts) and renders those cells blank; a row whose
// open cells disagree keeps a price in each cell, as before. Both kinds of row
// can appear in one grid — the decision is per row, never per grid. This is
// NOT a return of the per-row rate-band tinting described as dropped above:
// that asserted a shared band structure the data model does not guarantee,
// whereas this only renders a shared value after verifying the visible open
// cells actually agree. The button's aria-label always speaks the full price,
// blank cell or not.
```

- [ ] **Step 7: Update `design/branding.md` — Availability grid entry**

In the `- **Availability grid** (signature component):` bullet, keep the entire existing paragraph about the dropped rate-band tint and the four cell states verbatim. Append to that bullet:

> Density: slot chips are `--slot-h` (30px) in a `px-1 py-0.5` cell, giving ~34px rows; cell labels are 10px mono. The time spine is **shrink-to-fit** (`w-px whitespace-nowrap`), never a fixed or leftover-width column — a `w-full` table hands spare width to its first column, which on a single-court branch rendered a ~340px time column and an ~800px slot chip; slot chips are additionally capped at `max-w-[168px] mx-auto`. When every `open` cell in a row quotes the same price, that price renders once in the spine (right-aligned, muted mono, same line as the time) and those cells render blank; when open cells disagree, each prints its own price. This is decided per row and only after verifying agreement, so it does not reintroduce the shared-band assumption that killed the tint. Because open cells can be blank, a mono-uppercase legend (Available / Selected / Booked / Past / Closed, swatches reusing each state's own fill and border) sits between the table and the summary bar.

- [ ] **Step 8: Verify**

```bash
npx tsc --noEmit && npx eslint
```

Expected: both clean.

- [ ] **Step 9: Full test suite**

```bash
npx vitest run
```

Run in the **foreground**. Expected: green. This suite hits a shared hosted database and has known pool-contention flakes — if a test times out, re-run that file alone to confirm before reporting it as a failure. Do not report a flake as a pass without the isolated re-run.

---

## Task 4: Browser verification

**Files:** none modified (unless a defect is found).

**Interfaces:** Consumes the finished component from Tasks 1–3.

- [ ] **Step 1: Start the dev server via the preview tool**

Use `preview_start` with the dev-server config from `.claude/launch.json` (create it if absent: `npm` / `["run","dev"]` / port 3000). **Never start the server with Bash.**

- [ ] **Step 2: Open a public venue page**

Find a real slug: `select slug from branches where status = 'approved' limit 3`. Navigate to `/venues/<slug>`. This is unauthenticated, so `canBook` is false and the summary bar shows the owner/sign-in copy — that is expected and fine; the grid itself renders fully. (Per project memory: `/dashboard` and `/admin` are not browser-verifiable, but public venue pages are.)

- [ ] **Step 3: Check for errors**

`read_console_messages` and `preview_logs`. Expected: no errors.

- [ ] **Step 4: Measure the result**

Use `javascript_tool` to confirm the numbers rather than eyeballing them:

```js
const rows = document.querySelectorAll('table tbody tr')
const spine = rows[0]?.querySelector('th')
JSON.stringify({
  rowCount: rows.length,
  rowHeight: rows[0]?.getBoundingClientRect().height,
  spineWidth: spine?.getBoundingClientRect().width,
  chipWidth: rows[0]?.querySelector('button')?.getBoundingClientRect().width,
})
```

Expected: `rowHeight` ~34, `spineWidth` well under 200 (content-sized), `chipWidth` ≤ 168.

- [ ] **Step 5: Confirm the spine price renders**

`read_page` and confirm at least one row shows `₱` in the time column with a blank open cell, and that the legend is present.

- [ ] **Step 6: Verify the mixed-price fallback**

A branch with genuinely different per-court rate bands may not exist in the shared database. Check first:

```sql
select court_id, start_hour, price_centavos from rate_bands order by court_id limit 20
```

If a branch with disagreeing per-court prices exists, navigate to it and confirm that row shows no spine price and each open cell prints its own. If none exists, temporarily hardcode `const spinePrice = null` in the component, confirm the fallback renders per-cell prices, then **revert that edit**. Say in the report which of the two paths was used — do not claim real-data verification if the branch was forced.

- [ ] **Step 7: Screenshot**

`computer {action: "screenshot"}` and save to `docs/screenshots/` (create the directory if missing). **Never save screenshots to the project root.**

- [ ] **Step 8: Report**

Report the measured numbers from Step 4, which fallback path Step 6 used, and any defect found. Do not claim completion without the measurements.

---

## Self-review notes

**Spec coverage:** Density §1 → Task 2 Steps 1-3, 6. Spine price §2 → Task 1 (rule) + Task 3 Steps 2-4. Cell states + legend §3 → Task 3 Step 5 (state treatments deliberately untouched). Horizontal sizing §4 → Task 2 Steps 4-6. branding.md §5 → Task 2 Step 7 (Controls) + Task 3 Step 7 (Availability grid). Testing → Task 1 Steps 2/4, Task 3 Steps 8-9, Task 4. Non-goals are called out as "do not change" in Tasks 2 and 3.

**Naming:** `spinePriceCentavos` is used identically in Task 1 (definition), Task 1 tests, Task 3 Step 1 (import), and Task 3 Step 2 (call). `--slot-h` is used identically in Task 2 Steps 1, 2, 7 and Task 3 Step 7. The local `spinePrice` variable name is consistent across Task 3 Steps 2, 3, 4, 6.

**No commit steps**, by the Global Constraints rule above — this deliberately departs from the writing-plans template, which assumes frequent commits.
