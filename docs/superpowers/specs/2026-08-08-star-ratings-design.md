# Review ratings as 1–5 stars

**Date:** 2026-08-08
**Status:** decisions approved; **not scheduled** — build after the player-profile-completion plan lands

## Problem

The rating *scale* is already right. `20260801161137_reviews.sql` declares
`rating smallint not null check (rating between 1 and 5)`, and the database has
enforced 1–5 since the reviews slice shipped. **No migration is needed and the
scale does not change.**

What is wrong is that nothing in the interface looks like a rating. Three
places, three different treatments:

1. **Input** — `src/app/bookings/review-form.tsx` uses a `<select>` reading
   "5 — Excellent" … "1 — Bad". Functional and accessible, but it reads like a
   settings dropdown, not like leaving a review.
2. **Aggregate display** — `src/components/ui/rating.tsx` renders a 7px lime dot,
   the average to one decimal, and the count in parentheses. That is
   `design/branding.md`'s documented Rating rule, and it is the thing being
   replaced.
3. **A single review on the player dashboard** — `src/app/bookings/page.tsx:263`
   renders the lime dot inline and prints `review.rating.toFixed(1)`. Since a
   single review's rating is an integer by database constraint, this renders
   "5.0" — a decimal place that can never be anything but `.0`.
4. **A single review on the owner's reviews page** — `src/app/dashboard/reviews/page.tsx:137`
   does the *same thing again*, with its own copy of the lime-dot markup and its
   own `.toFixed(1)`. Its comment explains the duplication honestly: `<Rating>`
   is the aggregate component (average + count, renders nothing at zero), so
   neither single-review surface could use it.

Sites 3 and 4 are the same widget written twice because no primitive existed for
"show one rating". That is what `Stars` below is for; both then compose it
instead of each carrying its own copy.

## Decisions

| Question | Decision |
|---|---|
| Scale | Unchanged — already 1–5, enforced by a check constraint |
| Migration | **None.** No schema change of any kind |
| Aggregate display | Stars **and** the number: `★★★★½ 4.3 (12)` |
| Star precision | Nearest **half** star |
| Numeric average | **Kept** beside the stars — not replaced by them |
| Review count | Kept, in parentheses, as today |
| Input | Five radio inputs styled as stars, in a labelled `<fieldset>` |
| Single-review display | Stars, and the stray `.toFixed(1)` dropped |
| `branding.md` | Rating entry rewritten in the same turn |

### Why the number stays beside the stars

Half-star rounding makes 4.3 and 4.7 render identically. The database already
holds the precision and today's UI already shows it, so dropping the number
would be discarding information a player currently has. Stars give the instant
read; the number keeps the precision. Partial-fill stars were considered and
rejected: they are fiddly to render crisply at 14px and nobody reads 4.3 from a
partially clipped glyph anyway, so the complexity buys nothing the number does
not already provide.

### Why radio inputs rather than clickable spans

The common way to build a star picker — click handlers on `<span>`s with local
state — is keyboard-inoperable and silent to screen readers. Five radios in a
`<fieldset>` with a `<legend>` are natively arrow-key navigable, announced as a
grouped choice, submit without JavaScript, and need no `useState` at all. The
stars are then pure CSS over `:checked`. This is strictly less code **and**
strictly more accessible, so there is no trade-off to weigh.

Radios also keep the existing form contract intact: `createReviewAction` reads
`rating` off `FormData`, and a radio group named `rating` submits exactly the
same value the `<select>` did. **The Server Action does not change.**

## Design

### 1. A shared `Stars` primitive — `src/components/ui/stars.tsx`

One presentational component, used by every read-only rating surface:

```ts
export function Stars({
  value,          // 0–5, may be fractional
  size = 14,      // px; 14 for cards, larger where a rating is the subject
}: { value: number; size?: number }): JSX.Element
```

Renders five glyphs — full, half, or empty — from `Math.round(value * 2) / 2`.
The whole group is `aria-hidden`; the accessible name lives on the caller, which
knows whether it is announcing "rated 4.3 out of 5 from 12 reviews" or "you rated
5 out of 5". A star row that announced itself five times would be noise.

Pure and import-free, so any surface — client or server — can use it.

### 2. `Rating` keeps its job, changes its face — `src/components/ui/rating.tsx`

Same props (`average`, `count`, `onDark`), same "render nothing when there are
no reviews" rule — a zero-star row reads as a bad rating rather than an absent
one, which is why that guard exists and why it stays. It now composes `Stars`
plus the existing number and count, and carries the group's accessible name.

Every current caller keeps working untouched.

### 3. The player dashboard's single review — `src/app/bookings/page.tsx`

Replace `{review.rating.toFixed(1)}` with `<Stars value={review.rating} />` plus
an `sr-only` "Rated N out of 5". The `.toFixed(1)` goes: a single review's rating
is an integer, so the decimal was always noise.

### 4. The input — `src/app/bookings/review-form.tsx`

The `<select>` becomes a `<fieldset>` with a `<legend className="sr-only">`
("Rating") and five `<input type="radio" name="rating">`, values 1–5, `5`
checked by default exactly as the select defaulted to `5`. Each radio's label
carries an `sr-only` text equivalent ("5 — Excellent" … "1 — Bad", the strings
already in the select, so the vocabulary does not drift). Stars are drawn from
the radio state in CSS.

The radios need a visible focus indicator per `branding.md`'s Controls rule —
`var(--court)` on this light surface, `outline-offset: 3px`. **Do not pair the
focus utilities with `outline-none`:** in Tailwind v4 that compiles to an
ungated `--tw-outline-style: none` which the `focus-visible:` rule then reads
through `var()`, silently killing the ring. That trap is documented in
`branding.md` and has bitten this codebase twice already.

### 5. `design/branding.md`

The Rating entry currently reads: *"lime dot (7px, ink outline) + bold number,
count in parens muted."* Rewrite it to describe the star treatment — five stars
at half-star precision, the numeric average retained beside them, the count in
parens, nothing rendered at zero reviews — and record that the lime dot is
retired. Note the input treatment (radio stars, never click-handled spans) so
the next rating surface built copies the accessible pattern rather than
reinventing the broken one.

## Testing

- `Stars` rounding: 0, 0.24→0, 0.25→½, 4.3→4½, 4.75→5, 5. Pure, no DB.
- `Rating` renders nothing at `count === 0` or `average === null` — the existing
  guarantee, pinned so a refactor cannot quietly start showing "0 stars".
- The review form still submits `rating` as `"1"`–`"5"`; `createReviewAction`
  and its existing tests are untouched.
- The whole reviews suite must pass **unchanged** — this is presentation only,
  and a diff to any review test is a signal the change escaped its scope.

## Out of scope

- Any schema change. The check constraint already enforces 1–5.
- Changing what a rating *means*, or adding half-star *input* (players pick whole
  stars; only aggregates render halves).
- Review moderation, editing, or deletion.
- The `?sort=rating` "Top rated" ordering — unchanged.
