# Supabase foundation — review notes

Distilled from the ten task reports and the whole-branch review produced while
implementing `docs/superpowers/plans/2026-07-31-supabase-foundation.md`.
Those scratch artifacts were deleted after the work landed; this file is what
outlives them. Everything here was verified against the live database or the
build output at the time of writing.

Conventions and environment facts live in `CLAUDE.md`. Hosted-project setup
steps live in `docs/runbooks/supabase-project-setup.md`. This file is the
"what we learned and what is still open" record.

---

## Open items requiring Dashboard access

None of these are fixable from code. All three are recorded in the runbook.

**Update, 2026-08-02:** open item 2 below is resolved — see item 2 itself and
row 5 of the Definition of Done table.

1. **The Data API is still enabled.** No application data is reachable — every
   table refuses both the publishable and secret keys — but `spatial_ref_sys`,
   the `geometry_columns` / `geography_columns` views, and ~932
   `supabase_admin`-owned functions answer the publishable key. Those objects
   are owned by `supabase_admin` and cannot be revoked from our role. Turning
   the Data API off is the only mitigation.

   Note `geography_columns` now returns `public / branches / location / 4326 /
   Point` — schema metadata for a real application table, not just PostGIS
   reference data.

2. **RESOLVED (verified 2026-08-02).** Google OAuth **is** configured — see
   `docs/superpowers/specs/2026-08-02-dashboards-and-account-menu-design.md`,
   Scope item 11 and its Verification section: the authorize endpoint 302s to
   Google's consent screen rather than returning `400 Unsupported provider`.
   The guards, the allowlist and the callback are tested against the real
   database. Not confirmed by that probe: whether the redirect allowlist
   contains every deployed origin — Supabase validates that at callback time,
   so a missing entry surfaces as a failed post-consent redirect.

3. **Nobody has confirmed other auth providers are disabled.** This is the sharp
   one. `src/app/auth/callback/route.ts` promotes any verified-JWT email that
   matches `ADMIN_EMAILS`. If email/password signup is enabled, self-registration
   with an allowlisted address reaches `role = 'admin'` directly. Check before
   launch.

---

## Definition of Done — final audit

| # | Item | Status |
|---|---|---|
| 1 | `npm test` fully green | Met — 79 tests / 13 files |
| 2 | `db reset && npm test` from scratch | N/A — `db reset` unavailable on a hosted project; idempotency proven by double-apply instead. **Caveat:** double-apply proves migrations are re-runnable against an already-migrated DB, not that they build a correct schema from an empty one. Ordering regressions would be invisible. |
| 3 | Lockdown suite enumerates every table, all denied | Met, and exceeds the plan (see below) |
| 4 | Two concurrency tests pass | Met — plus a third raw two-connection race |
| 5 | Google sign-in works; allowlisted email promoted | **Met** — provider configured, verified 2026-08-02 (see open item 2). A signed-in browser walk of the allowlist-promotion path is a separate, later verification. |
| 6 | `/venues/smash-zone-marikina` renders; slot click creates a hold | **Partial** — page and grid verified with real data; the browser click → Server Action → hold segment is gated behind the missing OAuth. Substitute evidence: a direct `createHold()` call produced a real `pending_payment` row. |
| 7 | Runbook records the Data API decision and app-role outcome | Met |
| 8 | No `create_booking_hold` function | Met — verified against `pg_proc` |

---

## Decisions worth not re-litigating

**Revokes are deliberately wider than the plan text.** `revoke all` on tables,
sequences and functions for `anon`, `authenticated` and `service_role`. The
plan's `select, insert, update, delete` left `anon` holding TRUNCATE on every
future table — which RLS does **not** filter — and EXECUTE on every future
function in `public`, which would have made the pg_cron job bodies
anon-callable RPC endpoints.

**A schema-level `revoke usage on schema public` was considered and rejected.**
It is technically available to `postgres` via `pg_database_owner`, and it would
close the residual PostGIS exposure. But `anon` inherits USAGE from the `PUBLIC`
pseudo-role, so closing it requires revoking from `PUBLIC` — which also strips
`supabase_auth_admin`, the role that fires the `on_auth_user_created` signup
trigger. Re-granting to each internal Supabase role is fragile against a
platform whose role set we do not control. Do not revisit without a plan for
that.

**`bookings` foreign keys are `NO ACTION` while every table above them
CASCADEs.** Deliberate: bookings are financial records and must not vanish with
a user. Consequence: deleting an `auth.users` row raises 23503 once any booking
exists under it. Pinned by a test so the behavior is documented rather than
discovered.

**Function EXECUTE lockdown depends on an explicit per-function revoke.** Task
3's default-privilege revoke targets the three named roles and does **not**
strip `PUBLIC`. What actually keeps `handle_new_user`, `expire_stale_holds` and
`complete_past_bookings` locked down is the explicit
`revoke all on function ... from public` in their own migrations. Any future
migration adding a `public`-schema function must write that line — the lockdown
suite now catches it if you forget.

**The exclusion constraint's predicate cannot reference `now()`** (index
predicates must be immutable), so it cannot distinguish a live hold from an
expired-but-unswept one. It therefore over-blocks, which fails safe — it can
never double-sell. `hold.ts` sweeps stale holds inside the same transaction to
make the check exact; the pg_cron janitor bounds staleness in the background.
Both use an identical definition of expired.

**A losing insert can raise `23P01` or `40P01`.** GiST exclusion checking must
`XactLockTableWait` on an in-progress conflicting candidate, and unlike a unique
btree there is no identical-key tie-break, so two backends inserting mutually
overlapping ranges can form a genuine wait-for cycle. Both codes mean "someone
else took this slot" and are mapped identically.

---

## Bugs found in the plan's own reference code

The plan was written before the dependency versions were known. Seven real bugs
in its sample code were caught during implementation:

1. **Manila weekday** — `getUTCDay()` on a `+08:00`-shifted instant is off by one
   on *every* day of the year. Would have validated every booking against the
   wrong day's operating hours. Hit independently in two tasks.
2. **SQLSTATE read location** — drizzle-orm 0.45.2 wraps driver errors in
   `DrizzleQueryError`, which sets only `.cause`, never `.code`. The plan's read
   would have been `undefined` on every path, so `slot_taken` was unreachable.
3. **Array parameter binding** — `in (${courtIds})` makes drizzle wrap the array
   in its own parentheses, producing `in (($1, $2))` — a row constructor, not an
   IN-list. Fails with `42883 operator does not exist: uuid = record` on any
   branch with 2+ courts. Correct form is `= any (${sql.param(ids)}::uuid[])`.
4. **`shiftDay` arithmetic** — a no-op going forward and a two-day jump going
   backward.
5. **plpgsql variable shadowing** — a `court_id` loop variable colliding with the
   column in `on conflict (court_id, ...)`; the documented `42702` trap
   (PostgreSQL docs §43.11.1).
6. **Seed id collision** with an existing fixture branch.
7. **`formatHour(24)`** rendering midnight incorrectly.

---

## The recurring failure mode: comments that outran the code

This happened in **five** separate places, and in one case a confident comment
made a broken SQL fix look verified for a full review cycle. Examples:

- A comment asserting `in (${courtIds})` generates `in ($1, $2)` — drizzle does
  not produce that shape.
- A comment claiming a malformed date "returns a `HoldResult`" when the `catch`
  handled only two SQLSTATEs and `PricingError`, so it still threw.
- A docstring claiming out-of-range hours are rejected, when `hour = 24` rolls
  over to next-day midnight — and `closes_hour = 24` is used by the fixtures, so
  that path ran constantly.
- A `globals.css` comment stating nothing used the `bg-foreground` utilities
  while `page.tsx` used them and the build had dropped them.

**If you take one habit into the payments slice:** verify what generated code
actually produces — print the SQL, read the compiled CSS, query the catalog —
rather than trusting a comment or a passing test. Several of these survived
green suites.

---

## Residual risk

- **Roughly half of the auth layer has never executed.** The proxy's cookie and
  header forwarding, `exchangeCodeForSession`, and the callback's admin
  promotion have only run against a mock or not at all. The guards below that
  boundary are well tested; the boundary itself is not.
- **No end-to-end browser run of the booking flow.** The `slot_taken` branch in
  particular — including whether the grid visibly refreshes as its copy promises
  — has never been seen.
- **One unexplained intermittent suite failure**, investigated across 7 runs /
  70 executions with no reproduction; a logic race was ruled out structurally
  (both SQLSTATEs map to the same reason, and the ceiling test's holds target
  different courts so no conflict is reachable). Most likely candidates if it
  recurs: Supavisor session-mode client limits (nothing calls `pool.end()`),
  clock skew between the local machine and the DB host (the hold-expiry
  assertion compares a DB-computed `expires_at` against local `Date.now()`), or
  the 20s timeouts against a remote pooler. **Capture full `--reporter=verbose`
  output before rerunning** — a truncated log is what prevented root-causing it.
- **Per-owner fee overrides and `platform_fee_mode = 'flat'` have zero
  coverage**, and `owner_net_centavos` has no `>= 0` guard in schema or code.
  Harmless today because nothing can set flat mode. The payments slice owns this.
- **`total_charged_centavos = court_fee + transaction_fee` is enforced only in
  `hold.ts`**, not by the database. The payments slice writes those columns from
  a second code path.
- **No CI.** Nothing enforces `npm test` / `tsc` / `eslint` / `build` on future
  commits, and nothing re-proves migration idempotency now that `db reset` is
  unavailable.
- **The test database is also the demo database.** The suite now cleans up after
  itself, but ~2,300 historical rows and ~2,700 fake users predate that fix, and
  the same project hosts the seeded `smash-zone-marikina` branch. A separate
  throwaway test project is cheap now and awkward later.
- **`cron.test.ts` holds a `BEGIN..ROLLBACK` window** during which the live
  pg_cron jobs could contend for row locks. Bounded; worst case a transient
  wait. Worth knowing if CI ever goes flaky.

---

## Smaller deferred items

- `design/branding.md` has no error color; `availability-grid.tsx` uses a
  hardcoded `text-red-600`. Adding one to the doc is a design decision.
- `font-display` is applied on the home page but was not retrofitted onto the
  login and venues headings.
- ~~Duplicated Manila date helpers~~ **RESOLVED** (Task 1): `isRealCalendarDate`/
  `isValidCalendarDate` and the two copies of `manilaWeekday` are consolidated
  into `src/lib/date-manila.ts`, with the off-by-one and `shiftDay` traps
  documented inline. Verified by reading the file during Task 13.
- A booking crossing Manila midnight would put hour 0 into `occupiedHours`, and
  a booking starting the previous Manila day would not appear on today's grid.
  Both unreachable while `endHour <= 24` and the grid never renders hour 0.
- The eight files in `design/mockups/` still define `--band-peak` and render the
  rate-band time-spine tint that `branding.md` records as dropped. The built app
  is authoritative where they differ.
- `src/db/schema.ts` is generated, excluded from `tsconfig.json`, and imported by
  nothing — see `CLAUDE.md` for why, and why importing it will resurface a
  `TS2304`.

---

## Task 13 — what the public-browse-pages verification could not confirm

Task 13 ran the automated suite twice, `tsc`/`lint`/`build`, a full browser walk
of the browse flow, and measured overflow at three widths. It did **not**
close these gaps:

- **The signed-in nav state has never rendered against a real session.** Google
  sign-in is still unconfigured (open item 2 above), so every browser check in
  this task — and every one before it — ran signed out. Whether the nav's
  authenticated state, the owner-branch "List your court" affordances, or any
  session-dependent chrome actually render correctly is unverified.
- **The database now also carries real demo content**: 11 branches (`select
  count(*) from branches` on the hosted project), on top of the historical rows
  and fake users already on record. This strengthens, rather than resolves, the
  existing case for a separate throwaway test project — the shared hosted
  database keeps accumulating fixtures that a future reset would have to
  account for.
- **`profiles.business_logo_path` has no provisioned Storage bucket.** The
  column exists (`supabase/migrations/20260801052945_profiles.sql`) and
  `branches/queries.ts` reads it, but `PhotoBucket` in `src/lib/photos.ts` only
  allows `'branch-photos' | 'court-photos'` — no bucket was ever created for
  owner logos. `src/app/owners/[slug]/page.tsx` already documents this gap
  inline; it needs a storage migration before an owner logo can ever render.

One additional finding surfaced by this task's own checks, not previously
recorded: at exactly the `min-[980px]` breakpoint, `/venues/[slug]` overflowed
horizontally by 76px (`document.documentElement.scrollWidth` 1056 vs
`window.innerWidth` 980). The booking table's `min-w-[640px]`, wrapped in its
own `overflow-x-auto`, was meant to scroll internally, but the grid item
(`<section aria-label="Book a court">` under `grid-cols-[360px_1fr]` in
`src/app/venues/[slug]/page.tsx:89`) had no `min-w-0`, so its default
`min-width: auto` let the table's intrinsic width push the whole section past
the 1fr track instead of clipping into it — violating branding.md's "the page
itself never scrolls sideways" rule. Confirmed only at 980px — 1280px and 375px
measured zero overflow on the same page. **Fixed** in the same task by adding
`min-w-0` to that section; all 12 page×width combinations re-measured at 0px
overflow afterward, and the booking grid's internal scroll, sticky time
column, and slot clickability were confirmed still working at 980px. See
`task-13-report.md` for the full before/after measurement tables.
