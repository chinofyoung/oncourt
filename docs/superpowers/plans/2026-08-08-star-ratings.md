# Star Ratings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show review ratings as 1–5 stars everywhere they appear, and let a player leave one by picking a star instead of choosing from a dropdown.

**Architecture:** One pure `Stars` primitive renders five glyphs filled to the nearest half via a clipped overlay. Every read-only surface composes it — the aggregate `Rating` component and the two single-review sites that had each hand-rolled their own lime-dot markup. The review form's `<select>` becomes five radio inputs styled as stars, which submits the identical `rating` value so the Server Action is untouched.

**Tech Stack:** Next.js App Router (Server + Client Components), TypeScript, Tailwind CSS v4, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-08-star-ratings-design.md` — read it before Task 1.

## Global Constraints

Every task's requirements implicitly include this section.

- **NO migration, and no schema change of any kind.** `20260801161137_reviews.sql` already declares `rating smallint not null check (rating between 1 and 5)`. The scale is correct and stays. This entire feature is presentation.
- **The Server Action does not change.** `src/lib/bookings/review-write.ts` reads `Number(formData.get('rating'))` and rejects anything that is not an integer 1–5. A radio group named `rating` submits exactly what the `<select>` did. If you find yourself editing `review-write.ts` or `src/app/bookings/actions.ts`, stop — you have gone outside this plan.
- **Do NOT run any state-changing git command.** No `commit`, `add`, `branch`, `checkout`, `stash`, `reset`, `push`. Read-only `status`/`diff`/`log` is fine. The owner commits their own work. Where the template would put a "Commit" step, this plan puts a **Report** step.
- **Read `design/branding.md` before any styling**, and update it in the same turn — this changes a documented component. The project's `CLAUDE.md` requires it.
- **Tailwind v4 focus trap:** never pair `outline-none` or `outline-hidden` with `focus-visible:outline-*` on the same element. `outline-none` compiles to an ungated `--tw-outline-style: none` which the `focus-visible:` rule then reads through `var()`, silently killing the ring. This has bitten this codebase twice; `branding.md` documents it.
- **Existing review tests must pass unchanged** — `tests/bookings/review-action.test.ts`, `tests/schema/reviews.test.ts`, `tests/owner/reviews.test.ts`, `tests/bookings/queries.test.ts`. A diff to any of them signals the change escaped its scope.
- **Two tests fail for unrelated, pre-existing reasons** and must be left alone: `tests/schema/settings.test.ts` and `tests/booking/hold.test.ts`, both of which assume `platform_settings.hold_duration_minutes` is 15 while the hosted database holds 5.
- Tests run against a **hosted, shared, persistent** Supabase database via `DATABASE_URL` in `.env.local` (Supavisor session pooler, port **5432**, never 6543). `DATABASE_URL` is **not** in the shell environment — source it: `set -a; . ./.env.local; set +a`. Run vitest in the **foreground**.
- eslint baseline is **9 warnings / 0 errors**: clean means 0 errors and no NEW warnings.

## Colour decision (made here, flag it if you disagree)

Filled stars use **`--court`** (`#2E6B4F`), empty stars **`--hairline`**.

Not lime. `branding.md` reserves `--ball` as THE accent, "use sparingly", and the old mark was a *single* 7px dot — five lime glyphs on every branch card in a search grid is the opposite of sparing. Lime also has poor contrast on white, which is why that dot needed an ink outline; five outlined lime stars would read as clutter. `--court` is the established primary green, already used for links and kickers, and gives clean contrast at 14px.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/components/ui/stars.tsx` | The five-glyph primitive — the only place star geometry lives | 1 |
| `tests/lib/ui/stars.test.ts` | Rounding and clamping | 1 |
| `src/components/ui/rating.tsx` | Aggregate display: stars + average + count | 2 |
| `src/app/bookings/page.tsx` | Player's own review — drops its hand-rolled dot | 2 |
| `src/app/dashboard/reviews/page.tsx` | Owner's view of a review — drops its hand-rolled dot | 2 |
| `src/app/bookings/review-form.tsx` | The input: `<select>` → radio stars | 3 |
| `design/branding.md` | Rating entry rewritten | 4 |

---

### Task 1: The `Stars` primitive

**Files:**
- Create: `src/components/ui/stars.tsx`, `tests/lib/ui/stars.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function Stars({ value, size }: { value: number; size?: number }): JSX.Element`, and `export function starFill(value: number): number` — the pure rounding helper, exported so it can be unit-tested without a DOM.

**This file must be import-free apart from React types**, and must not be a `'use client'` component — it is pure presentation used by both Server and Client Components. In this codebase a client component that imports a module transitively reaching `@/db` or `server-only` type-checks clean, lints clean, then 500s the page at runtime; keeping this primitive dependency-free avoids that class of problem entirely.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ui/stars.test.ts`. This tests only the pure helper — the repo has no DOM test environment (`vitest.config.ts` is `environment: 'node'`), so do NOT attempt to render the component in a test.

Importing a `.tsx` module from a node-environment test **does** work here, and there is precedent: `tests/listings/fields.test.ts` already imports `AMENITY_SLUGS` from `@/components/ui/amenity-chip.tsx`. The `@/` alias is mirrored in `vitest.config.ts`. Only the module's top level executes — no component is rendered — so JSX in the file is transformed and then simply never called.

```ts
import { expect, test } from 'vitest'
import { starFill } from '@/components/ui/stars'

test('rounds to the nearest half star', () => {
  expect(starFill(0)).toBe(0)
  expect(starFill(0.24)).toBe(0)
  expect(starFill(0.25)).toBe(0.5)
  expect(starFill(4.3)).toBe(4.5)
  expect(starFill(4.74)).toBe(4.5)
  expect(starFill(4.75)).toBe(5)
  expect(starFill(5)).toBe(5)
})

test('an exact integer rating is unchanged', () => {
  for (const n of [1, 2, 3, 4, 5]) expect(starFill(n)).toBe(n)
})

test('clamps out-of-range input instead of overflowing the row', () => {
  // The DB constrains reviews to 1..5, but an average is computed and this
  // component is public API — a value outside the range must not render six
  // stars or a negative-width overlay.
  expect(starFill(-3)).toBe(0)
  expect(starFill(7)).toBe(5)
  expect(starFill(Number.NaN)).toBe(0)
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/lib/ui/stars.test.ts
```

Expected: FAIL — cannot resolve `@/components/ui/stars`.

- [ ] **Step 3: Implement the primitive**

Create `src/components/ui/stars.tsx`:

```tsx
/**
 * Five stars, filled to the nearest half. The only place star geometry lives.
 *
 * ONE MECHANISM, NOT THREE GLYPHS: a muted row of five stars with a clipped
 * overlay of filled ones on top. Half-stars fall out of the clip width, so
 * there is no separate half-star asset to keep in sync, and the same code
 * would render any fraction if the rounding rule ever changed.
 *
 * Colour: filled `--court`, empty `--hairline`. Deliberately NOT `--ball` —
 * branding.md reserves lime as THE accent, "use sparingly", and the mark this
 * replaces was a single 7px dot. Five lime glyphs on every card in a search
 * grid is the opposite of sparing, and lime on white needs an outline to be
 * legible at all (which is why that dot had one).
 *
 * `aria-hidden` on the whole row, on purpose: the caller owns the accessible
 * name, because only the caller knows whether it is announcing "rated 4.3 out
 * of 5 from 12 reviews" or "you rated this 5 out of 5". A star row that named
 * itself would make every caller announce twice.
 *
 * Dependency-free so both Server and Client Components can use it.
 */
const STAR_PATH =
  'M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z'

/** Nearest half star, clamped to 0–5. Exported for its own unit test. */
export function starFill(value: number): number {
  if (!Number.isFinite(value)) return 0
  const clamped = Math.min(5, Math.max(0, value))
  return Math.round(clamped * 2) / 2
}

function Row({ color, size }: { color: string; size: number }) {
  return (
    <span className="flex shrink-0" style={{ gap: size * 0.15 }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden>
          <path d={STAR_PATH} />
        </svg>
      ))}
    </span>
  )
}

export function Stars({ value, size = 14 }: { value: number; size?: number }) {
  const filled = starFill(value)
  return (
    <span aria-hidden className="relative inline-flex w-fit align-middle">
      <Row color="var(--hairline)" size={size} />
      <span
        className="absolute top-0 left-0 overflow-hidden"
        style={{ width: `${(filled / 5) * 100}%` }}
      >
        <Row color="var(--court)" size={size} />
      </span>
    </span>
  )
}
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run tests/lib/ui/stars.test.ts
```

Expected: all 3 PASS.

- [ ] **Step 5: Gate and report**

```bash
npx tsc --noEmit && npx eslint
```

Expected: `tsc` silent; eslint 0 errors and no new warnings against the 9-warning baseline. Report the test output and the gate. Do not commit.

---

### Task 2: Every read-only rating surface

**Files:**
- Modify: `src/components/ui/rating.tsx`, `src/app/bookings/page.tsx`, `src/app/dashboard/reviews/page.tsx`

**Interfaces:**
- Consumes: `Stars` and `starFill` from Task 1.
- Produces: `Rating` keeps its exact current props — `{ average: number | null; count: number; onDark?: boolean }` — so its three existing callers need no edit at all.

There are three read-only surfaces, and two of them are the same widget written twice. Read all three before editing.

- [ ] **Step 1: Rewrite `Rating` to compose `Stars`**

`src/components/ui/rating.tsx`. Keep the null/zero guard exactly as it is and keep its comment's reasoning — a zero-star row reads as a *bad* rating rather than an *absent* one, which is why the component renders nothing at all when there are no reviews.

```tsx
import { Stars } from '@/components/ui/stars'

/**
 * A branch's aggregate rating: stars, the average, and the review count.
 *
 * The stars round to the nearest half, so 4.3 and 4.7 look identical — which
 * is exactly why the number stays beside them rather than being replaced by
 * them. The database holds that precision and this surface has always shown
 * it; stars are the fast read, the number is the true one.
 *
 * Renders nothing at all when a branch has no reviews — a "0 stars (0)" row
 * reads as a bad rating rather than an absent one.
 */
export function Rating({
  average,
  count,
  onDark = false,
}: {
  average: number | null
  count: number
  onDark?: boolean
}) {
  if (average === null || count === 0) return null
  return (
    <span
      className="inline-flex items-center gap-1.5 text-sm"
      aria-label={`Rated ${average.toFixed(1)} out of 5 from ${count} ${count === 1 ? 'review' : 'reviews'}`}
    >
      <Stars value={average} />
      <span className={`font-semibold ${onDark ? 'text-white' : 'text-[var(--ink)]'}`}>
        {average.toFixed(1)}
      </span>
      <span className={onDark ? 'text-white/70' : 'text-[var(--ink-soft)]'}>({count})</span>
    </span>
  )
}
```

Do **not** change `Rating`'s three callers (`src/app/venues/[slug]/page.tsx`, `src/components/ui/branch-card.tsx`, `src/components/branch/review-list.tsx`) — same props, same behaviour, so they keep working untouched. Confirm that by reading them, not by assuming.

- [ ] **Step 2: The player's own review — `src/app/bookings/page.tsx`**

Around line 258 there is a hand-rolled lime dot plus `{review.rating.toFixed(1)}`. Replace the whole `<div>` holding them:

```tsx
                        <div
                          className="mt-1.5 flex items-center justify-end"
                          aria-label={`You rated this ${review.rating} out of 5`}
                        >
                          <Stars value={review.rating} />
                        </div>
```

Add `import { Stars } from '@/components/ui/stars'`. The `.toFixed(1)` goes: a single review's rating is an integer by database constraint, so the decimal could only ever be `.0`.

- [ ] **Step 3: The owner's view of a review — `src/app/dashboard/reviews/page.tsx`**

Around line 133 the same widget appears again with its own copy of the dot markup and its own `.toFixed(1)`. Its comment explains the duplication: `<Rating>` is the aggregate component and renders nothing at zero, so this surface could not use it. **That reason no longer applies** — `Stars` is the primitive for exactly this case — so replace both the comment and the markup:

```tsx
                    {/* The single-review mark. Uses the Stars primitive rather
                        than <Rating>, which is the AGGREGATE component
                        (average + count in parens, renders nothing at zero).
                        Both single-review surfaces — this one and the player's
                        own reviews on /bookings — used to hand-roll their own
                        copy of this markup because no primitive existed. */}
                    <div
                      className="mt-1.5 flex items-center justify-end"
                      aria-label={`Rated ${review.rating} out of 5`}
                    >
                      <Stars value={review.rating} />
                    </div>
```

Add the same import.

- [ ] **Step 4: Confirm no hand-rolled rating mark survives**

```bash
grep -rn 'rating.toFixed\|--ball).*rounded-full' src/app src/components | grep -i 'rating\|review' || echo "clean"
```

Expected: `clean`. Any survivor is a fourth copy of the widget this task exists to consolidate.

- [ ] **Step 5: Verify the public surfaces render**

`/search` and a venue page are public — no auth needed. Start the dev server with the preview tool (`{name: "oncourt-dev"}`), then on `http://localhost:3000/search?city=tacloban`:

```js
(() => {
  const el = document.querySelector('[aria-label^="Rated"]')
  return JSON.stringify({
    found: !!el,
    label: el?.getAttribute('aria-label') ?? null,
    svgCount: el?.querySelectorAll('svg').length ?? 0,
    text: el?.textContent?.trim() ?? null,
  })
})()
```

Expected: `found: true`, a label like `"Rated 5.0 out of 5 from 1 review"`, **`svgCount: 10`** (five muted plus five filled), and text containing both the average and the count. Ten is the number to check — five would mean the overlay row failed to render.

- [ ] **Step 6: Gate and report**

```bash
set -a; . ./.env.local; set +a
npx vitest run tests/bookings tests/owner/reviews.test.ts tests/branches
npx tsc --noEmit && npx eslint
```

Foreground. Expected: all pass **unchanged** — these cover the review action, the queries feeding these surfaces, and the branch detail/search pages. Report the browser measurement and the gate. Do not commit.

---

### Task 3: The star input

**Files:**
- Modify: `src/app/bookings/review-form.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks — the input draws its own stars from CSS, because a radio's checked state must drive the fill and `Stars` renders a fixed value.
- Produces: a form that submits `rating` as `"1"`–`"5"`, byte-identical to what the `<select>` submitted.

- [ ] **Step 1: Replace the select with a radio group**

In `src/app/bookings/review-form.tsx`, replace the `<label className="sr-only">` + `<select>` block (roughly lines 28–42) with a fieldset of five radios. Keep the option wording — those strings are the existing vocabulary and should not drift:

```tsx
      <fieldset className="flex flex-col gap-1">
        <legend className="sr-only">Rating</legend>
        {/* Radios, not click handlers on spans. A radio group is arrow-key
            navigable, announced as a grouped choice, and submits without JS —
            all three of which a div-with-onClick star picker silently loses.
            The stars are drawn from :checked in CSS, so there is no state to
            manage here at all.

            Rendered in reverse DOM order (5 first) so the CSS sibling
            combinator can fill the checked star and every star before it;
            `flex-row-reverse` puts them back in visual 1→5 order. */}
        <div className="flex flex-row-reverse justify-end gap-0.5">
          {[
            { value: '5', label: '5 — Excellent' },
            { value: '4', label: '4 — Good' },
            { value: '3', label: '3 — Okay' },
            { value: '2', label: '2 — Poor' },
            { value: '1', label: '1 — Bad' },
          ].map((option) => (
            <label
              key={option.value}
              className="group cursor-pointer p-0.5 text-[18px] leading-none text-[var(--hairline)] transition-colors has-[:checked]:text-[var(--court)] hover:text-[var(--court)] motion-reduce:transition-none [&:has(~label:hover)]:text-[var(--court)] [&:has(~label_input:checked)]:text-[var(--court)]"
            >
              <input
                type="radio"
                name="rating"
                value={option.value}
                defaultChecked={option.value === '5'}
                className="sr-only"
              />
              <span aria-hidden>★</span>
              <span className="sr-only">{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
```

`defaultChecked` on `5` preserves the `<select>`'s `defaultValue="5"` exactly, so a player who submits without touching the control sends the same value as before.

- [ ] **Step 2: Give the group a visible focus indicator**

A `sr-only` radio is invisible, so the focus ring must be drawn on its label. Add to the same `<label>` class string:

```
has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[3px] has-[:focus-visible]:outline-[var(--court)]
```

`var(--court)` with a 3px offset is `branding.md`'s Controls focus rule for a light surface. **Do not add `outline-none` anywhere in this file** — see the Tailwind v4 trap in the Global Constraints.

- [ ] **Step 3: Confirm the form contract is unchanged**

The Server Action must not need editing. Verify by reading, not assuming:

```bash
grep -n "formData.get('rating')" src/lib/bookings/review-write.ts
grep -rn "name=\"rating\"" src/app/bookings/review-form.tsx
```

Expected: the action still reads `rating` off `FormData`, and the radios are all named `rating`. `review-write.ts` must appear in **no** diff.

- [ ] **Step 4: Run the review tests**

```bash
set -a; . ./.env.local; set +a
npx vitest run tests/bookings/review-action.test.ts tests/schema/reviews.test.ts
```

Foreground. Expected: pass **unchanged**. These cover the action's parsing and the database constraint — the two things a changed form contract would break.

- [ ] **Step 5: Verify the compiled CSS actually emits the states**

`/bookings` needs a signed-in player and this project has **no dev login**, so you cannot tab through this form. Do not claim you did. Verify instead that the `has-[...]` variants compiled — a Tailwind variant that silently fails to generate is the realistic failure mode here. On any public page, in the browser:

```js
(() => {
  // Plain substring matching, NOT a RegExp. A compiled Tailwind selector for an
  // escaped class name contains REAL backslashes — `.has-\[\:checked\]:…` — so
  // a pattern like `new RegExp('has-\\[\\:checked\\]')` compiles to `has-\[\:checked\]`,
  // which matches the *unescaped* text `has-[:checked]` and therefore never
  // matches the actual selector. An earlier draft of this step did exactly that
  // and reported a false negative on CSS that had compiled correctly.
  const wanted = ['has-\\[:checked\\]', 'focus-visible', 'flex-row-reverse']
  const found = Object.fromEntries(wanted.map((w) => [w, false]))
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch { continue }
    for (const r of rules) {
      const text = r.selectorText || r.cssText || ''
      for (const w of wanted) if (text.includes(w)) found[w] = true
    }
  }
  return JSON.stringify(found)
})()
```

Expected: all three `true`. If one reads `false`, confirm by dumping the matching selectors directly (`[...document.styleSheets].flatMap(s => { try { return [...s.cssRules] } catch { return [] } }).map(r => r.selectorText).filter(Boolean).filter(s => s.includes('checked'))`) before concluding the variant failed to compile — the check is more likely wrong than Tailwind is.

Report this as evidence about the generated CSS, and state plainly that the rendered form remains unverified pending the owner's own signed-in check.

- [ ] **Step 6: Gate and report**

```bash
npx tsc --noEmit && npx eslint
```

Report the test results, the CSS check, and an explicit statement that the form's appearance and keyboard behaviour are unverified. Do not commit.

---

### Task 4: `branding.md` and the final sweep

**Files:**
- Modify: `design/branding.md`

- [ ] **Step 1: Rewrite the Rating entry**

`design/branding.md`'s Components list currently reads:

```
- **Rating:** lime dot (7px, ink outline) + bold number, count in parens muted.
```

Replace with an entry describing what now exists. It must record: five stars at half-star precision from `src/components/ui/stars.tsx`; filled `--court`, empty `--hairline`; **why not lime** (branding.md's own "use sparingly" rule — the mark this replaced was a single 7px dot, and five lime glyphs per card in a search grid is the opposite of sparing, besides needing an outline to be legible on white); the numeric average kept beside the stars because half-star rounding makes 4.3 and 4.7 identical; the count in parens; nothing rendered at zero reviews; and that the star row is `aria-hidden` with the accessible name on the caller.

Add the input rule too: a rating input is **five radios in a fieldset styled as stars**, never click handlers on spans — radios are arrow-key navigable, announced as a group, and submit without JS. Note the reverse-DOM-order + `flex-row-reverse` technique, since it looks like a mistake to anyone reading it cold.

Use targeted string replacement after re-reading the file. Another session has edited `branding.md` during this project.

- [ ] **Step 2: Confirm scope**

```bash
git status --short
```

Expected, and nothing else beyond the profile-completion work if it is still uncommitted: `src/components/ui/stars.tsx` (new), `tests/lib/ui/stars.test.ts` (new), `src/components/ui/rating.tsx`, `src/app/bookings/page.tsx`, `src/app/dashboard/reviews/page.tsx`, `src/app/bookings/review-form.tsx`, `design/branding.md`.

**`src/lib/bookings/review-write.ts`, `src/app/bookings/actions.ts`, and anything under `supabase/migrations/` must NOT appear.** If one does, stop and report — this feature changes no behaviour and no schema.

- [ ] **Step 3: Full suite**

```bash
set -a; . ./.env.local; set +a
npx vitest run
```

Foreground; it takes ~14 minutes against the hosted database. Expected: everything passes **except** the two known-unrelated failures — `tests/schema/settings.test.ts` and `tests/booking/hold.test.ts`, both assuming `hold_duration_minutes` is 15 while the database holds 5. Report the exact pass/fail counts. If a test fails on a timeout rather than an assertion, that is a pool-contention flake on this shared database — re-run that single file and say which it was.

- [ ] **Step 4: Public pages healthy**

```bash
curl -s -o /dev/null -w '/ %{http_code}\n' http://localhost:3000/
curl -s -o /dev/null -w '/search %{http_code}\n' 'http://localhost:3000/search?city=tacloban'
curl -s -o /dev/null -w '/venue %{http_code}\n' http://localhost:3000/venues/gapickle-taboan
```

Expected: `200` for all three. Check the dev server log for `server-only` and for any unhandled error.

- [ ] **Step 5: Screenshot**

Capture the venue page's rating row to `docs/screenshots/` — never the repo root (project rule).

- [ ] **Step 6: Report**

Final report: the stars visible on the public surfaces, the suite counts with the two known failures named, the scope confirmation, the screenshot path, an explicit note that **the review form itself is unverified** (no dev login), and that **nothing was committed**.

---

## Notes for the executing agent

**You are the implementer.** Do not delegate any task to another subagent. Do not create a git worktree.

**The two things most likely to go wrong, both quiet:**
1. A Tailwind variant (`has-[:checked]`, `has-[:focus-visible]`) that does not compile — the form would look permanently unfilled with no error anywhere. Task 3 Step 5 checks this.
2. The clipped overlay rendering as five stars instead of ten — meaning the fill layer collapsed. Task 2 Step 5 checks the count explicitly.

**Do not fix things you notice in passing.** The spec's "Out of scope" lists schema changes, half-star *input*, review moderation, and the `?sort=rating` ordering. Flag them; do not implement them.
