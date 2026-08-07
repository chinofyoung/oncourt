# Search bar: Tacloban default, time range, "Search" CTA

**Date:** 2026-08-07
**Status:** approved, ready for implementation

## Problem

Three defects in the home hero and `/search` search bar, all pointing the same
direction — the search bar describes a product that no longer exists:

1. **The city picker offers ten Metro Manila cities and none of them have
   courts.** `DEFAULT_CITY_SLUG` is `metro-manila`. The only real branch in the
   database is `gapickle-taboan` in Tacloban, which the picker cannot reach at
   all. Every option in the dropdown returns "No courts found".
2. **Time is a single start hour.** A player booking a two-hour session has no
   way to express it, and a one-hour match tells them nothing about whether the
   second hour is free on the same court.
3. **The CTAs don't say "Search".** The home hero says "Find open courts"; the
   `/search` float has no submit control at all — the slot where one belongs
   holds "Use my location".

## Decisions

| Question | Decision |
|---|---|
| City list | Replace all ten Metro Manila entries with Tacloban City (default) + a nationwide fallback |
| Wide-area option | "All of the Philippines", **not** a regional entry — a region goes stale the moment an owner signs up outside it |
| Range semantics | One court must cover the **whole** span, so a result is always bookable as a single session |
| Range UI | One Time field, two selects, spaced en dash between them |
| `/search` CTA | Add a lime "Search"; fields keep applying live; "Use my location" demotes to a text link |

## Design

### 1. Cities — `src/lib/geo/cities.ts`

`CITIES` drops from ten entries to two, and `DEFAULT_CITY_SLUG` becomes
`tacloban`:

| slug | name | lat | lng | search radius |
|---|---|---|---|---|
| `tacloban` | Tacloban City | 11.2444 | 125.0048 | `CITY_SEARCH_RADIUS_METERS` (12 km) |
| `philippines` | All of the Philippines | 12.8797 | 121.7740 | 1,500 km |

`tacloban` is the default, so the wide entry is a deliberate second choice
rather than the landing state.

**Why nationwide instead of "All of Eastern Visayas".** The file's own doc
comment promises that every entry corresponds to real branches, so the picker
never offers a dead option. A regional entry breaks that promise in the other
direction: the first owner who signs up in Cebu or Manila is unreachable from
the picker entirely. A nationwide fallback is correct for every future branch
and needs no maintenance.

**Radius.** `parseSearchParams` currently special-cases the default slug to a
30 km radius and gives every other city 12 km. That branch inverts: the default
(`tacloban`) is now a real city on the 12 km radius, and `philippines` is the
one that needs the wide radius. Key the radius off the city entry itself — add
an optional `radiusMeters` to the `City` type — rather than off "is this the
default slug", which is now a coincidence rather than a rule.

### 2. Time range — the `until` param

A new optional `until` URL param joins the existing `hour`.

- `?hour=14` — unchanged single-hour behavior, 2–3 PM.
- `?hour=14&until=17` — 2 PM to 5 PM, i.e. hours 14, 15 and 16. `until` is
  **exclusive**, matching `court_operating_hours.closes_hour` and the
  `tstzrange(…, '[)')` bounds already used throughout the booking code.

Omitting `until` reproduces today's behavior exactly, so existing links and
bookmarks keep working with no migration.

**Validation** (`parseSearchParams`). `until` resolves to `undefined` unless it
is an integer in 1..24 **and** strictly greater than `hour` **and** `hour` is
itself defined. Empty string is treated as absent before `Number()`, the same
trap `hour`/`lat`/`lng`/`max` already document. A hand-edited URL can therefore
never produce a backwards or zero-width span.

**Filter semantics** (`searchBranches`). A branch qualifies when **one single
court** satisfies all of:

- operating hours enclose the span — `opens_hour <= hour and closes_hour >= until`
- a rate band prices **every** hour in `[hour, until)` — an unpriced hour is
  not a bookable hour, the same rule `buildAvailabilityGrid` applies per cell
- no `confirmed` / `completed` / `blocked` booking, and no unexpired
  `pending_payment` hold, overlaps `[hour, until)`

Keeping this inside the existing per-court `EXISTS` is what guarantees "the same
court for the whole span" — a branch with court A free 2–3 PM and court B free
3–5 PM does not qualify for a 2–5 PM search, and should not, since it can't be
booked as one session.

The single-hour path is this same predicate with `until = hour + 1`, so there is
one code path, not two.

`filters.hour`/`until` stay deliberately out of the `courtCount` /
`minPriceCentavos` aggregates, unchanged — scoping those to the span would mean
picking one court's price to display when several qualify, which is a separate
product question.

### 3. The Time control

One field holding two selects with a spaced en dash between them, matching
branding.md's `7 – 9 AM` convention:

```
TIME
[ Any time ▾ ] – [ — ▾ ]
```

- Start select: "Any time" (value `""`) plus 7 AM … 11 PM.
- End select: "—" (value `""`, meaning start-hour-only) plus every hour after
  the selected start, up to midnight.
- With no start chosen the end select is inert; an end that isn't after the
  start is dropped server-side by `parseSearchParams`, so no client validation
  is load-bearing.

**Shared logic, not shared markup.** `HOUR_OPTIONS` is currently duplicated
between `src/app/page.tsx` and `src/components/search/map-hero.tsx`. That, plus
the end-hour derivation, moves into a new `src/lib/search/hours.ts`. The markup
stays per-page: the hero's selects are white-on-glass with `[color-scheme:dark]`
over a photo, the search float's are ink-on-panel, and a shared component would
need a styling escape hatch large enough to defeat the purpose.

The home hero form stays a plain server-rendered GET form — the end select
lists all hours unconditionally there, and the server drops an invalid pair.
`map-hero.tsx` is already a client component, so its end select narrows
reactively to hours after the chosen start.

`formatHourRange(start, end)` already exists in `src/lib/format.ts` and needs no
change; the map hero's summary pill uses it when `until` is set.

### 4. CTAs

- **Home hero:** "Find open courts" → **"Search"**, still the page's one lime
  button.
- **`/search` float:** a new lime **"Search"** button in the slot currently
  holding "Use my location", at `--control-h` / `--btn-radius` / `--ball`. It is
  the only lime button on that page, so the "never two lime buttons in one view"
  rule is satisfied. "Use my location" becomes a small text link beside the
  Where label.
- The fields keep applying live on change, so "Search" re-runs the current
  query. That is not a no-op: availability moves with the clock, and re-running
  is the honest meaning of the button on a page whose filters are already
  in the URL.

### 5. branding.md

Per the project rule, `design/branding.md` is updated in the same change:

- The **Voice** line cites "Find open courts" as an example of a button that
  says exactly what it does. That string no longer exists; replace the example.
- **Controls** gains a note for the two-select range field and its en-dash
  separator, so the pattern is documented rather than folklore.

## Consequences elsewhere

- `getHomeData`'s per-city chip counts (`src/lib/branches/queries.ts`) exclude
  `DEFAULT_CITY_SLUG` and count within `CITY_SEARCH_RADIUS_METERS`. With the new
  table that leaves exactly one named city, Tacloban. The query needs no change,
  but its comment names "All of Metro Manila" and must be corrected.
- `cityCenterByName` (the branch form's map-pin starting view) falls back to the
  default city for an unknown name. That default moves from Metro Manila to
  Tacloban. Correct, and it matches where the real branch is.
- `src/app/page.tsx`'s `hourOptions` comment justifies the 7–23 range by citing
  seeded Rally Republic / Dink Haus / Smash Zone branches. Those rows were
  deleted from the shared database on 2026-08-07. The comment is rewritten to
  state the range as a product choice, which is what it now is.
- `tests/lib/search/params.test.ts` asserts against `makati`; `tests/branches/
  detail.test.ts` looks up `marikina` from `CITIES`. Both break on the new table
  and must be updated to the new slugs.

## Testing

Against the hosted database, per project convention — the constraints are the
logic, and every test must survive repeated runs on shared, persistent data.

- `parseSearchParams`: `until` accepted in range; dropped when ≤ `hour`, when
  `hour` is absent, when empty, when non-integer, when out of 1..24. Default
  city resolves to `tacloban`; unknown slug falls back to it; `philippines`
  resolves to the wide radius.
- `searchBranches` range filter, seeding a branch whose single court is free
  only part of the span: qualifies for the sub-span, does **not** qualify for
  the full span. A second test with two courts, each covering half the span,
  must **not** qualify — this is the assertion that pins "same court
  throughout" and is the one a naive implementation fails.
- Span crossing a rate-band edge qualifies; span running past `closes_hour`
  does not.
- Existing single-hour tests must pass unchanged — that is the regression proof
  that `until`'s absence preserves today's behavior.
