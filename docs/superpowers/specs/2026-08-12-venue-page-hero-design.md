**SUPERSEDED — the shipped design is described in src/app/venues/[slug]/page.tsx's header comment. This document records the design history, including two rejected iterations.**

# Venue Page Hero & Full-Width Booking — Design Spec

**Date:** 2026-08-12
**Status:** Revised post-implementation — see "Revision" below. The photo
full-bleed treatment and full-width booking grid shipped as designed; the
text-over-photo hero did not.
**Scope:** `/venues/[slug]` layout only. No data, query, or booking-logic changes.

## Revision (2026-08-12, after visual review)

This spec originally called for the venue's identity (city, name, rating,
address, price, amenity chips) rendered directly ON the lead photo, inside a
dark `rgba(6,20,13,.68)` scrim, with `Nav variant="overlay"` floating
transparently above it — mirroring `src/app/page.tsx`'s home hero exactly, as
described in "The hero" below. **That version was built, gated clean
(tsc/lint/build), and visually verified in the browser — then the user
rejected it** after seeing it rendered, and asked for the identity block
moved below the photo so no text sits over an image at all. This section
records that rather than silently rewriting the spec as if the overlay
version were never tried; the rest of this document is amended in place to
describe what actually shipped, with the superseded overlay design struck
through in context rather than deleted, so the next reader knows both what
was tried and why it didn't survive.

What changed as a result:

- The photo band is now a plain, fixed-height **banner** — no text, no dark
  scrim, no floating nav over it. Height: `340px` desktop / `240px` at
  `<=980px` / `200px` at `<=560px` (down from the overlay hero's
  content-driven ~490px, since the band no longer has to hold a headline).
  It keeps the full-bleed photo (or the flat `--band-off` zero-photo
  fallback) and the thumbnail strip riding over its bottom edge.
- `Nav` is back to `variant="solid"` — a transparent nav has no job once
  nothing under it needs contrast help.
- The `rgba(6,20,13,.68)` overlay is gone entirely. `branding.md`'s
  no-gradients rule ruled out a top-only darkening gradient as an
  alternative for a floating nav; a solid nav was the actual answer, not a
  gradient exception.
- The venue identity moves into `main`, as a plain `<header>` on
  `--surface`, in this order: city kicker, `<h1>`, a compact **"Hosted by"**
  row (moved up from the page's bottom strip), the rating/address/price row,
  then amenity chips.
- `AmenityChip`'s `onDark` prop — added by this plan specifically to put
  chips on the rejected overlay — was **removed again**, along with its
  `branding.md` entry: it has no call site once the overlay is gone.
  `Rating`'s own `onDark` prop predates this plan and has other users, so it
  was left alone.
- The bottom-of-page "Hosted by" owner-strip section is gone as a separate
  section, folded into the compact row under the venue name instead.

## Why

`/venues/[slug]` currently opens with a 360px sidebar: a small three-shot photo
grid, the venue's name, rating, address, amenities, an About card, and a map,
with the booking grid squeezed into the remaining `1fr` track. Two problems
follow from that shape:

1. **The photos are decorative rather than persuasive.** A venue page's job is
   to convince a player this is the right court and then let them book it. At
   360px wide the lead shot is a thumbnail.
2. **The availability grid is starved.** It sits in roughly 720px (1120 − 360 −
   32px gap), so a branch with more than a few courts scrolls horizontally
   before it needs to.

This restructure makes the lead photo the page's opening statement and gives the
booking grid the full content column.

## Decisions

| Question | Decision |
|---|---|
| Hero treatment | ~~Full-bleed lead photo, dark overlay, `Nav variant="overlay"` floating over it — matching the home hero.~~ **Superseded:** a plain full-bleed photo **banner**, no text, no overlay, `Nav variant="solid"`. See "Revision" above. |
| The venue's other photos | A thumbnail row inside the photo band, keeping the existing `+N` badge. (Unchanged by the revision.) |
| Venue identity | ~~Rendered on the photo, inside the overlay.~~ **Superseded:** a plain `<header>` in `main`, below the photo band. |
| Hosted by | **New in the revision:** moved from a bottom-of-page card into a compact row directly under the venue name. |
| Booking panel | Full width, a direct child of `main`. (Unchanged.) |
| About & Location | Side by side at ≥980px, where they were stacked in the rail. (Unchanged.) |
| Section rhythm | Brought to `branding.md`'s documented 72px / 56px mobile, replacing the page's current 32px. (Unchanged.) |

## ~~The hero~~ The photo band (revised)

**This section originally read as below, and the code was built exactly this
way — kept verbatim for the record:**

> Structure mirrors `src/app/page.tsx`'s home hero, so the two pages share one
> convention rather than inventing a second:
>
> ```
> <section className="relative">
>   <Nav variant="overlay" />
>   <header className="relative overflow-hidden pt-[148px] pb-[88px]
>                      max-[980px]:pt-[112px] max-[980px]:pb-14">
>     <img … className="absolute inset-0 h-full w-full object-cover" />
>     <div aria-hidden className="absolute inset-0 bg-[rgba(6,20,13,.68)]" />
>     <div className="relative px-[max(24px,calc((100vw-1120px)/2))]">
>       … identity, chips, thumbnails …
>     </div>
>   </header>
> </section>
> ```
>
> Three things in that skeleton are load-bearing and must not be "tidied":
>
> - **`pt-[148px]`** is what clears the floating overlay nav. It is copied from
>   the home hero rather than re-derived, so the two heroes stay in step.
> - **`rgba(6, 20, 13, .68)`** is `design/branding.md:37`'s exact codified value
>   for a dark overlay on hero photos. Not a similar-looking colour.
> - **The inner `div` uses the padding formula with NO `max-w`.**
>   `branding.md:54` documents this precise combination as the bug that
>   misaligned the home hero's headline from its own page content until
>   2026-08-07: a `max-w` inside the padding formula re-centres a narrower box
>   and breaks the alignment the formula exists to create.

**What shipped next** — an intermediate shape, since superseded in its own
turn (see the SUPERSEDED banner at the top of this document) — after the user
saw the above rendered and rejected text-over-photo entirely: a plain,
fixed-height photo banner, no text, no overlay:

```
<Nav variant="solid" />

<div className="relative h-[340px] overflow-hidden
                max-[980px]:h-[240px] max-[560px]:h-[200px]">
  <img … className="absolute inset-0 h-full w-full object-cover" />
  <div className="absolute inset-x-0 bottom-0 px-[max(24px,calc((100vw-1120px)/2))] pb-4">
    <PhotoThumbs … />
  </div>
</div>
```

It had no overlay div, no floating nav, no identity content inside the band
at all — just the photo (or the zero-photo fallback) and the thumbnail strip
anchored to its bottom edge. The band's height was fixed rather than
content-driven, picked to read as a banner: short enough that it clearly
wasn't trying to hold a headline, tall enough that the court/venue photo
still read clearly. The `pt-[148px]`/overlay-nav-clearance concern didn't
apply anymore since there was no floating nav to clear. This shape did not
survive either — the final, shipped page moved the identity block back
beside the map instead of stacking it under a photo band; see this
document's SUPERSEDED banner and `src/app/venues/[slug]/page.tsx`'s header
comment for what actually shipped.

### Identity content, in order (now below the band, in `main`)

1. City kicker — mono, uppercase, `tracking-[.08em]`, `text-[var(--ink-soft)]`
   (was `text-white/70` on the rejected overlay).
2. `<h1>` venue name, `text-[var(--ink)]` (was white).
3. **New position:** a compact "Hosted by" row — logo/initial-letter
   fallback, "Hosted by" mono kicker, business name, "View profile" link when
   `detail.owner.slug` exists. Moved up from the page's bottom strip; see
   "What `main` becomes" below.
4. A wrapping row: `<Rating average count />` (no `onDark` — see below), the
   address, and `formatPriceFrom(minPriceCentavos)` when non-null.
5. Amenity chips, when the branch has any (no `onDark` — see below).
6. The thumbnail row stays in the photo band above, not here — see "The
   photo band" above.

`Rating`'s `onDark` prop still exists (it predates this plan and has other
users) but is not passed here, since the identity block is no longer on a
photo.

### Zero-photo fallback (unchanged in substance)

A branch with no photos renders the flat `--band-off` band in place of the
`<img>`, and no thumbnail row. There is no overlay to worry about contrast
against anymore, since the identity text is no longer on the band at all —
this fallback now only has to look like "no photo," not carry legible text.
Still mirrors `PhotoGallery`'s existing zero-photo behaviour rather than
inventing a second empty state.

## Component changes

### `AmenityChip`'s `onDark` prop — added, then reverted

This plan originally added an `onDark = false` prop to `AmenityChip`,
mirroring `Rating`'s existing prop, so chips could take a glass skin
(`border-white/[.18] bg-white/[.10] text-white`) over the rejected overlay
hero. That version shipped, gated clean, and was visually verified — then
reverted along with the rest of the overlay hero once the user rejected
text-over-photo. `AmenityChip` is back to its original, single-skin shape
(`bg-[var(--panel)]`, `border-[var(--hairline)]`, `text-[var(--ink-soft)]`,
no `onDark` parameter at all): with the identity block back on `--surface`,
the dark skin has no call site, and an unused variant plus its
`branding.md` entry would be dead weight. The `branding.md` entry documenting
`onDark` was reverted in the same pass.

`Rating`'s own `onDark` prop is untouched — it predates this plan and has
other call sites, so it was never in question.

### `PhotoGallery` splits into two exports

Its current 2fr/1fr grid fits neither a full-bleed backdrop nor a thumbnail
strip. The file keeps its name and gains two exports in place of the one:

```ts
/** The lead photo's public URL, or null when the branch has no photos. */
export function heroLeadPhoto(photoPaths: string[]): string | null

/** Up to three thumbnails, with a "+N" badge on the last when more exist.
 *  Returns null when there is nothing left to show. Let TS infer the return
 *  type rather than annotating it — React 19's JSX namespace moved, and a
 *  hand-written `JSX.Element` is a needless way to break the build. */
export function PhotoThumbs({ photoPaths }: { photoPaths: string[] })
```

`PhotoThumbs` renders 72px-tall thumbnails, returns `null` for an empty or
single-photo branch (there is nothing left to show once the lead is the
backdrop), and keeps the existing `+N` badge and its
`bg-[rgba(14,42,31,.75)]` pill styling.

The old `PhotoGallery` export is removed. It has exactly one call site — this
page — so nothing else breaks; the implementation must confirm that with a grep
rather than assume it.

## What `main` becomes

A flat stack, revised from the original plan: the venue `<header>` is back
in `main` (the original plan deleted it because its content lived in the
overlay hero instead; the overlay hero is gone, so the header is too, just
in a different shape — see "The photo band" above for its new contents).
The bottom-of-page owner strip is gone as a standalone section, folded into
the header's compact "Hosted by" row instead.

```
<main className="flex flex-col gap-[72px] bg-[var(--surface)]
                 px-[max(24px,calc((100vw-1120px)/2))] py-[72px]
                 max-[560px]:gap-14 max-[560px]:py-14">
  1. Venue identity <header> — city kicker, h1, Hosted by row, rating/
                               address/price row, amenity chips
  2. Book a court            — full width
  3. About + Location        — grid gap-8 min-[980px]:grid-cols-2
  4. Reviews                 — unchanged
</main>
```

**Section rhythm.** `branding.md:55` specifies 72px between major sections, 56px
on mobile. This page used `gap-8` (32px) and `py-10` (40px) — a pre-existing
deviation. Bringing it to the documented rhythm is part of this change by
explicit user instruction, so the page stops contradicting the design doc it is
supposed to follow.

**About + Location.** Two cards in a two-column grid at ≥980px, stacking below
it. `gap-8` between the two cards is deliberate and not the 72px rhythm: they
are two cards inside one band, not two major sections.

When a branch has no description, the About card is absent and **Location spans
both columns** (`min-[980px]:col-span-2`). Letting it sit as the grid's lone
child would render a half-width map card with dead space beside it, which reads
as a layout bug rather than as an absent card — the same reasoning that makes
`PhotoGallery` always render two side slots today instead of collapsing into a
gappy grid.

**Book a court** keeps its header row (`h2` + prev / date label / Today badge /
next), its `?date=` links, the zero-courts fallback, and `canBook` handling
verbatim. Only its container changes.

## The thing to verify rather than assume

`AvailabilityGrid` goes from roughly 720px to the full 1120px — about 400px
more, or several more court columns before horizontal scroll. That is the main
functional benefit of the restructure.

**The implementation must confirm the component does not carry its own
`max-w`, fixed width, or narrow-container assumption.** If it does, widening the
container achieves nothing and the fix belongs in this change. `branding.md:56`
also requires that wide grids scroll inside their own container with a sticky
first column and that the page never scrolls sideways — verify that still holds
at the new width and at 375px.

## `design/branding.md` — added, then reverted

Per `CLAUDE.md`, the two entries this plan originally called for (recording
`/venues/[slug]` as a second overlay-nav-photo-hero page, and `AmenityChip`'s
`onDark` glass variant) were added when the overlay hero shipped, then
**both reverted** in the same pass that reverted the overlay hero and
`onDark` themselves — `branding.md` should describe what the app actually
does, and after this revision neither statement is true: the overlay-nav
photo hero remains a home-page-only pattern, and `AmenityChip` has no dark
variant. `branding.md` is back to byte-identical with its state before this
plan touched it.

## Verification

No unit tests. This project has no DOM test environment (`vitest.config.ts` sets
`environment: 'node'`), and `/venues/[slug]` is **public** — unlike `/admin/*`
and `/dashboard/*`, it can be browsed without a session, so it gets real visual
verification through the browser pane on port 3030:

- The photo band renders the lead photo plainly — no overlay, no text on it.
- Nav sits solid above the band (not floating/transparent) since nothing
  under it needs contrast help anymore.
- **The `<h1>` and the "Book a court" `<h2>` align** — both now live inside
  `main`'s own padding formula, so their left edges must be at the same x.
  This is the exact alignment `branding.md:54` exists to protect, and the
  only way to catch a reintroduced `max-w` is to measure it.
- The availability grid uses the full column; a many-court branch scrolls inside
  its own container, not the page.
- A branch with no photos renders the flat band, not a broken image.
- A branch with no description renders Location alone without a gap where About
  would be.
- 375px: no horizontal page scroll, the band's mobile height applies, About and
  Location stack.
- Console clean.

`npx tsc --noEmit` and `npm run lint` stay clean, with the lint warning count
unchanged at 9.

## Out of scope

- Any change to booking logic, `loadBranchDay`, `getBranchDetail`, or
  `AvailabilityGrid`'s internals beyond removing a width constraint if one is
  found.
- A lightbox or carousel behind the thumbnails. They remain static, as the
  current gallery is.
- Touching `src/app/dashboard/listings/form-ui.tsx`'s known dead focus ring —
  a separate systemic issue with its own slice.
- The other pages' section rhythm. Only `/venues/[slug]` is brought to 72px
  here; a sweep of the rest is its own change.
