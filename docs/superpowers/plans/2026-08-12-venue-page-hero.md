**SUPERSEDED — the shipped design is described in src/app/venues/[slug]/page.tsx's header comment. This document records the design history, including two rejected iterations.**

# Venue Page Hero & Full-Width Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/venues/[slug]`'s lead photo into a full-bleed hero carrying the venue's identity, give the booking grid the full 1120px content column, and bring the page to `branding.md`'s documented 72px section rhythm.

**Architecture:** The hero copies `src/app/page.tsx`'s home-hero skeleton verbatim — `Nav variant="overlay"` inside a `relative` section, lead photo plus the codified `rgba(6,20,13,.68)` overlay, content in the padding formula with no `max-w`. `PhotoGallery` splits into a lead-URL helper and a thumbnail component; `AmenityChip` gains an `onDark` glass variant mirroring `Rating`'s existing prop. `main` flattens from a 360px/1fr grid into a stack.

**Tech Stack:** Next.js 16 App Router, React 19, Tailwind v4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-12-venue-page-hero-design.md`. Read it before Task 1. Where this plan and the spec disagree, the spec wins — raise the conflict rather than silently picking.

## Global Constraints

Every task's requirements implicitly include all of these.

- **`design/branding.md` is the design source of truth.** Read it before touching any JSX. Colors, type, control tokens, radius, the layout column, and the no-gradients rule all apply.
- **The overlay value is `rgba(6, 20, 13, .68)`** — `branding.md:37`'s codified value for a dark overlay on hero photos. Not a similar-looking colour, not an opacity utility.
- **Content column: `px-[max(24px,calc((100vw-1120px)/2))]`, and NEVER combined with `max-w`.** `branding.md:54` documents that exact combination as the bug that misaligned the home hero's headline from its own page content until 2026-08-07. This applies inside the `relative` hero too — that is precisely where the last exception survived.
- **Section rhythm: 72px between major sections, 56px mobile** (`branding.md:55`).
- **Focus rings: never pair a focus utility with `outline-none`** on the same element — in Tailwind v4 that silently kills the ring (`branding.md:71`). Verify with real keyboard focus; `.focus()` from the console does not reliably match `:focus-visible`.
- **Non-interactive chips stay pill-shaped** (`border-radius: 999px`) to distinguish them from buttons.
- **All user-facing copy is English only.** No Taglish.
- **No data, query, or booking-logic changes.** `getBranchDetail`, `loadBranchDay`, and `AvailabilityGrid`'s internals are out of scope.
- **The page never scrolls sideways.** Wide grids scroll inside their own container with a sticky first column (`branding.md:56`).
- Money via `formatPeso` / `formatPriceFrom`, dates via `formatDateLabel`, all from `@/lib/format`.
- **Do NOT run any state-changing git command.** No `git add`, no `git commit`, no branch/stash/checkout. Each task ends by reporting; the user commits.
- **Never start a dev server with Bash** — use the preview tool.
- Pre-existing lint warnings: **9**. That count must not grow. Note that `venues/[slug]/page.tsx` already carries one of them (an `<img>` for the owner logo, with an inline eslint-disable) — adding hero and thumbnail `<img>` tags means adding disables, not warnings.

## Facts already verified — do not re-derive these

- **`AvailabilityGrid` needs no change to go full width.** It is `w-full` inside an `overflow-x-auto` wrapper with a sticky first column, and `src/components/availability-grid.tsx:228` records that a max-width cap on slot buttons was tried and deliberately rejected. Widening its container is sufficient. The spec listed this as "verify rather than assume"; it is now verified.
- **`Nav` accepts `variant?: 'overlay' | 'solid'`** (`src/components/site/nav.tsx:22`), defaulting to `'solid'`.
- **`Rating` already has an `onDark` prop.** No change needed there.
- **Amenity icons use `stroke="currentColor"`** (`src/components/ui/amenity-icons.tsx`), so a `text-white` chip carries its icon automatically. No icon work.
- **`photoUrl(bucket, path)` returns `string | null`** (`src/lib/photos.ts:16`), null for a null/empty path.
- **`PhotoGallery` has exactly one call site** — `src/app/venues/[slug]/page.tsx`. Confirmed by grep. Removing the export breaks nothing else.

---

### Task 1: Component changes and the branding doc

**Files:**
- Modify: `src/components/ui/amenity-chip.tsx` (add `onDark`)
- Modify: `src/components/branch/photo-gallery.tsx` (replace `PhotoGallery` with `heroLeadPhoto` + `PhotoThumbs`)
- Modify: `design/branding.md` (two entries)

**Interfaces:**
- Consumes: `photoUrl` from `@/lib/photos`; `AMENITY_LABELS` / `AMENITY_ICONS` / `CustomAmenityIcon` already in scope in `amenity-chip.tsx`.
- Produces, for Task 2:
  ```ts
  // amenity-chip.tsx
  export function AmenityChip({ amenity, onDark }: { amenity: string; onDark?: boolean })
  // photo-gallery.tsx
  export function heroLeadPhoto(photoPaths: string[]): string | null
  export function PhotoThumbs({ photoPaths }: { photoPaths: string[] })
  // `PhotoGallery` no longer exists.
  ```

- [ ] **Step 1: Read the branding rules first**

Read `design/branding.md`'s **Color**, **Controls**, and **Components** sections. You need three things from it: the codified hero overlay value, the glass treatment the home hero uses (`border border-white/[.18]`), and the pill-shape rule for non-interactive chips.

Also read `src/components/ui/rating.tsx`. Its `onDark` prop is the pattern you are mirroring — same prop name, same `= false` default, same inline-ternary style. The goal is that a reader who learns one learns the other.

- [ ] **Step 2: Add `onDark` to `AmenityChip`**

Replace the component (leave every comment and the two exported constants above it untouched):

```tsx
/**
 * `onDark` mirrors Rating's prop of the same name — same name and same default
 * on purpose, so the two read as a pair. The dark skin is the glass treatment
 * design/branding.md gives hero controls (border-white/[.18]), not a solid
 * panel: a row of solid white pills over a photo reads as heavy tags rather
 * than as metadata. The icons need no handling — amenity-icons.tsx draws every
 * one with stroke="currentColor", so `text-white` carries them.
 */
export function AmenityChip({ amenity, onDark = false }: { amenity: string; onDark?: boolean }) {
  const label = AMENITY_LABELS[amenity] ?? amenity.replaceAll('-', ' ')
  const AmenityIcon = AMENITY_ICONS[amenity] ?? CustomAmenityIcon
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium ${
        onDark
          ? 'border-white/[.18] bg-white/[.10] text-white'
          : 'border-[var(--hairline)] bg-[var(--panel)] text-[var(--ink-soft)]'
      }`}
    >
      <AmenityIcon />
      {label}
    </span>
  )
}
```

A note on why the skin is a ternary over one `className` rather than two separate branches: Tailwind v4 silently drops a class it cannot statically see, so a dynamically assembled class string is a real hazard here. Every class above is a literal in the source — no interpolation into a class name — which is what keeps the dark skin from compiling to nothing.

The default `false` keeps every existing call site byte-identical. Confirm those call sites with `grep -rn "AmenityChip" src/` and report how many there are.

- [ ] **Step 3: Split `photo-gallery.tsx`**

Replace the `PhotoGallery` export with two. Keep the file's existing top-of-file doc comment but update it to describe the new shape — it currently describes the 2fr/1fr grid that is going away.

```tsx
/** The lead photo's public URL, or null when the branch has no photos. */
export function heroLeadPhoto(photoPaths: string[]): string | null {
  const [lead] = photoPaths
  return photoUrl('branch-photos', lead)
}

/**
 * How many thumbnails ride in the hero before the rest collapse into "+N".
 * Three, because the hero's content column also has to hold the venue name,
 * a rating row and the amenity chips without the photo strip dominating it.
 */
const MAX_THUMBS = 3

/**
 * The venue's non-lead photos, as a thumbnail row inside the hero.
 *
 * Returns null when there is nothing left to show — the lead photo is already
 * the hero's backdrop, so a branch with 0 or 1 photos has no strip. That is
 * deliberately unlike the old PhotoGallery, which always rendered two side
 * slots (filling absent ones with a flat block) because an empty cell in a
 * 2fr/1fr grid left a visible hole. A flex row has no hole to fill.
 */
export function PhotoThumbs({ photoPaths }: { photoPaths: string[] }) {
  const rest = photoPaths.slice(1)
  if (rest.length === 0) return null

  const shown = rest.slice(0, MAX_THUMBS)
  const remaining = rest.length - shown.length

  return (
    <div className="flex flex-wrap gap-2">
      {shown.map((path, i) => {
        const url = photoUrl('branch-photos', path)
        const isLast = i === shown.length - 1
        return (
          <figure
            key={path}
            className="relative h-[72px] w-[96px] overflow-hidden rounded-[10px] border border-white/[.18]"
          >
            {url ? (
              // eslint-disable-next-line @next/next/no-img-element -- the bucket
              // is public and these are already-sized uploads; the same call the
              // owner strip below the fold already makes.
              <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <div className="absolute inset-0 bg-[var(--band-off)]" />
            )}
            {isLast && remaining > 0 && (
              <span className="absolute bottom-1.5 right-1.5 rounded-full bg-[rgba(14,42,31,.75)] px-2 py-0.5 font-mono text-[10.5px] text-white">
                +{remaining}
              </span>
            )}
          </figure>
        )
      })}
    </div>
  )
}
```

`heroLeadPhoto` passes `lead` straight to `photoUrl` without a guard because `photoUrl` already returns null for a null/undefined path — destructuring an empty array yields `undefined`, which it handles.

- [ ] **Step 4: Update `design/branding.md`**

Two entries, per `CLAUDE.md`'s rule that a design-system change updates the branding doc in the same turn:

1. In the **Components → Nav** entry, record that `/venues/[slug]` is now the second page using the overlay-nav photo hero, so the pattern reads as a convention rather than a home-page one-off. Name both files.
2. Beside the chip guidance, record `AmenityChip`'s `onDark` glass variant with its literal values (`border-white/[.18] bg-white/[.10] text-white`), noting it mirrors `Rating`'s prop of the same name, so the next dark-background chip does not invent a third skin.

Match the file's existing voice: it explains *why* a value is what it is and records history where a decision reversed. Do not restructure the document.

- [ ] **Step 5: Gate**

```bash
npx tsc --noEmit && npm run lint
```

Expected: `tsc` clean. `tsc` will **fail** at this point with an error in `src/app/venues/[slug]/page.tsx` — it still imports the now-removed `PhotoGallery`. That is expected and is Task 2's job. Report the error text to prove it is that error and nothing else; do not fix the page here, and do not leave a compatibility shim behind to make this step green.

Lint's warning count must not have grown beyond 9.

- [ ] **Step 6: Report (do not commit)**

Report: the exported signatures verbatim, how many `AmenityChip` call sites exist, the two branding.md entries you added, and the expected `tsc` error.

---

### Task 2: The page restructure

**Files:**
- Modify: `src/app/venues/[slug]/page.tsx`

**Interfaces:**
- Consumes from Task 1: `heroLeadPhoto(photoPaths)`, `<PhotoThumbs photoPaths>`, `<AmenityChip amenity onDark>`. Also, already in the codebase: `<Nav variant="overlay" | "solid">`, `<Rating average count onDark>`, `<AvailabilityGrid grid branchId slug date canBook>`, `<ReviewList reviews ratingAvg ratingCount>`, `<BranchMap lat lng name>`, `formatDateLabel`, `formatPriceFrom`, `shiftDay`, `isValidCalendarDate`, `manilaToday`, `photoUrl`, `LOGO_BUCKET`.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Read the home hero before writing any JSX**

Read `src/app/page.tsx`'s hero — the `<section className="relative">`, the `Nav variant="overlay"` inside it, the `<header className="relative overflow-hidden pt-[148px] …">`, the absolutely-positioned photo and overlay, and the content wrapper's padding class.

You are copying that skeleton, not inventing one. Three values in it are load-bearing:
- `pt-[148px]` is what clears the floating overlay nav. Copy it; do not re-derive it.
- The overlay is `rgba(6, 20, 13, .68)` exactly — `branding.md:37`.
- The content wrapper uses the padding formula and **no `max-w`**. `branding.md:54` documents that combination as a real, weeks-long alignment bug on this very hero.

- [ ] **Step 2: Swap the import and add the hero**

Change the imports: `PhotoGallery` → `{ heroLeadPhoto, PhotoThumbs }`.

Replace `<Nav variant="solid" />` with the hero section. `heroUrl` is computed alongside `ownerLogoUrl`:

```tsx
const heroUrl = heroLeadPhoto(detail.photoPaths)
```

```tsx
{/* Hero. Skeleton copied from src/app/page.tsx's home hero so the two pages
    share one convention: overlay Nav inside a relative section, photo plus
    branding.md:37's codified rgba(6,20,13,.68) overlay, content in the padding
    formula. The pt-[148px] is what clears the floating nav — it is copied, not
    re-derived. Do NOT add a max-w to the content wrapper: branding.md:54
    records that exact combination as the bug that misaligned this same hero
    pattern's headline from its own page content for weeks. */}
<section className="relative">
  <Nav variant="overlay" />

  <header className="relative overflow-hidden pt-[148px] pb-[88px] max-[980px]:pt-[112px] max-[980px]:pb-14">
    {heroUrl ? (
      // eslint-disable-next-line @next/next/no-img-element -- public bucket,
      // already-sized upload; same call the owner strip makes below.
      <img
        src={heroUrl}
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-[center_55%]"
      />
    ) : (
      <div aria-hidden className="absolute inset-0 bg-[var(--band-off)]" />
    )}
    <div aria-hidden className="absolute inset-0 bg-[rgba(6,20,13,.68)]" />

    <div className="relative flex flex-col gap-3 px-[max(24px,calc((100vw-1120px)/2))]">
      <p className="font-mono text-[11.5px] uppercase tracking-[.08em] text-white/70">
        {detail.city}
      </p>
      <h1 className="max-w-[18ch] text-[44px] font-bold leading-[1.05] tracking-tight text-white max-[980px]:text-[34px]">
        {detail.name}
      </h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-white/80">
        <Rating average={detail.ratingAvg} count={detail.ratingCount} onDark />
        <span>
          {detail.address}, {detail.city}
        </span>
        {detail.minPriceCentavos !== null && (
          <span className="font-mono text-white">
            {formatPriceFrom(detail.minPriceCentavos)}
          </span>
        )}
      </div>
      {detail.amenities.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-2">
          {detail.amenities.map((amenity) => (
            <AmenityChip key={amenity} amenity={amenity} onDark />
          ))}
        </div>
      )}
      <div className="mt-2">
        <PhotoThumbs photoPaths={detail.photoPaths} />
      </div>
    </div>
  </header>
</section>
```

The `max-w-[18ch]` on the `h1` is on the **heading**, not on the content wrapper — capping a line length is not the same thing as re-centring the column, and `branding.md:54`'s prohibition is about the wrapper. A long venue name otherwise runs the full 1120px as one line.

`object-[center_55%]` biases the crop upward slightly so a court floor fills the band rather than the sky; the home hero uses `object-[center_62%]` for the same reason. Adjust if a real photo looks wrong and say so in your report.

- [ ] **Step 3: Flatten `main`**

Replace `main`'s opening tag and delete the `grid` wrapper and the venue `<header>` entirely — its content now lives in the hero.

```tsx
<main className="flex flex-col gap-[72px] bg-[var(--surface)] px-[max(24px,calc((100vw-1120px)/2))] py-[72px] max-[560px]:gap-14 max-[560px]:py-14">
```

That is `branding.md:55`'s documented rhythm — 72px between major sections, 56px mobile — replacing the page's previous `gap-8` / `py-10`. The page was deviating from the doc; this brings it into line, by explicit user instruction.

Section order inside `main`:

1. **Book a court** — the existing `<section aria-label="Book a court">`, unchanged except that it is now a direct child of `main` rather than a grid track. Keep `className="min-w-0 flex flex-col gap-4"`: `min-w-0` still matters, because a flex column child with a wide table inside it will otherwise refuse to shrink and push the page sideways.
2. **About + Location** — a new wrapper around the two existing cards.
3. **Reviews** — the existing `<ReviewList …>`, unchanged.
4. **Owner strip** — the existing `<section aria-label="Hosted by">`, unchanged.

- [ ] **Step 4: Put About and Location side by side**

Wrap the two existing `<article>` cards, moved out of the deleted left rail:

```tsx
{/* Two cards in one band, so gap-8 rather than the 72px section rhythm —
    that rhythm separates major sections, not cards inside one. */}
<div className="grid gap-8 min-[980px]:grid-cols-2">
  {detail.description && (
    <article
      aria-label="About"
      className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
    >
      <h2 className="mb-2 text-[17px] font-bold text-[var(--ink)]">About</h2>
      <p className="text-sm text-[var(--ink-soft)]">{detail.description}</p>
    </article>
  )}

  <article
    aria-label="Location"
    className={`rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)] ${
      detail.description ? '' : 'min-[980px]:col-span-2'
    }`}
  >
    <h2 className="mb-2 text-[17px] font-bold text-[var(--ink)]">Where to find us</h2>
    {detail.lat !== null && detail.lng !== null ? (
      <BranchMap lat={detail.lat} lng={detail.lng} name={detail.name} />
    ) : (
      <div className="rounded-[10px] border border-dashed border-[var(--hairline)] bg-[var(--surface)] p-4 text-sm text-[var(--ink-soft)]">
        Map location not available yet.
      </div>
    )}
    <p className="mt-2 text-sm text-[var(--ink-soft)]">
      {detail.address}, {detail.city}
    </p>
  </article>
</div>
```

The `col-span-2` when there is no description is deliberate: a lone half-width map card with dead space beside it reads as a layout bug rather than as an absent card.

- [ ] **Step 5: Rewrite the file's top-of-file comment**

The existing block comment describes the 360px/1fr grid, the left rail, and where the gallery sits — all of which this task removes. Rewrite it to describe the new structure. **Keep** the parts that are still true and still load-bearing:

- why the padding formula is used instead of `mx-auto max-w-` (the 375px overflow bug),
- why the `--band-peak` rate-band tint is deliberately not ported from the mockup,
- why `BranchMap` exists rather than reusing `SearchMap`,
- why the flat `--band-off` map fallback appears only when lat/lng are null.

Add why the hero's skeleton is copied from the home hero rather than invented, and why the content wrapper carries no `max-w`.

- [ ] **Step 6: Gate**

```bash
npx tsc --noEmit && npm run lint && npm run build
```

Expected: all clean, lint still at 9 warnings, build succeeds. Task 1's expected `tsc` error is now resolved by the import swap.

- [ ] **Step 7: Verify visually — this page is public, so actually look at it**

Unlike `/admin/*` and `/dashboard/*`, `/venues/[slug]` needs no session. Start the `oncourt-dev` config from `.claude/launch.json` with the **preview tool** (never `npm run dev` via Bash; the dev server is on port 3030) and check each of these:

1. **Hero renders the lead photo with the overlay**, and the white text is legible over it.
2. **Nav floats transparently over the hero** rather than sitting solid above it.
3. **THE ALIGNMENT CHECK.** The `h1`'s left edge and the "Book a court" heading's left edge must be at the same x. Measure it — `document.querySelector('h1').getBoundingClientRect().left` against the same for the Book-a-court `h2`. This is the exact alignment `branding.md:54` exists to protect, and a reintroduced `max-w` is invisible without measuring.
4. **The availability grid uses the full column.** Find a branch with several courts; confirm it is wider than before and that when it does overflow, the grid scrolls inside its own container with the time spine stuck — not the page.
5. **A branch with no photos** renders the flat `--band-off` band, not a broken image icon.
6. **A branch with no description** renders Location spanning the full width, with no gap where About would be.
7. **375px** (`resize_window` to mobile): no horizontal page scroll, the hero's `max-[980px]` padding applies, About and Location stack.
8. **Console clean** — read console messages, not just the rendered page.

You need real branch slugs. Get them from the database or from `/search`'s own output rather than guessing. Report which slug you used for each case, and say explicitly if you could not find a branch exercising cases 5 or 6.

- [ ] **Step 8: Screenshot and report (do not commit)**

Take a screenshot of the hero at desktop width and one at 375px, and save them under `docs/screenshots/` — creating that directory if it does not exist. **Never write PNGs to the project root.**

Report: the measured left-edge values from check 3, which slugs you used, the screenshots' paths, and anything that looked wrong that you did not change.

---

## What this plan deliberately does not do

- **No unit tests.** This project has no DOM test environment (`vitest.config.ts` sets `environment: 'node'`), and the change is purely presentational — there is no logic to assert. Verification is `tsc` + lint + build + the visual pass in Task 2 Step 7. The full vitest suite is untouched by this change and does not need re-running.
- **No lightbox or carousel** behind the thumbnails. They stay static, as the gallery is today.
- **No change to `AvailabilityGrid`** — verified unnecessary; see Facts above.
- **No section-rhythm sweep of other pages.** Only `/venues/[slug]` moves to 72px here.
- **No touching `src/app/dashboard/listings/form-ui.tsx`**'s known dead focus ring — a systemic issue with its own slice.
