# OnCourt — Branding & Design Guidelines

> Source of truth for all UI/design work on this project. Read this before designing
> or building any page, component, or mockup. When the user requests branding changes,
> UPDATE THIS FILE in the same turn so it stays authoritative.

## Brand

- **Name:** `oncourt` — double meaning: booked on a court, and actually on the court playing. Always lowercase in the wordmark.
- **Wordmark:** "oncourt" in display font weight 800, followed by a small lime square (8×8px, 2px radius, `--ball` fill). On light backgrounds add a `1.5px solid var(--ink)` border so the square keeps contrast; on dark/photo backgrounds no border. Same rule at footer size.
- **Product:** pickleball court booking marketplace, Philippines-first (GCash/Maya culture).
- **Voice:** plain, energetic, player-to-player. Never corporate. Buttons say exactly what they do ("Search", "Book now", "List your court"). The home hero's button read "Find open courts" until 2026-08-07, when it became plain "Search" — the search bar beside it already says where, when and for how long, so the longer label was restating its own field labels. Prefer the shortest label that is still unambiguous in context.
- **Language: English only.** An earlier version of this doc called for "light Taglish accents where natural" and gave "Laro na." / "May court ka?" as examples; that was reversed by explicit user instruction ("text should always be english"). Philippines-first still shapes *what* the copy talks about — pesos, GCash/Maya, local cities — but not the language it's written in. The strings that carried the old voice were replaced in the built app: the home hero now reads "Game on." (was "Laro na."), the owner CTA "Own a court?" (was "May court ka?"), the empty-state line dropped "mga bossing", and the site metadata description in `src/app/layout.tsx` ends "Game on." Files in `design/mockups/` still contain the old Taglish strings — they predate this change and were not swept; **the built app under `src/` is authoritative** where a mockup disagrees.

## Color

Solid colors ONLY. No gradients of any kind (linear, radial, repeating — none), no glows.

| Token | Value | Use |
|---|---|---|
| `--ink` | `#0C1F16` | Primary text, dark surfaces |
| `--ink-soft` | `#5B6E60` | Secondary text |
| `--surface` | `#FAFBF8` | Page background |
| `--panel` | `#FFFFFF` | Cards, panels |
| `--hairline` | `#E5EAE2` | Borders, dividers |
| `--court` | `#2E6B4F` | Primary green (links, kickers, accents) |
| `--court-deep` | `#143D2C` | Dark green (CTA panels, hovers) |
| `--ball` | `#E8FF54` | Optic lime — THE accent. Selection, primary buttons, highlights only. Use sparingly. |
| `--ball-ink` | `#232D00` | Text on lime |
| `--booked` | `#E7ECE2` | Disabled/booked states (flat, no texture) |
| `--band-off` | `#EAF2E4` | Soft green tint — outdoor-court tag, informational banners. (No longer a rate-band tint; see Availability grid below.) |

Dark overlay on hero photos: solid `rgba(6, 20, 13, .68)`.
Glass surfaces (over photos only): `rgba(255,255,255,.09)` bg + `rgba(255,255,255,.18)` 1px border + `backdrop-filter: blur(22px)`.

## Typography

Google Fonts import: `Inter+Tight:wght@500;600;700;800`, `Inter:wght@400;500;600`, `Spline+Sans+Mono:wght@400;500;600`.

| Token | Stack | Use |
|---|---|---|
| `--display` | `"Inter Tight", "Inter", "Helvetica Neue", Arial, sans-serif` | Headlines, card titles, buttons. Tight letter-spacing (−0.015em to −0.035em as size grows). |
| `--body` | `"Inter", "Helvetica Neue", Arial, sans-serif` | Body text, 15px base, line-height ~1.55 |
| `--mono` | `"Spline Sans Mono", "SF Mono", Menlo, monospace` | Times, prices, data, eyebrows/kickers (10–12px, uppercase, letter-spacing .12–.16em) |

Headline scale: h1 68px (desktop) / 44px / 38px (mobile); section h2 30px; card h3 18px.

## Layout

- **Content column: 1120px max**, centered, 24px side padding. Full-bleed bands (nav, hero, footer) pad with `max(24px, calc((100vw - 1120px) / 2))`.
- Section rhythm: 72px top padding between major sections (56px mobile).
- Breakpoints: `980px` (stack columns, hide nav links), `560px` (tighten type, full-width CTAs, stacked footer).
- Mobile: wide tables/grids scroll horizontally inside their own container with a sticky first column; the page itself never scrolls sideways.

## Controls (standardized — always use these tokens)

```css
--control-h: 56px;   /* hero-level fields + their primary button */
--btn-h: 48px;       /* standard buttons (Book now, CTAs) */
--btn-h-sm: 38px;    /* compact controls (icon buttons, form fields, nav pill) */
--slot-h: 30px;      /* availability-grid slot cells */
--btn-radius: 12px;  /* ONE corner radius for ALL buttons and input fields */
```

- Buttons: display font, weight 700, `inline-flex; align-items: center`, height from token, horizontal padding only.
- Primary action: lime (`--ball` bg, `--ball-ink` text). On light panels a dark button (`--ink` bg, `--ball` text) is the alternative primary. Never two lime buttons in one view.
- Focus: `outline: 2px solid var(--ball); outline-offset: 3px` on dark, `var(--court)` on light.
- Cursor: everything clickable shows `cursor: pointer` on hover — buttons, `role="button"`, `<summary>`, selects, checkboxes/radios and their labels. Disabled controls keep the default arrow (they aren't clickable), and labels above text fields stay default (they aren't a click target). This is a **single base rule in `src/app/globals.css`**, not a per-component class: Tailwind v4's preflight reverted buttons to the browser default `cursor: default` (v3 forced pointer), so without that rule every button in the app renders with an arrow. Don't re-add `cursor-pointer` component by component.
- Non-interactive chips/badges stay pill-shaped (`border-radius: 999px`) to distinguish them from buttons.
- **Time-range field:** a span is ONE field holding TWO selects with a spaced en dash between them (`[ Any time ▾ ] – [ — ▾ ]`), not two fields and not two grid columns — the label sits above the pair, and the dash is `aria-hidden` decoration matching the `7 – 9 AM` convention under "Currency & data formatting". The empty start option reads "Any time"; the empty end option is an em dash, meaning "just that hour". Each select needs its own accessible name ("Time from" / "Time until"), since one visible label can't name two controls. The end select narrows to hours after the chosen start and goes inert with no start — but only where the page is already a client component; a server-rendered GET form lists all end hours and lets the server drop an impossible pair, so client narrowing is never load-bearing. Both selects need `min-w-0` (and their container too): the `truncate` on a select refuses to shrink below its text width, and two of them in one cell will otherwise push the page sideways, which the Layout rule forbids. Below 560px give the field the full row rather than making two selects share half of a phone screen. Built twice, on purpose: `src/app/page.tsx`'s hero (white-on-glass) and `src/components/search/map-hero.tsx`'s float (ink-on-panel) share the hour logic in `src/lib/search/hours.ts` but not the markup — the two skins have nothing stylable in common.

## Components

- **Nav:** floating over heroes (absolute, transparent, white text + glass pill) or solid `--surface` with hairline border on utility pages. Right side: "List your court" pill + 36px avatar.
- **Cards, base recipe:** white, `border-radius: 20px`, no border, shadow `--shadow-sm` (`0 1px 2px rgba(12,31,22,.06), 0 4px 16px rgba(12,31,22,.05)`). Two different things are built on this one base, and they are not interchangeable:
  - **Panels** — a page section framed in the card recipe: settings, the bookings list, the earnings page, `stat-card.tsx`, "Branch details"/"Branch photos" form cards, dashed-border empty states. Static: no hover, no cover photo, no stretched link. Padding and internal layout are whatever the section's content needs.
  - **Entity cards** — a clickable tile that links to a different branch/court/record, with a cover photo, a hover lift (`--shadow-lg`, `0 12px 32px rgba(12,31,22,.12)`, −4px translate, image scale 1.045), and a precise structure. See the dedicated section below. Do not add hover-lift/cover-photo/stretched-link to a panel, and do not fold a panel's own controls (multi-field forms, moderation actions) into an entity card's structure — see "Documented variants" below for how the admin queue card resolves that tension instead.
- **Section headers:** mono uppercase kicker in `--court` above a display h2; optional right-aligned text link "… →".
- **Availability grid** (signature component): time rows × court columns; the time spine is a plain mono time column (sticky-left), **not** tinted by rate band — an earlier version of this doc specified a shared off-peak/peak tint on that column (a `--band-peak` token), but the real data model has rate bands *per court*, not per branch, so two courts in the same grid can define different band edges (or even a different count of bands) for the same hour. A single shared tint column would be correct for at most one of the visible courts and misleading for the rest, so it was dropped rather than shipped inaccurate (see `src/lib/booking/availability.ts`/`src/components/availability-grid.tsx`, task-9-report.md fix round 1). Open cells show a price in mono (in the cell, or once per row in the spine — see Density below); booked cells flat `--booked`; selected cells lime with 1.5px ink border and court-corner tick marks (7×7px, 2px strokes, top-left + bottom-right). A fourth, non-interactive cell state — **past** — covers an hour whose end instant has already passed today (no lead-time buffer; mirrors the payment webhook's `ends_at <= now()` gate so a slot can never be paid for after it renders open): `border-dashed border-[var(--hairline)]` on a transparent fill, `--ink-soft` text, "Past" label, `opacity-70`. Deliberately distinct from both neighbors it could otherwise be confused with — flat `--booked` fill ("Booked") means someone else holds the slot; the plain borderless `opacity-50` "closed" treatment means the court doesn't operate at that hour regardless of the clock. The dashed border reuses the same "info not available" vocabulary as this page's map empty-state block. Density: slot chips are `--slot-h` (30px) in a `px-1 py-0.5` cell, giving ~34px rows; cell labels are 10px mono. The time spine is **shrink-to-fit** (`w-px whitespace-nowrap`), never a fixed or leftover-width column — a `w-full` table hands spare width to its first column, which on a single-court branch rendered a ~340px time column. Slot chips are deliberately NOT max-width capped: a 168px centered cap was tried and read as broken on a one-court branch (a small pill stranded in ~460px of blank column, every row), so chips fill their column and stay a wide, obvious click target. The shrink-to-fit spine is what reclaims the wasted width. When every `open` cell in a row quotes the same price, that price renders once in the spine (right-aligned, muted mono, same line as the time) and those cells render blank; when open cells disagree, each prints its own price. This is decided per row and only after verifying agreement, so it does not reintroduce the shared-band assumption that killed the tint. Because open cells can be blank, a mono-uppercase legend (Available / Selected / Booked / Past / Closed, swatches reusing each state's own fill and border) sits between the table and the summary bar.

  **Mockups vs. built app:** several files in `design/mockups/` (`admin-approvals.html`, `branch-page.html`, `checkout.html`, `index.html`, `owner-dashboard.html`, `player-dashboard.html`, `search-results.html`) still define `--band-peak` and/or render the tinted time-spine this entry describes as dropped — `branch-page.html` in particular still visibly renders it. Those mockups predate this change and were not updated when it landed; they are intentionally left as-is (not edited as part of this fix) rather than treated as a design decision to re-litigate. Where a mockup and the built app disagree on this point, **the built app is authoritative** — go by `src/components/availability-grid.tsx`, not the mockup HTML.
- **Tab strip:** a `<nav>` of plain links, not `role="tab"`/`aria-selected` — these tabs navigate to a URL (`?tab=`), they don't toggle a panel in place, so link semantics plus `aria-current="page"` on the active one is the honest choice. Underline style: `font-display` weight 700, 2px bottom border, active tab `border-[var(--ink)] text-[var(--ink)]`, inactive `border-transparent text-[var(--ink-soft)]` hovering to `--ink`, the row sitting on a `--hairline` bottom border. See `src/app/bookings/page.tsx` and `src/app/dashboard/listings/[branchId]/page.tsx`.
- **Rating:** lime dot (7px, ink outline) + bold number, count in parens muted.
- **Maps:** Leaflet + CARTO Positron light tiles (`https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png`, the `light_all` basemap). The two-tone look is produced by an inline SVG duotone filter applied to `.leaflet-tile-pane`: a `feColorMatrix` reduces the tile image to luminance, feeding a `feComponentTransfer` whose per-channel `feFuncR`/`feFuncG`/`feFuncB` lookup tables remap that luminance into two brand tones — dark tile values map to `--court-deep`, light tile values map to `--band-off`. It's applied via CSS as exactly `filter: url(#duotone) contrast(1.06)` on `.leaflet-tile-pane`. Exact tableValues, so the filter is reproducible from this doc alone: feFuncR `0.078 0.918`, feFuncG `0.239 0.949`, feFuncB `0.173 0.894`. Markers live in Leaflet's marker pane, a sibling of (outside) the tile pane, so the filter does not apply to them — markers stay untinted; price markers are pills: white bg, `--ink` text, mono 12px, `--shadow-sm`, 999px radius, active/hover inverts to `--ball` bg with a 1.5px `--ink` border. Attribution stays legible. **Warning:** container-level blend-mode overlays do NOT work with Leaflet — `.leaflet-map-pane` sits at z-index 400 on the map container, so any overlay is either fully below the map or fully above the markers and can never tint the tiles.
- **Live indicator:** small pulsing dot + mono uppercase label (respect `prefers-reduced-motion`).
- **Forms with a map** (e.g. the branch form): two columns above 980px, fields
  left, map on its own `sticky` right column so pinning a location doesn't
  require scrolling away from the map; collapses to one column at 980px, map
  back in normal flow at a short height. The dashboard shell (sidebar + fluid
  content, no 1120px cap — that column rule is for marketing/public pages
  only) means the map column gets a `minmax()` width cap rather than an `fr`
  share, so it doesn't balloon on a wide monitor. The primary form action sits
  top-right of the form's own header row — the page header when a page has
  one form, the card header next to its `<h2>` when the page has several —
  not buried below the fold; since `pending` state lives in the client form
  component, the header moves there too wherever it needs to read it. A
  top-right card-header button that only *navigates* to another page (e.g.
  "Add court" opening its own add-court page) needs no `pending` state and no
  client component — it stays a plain `Link` in the Server Component header,
  same row treatment, no move required. The
  same 980px collapse and `items-start` (cards size to their own content,
  not the tallest sibling) generalize to plain card grids on wide dashboard
  pages too, not just forms; unlike the map column there's no natural
  minmax cap for card content, so an even `fr` split is the default there.
  Reach for that pairing only when a page really has two cards' worth of
  content side by side — the branch page briefly paired photos against
  courts and then dropped it once a tab strip moved courts elsewhere,
  leaving one card alone in a half-width column. Prefer tabs over columns
  when the sections are separate concerns rather than a single view.

## Entity cards

A clickable tile that represents ONE thing — a branch, a court — with a
cover photo, a title, one line of meta, and (dashboard/admin contexts) an
action control. The canonical implementations: `src/components/ui/branch-
card.tsx` (public, used by `src/components/search/results-grid.tsx`), the
dashboard branch grid (`src/app/dashboard/listings/page.tsx`), the dashboard
court grid (`src/app/dashboard/listings/[branchId]/page.tsx`), and the admin
court queue (`src/app/admin/page.tsx`).

**What this is NOT.** Roughly 30 files in this codebase use
`rounded-[20px]` — most of them are page **panels**, not entity cards:
settings forms, the bookings list, the earnings page, `stat-card.tsx`, the
"Branch details"/"Branch photos" form cards, dashed-border empty states. The
tell: does removing the card change what page/record you're looking at? An
entity card is a link elsewhere; a panel just frames a section of the
current page. Don't give a panel a cover photo, a hover lift, or a
stretched-link structure because it happens to share the 20px/white/shadow
DNA — and don't reshape a panel's own multi-field form or moderation
controls to fit the entity-card skeleton below (see "Documented variants").

**Structure, top to bottom:**

1. **Outer wrapper** — sits directly on `--surface` (the page background),
   never nested inside another card/panel's padding (see "No nested cards"
   below). `overflow-hidden rounded-[20px] bg-[var(--panel)]` (no border),
   shadow `--shadow-sm`; hover `-translate-y-1` + shadow `--shadow-lg`;
   `transition-[transform,box-shadow] duration-[220ms]
   ease-[cubic-bezier(0.2,0.7,0.3,1)]`; guard with
   `motion-reduce:transform-none motion-reduce:transition-none`.
   - If the card is a pure link with no independent in-card control (the
     public `BranchCard`), the wrapper itself is the `<Link>`.
   - If the card carries its own action (an Edit button, etc.), the wrapper
     is a plain `<div className="group relative ...">` and the click target
     is a separate `<Link className="absolute inset-0 ...">` carrying an
     `sr-only` accessible name — nesting an `<a>` inside an `<a>` is invalid
     HTML. The action control is a POSITIONED sibling *after* it in DOM
     order (`relative z-10`), which paints above the stretched link and
     intercepts its own clicks; that ordering, not `pointer-events`, is what
     makes both work.
2. **Cover** — `aspect-[16/10] overflow-hidden`, no padding.
   - Photo: `<img>` `h-full w-full object-cover`, `transition-transform
     duration-500 ease-[cubic-bezier(0.2,0.7,0.3,1)]
     group-hover:scale-[1.045]`, same motion-reduce guard, plus a targeted
     `eslint-disable-next-line @next/next/no-img-element` (the bucket is
     public and the upload is already sized — `next/image` would add a
     loader round trip for no benefit on a dashboard/admin card).
   - No photo: a `flex items-center justify-center` div on
     `bg-[var(--band-off)]` showing the entity's initial letter,
     `font-display text-[40px] font-bold text-[var(--court-deep)]`.
   - If the wrapper is a `<div>` (the stretched-link case above), the cover
     div carries NO position/z-index of its own — a positioned cover would
     paint above the stretched link in DOM order and create a dead click
     zone over the whole photo.
3. **Body** — `px-5 pt-[18px] pb-5`.
   - Title: `font-display text-lg font-bold tracking-[-0.015em]
     text-[var(--ink)]`.
   - Meta line: `mt-[5px] text-[13px] text-[var(--ink-soft)]`, one line,
     `·`-separated facts (rating, city, distance, environment/surface...).
   - Below that: whatever the card needs — status/count pills
     (`font-mono rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[10.5px]
     tracking-[.05em] text-[var(--court-deep)] uppercase`), a price row
     behind a `border-t border-[var(--hairline)] pt-3.5` divider, amenity
     chips, a one-line status note — and, for cards with an action, the
     action button (`relative z-10`) last.

**No nested cards.** An entity card never lives inside another card's
padding/shadow — a shadowed tile inside a shadowed panel reads as mush. If a
grid of entity cards used to sit inside a panel `<section>` (the old Courts
tab, wrapped in the `CARD` class), pull the grid out so it sits directly on
`--surface`, with the section's `<h2>` and primary action promoted to a
plain header row above the grid instead. This retires an earlier version of
this doc's rule, which reached for a `--hairline`-bordered "nested card"
treatment for exactly that case
(`src/app/dashboard/listings/[branchId]/page.tsx`'s original Courts tab). It
is now superseded rather than a coexisting option: every entity-card grid in
the app sits on the page background, so there is one card treatment, not
two. If a future page is tempted to nest an entity-card grid inside a panel
again, lift the grid out instead of reintroducing the hairline variant.

**Documented variants** (deviate on purpose, not by drift):

- Public `BranchCard` adds a rating row and a price-from + court-count row
  behind the standard hairline divider — data the dashboard/admin cards
  don't carry.
- The admin court queue card (`src/app/admin/page.tsx`) is not a single
  clickable tile — it hosts several independent controls at once (approve/
  reject or suspend forms, a "View branch" link), so there is no single
  destination a whole-card click could mean. It therefore has no outer
  `<Link>`, no stretched-link structure, no hover-lift, and no cover-image
  zoom on hover — only its explicit interactive elements respond to hover/
  focus, the same reasoning that keeps a panel un-lifted. It also uses `p-6`
  body padding (`max-[560px]:p-5`) instead of the standard `px-5 pt-[18px]
  pb-5`, because its body carries substantially more (a price line, an
  hours/environment fact list, the forms above, the branch link) than a
  plain title+meta card, and the tighter standard padding read cramped
  against that much content.

## Photography

Real court/gameplay photos (Unsplash free tier, hotlinked with `?q=70&w=<size>&auto=format&fit=crop`). Prefer shots where the court is visible. Under dark overlays keep text contrast ≥ WCAG AA. No illustrations, no 3D renders.

## Motion

Subtle and purposeful: 0.15s color/filter transitions, 0.22s card lift with `cubic-bezier(.2,.7,.3,1)`, `:active { transform: scale(.98) }` on buttons. Always guard with `@media (prefers-reduced-motion: reduce)`.

## Currency & data formatting

- Peso amounts in mono: `₱300`, thousands separated: `₱1,022.90`. "from ₱200/hr" pattern for price-from.
- Times: `6 AM`, `7 – 9 AM` (spaced en dash), dates: `Fri, Aug 1`.

## Mockup conventions

- Mockups are self-contained local HTML files in `design/mockups/` (inline CSS/JS, no build step), previewed in the browser pane. Do NOT use DesignSync or Pencil.
- First line: `<!-- @dsCard group="Pages" name="<Page name>" -->`; then meta charset/viewport and `<title>`.
- No `<html>/<head>/<body>` wrapper tags needed. Light interactivity (selection, tabs) in vanilla JS is welcome.
- Reference implementations: `design/mockups/home.html`, `design/mockups/branch-page.html`.
