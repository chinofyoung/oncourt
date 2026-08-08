# Search bar: visual polish, full-width `/search` float, "Find a Court" CTA

**Date:** 2026-08-07
**Status:** approved, ready for implementation

## Problem

The two search bars — the home hero's GET form (`src/app/page.tsx`) and
`/search`'s client float (`src/components/search/map-hero.tsx`) — work
correctly. This is a **presentation-only** pass over both. Nothing about what
they submit, parse, or filter changes.

Seven defects, confirmed by measuring the rendered pages at a 1309px viewport:

1. **`/search`'s Time start select renders clipped as `Any t…`.** The float is
   711px wide and its cells are `flex-none px-4`, so each hour select gets
   **73px** — narrower than the widest option label ("Any time"). `truncate`
   then does exactly what it was asked to.
2. **The float is ~⅔ the home bar's width.** 711px against the home form's
   1072px, on pages sharing the same 1120px design column, so the two bars read
   as different components rather than one component in two skins.
3. **All four selects are `appearance: auto`.** The bar's chrome is the
   browser's — three native chevrons plus the date field's calendar
   indicator, each at a different size and offset, and rendering as grey system
   boxes on the float's white panel. Nothing in `branding.md` asked for native
   widgets in a hand-built control.
4. **The date reads `08/07/2026`, 8px below a pill reading `Fri, Aug 7`.** One
   date, two formats, one view — and neither native format is the documented
   `Fri, Aug 7`.
5. **The two bars have drifted on values that should match:** 15.5px vs 14.5px
   field text, `px-[30px]` vs `px-[26px]` on the button, `gap-2` vs `gap-1`,
   `p-2` vs `p-4`, and a hover affordance on the home cells that the float's
   cells don't have.
6. **"USE MY LOCATION" competes with its own field label.** A 10px lime
   underlined uppercase mono link sits beside the 10px grey uppercase mono
   `WHERE` label in a row with 3px of bottom margin — two near-identical
   treatments fighting in the same row.
7. **The home hero's content column is 24px narrower than every other column
   on the page.** The hero's inner wrapper is `mx-auto max-w-[1120px] px-6`,
   giving 1072px of content starting at x=119. The nav, `main`, and the footer
   all use the full-bleed padding formula and start at **x=95** with 1120px of
   content. Measured at a 1309px viewport: nav wordmark 95, `main` heading 95,
   footer 95, hero h1 **119**. The hero is the sole outlier, so the headline
   and search bar sit 24px inboard of the cards directly beneath them.

Separately, the user has asked for the CTA to read **"Find a Court"** in both
bars, and for the `/search` bar to be full width like the home bar.

## Decisions

| Question | Decision |
|---|---|
| CTA label | "Find a Court" in both bars, replacing "Search" |
| `/search` float width | Full content column — 1120px |
| Home hero column | Fixed to the 1120px padding formula, so both bars are **exactly** equal |
| `/search` field layout | Adopt the home bar's `1.25fr 1fr 1fr auto` grid |
| Time truncation | Fixed *by* the grid — Time gets ~281px, not a `max-w` tweak |
| Select chevrons | `appearance-none` + one brand chevron, two skins, as globals.css utilities |
| Date field | Stays `<input type="date">`; format mismatch accepted |
| Shared component | **Not** extracted — the two skins stay two files |
| "Use my location" | Stays in the Where cell; restyled to stop twinning the label |
| Home "Use my location" | **Not** added — that's a feature, not polish |

### Why the CTA reverses a decision made today

`design/branding.md`'s Voice entry currently records that this button read
"Find open courts" until 2026-08-07, when it became plain "Search", reasoning
that "the search bar beside it already says where, when and for how long, so
the longer label was restating its own field labels," and closing with "Prefer
the shortest label that is still unambiguous in context."

"Find a Court" reverses that. It was raised with the user, who confirmed it.
The rewritten entry must not read as if the earlier decision never happened —
it records both the shortening and this reversal, so the next person to touch
the label sees that "shortest possible" was tried and set aside in favour of a
verb phrase that names the object. The general "prefer the shortest label"
guidance survives; the specific claim that "Search" is the right label does not.

### Why not a custom date picker

Making the field read `Fri, Aug 7` means replacing `<input type="date">` with a
text input plus a calendar component. That is a new component with its own
keyboard handling, locale behaviour, and validation surface — not polish — and
it costs the native date wheel on mobile, which is the best date-entry UI on a
phone. The mismatch between the field (`08/07/2026`) and the pill above it
(`Fri, Aug 7`) is accepted for now. The pill is not changed to match the field:
`Fri, Aug 7` is the documented format and the field is the one that can't be
changed cheaply.

### Why the two bars stay two files

`branding.md`'s Controls section states the time-range field is "Built twice,
on purpose: `src/app/page.tsx`'s hero (white-on-glass) and
`src/components/search/map-hero.tsx`'s float (ink-on-panel) share the hour logic
in `src/lib/search/hours.ts` but not the markup — the two skins have nothing
stylable in common." That still holds: the glass skin's colours are all
`white/NN` literals over a photo, the panel skin's are `var(--*)` tokens on
white. Extracting a shared component means either a `skin` prop that switches
every colour, or a token indirection layer for two call sites.

This pass therefore removes drift by **matching values across the two files**,
not by merging them. The one thing that does get shared is the chevron, because
that genuinely is common (see below).

## Design

### 1. Both bars land on the same 1120px column

Two edits that together make "the same width" literally true rather than
approximately true. Done in one section because doing either alone leaves a
misalignment somewhere.

#### 1a. The home hero joins the shared column — `src/app/page.tsx`

The hero's inner wrapper changes from `mx-auto max-w-[1120px] px-6` to the
full-bleed padding formula the rest of the page already uses:

```
px-[max(24px,calc((100vw-1120px)/2))]
```

The kicker, h1, subhead, and search form all shift 24px left and the form grows
from 1072px to 1120px. The hero then aligns with the nav above it and the cards
below it — all four columns at x=95 with 1120px of content.

**This deliberately moves more than the search bar.** The headline moves too;
that is the point, since the misalignment is the wrapper's, not the form's, and
pinning only the form to 1120px inside a 1072px wrapper would fix the symptom
by adding a second inconsistency. `main`'s own comment in this file already
documents why the padding formula is the pattern here (a `mx-auto` flex item
loses `align-self: stretch` and shrink-to-fits, which overflowed the page at
375px); the hero is inside a `relative` header rather than the flex column, so
it never hit that bug and was never converted. It is converted now for
alignment, and the same formula is correct either way.

**Do not add `max-w-[1120px]` back alongside the padding.** The formula already
caps the content at 1120px by growing the padding; a `max-w` on top would
re-center a narrower box inside it and undo the alignment.

#### 1b. The `/search` float goes full width — `src/components/search/map-hero.tsx`

The float is currently `absolute bottom-6 left-[...]` with `flex items-stretch
gap-1` and `flex-none` cells, so it shrinks to its content. It becomes a
full-column grid matching the home bar.

**Positioning.** The existing `COLUMN_LEFT` constant pins the left edge to the
content column and doubles as the horizontal margin once the float goes static
at ≤980px. It gains a matching right inset:

```
left-[max(24px,calc((100vw-1120px)/2))]
right-[max(24px,calc((100vw-1120px)/2))]
max-[980px]:mx-[max(24px,calc((100vw-1120px)/2))]
```

Above a 1168px viewport this leaves exactly 1120px between the insets; below it
both clamp to 24px. The `max-[980px]:static` rule already in place makes the
`left`/`right` values inert when the float leaves the map band, so the `mx-`
margin keeps working unchanged — a static element ignores `left`/`right`
entirely, so the two rules cannot fight.

Rename the constant `COLUMN_INSET`; `COLUMN_LEFT` would now be a lie about what
it does.

**Layout.** `flex items-stretch gap-1` becomes the home bar's grid, verbatim:

```
grid grid-cols-[1.25fr_1fr_1fr_auto] items-center gap-2
max-[980px]:grid-cols-2 max-[980px]:gap-1.5
```

and the cell class drops `flex-none` / `max-[980px]:flex-auto` (both are flex
concepts) in favour of the home bar's per-cell span rules —
`max-[980px]:col-span-2` on Where, `max-[560px]:col-span-2` on Date and Time.
The float's `max-[980px]:flex-wrap` / `gap-y-2.5` go with the flex container.

At 1120px the grid gives Where ~352px, Date ~281px, Time ~281px, and the button
its intrinsic width. Note the fractional tracks land at almost exactly the home
bar's current values despite the container growing 48px: "Find a Court" is a
wider `auto` track than "Search" was, and it absorbs the difference. **This is
what fixes defect 1**: after the cell's `px-4`, the en dash, and the `gap-1.5`,
each hour select lands at ~113px against a longest label ("Any time") that needs
~66px, so `truncate` never fires.

No `max-w` on the hour selects, and no change to `rangeSelectClass`'s `flex-1
min-w-0` — that pair is still what keeps two selects from forcing the page
sideways at 560px, per the Layout rule, and the comment above it stays.

**Padding.** `p-4` → `p-2`, matching home, taking the float from 88px to 72px
tall (56px `--control-h` + 16px padding).

The home form measures 74px, not 72: it carries `border border-white/[.18]`, the
1px edge the glass recipe requires over a photo. That 2px delta is the one thing
the two skins are *supposed* to differ by, and the float must not grow a border
to erase it — branding.md's Cards recipe gives a solid `--panel` card a shadow
and no border. The bars are the same component in two places on the axes that
carry that claim: 1120px wide, left edge on the column, 56px fields, same
tracks, same type scale.

### 2. Value alignment across both bars

| Property | Home (before) | Float (before) | After, both |
|---|---|---|---|
| Field value text | 15.5px | 14.5px | **15.5px** |
| Button text | 15.5px | 14.5px | **15.5px** |
| Button padding | `px-[30px]` | `px-[26px]` | **`px-[30px]`** |
| Container padding | `p-2` | `p-4` | **`p-2`** |
| Grid gap | `gap-2` | `gap-1` | **`gap-2`** |
| Cell hover | `hover:bg-white/[.07]` | none | per-skin, see below |
| Button `whitespace-nowrap` | absent | present | **present** |

The float's `valueBase` / `valueClass` / `rangeSelectClass` constants and its
button move to 15.5px. The float's cells gain a hover in the panel skin's own
vocabulary — `hover:bg-[var(--surface)]`, the page background, which on a white
panel is the same barely-there wash that `white/[.07]` is on glass. Both keep
`transition-colors` with a `motion-reduce:transition-none` guard, per Motion.

`whitespace-nowrap` on the home button is not cosmetic: "Find a Court" is three
words where "Search" was one, and without it the label can break across lines
inside a fixed 56px button at narrow widths. The float already has it.

The 12px `--btn-radius` on cells, the 20px container radius, and every colour
token stay as they are in each skin. Nothing in `branding.md`'s Controls block
changes numerically.

### 3. One brand chevron, two skins — `src/app/globals.css`

Every `<select>` in both bars gets `appearance-none` plus a chevron drawn as an
inline-SVG `background-image`, right-aligned with `pr-5` clearing it.

This lands as **two utility classes in `globals.css`**, not as inline arbitrary
values:

```css
.select-chevron-light { /* glass skin: rgba(255,255,255,.55) stroke */ }
.select-chevron-dark  { /* panel skin: #5B6E60 (--ink-soft) stroke */ }
```

Two reasons it belongs in the stylesheet rather than inline. First, an SVG data
URI is ~120 characters of percent-encoded markup; repeated across four selects
in two files it is unreadable and will drift. Second, the stroke colour has to
be a literal hex — a data URI cannot read a CSS custom property — so the two
places a hex appears un-tokenised (`#5B6E60` for the panel skin, mirroring
`--ink-soft`; `#FFFFFF` at `.55` opacity for the glass skin, matching the
`white/55` labels beside it) should be two declarations under one comment that
names both, not four copies scattered through JSX.

This follows the precedent already set in `branding.md`'s Controls section for
`cursor: pointer`: a single base rule in `globals.css` rather than a per-
component class, for exactly the "don't re-add it component by component"
reason.

Chevron geometry: a 10×10 box, 1.75px stroke, `round` caps and joins, matching
the "subtle and purposeful" line weight the rest of the system uses. The same
glyph at the same size on all four selects — the current inconsistency is
that each native widget picks its own.

**The date field's calendar indicator stays**, but stops being default chrome:
`[&::-webkit-calendar-picker-indicator]` gets an explicit `opacity` and, in the
glass skin, the existing `[color-scheme:dark]` continues to render it white. It
is a *different* control from a select — it opens a picker rather than a list —
so giving it the select chevron would be a lie about what it does. Normalising
its opacity so it reads as deliberate is the fix; replacing it is not.

Only the two search bars are touched. Other selects in the app (the sort
select, the price filter) keep their current treatment — bringing them onto the
same chevron is a follow-up, not this pass, and the two new utilities are
available for it.

### 4. "Use my location" stops twinning its label — `map-hero.tsx`

The link keeps its position in the Where cell's label row and its handler
unchanged (silent no-op on denied permission). Only its type treatment changes:
it drops `uppercase` and the permanent `underline`, moving to sentence case at
10.5px semibold in `--court`, with `hover:underline` plus the existing
`hover:text-[var(--court-deep)]`.

The row then reads `WHERE   Use my location` — a mono uppercase label beside a
sentence-case link, which is two distinguishable things, instead of two 10px
mono uppercase runs that the eye reads as one broken label. It stays a text
link rather than becoming a button or an icon, preserving the reasoning already
recorded in the file: as a text link it "stops competing with the lime Search
for attention."

The home bar does **not** gain this link. It has no geolocation handler and
adding one is a behaviour change.

### 5. CTA copy

`src/app/page.tsx`'s submit button and `map-hero.tsx`'s refresh button both
read **"Find a Court"**. Title case as written by the user.

Neither button's behaviour changes: home still submits the GET form to
`/search`, the float still calls `router.refresh()` for the reason its comment
gives (availability moves with the clock, so the same URL can return a
different answer a minute later). Both stay lime, and each page still has
exactly one lime button, so "Never two lime buttons in one view" continues to
hold — the home owner CTA is still the light variant for that reason.

### 6. `design/branding.md`

In the same turn as the code, per the project rule.

**Concurrency warning.** At the time this spec was written another session had
`design/branding.md` and `src/components/site/wordmark.tsx` uncommitted in the
working tree, rewriting the **Name** and **Wordmark** bullets ("oncourt" →
"onCourt"). The edits below touch **Voice** and **Controls** only, so they do
not overlap — but make them as targeted string replacements after re-reading the
file, never by rewriting it wholesale, or that session's work is lost.

Three edits, then — Voice, Layout, Controls.

**Voice** — the sentence recording "Search" is rewritten to record the full
history: "Find open courts" → "Search" (2026-08-07, shortest-unambiguous-label
reasoning) → "Find a Court" (2026-08-07, by explicit user instruction). The
"prefer the shortest label" guidance stays as a general preference; the claim
that "Search" specifically is right does not. The examples list in that entry
(`"Search"`, `"Book now"`, `"List your court"`) updates its first item.

**Layout** — the "Content column: 1120px max, centered, 24px side padding"
bullet gains the mechanism, because "centered with 24px padding" describes two
implementations that do not produce the same column: `mx-auto max-w-[1120px]
px-6` yields 1072px of content, while `px-[max(24px,calc((100vw-1120px)/2))]`
yields 1120px. The padding formula is the rule for every band — including
content sitting inside a `relative` hero, which is where the one exception had
survived — and the two must never be combined, since a `max-w` inside the
formula re-centers a narrower box and breaks alignment. That ambiguity is what
produced defect 7; naming it is what stops it recurring.

**Controls** — the time-range entry's closing "Built twice, on purpose"
sentence stays true and stays, with two additions: that both skins now render
the same brand chevron via the `globals.css` utilities (so the shared thing is
named, and the next person doesn't re-add a native chevron), and that the
`/search` float spans the full content column on the same
`1.25fr 1fr 1fr auto` grid as the home hero, so the two bars are the same
size. A new line records that `<select>`s in the search bars are
`appearance-none` with the shared chevron, and that `<input type="date">`
deliberately keeps its native indicator.

## Out of scope

Named explicitly so they aren't picked up mid-implementation:

- Any change to `parseSearchParams`, `SearchFilters`, `CITIES`, or
  `src/lib/search/hours.ts`. No behaviour, no URL contract, no query.
- A custom date picker, or changing the `Fri, Aug 7` pill to match the field.
- Extracting a shared search-bar component.
- Adding "Use my location" (or any new control) to the home bar.
- Free-text / typeahead search over venue names — the `Where` select keeps its
  two `CITIES` options.
- Re-skinning the sort select, the price filter, or any other select outside
  the two search bars.

## Verification

The bars are public and need no auth, so both are directly checkable in the
browser pane against `oncourt-dev`.

1. `npx tsc --noEmit` and the project lint both clean.
2. At 1309px, the home form and the `/search` float both measure **1120px wide
   with a left edge at x=95**, and on the home page the nav wordmark, h1,
   `main`'s heading, and the footer all report the same x=95. These are the
   numbers the alignment fix is for; assert them by measurement, not by eye.
3. `/search?city=tacloban` at 1309px (and again across the width sweep in item
   4): confirm `Any t…` is gone using `canvas.measureText`, not
   `scrollWidth > clientWidth` — that check returns `false` on a `<select>`
   regardless of whether its text is visibly ellipsised, so it cannot detect
   the very defect it exists to catch. For each select, measure the widest
   `<option>` text against the control's content box (`getBoundingClientRect`
   width minus left/right padding) and require BOTH `fitsLongest: true` AND
   `appearance: "none"` — with `appearance: auto` the browser reserves arrow
   space *inside* the control where `paddingRight` can't see it, which is
   exactly how a 73px box "fit" a 66px label on paper while clipping on
   screen:

   ```js
   (() => {
     const ctx = document.createElement('canvas').getContext('2d')
     const ids = ['home-search-city', 'home-search-hour', 'home-search-until',
       'search-city', 'search-hour', 'search-until']
     const rows = ids.map((id) => document.getElementById(id)).filter(Boolean).map((e) => {
       const cs = getComputedStyle(e)
       ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
       const widest = Math.max(...[...e.options].map((o) => ctx.measureText(o.text).width))
       const avail = e.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
       return { id: e.id, appearance: cs.appearance, widestOption: Math.round(widest),
         availableWidth: Math.round(avail), fitsLongest: avail >= widest }
     })
     return JSON.stringify({ page: location.pathname, vw: innerWidth, rows }, null, 1)
   })()
   ```
4. Both bars at 1309px, 980px, 768px, and 375px: no horizontal page scroll
   (`document.documentElement.scrollWidth <= window.innerWidth`), which is the
   Layout rule that the `min-w-0` chain exists to protect. 375px matters most
   here — the hero's wrapper change is the one edit that could reintroduce the
   overflow `main`'s comment documents.
5. Screenshots of both bars, saved under `docs/screenshots/` per the project
   rule — never the repo root.
6. `npx vitest run` on the existing search suites
   (`tests/lib/search/params.test.ts`, `tests/branches/search.test.ts`). This
   pass touches no parsing or query code, so they must pass **unchanged**; a
   diff to any test file is a signal that the change escaped its scope. Run in
   the foreground against the hosted DB.
