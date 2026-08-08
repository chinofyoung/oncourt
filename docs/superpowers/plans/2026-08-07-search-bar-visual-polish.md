# Search Bar Visual Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the home hero and `/search` search bars read as one component in two skins — same 1120px width, same type scale, one brand chevron instead of four native widgets — and change both CTAs to "Find a Court".

**Architecture:** Presentation-only. Two JSX files change class strings, one CSS file gains two utilities, one design doc records the decisions. No component is created, extracted, or removed; no data flows, query params, or handlers change.

**Tech Stack:** Next.js App Router, TypeScript, Tailwind CSS v4 (`@utility` API for custom utilities), CSS custom properties from `src/app/globals.css`.

**Spec:** `docs/superpowers/specs/2026-08-07-search-bar-visual-polish-design.md` — read it before Task 1. Every "why" lives there; this plan is the "how".

## Global Constraints

Every task's requirements implicitly include this section.

- **Do NOT run any state-changing git command.** No `commit`, `add`, `branch`, `checkout`, `stash`, `reset`, `push`. Read-only inspection (`status`, `diff`, `log`) is fine. The user commits their own work. Where the writing-plans template would put a "Commit" step, this plan puts a "Report" step instead.
- **Presentation-only.** Do not modify `src/lib/search/params.ts`, `src/lib/search/hours.ts`, `src/lib/geo/cities.ts`, `src/lib/branches/queries.ts`, or any file under `tests/`. A diff to any of those means the change escaped its scope — stop and report instead.
- **Another session is editing this repo concurrently.** At plan time, `design/branding.md` and `src/components/site/wordmark.tsx` were uncommitted, rewriting the **Name** and **Wordmark** bullets ("oncourt" → "onCourt"). Never rewrite `design/branding.md` wholesale — always Read it immediately before editing, then use targeted string replacement. Do not touch `wordmark.tsx`.
- **Exact CTA copy:** `Find a Court` — capital F, lowercase a, capital C. Both bars, character-identical.
- **Screenshots go in `docs/screenshots/`**, never the repo root. Create the directory if missing.
- **Design tokens only.** Colours come from the `var(--*)` tokens in `src/app/globals.css` (panel skin) or `white/NN` literals (glass skin). The permitted un-tokenised hexes are **two**, both inside Task 1's SVG data URIs, because a data URI cannot read a CSS custom property: `#5B6E60` (mirrors `--ink-soft`; the two must change together) and `#FFFFFF` at `.55` opacity (the glass skin's counterpart to the `white/55` labels the chevron sits beside). The comment above them must describe both — an earlier draft of this constraint said "the one permitted hex", which made that comment contradict the code directly beneath it.
- **Never combine `max-w-[1120px]` with `px-[max(24px,calc((100vw-1120px)/2))]`.** The formula already caps content at 1120px; a `max-w` on top re-centers a narrower box and breaks the alignment this plan exists to fix.
- **Dev server:** already configured as `oncourt-dev` in `.claude/launch.json` (port 3000). Start it with the preview tool, never with Bash.
- **Measure, don't eyeball.** Every layout claim in this plan is verified by running JavaScript in the page and reading numbers. A screenshot is evidence for the user, not verification for you.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/app/globals.css` | The two shared chevron utilities — the only thing the two skins genuinely share | 1 |
| `src/app/page.tsx` | Home hero: column wrapper, glass-skin fields, CTA | 2 |
| `src/components/search/map-hero.tsx` | `/search` float: full-width grid, panel-skin fields, CTA, "Use my location" | 3 |
| `design/branding.md` | Records Voice (CTA), Layout (column mechanism), Controls (chevron + float width) | 4 |
| `docs/screenshots/` | Evidence for the user | 5 |

Task order matters: Task 1 produces the class names Tasks 2 and 3 consume.

---

### Task 1: Shared chevron utilities

**Files:**
- Modify: `src/app/globals.css` (append after the existing `@layer base` block, which ends at line 107)

**Interfaces:**
- Consumes: nothing.
- Produces: two CSS class names used verbatim by Tasks 2 and 3 —
  - `select-chevron-light` — for `<select>` on the glass skin (white text over a photo)
  - `select-chevron-dark` — for `<select>` on the panel skin (ink text on white)

  Each sets `appearance: none` **and** draws the chevron **and** reserves the
  right padding, so a caller needs exactly one class and cannot end up with
  both a native arrow and a drawn one.

- [ ] **Step 1: Read the file to confirm the insertion point**

Read `src/app/globals.css`. Confirm it ends with the `@layer base { … }` cursor-pointer block closing at line 107. Append below it — do not edit `:root`, `@theme inline`, `body`, or `@layer base`.

- [ ] **Step 2: Append the two utilities**

Tailwind v4's `@utility` API (not `@layer utilities`) — it registers the class in Tailwind's own layer ordering, which is what keeps a caller's `bg-transparent` from fighting the `background-image` here.

```css
/* Search-bar <select> chevron — branding.md, Controls.
   Both search bars (src/app/page.tsx's hero, src/components/search/map-hero.tsx's
   float) previously rendered the browser's native select arrow: a different glyph
   at a different size and offset per field and per browser, reading as grey system
   chrome inside a hand-built control. These two utilities replace it with one
   10x10 chevron at one stroke weight, in the two skins the bars come in.

   Each utility bundles appearance:none WITH the glyph and the padding that clears
   it, deliberately: split across three classes, a call site that forgets
   appearance-none renders two arrows, and one that forgets the padding renders the
   value text underneath the chevron. One class, or nothing.

   The stroke colour is a literal hex because a data URI cannot read a CSS custom
   property. `#5B6E60` below IS `--ink-soft`; if that token ever changes, this
   string must change with it — it is the only un-tokenised colour in the search
   bars. The light variant strokes white at .55 opacity, matching the white/55
   labels it sits beside on the glass skin. */
@utility select-chevron-dark {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10' fill='none' stroke='%235B6E60' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M1.5 3.5 5 7l3.5-3.5'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right center;
  background-size: 10px 10px;
  padding-right: 20px;
}

@utility select-chevron-light {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10' fill='none' opacity='.55' stroke='%23FFFFFF' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M1.5 3.5 5 7l3.5-3.5'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right center;
  background-size: 10px 10px;
  padding-right: 20px;
}
```

- [ ] **Step 3: Verify the utilities compile and produce real CSS**

Start the dev server with the preview tool (`preview_start` with `{name: "oncourt-dev"}`), then run this in the page:

```js
(() => {
  const el = document.createElement('div')
  el.className = 'select-chevron-dark'
  document.body.appendChild(el)
  const s = getComputedStyle(el)
  const out = {
    appearance: s.appearance,
    hasImage: s.backgroundImage.startsWith('url("data:image/svg+xml'),
    size: s.backgroundSize,
    padRight: s.paddingRight,
    repeat: s.backgroundRepeat,
  }
  el.remove()
  return JSON.stringify(out)
})()
```

Expected exactly: `appearance: "none"`, `hasImage: true`, `size: "10px 10px"`, `padRight: "20px"`, `repeat: "no-repeat"`.

If `hasImage` is `false`, the `@utility` block did not compile — most likely the data URI's quoting broke. Do not proceed; the two consuming tasks depend on this.

- [ ] **Step 4: Verify the SVG itself is valid, not just present**

A malformed SVG still yields a `url("data:…")` string and a silently blank chevron, so `hasImage: true` alone is not proof. Decode and render it:

```js
(() => {
  const el = document.createElement('div')
  el.className = 'select-chevron-dark'
  document.body.appendChild(el)
  const raw = getComputedStyle(el).backgroundImage
  el.remove()
  const uri = raw.slice(raw.indexOf('data:'), raw.lastIndexOf('"'))
  return new Promise((res) => {
    const img = new Image()
    img.onload = () => res(`OK ${img.naturalWidth}x${img.naturalHeight}`)
    img.onerror = () => res('DECODE FAILED — malformed SVG')
    // Feed the URI still percent-encoded, exactly as `background-image: url(...)`
    // resolves it. Do NOT wrap this in decodeURIComponent(): that turns the
    // `%23` of a hex stroke colour into a literal `#`, which the URL parser
    // reads as the start of a fragment and truncates the SVG — every
    // hex-coloured chevron then "fails" a check that is itself broken.
    img.src = uri
  })
})()
```

Expected: `OK 10x10`. Anything else means the path data or attribute quoting is wrong — fix it before moving on. Repeat both steps for `select-chevron-light`.

- [ ] **Step 5: Confirm nothing else regressed**

Run:

```bash
npx tsc --noEmit && npx eslint
```

Expected: both exit 0 with no output. (A CSS-only change cannot break types, but this is the gate every task passes.)

- [ ] **Step 6: Report**

Report to the reviewer: the appended CSS, the two measurement outputs, and the clean `tsc`/`eslint` run. Do not commit.

---

### Task 2: Home hero — column, chevrons, CTA

**Files:**
- Modify: `src/app/page.tsx` (hero wrapper line ~69; the three `<select>`s and the date `<input>` at lines ~98–182; the submit button at lines ~186–191)

**Interfaces:**
- Consumes: `select-chevron-light` from Task 1.
- Produces: a home hero whose content column starts at the same x as the nav, `main`, and footer, with a 1120px-wide search form. Task 5 asserts these numbers.

- [ ] **Step 1: Capture the "before" numbers**

With `oncourt-dev` running, navigate to `http://localhost:3000/` at a desktop viewport and run:

```js
(() => {
  const L = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().left) : null }
  const F = document.querySelector('form[aria-label="Search courts"]').getBoundingClientRect()
  return JSON.stringify({
    vw: innerWidth,
    navWordmark: L('nav a[href="/"]'),
    h1: L('h1'),
    heroForm: L('form[aria-label="Search courts"]'),
    heroFormWidth: Math.round(F.width),
    mainHeading: L('main h2'),
    footer: L('footer a'),
  })
})()
```

At a 1309px viewport this records the defect: `navWordmark: 95`, `mainHeading: 95`, `footer: 95`, but `h1: 119`, `heroForm: 119`, `heroFormWidth: 1072`. Write the actual numbers down — Step 6 compares against them. If your viewport is not 1309px the absolute numbers differ, but `h1`/`heroForm` will still be exactly 24 greater than `navWordmark`.

- [ ] **Step 2: Move the hero onto the shared column**

Find this line (~69):

```tsx
          <div className="relative z-[1] mx-auto max-w-[1120px] px-6">
```

Replace with:

```tsx
          {/* The full-bleed padding formula, NOT `mx-auto max-w-[1120px]
              px-6` — the two are not the same column. `max-w` + `px-6`
              leaves 1072px of content inset 24px from where every other
              band on this page starts; the formula leaves exactly 1120px
              flush with them. Before this changed, the nav, `main` and the
              footer all began at x=95 on a 1309px viewport while this hero
              began at x=119, so the headline and search bar sat 24px inboard
              of the cards directly beneath them. See branding.md, Layout.
              Do NOT re-add `max-w-[1120px]` alongside this: the formula
              already caps the content, and a max-w on top would re-center a
              narrower box inside the padding and undo the alignment. */}
          <div className="relative z-[1] px-[max(24px,calc((100vw-1120px)/2))]">
```

Nothing else in the hero changes for this step — the `<header>` above it stays full-bleed, and the grid inside the form is untouched.

- [ ] **Step 3: Put the brand chevron on all three selects**

Three `<select>` elements, at roughly lines 98, 148, and 167. Each currently carries `[color-scheme:dark]` and its own layout classes. Add `select-chevron-light` to each, and **keep** `[color-scheme:dark]` — `appearance: none` removes the native arrow but not the popup, which still needs to render dark against the glass field.

`#home-search-city`, from:

```tsx
                  className="[color-scheme:dark] truncate bg-transparent text-[15.5px] font-semibold text-white outline-none"
```

to:

```tsx
                  className="select-chevron-light [color-scheme:dark] truncate bg-transparent text-[15.5px] font-semibold text-white outline-none"
```

`#home-search-hour`, from:

```tsx
                    className="[color-scheme:dark] min-w-0 flex-1 truncate bg-transparent text-[15.5px] font-semibold text-white outline-none"
```

to:

```tsx
                    className="select-chevron-light [color-scheme:dark] min-w-0 flex-1 truncate bg-transparent text-[15.5px] font-semibold text-white outline-none"
```

`#home-search-until` — identical class string to `#home-search-hour`; apply the same change. Both are needed: this is the one field with two selects, and one chevroned sibling beside one native one is worse than two native ones.

- [ ] **Step 4: Normalise the date field's calendar indicator**

The date input keeps its native indicator on purpose — it opens a picker, not a list, so giving it the select chevron would misrepresent it. It only stops looking like unstyled chrome.

`#home-search-date`, from:

```tsx
                  className="[color-scheme:dark] bg-transparent text-[15.5px] font-semibold text-white outline-none"
```

to:

```tsx
                  className="[color-scheme:dark] bg-transparent text-[15.5px] font-semibold text-white outline-none [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100"
```

`cursor-pointer` here is branding.md's Controls rule ("everything clickable shows `cursor: pointer`") reaching a pseudo-element the `globals.css` base rule cannot select.

- [ ] **Step 5: Change the CTA**

The submit button, ~line 186. Change the label **and** add `whitespace-nowrap`:

```tsx
              <button
                type="submit"
                className="font-display ml-2 inline-flex h-[var(--control-h)] items-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-[30px] text-[15.5px] font-bold tracking-[-0.01em] whitespace-nowrap text-[var(--ball-ink)] transition-[filter,transform] duration-150 hover:brightness-[1.06] active:scale-[.98] motion-reduce:transition-none max-[980px]:col-span-2 max-[980px]:mt-0.5 max-[980px]:ml-0 max-[980px]:justify-center"
              >
                Find a Court
              </button>
```

`whitespace-nowrap` is load-bearing, not tidying: "Find a Court" is three words where "Search" was one, and inside a fixed 56px-tall button a wrap would clip. The float already has this class.

- [ ] **Step 6: Verify alignment by measurement**

Reload and re-run the Step 1 snippet. Expected at 1309px:

- `navWordmark`, `h1`, `heroForm`, `mainHeading`, `footer` — **all the same number** (95), where `h1` and `heroForm` were previously 24 greater
- `heroFormWidth: 1120`, up from 1072

The pass condition is that all five left edges are equal, whatever your viewport width makes that number.

- [ ] **Step 7: Verify the chevrons render and nothing doubles up**

```js
(() => JSON.stringify(['home-search-city','home-search-hour','home-search-until'].map((id) => {
  const s = getComputedStyle(document.getElementById(id))
  return { id, appearance: s.appearance, chevron: s.backgroundImage !== 'none', padRight: s.paddingRight }
})))()
```

Expected for all three: `appearance: "none"`, `chevron: true`, `padRight: "20px"`. `appearance: "none"` is what guarantees the native arrow is gone rather than sitting beside the drawn one.

- [ ] **Step 8: Verify no horizontal overflow at any breakpoint**

The hero wrapper change is the one edit in this plan that could reintroduce the page-level overflow documented in `main`'s own comment in this file. Check all four widths — resize, reload, then run:

```js
JSON.stringify({ vw: innerWidth, docW: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > innerWidth })
```

At **1309, 980, 768, and 375**: `overflow` must be `false` every time. 375px is the one that matters most.

- [ ] **Step 9: Gate**

```bash
npx tsc --noEmit && npx eslint
```

Expected: both exit 0, no output.

- [ ] **Step 10: Report**

Report the before/after numbers from Steps 1 and 6 side by side, the Step 7 chevron output, the four overflow results, and the clean gate. Do not commit.

---

### Task 3: `/search` float — full-width grid, value alignment, CTA

**Files:**
- Modify: `src/components/search/map-hero.tsx` (the `COLUMN_LEFT` constant ~line 34; the class constants ~lines 42–57; the float container ~line 126; the "Use my location" button ~line 138; the three selects; the date input; the submit button ~line 240)

**Interfaces:**
- Consumes: `select-chevron-dark` from Task 1.
- Produces: a float 1120px wide with a left edge matching the home form's, on the grid `grid-cols-[1.25fr_1fr_1fr_auto]`, with no clipped select. Task 5 asserts these.
- Renames: `COLUMN_LEFT` → `COLUMN_INSET` (module-private; both consumers are in this file, so nothing outside it needs updating).

This is the largest task and the whole file is in scope. Read all 250 lines before editing — the file's existing comments explain several decisions you must not undo (the `z-0` stacking context, `router.refresh()`, the `min-w-0` chain).

- [ ] **Step 1: Capture the "before" numbers**

Navigate to `http://localhost:3000/search?city=tacloban` and run:

```js
(() => {
  const fl = document.getElementById('search-city').closest('div[class*="absolute"]')
  const b = fl.getBoundingClientRect()
  const sel = (id) => {
    const e = document.getElementById(id), r = e.getBoundingClientRect()
    return { id, w: Math.round(r.width), scrollW: e.scrollWidth, clipped: e.scrollWidth > Math.ceil(r.width) }
  }
  return JSON.stringify({
    vw: innerWidth,
    floatLeft: Math.round(b.left),
    floatWidth: Math.round(b.width),
    floatHeight: Math.round(b.height),
    fields: ['search-city','search-date','search-hour','search-until'].map(sel),
  })
})()
```

At 1309px this records the defects: `floatWidth: 711` (vs the home form's 1120 after Task 2) and `search-hour` at `w: 73` with `clipped: true` — the `Any t…` bug. Note the numbers.

- [ ] **Step 2: Rename the position constant and add the right inset**

Replace the `COLUMN_LEFT` constant (~line 34) and its doc comment:

```tsx
/**
 * The 1120px content column's insets — branding.md, Layout. Both floating
 * overlays align to them so they line up with the results below; once they go
 * static at ≤980px the same value becomes their horizontal margin, since the
 * hero band itself stays full-bleed.
 *
 * Both `left` AND `right` are set, which is what makes the float span the full
 * column instead of shrinking to its content. Above a 1168px viewport the two
 * insets leave exactly 1120px between them; below it both clamp to 24px.
 *
 * The `max-[980px]:static` on the consumers is what keeps the `mx-` margin
 * working: a static element ignores `left`/`right` entirely, so the absolute
 * insets and the static margin cannot fight.
 */
const COLUMN_INSET =
  'left-[max(24px,calc((100vw-1120px)/2))] right-[max(24px,calc((100vw-1120px)/2))] max-[980px]:mx-[max(24px,calc((100vw-1120px)/2))]'
```

Then update **both** consumers — the filter-summary `<p>` (~line 112) and the float `<div>` (~line 126) — replacing `${COLUMN_LEFT}` with `${COLUMN_INSET}`.

The `<p>` pill also gets the right inset this way. That is harmless and correct: it already carries `w-fit`, so it stays shrink-to-fit and only gains a right boundary it never reaches. Do not give the pill its own separate constant.

- [ ] **Step 3: Convert the field and divider class constants**

Replace `fieldClass` and `dividerClass` (~lines 42–47). The old comment about `min-w-0` stays true and stays — only the flex-specific parts change:

```tsx
// `min-w-0` on the field and the control is load-bearing, not decoration:
// `truncate` sets `white-space: nowrap`, which raises the control's
// min-content width to its full text width and would otherwise refuse to
// shrink — at 480px that pushed the whole float past the viewport and made
// the page scroll sideways, which branding.md's Layout section forbids.
//
// `flex-none` / `max-[980px]:flex-auto` were dropped when the float became a
// grid: both are flex-item concepts and are inert in a grid container. The
// per-cell responsive spans live at the call sites instead, matching the home
// hero. The hover wash is the panel-skin counterpart of the hero's
// `hover:bg-white/[.07]` — `--surface` on `--panel` is the same barely-there
// shift on white that white/.07 is on glass.
const fieldClass =
  'flex h-[var(--control-h)] min-w-0 flex-col justify-center rounded-[var(--btn-radius)] px-4 transition-colors hover:bg-[var(--surface)] motion-reduce:transition-none'
// `max-[980px]:border-l-0`, not `max-[560px]`: at ≤980px the grid drops to two
// columns, so Date becomes the first cell in its row and a left border there
// would draw a line against nothing. Matches the home hero exactly.
const dividerClass = 'border-l border-[var(--hairline)] max-[980px]:border-l-0'
```

- [ ] **Step 4: Bump the three value constants to 15.5px**

Replace `valueBase`, `valueClass`, and `rangeSelectClass` (~lines 48–57). Only the font size changes (14.5 → 15.5), matching the home hero; every other class and the whole `rangeSelectClass` comment stay:

```tsx
const valueBase =
  'min-w-0 truncate bg-transparent text-[15.5px] font-semibold text-[var(--ink)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--court)]'
const valueClass = `w-full max-w-[220px] ${valueBase}`
/**
 * One half of the Time field. `flex-1 min-w-0` instead of `w-full
 * max-w-[220px]`: the two selects share the cell, and without `min-w-0` the
 * `truncate` on each would refuse to shrink and push the float past the
 * viewport — the same trap documented above the field classes.
 */
const rangeSelectClass = `flex-1 disabled:text-[var(--ink-soft)] ${valueBase}`
```

- [ ] **Step 5: Bump the en dash to match**

The decorative en dash between the two hour selects (~line 209) is sized to
match the values it sits between, so it moves with them or it will be the one
14.5px glyph left in a 15.5px field:

```tsx
            <span aria-hidden className="text-[15.5px] text-[var(--ink-soft)]">
              &ndash;
            </span>
```

The home hero's dash is already `text-[15.5px]`; this brings the float in line.
Keep `aria-hidden` — the dash is decoration, and each select carries its own
accessible name ("Time from" / "Time until") per branding.md's Controls rule.

- [ ] **Step 6: Convert the float container from flex to grid**

The float `<div>` (~line 126). Replace `flex items-stretch gap-1` with the home hero's grid, `p-4` with `p-2`, and the flex-wrap mobile rules with grid ones:

```tsx
      <div
        className={`absolute bottom-6 z-10 grid grid-cols-[1.25fr_1fr_1fr_auto] items-center gap-2 rounded-[20px] bg-[var(--panel)] p-2 shadow-[var(--shadow-lg)] max-[980px]:static max-[980px]:mt-4 max-[980px]:grid-cols-2 max-[980px]:gap-1.5 max-[980px]:shadow-[var(--shadow-sm)] ${COLUMN_INSET}`}
      >
```

Four things changed, all matching the home hero: `flex items-stretch gap-1` → `grid grid-cols-[1.25fr_1fr_1fr_auto] items-center gap-2`; `p-4` → `p-2` (taking the float from 88px to **72px** tall); `max-[980px]:flex-wrap max-[980px]:gap-y-2.5` → `max-[980px]:grid-cols-2 max-[980px]:gap-1.5`. The `absolute bottom-6 z-10`, both shadows, and the radius are unchanged — and do **not** touch the `z-0` comment block above this element.

**Correction to an earlier draft of this plan**, which claimed both bars would then "compute to the same 74px height". They do not, and should not. The home form carries `border border-white/[.18]` — the 1px edge branding.md's glass recipe requires over a photo — so it measures **74px**; the float is a solid `--panel` card with a shadow and no border, so it measures **72px**. The 2px delta IS the glass border: a deliberate skin difference, not drift. Do NOT add a border to the float to force the numbers level — a hairline edge on a shadowed white card contradicts branding.md's Cards recipe ("white, `border-radius: 20px`, no border"). The bars match on what matters: 1120px wide, left edge at x=95, 56px fields, same tracks, same type scale.

- [ ] **Step 7: Add the per-cell responsive spans**

The grid needs the spans the dropped `flex-auto` used to stand in for. Three call sites:

Where cell — `<div className={fieldClass}>` becomes:

```tsx
        <div className={`${fieldClass} max-[980px]:col-span-2`}>
```

Date cell and Time cell — each `<div className={`${fieldClass} ${dividerClass}`}>` becomes:

```tsx
        <div className={`${fieldClass} ${dividerClass} max-[560px]:col-span-2`}>
```

Below 560px this gives Date and Time each a full row, so two selects never share half a phone screen — branding.md's Controls rule for the time-range field.

- [ ] **Step 8: Chevron the three selects and the date input**

`#search-city` and both range selects, from `className={valueClass}` / `className={rangeSelectClass}` to:

```tsx
            className={`select-chevron-dark ${valueClass}`}
```

```tsx
              className={`select-chevron-dark ${rangeSelectClass}`}
```

Apply the `rangeSelectClass` version to **both** `#search-hour` and `#search-until`.

`#search-date` keeps its native indicator, normalised — no `[color-scheme:dark]` here, since this skin is ink-on-white:

```tsx
            className={`${valueClass} [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100`}
```

- [ ] **Step 9: Restyle "Use my location" so it stops twinning its label**

The button ~line 138. The handler and its position are unchanged; only the type treatment. Drop `uppercase` and the permanent `underline`, go sentence case at 10.5px, add `hover:underline`:

```tsx
            <button
              type="button"
              onClick={useMyLocation}
              className="text-[10.5px] font-semibold text-[var(--court)] transition-colors hover:text-[var(--court-deep)] hover:underline motion-reduce:transition-none"
            >
              Use my location
            </button>
```

Note `font-mono`, `tracking-[.06em]`, `uppercase`, `underline`, and `underline-offset-2` are all gone. That is the fix: the row now reads `WHERE` (mono uppercase) beside `Use my location` (sentence case) — two distinguishable things, where before two 10px mono uppercase runs read as one broken label.

Keep the existing comment above the button — it explains why this stays a text link rather than a button, and that reasoning still holds — **with one edit**: its closing phrase "stops competing with the lime Search for attention" quotes the CTA's old label, which Step 10 is about to change. Reword the label reference only ("the lime CTA", or "the lime Find a Court button"), keeping the competing-for-attention reasoning intact. The identical stale-label problem was caught by review in Task 2's file; fix it here in the same pass rather than leaving it for review.

- [ ] **Step 10: Change the CTA**

The submit button ~line 240. Label, size, and padding change; the `router.refresh()` handler and its long explanatory comment stay — **except** for the one clause that quotes the old label: "which is the honest meaning of \"Search\" on a page whose filters live in the URL". Update that quoted string to `"Find a Court"` so the sentence describes the button that actually exists. Every other word of that comment, including the availability-moves-with-the-clock reasoning that justifies `router.refresh()`, stays verbatim.

```tsx
        <button
          type="button"
          onClick={() => router.refresh()}
          className="font-display ml-2 inline-flex h-[var(--control-h)] items-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-[30px] text-[15.5px] font-bold tracking-[-0.01em] whitespace-nowrap text-[var(--ball-ink)] transition-[filter,transform] duration-150 hover:brightness-[1.06] active:scale-[.98] motion-reduce:transition-none max-[980px]:col-span-2 max-[980px]:ml-0 max-[980px]:justify-center"
        >
          Find a Court
        </button>
```

`px-[26px]` → `px-[30px]` and `text-[14.5px]` → `text-[15.5px]` match the home bar. `max-[980px]:basis-full` → `max-[980px]:col-span-2`, since `basis` is a flex property and does nothing in a grid.

- [ ] **Step 11: Verify the float is full width and nothing is clipped**

Reload `/search?city=tacloban` and re-run the Step 1 snippet. Expected at 1309px:

- `floatLeft: 95`, `floatWidth: 1120` — up from 711, now equal to the home form
- `floatHeight: 74` — down from 88, now equal to the home form
- **`clipped: false` for all four fields**, with `search-hour` and `search-until` each ~113px instead of 73px

`clipped: false` on `search-hour` is the pass condition for the headline defect. If it is still `true`, the grid did not apply — check that `flex` is gone from the container, not just that `grid` was added.

- [ ] **Step 12: Verify the grid tracks landed where expected**

```js
JSON.stringify({
  cols: getComputedStyle(document.getElementById('search-city').closest('div[class*="absolute"]')).gridTemplateColumns,
  display: getComputedStyle(document.getElementById('search-city').closest('div[class*="absolute"]')).display,
})
```

Expected: `display: "grid"`, and `cols` resolving to four tracks in roughly `352px 281px 281px <button>`. The two middle tracks must be equal — if they are not, a `flex-none` survived somewhere.

- [ ] **Step 13: Verify no horizontal overflow at any breakpoint**

At **1309, 980, 768, and 375** — resize, reload, run:

```js
JSON.stringify({ vw: innerWidth, docW: document.documentElement.scrollWidth, overflow: document.documentElement.scrollWidth > innerWidth })
```

`overflow: false` at every width. This is what the `min-w-0` chain protects and what the grid conversion could break; 375px matters most. Also confirm by eye at 375px that the float has left the map band and sits in normal flow (the `max-[980px]:static` path).

- [ ] **Step 14: Confirm behaviour is untouched**

The float is a client component whose fields write to the URL. Check the handlers still work — this task changed only classes, so any change here is a regression:

1. Change the Where select. The URL's `city` param updates and results re-render.
2. Set a start hour, then set an end hour. Both appear as `hour` and `until`.
3. Set a start hour of 8 PM while an earlier end is set. Confirm `until` clears rather than leaving a backwards span (the `setStartHour` logic).
4. Click "Find a Court". The page re-fetches; the URL does not change.

- [ ] **Step 15: Gate**

```bash
npx tsc --noEmit && npx eslint
```

Expected: both exit 0, no output.

- [ ] **Step 16: Report**

Report the before/after from Steps 1 and 11 side by side (calling out `clipped: true → false`), the Step 12 track widths, the four overflow results, the Step 14 behaviour checks, and the clean gate. Do not commit.

---

### Task 4: Record the decisions in `design/branding.md`

**Files:**
- Modify: `design/branding.md` — the **Voice** bullet (~line 12), the **Layout** section's first bullet (~line 50), and the **Controls** section's time-range bullet (~line 70)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks read. This is the project's design source of truth catching up with Tasks 1–3, required by `CLAUDE.md` in the same turn as the code.

**CRITICAL — concurrent session.** Another session has this file uncommitted, rewriting the **Name** and **Wordmark** bullets. Read the file immediately before each edit and use targeted string replacement on the three bullets below. Never rewrite the file wholesale, never touch Name or Wordmark, and if a target string does not match, re-read rather than forcing it.

- [ ] **Step 1: Read the file and confirm the three targets**

Read `design/branding.md`. Confirm the Voice bullet still ends "Prefer the shortest label that is still unambiguous in context.", the Layout section's first bullet still begins "**Content column: 1120px max**", and the Controls time-range bullet still ends "the two skins have nothing stylable in common." If any differs, the other session moved further — re-read and adapt the anchor, keeping their wording intact.

- [ ] **Step 2: Update Voice**

Replace this sentence inside the Voice bullet:

```
Buttons say exactly what they do ("Search", "Book now", "List your court"). The home hero's button read "Find open courts" until 2026-08-07, when it became plain "Search" — the search bar beside it already says where, when and for how long, so the longer label was restating its own field labels. Prefer the shortest label that is still unambiguous in context.
```

with:

```
Buttons say exactly what they do ("Find a Court", "Book now", "List your court"). The search bars' CTA has moved twice, and the history matters because the second move reverses the first: it read "Find open courts" until 2026-08-07, when it was shortened to plain "Search" on the reasoning that the search bar beside it already says where, when and for how long, so a longer label was restating its own field labels — then later the same day it became **"Find a Court"** by explicit user instruction. Both search bars (home hero and `/search` float) carry that exact string, capital F and capital C. Prefer the shortest label that is still unambiguous in context — but note that "shortest possible" was tried here and set aside for a verb phrase that names the object, so the preference is a tiebreaker, not a rule that overrides a deliberate copy choice.
```

- [ ] **Step 3: Update Layout**

Replace the Layout section's first bullet:

```
- **Content column: 1120px max**, centered, 24px side padding. Full-bleed bands (nav, hero, footer) pad with `max(24px, calc((100vw - 1120px) / 2))`.
```

with:

```
- **Content column: 1120px max**, centered, 24px side padding — and the mechanism is part of the rule, because "centered with 24px padding" describes two implementations that do NOT produce the same column. `px-[max(24px,calc((100vw-1120px)/2))]` yields **1120px** of content; `mx-auto max-w-[1120px] px-6` yields **1072px**, inset 24px further. Use the padding formula for every band — nav, hero, `main`, footer — including content nested inside a `relative` hero, which is where the last exception survived: until 2026-08-07 `src/app/page.tsx`'s hero used the `max-w` form, so on a 1309px viewport the nav, `main` and footer all began at x=95 while the hero's headline and search bar began at x=119, misaligned with the cards directly beneath them. **Never combine the two** — a `max-w` inside the padding formula re-centers a narrower box and breaks the alignment the formula exists to create.
```

- [ ] **Step 4: Update Controls — the time-range bullet's closing sentence**

Replace:

```
Built twice, on purpose: `src/app/page.tsx`'s hero (white-on-glass) and `src/components/search/map-hero.tsx`'s float (ink-on-panel) share the hour logic in `src/lib/search/hours.ts` but not the markup — the two skins have nothing stylable in common.
```

with:

```
Built twice, on purpose: `src/app/page.tsx`'s hero (white-on-glass) and `src/components/search/map-hero.tsx`'s float (ink-on-panel) share the hour logic in `src/lib/search/hours.ts` but not the markup — the two skins have nothing stylable in common. What they DO share, as of 2026-08-07: the same 1120px content column, the same `grid-cols-[1.25fr_1fr_1fr_auto]` track list (the float was previously a shrink-to-fit flex row ~⅔ the width, which squeezed each hour select to 73px and visibly clipped "Any time" to "Any t…"), the same `p-2`/`gap-2`/56px-field metrics (which puts the float at 72px tall and the hero at 74px — the 2px is the glass skin's `border-white/[.18]`, which a solid `--panel` card correctly does not have; do not add a border to level them), the same 15.5px field text, and the same chevron. Keep new values matched across the two files rather than extracting a shared component — the drift is what needs fixing, not the duplication.
```

- [ ] **Step 5: Add the select-chevron rule to Controls**

Add this as a new bullet in the Controls section, directly after the time-range bullet:

```
- **Search-bar `<select>`s:** never the browser's native arrow. Apply exactly one of `select-chevron-light` (glass skin) or `select-chevron-dark` (panel skin) from `src/app/globals.css` — each bundles `appearance: none`, the 10×10 chevron (1.75px stroke, round caps/joins), and the 20px right padding that clears it, so one class does the whole job and no call site can end up with a native arrow beside a drawn one. This is a single pair of `@utility` declarations in `globals.css`, not per-component classes, for the same reason the `cursor: pointer` rule lives there — see that entry above. The chevron's stroke is a literal `#5B6E60`/`#FFFFFF`: a data URI cannot read a custom property, so `--ink-soft` is mirrored by hand there and the two must be changed together. `<input type="date">` deliberately KEEPS its native `::-webkit-calendar-picker-indicator` (normalised to `opacity-60`, `cursor-pointer`, full opacity on hover) — it opens a picker rather than a list, so dressing it as a select chevron would misrepresent what it does. Selects outside the two search bars (the sort select, the price filter) have not been converted yet; these utilities are there when they are.
```

- [ ] **Step 6: Verify only the intended bullets changed**

```bash
git diff --stat design/branding.md && git diff design/branding.md | grep -c '^[-+]'
```

Then read the full `git diff design/branding.md`. Confirm the Name and Wordmark bullets from the other session appear **unchanged** in the diff context (not as `-`/`+` lines). If either shows as modified, you have clobbered concurrent work — restore their wording from the diff before continuing. Do not run any state-changing git command to "fix" it; edit the file back by hand.

- [ ] **Step 7: Report**

Report the diff of the three (now four, with the new bullet) edited bullets, plus explicit confirmation that Name and Wordmark are untouched. Do not commit.

---

### Task 5: Final verification sweep and evidence

**Files:**
- Create: `docs/screenshots/2026-08-07-home-search-bar.png`, `docs/screenshots/2026-08-07-search-float.png`
- Modify: none

**Interfaces:**
- Consumes: the finished state of Tasks 1–4.
- Produces: the evidence the user reviews.

- [ ] **Step 1: Confirm scope was not exceeded**

```bash
git status --short && git diff --stat
```

Expected modified/untracked, and nothing else beyond the other session's two files:

- `src/app/globals.css`
- `src/app/page.tsx`
- `src/components/search/map-hero.tsx`
- `design/branding.md`
- `docs/superpowers/specs/2026-08-07-search-bar-visual-polish-design.md` (untracked)
- `docs/superpowers/plans/2026-08-07-search-bar-visual-polish.md` (untracked)
- `src/components/site/wordmark.tsx` — **the other session's, not ours**

**Any file under `tests/`, `src/lib/`, or `supabase/` in this list is a scope violation.** Stop and report rather than continuing.

- [ ] **Step 2: Static gates**

```bash
npx tsc --noEmit && npx eslint
```

Expected: both exit 0, no output.

- [ ] **Step 3: The two bars now measure identically**

This is the whole point of the change, so assert it directly. On `http://localhost:3000/` at a desktop viewport:

```js
(() => { const r = document.querySelector('form[aria-label="Search courts"]').getBoundingClientRect(); return JSON.stringify({ vw: innerWidth, left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }) })()
```

Then on `http://localhost:3000/search?city=tacloban`:

```js
(() => { const r = document.getElementById('search-city').closest('div[class*="absolute"]').getBoundingClientRect(); return JSON.stringify({ vw: innerWidth, left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }) })()
```

Expected at a 1309px viewport: **identical `left` (95) and `w` (1120)** from both. Heights differ by exactly 2px and that is correct — the home form is **74** and the float is **72**, the delta being the home form's `border border-white/[.18]`, which branding.md's glass recipe requires over a photo and its Cards recipe forbids on a solid `--panel` card. An earlier draft of this plan wrongly asserted both were 74; do not add a border to the float to make the numbers agree.

- [ ] **Step 4: Every search-bar select has real headroom for its longest option**

**Do not use `scrollWidth > clientWidth` to test a `<select>` for clipping.** An
earlier draft of this plan did, and it is useless: a native select reports
`scrollWidth === clientWidth` regardless of whether its text is visibly
ellipsised, so the check returns `false` even on the 73px control that was
demonstrably rendering `Any t…`. Task 3 confirmed this empirically. Measure the
text against the box instead:

```js
(() => {
  const ctx = document.createElement('canvas').getContext('2d')
  const ids = ['home-search-city','home-search-hour','home-search-until','search-city','search-hour','search-until']
  const rows = ids.map((id) => document.getElementById(id)).filter(Boolean).map((e) => {
    const cs = getComputedStyle(e)
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const widest = Math.max(...[...e.options].map((o) => ctx.measureText(o.text).width))
    const avail = e.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    return { id: e.id, appearance: cs.appearance, widestOption: Math.round(widest), availableWidth: Math.round(avail), fitsLongest: avail >= widest }
  })
  return JSON.stringify({ page: location.pathname, rows }, null, 1)
})()
```

Run on `/` (yields the three `home-search-*` rows) and on
`/search?city=tacloban` (yields the three `search-*` rows). Expected on both:
**`fitsLongest: true` and `appearance: "none"` for every row.**

Both halves are needed. `fitsLongest` alone is not enough, because with
`appearance: auto` the browser reserves room for its own arrow *inside* the
control where `paddingRight` cannot see it — which is exactly how the original
73px control fit a 66px label on paper while clipping on screen. `appearance:
"none"` is what proves that hidden reservation is gone, so the measured
`availableWidth` is the real available width.

For reference, `/search`'s `search-hour` reports `availableWidth: 96` against
`widestOption: 66` — a 116px box less the chevron's 20px right padding. (An
earlier draft of this step said 167; that was a stale reading taken before the
chevron padding was applied. 96 is the reproducible value.)

Note the `filter-sort` and `filter-max-price` selects on `/search` are
deliberately still `appearance: auto` — they are out of this pass's scope (see
the spec's Out of scope list). Excluding them from `ids` above is intentional;
do not "fix" them.

- [ ] **Step 5: Both pages at all four breakpoints**

For `/` and `/search?city=tacloban`, at **1309, 980, 768, 375** — resize, reload, run:

```js
JSON.stringify({ vw: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth })
```

All eight must report `overflow: false`.

- [ ] **Step 6: Confirm the CTA copy is character-exact in both bars**

```js
(() => { const b = [...document.querySelectorAll('button')].filter((x) => /Find a Court/.test(x.textContent)); return JSON.stringify({ count: b.length, texts: b.map((x) => JSON.stringify(x.textContent.trim())) }) })()
```

On each page: `count: 1`, text exactly `"Find a Court"`. A count of 0 means a label was missed; a stray `"Find a court"` or `"Find A Court"` is a copy bug — the constraint is character-identical.

- [ ] **Step 7: Confirm the existing test suites still pass, unchanged**

This pass touched no parsing or query code, so these must pass with **no edits to any test file**. Run in the foreground (never backgrounded) against the hosted DB:

```bash
npx vitest run tests/lib/search/params.test.ts tests/branches/search.test.ts
```

Expected: all pass. If a test fails on a pool-contention timeout rather than an assertion, re-run that single file in isolation to confirm — a timeout is an infrastructure flake on this shared hosted DB, an assertion failure is a real regression from this change.

Also confirm no test file was modified:

```bash
git status --short tests/
```

Expected: no output at all.

- [ ] **Step 8: Capture the screenshots**

```bash
mkdir -p docs/screenshots
```

At a desktop viewport, screenshot `/` and `/search?city=tacloban`, saving to `docs/screenshots/2026-08-07-home-search-bar.png` and `docs/screenshots/2026-08-07-search-float.png`. Never the repo root — project rule.

- [ ] **Step 9: Report**

Final report to the user:

- The identical `left`/`w`/`h` from Step 3, as the headline result
- `clipped: true → false` on `search-hour`, the original defect
- All eight `overflow: false` results
- Clean `tsc`, `eslint`, and the two test suites passing with `tests/` untouched
- The two screenshots
- The list of exactly five files changed, with `wordmark.tsx` explicitly called out as the other session's
- An explicit note that **nothing was committed**, and the working tree is the user's to review and commit

---

## Notes for the executing agent

**You are the implementer.** Do not delegate any task in this plan to another subagent — implement it yourself, in the working directory. Do not create a git worktree.

**On "tests" in this plan.** There is no DOM test harness in this repo; `tests/` holds integration tests that run against a hosted Supabase project and cover queries, not layout. For a presentation-only change the equivalent of a failing-then-passing test is the **measured browser assertion**: every task captures the defect numerically before the edit (Task 2 Step 1, Task 3 Step 1) and re-measures after (Task 2 Step 6, Task 3 Step 11). Treat a "before" measurement that does not reproduce the documented defect as a signal to stop and re-read, exactly as you would a test that passes before you have written the code.

**Do not "fix" things you notice in passing.** The spec's "Out of scope" section lists several tempting adjacent items — a custom date picker to fix the `08/07/2026` format, a shared search-bar component, typeahead over venue names, converting the sort select's chevron. All were considered and deliberately excluded. Flag them in your report; do not implement them.
