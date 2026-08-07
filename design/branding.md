# OnCourt — Branding & Design Guidelines

> Source of truth for all UI/design work on this project. Read this before designing
> or building any page, component, or mockup. When the user requests branding changes,
> UPDATE THIS FILE in the same turn so it stays authoritative.

## Brand

- **Name:** `oncourt` — double meaning: booked on a court, and actually on the court playing. Always lowercase in the wordmark.
- **Wordmark:** "oncourt" in display font weight 800, followed by a small lime square (8×8px, 2px radius, `--ball` fill). On light backgrounds add a `1.5px solid var(--ink)` border so the square keeps contrast; on dark/photo backgrounds no border. Same rule at footer size.
- **Product:** pickleball court booking marketplace, Philippines-first (GCash/Maya culture).
- **Voice:** plain, energetic, player-to-player. Never corporate. Buttons say exactly what they do ("Find open courts", "Book now", "List your court").
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
--btn-h-sm: 38px;    /* compact controls (icon buttons, slot cells, nav pill) */
--btn-radius: 12px;  /* ONE corner radius for ALL buttons and input fields */
```

- Buttons: display font, weight 700, `inline-flex; align-items: center`, height from token, horizontal padding only.
- Primary action: lime (`--ball` bg, `--ball-ink` text). On light panels a dark button (`--ink` bg, `--ball` text) is the alternative primary. Never two lime buttons in one view.
- Focus: `outline: 2px solid var(--ball); outline-offset: 3px` on dark, `var(--court)` on light.
- Cursor: everything clickable shows `cursor: pointer` on hover — buttons, `role="button"`, `<summary>`, selects, checkboxes/radios and their labels. Disabled controls keep the default arrow (they aren't clickable), and labels above text fields stay default (they aren't a click target). This is a **single base rule in `src/app/globals.css`**, not a per-component class: Tailwind v4's preflight reverted buttons to the browser default `cursor: default` (v3 forced pointer), so without that rule every button in the app renders with an arrow. Don't re-add `cursor-pointer` component by component.
- Non-interactive chips/badges stay pill-shaped (`border-radius: 999px`) to distinguish them from buttons.

## Components

- **Nav:** floating over heroes (absolute, transparent, white text + glass pill) or solid `--surface` with hairline border on utility pages. Right side: "List your court" pill + 36px avatar.
- **Cards:** white, `border-radius: 20px`, no border, shadow `--shadow-sm` (`0 1px 2px rgba(12,31,22,.06), 0 4px 16px rgba(12,31,22,.05)`); hover lifts −4px with `--shadow-lg` (`0 12px 32px rgba(12,31,22,.12)`) and image scale 1.045.
- **Section headers:** mono uppercase kicker in `--court` above a display h2; optional right-aligned text link "… →".
- **Availability grid** (signature component): time rows × court columns; the time spine is a plain mono time column (sticky-left), **not** tinted by rate band — an earlier version of this doc specified a shared off-peak/peak tint on that column (a `--band-peak` token), but the real data model has rate bands *per court*, not per branch, so two courts in the same grid can define different band edges (or even a different count of bands) for the same hour. A single shared tint column would be correct for at most one of the visible courts and misleading for the rest, so it was dropped rather than shipped inaccurate (see `src/lib/booking/availability.ts`/`src/components/availability-grid.tsx`, task-9-report.md fix round 1). Open cells show their price in mono; booked cells flat `--booked`; selected cells lime with 1.5px ink border and court-corner tick marks (7×7px, 2px strokes, top-left + bottom-right).

  **Mockups vs. built app:** several files in `design/mockups/` (`admin-approvals.html`, `branch-page.html`, `checkout.html`, `index.html`, `owner-dashboard.html`, `player-dashboard.html`, `search-results.html`) still define `--band-peak` and/or render the tinted time-spine this entry describes as dropped — `branch-page.html` in particular still visibly renders it. Those mockups predate this change and were not updated when it landed; they are intentionally left as-is (not edited as part of this fix) rather than treated as a design decision to re-litigate. Where a mockup and the built app disagree on this point, **the built app is authoritative** — go by `src/components/availability-grid.tsx`, not the mockup HTML.
- **Nested cards** (a card grid inside another card, e.g. the courts grid inside a branch's "Courts" card): skip the panel/shadow card recipe above — a shadowed card on top of a shadowed card reads as mush. Use a `--hairline` border on the `--btn-radius` token instead (the same treatment `BORDERED_BUTTON` and the other bordered controls already use), hover border to `--court`.
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
