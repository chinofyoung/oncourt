import { notFound } from 'next/navigation'
import { AvailabilityGrid } from '@/components/availability-grid'
import { loadBranchDay } from '@/lib/booking/availability'

// Colors/tokens reference the brand CSS variables in src/app/globals.css
// (mirroring design/branding.md, the design source of truth): --surface for
// the page background, --ink/--ink-soft for text, --panel/--hairline for
// the date-nav pill, --court for the light-background focus ring. The
// booking-panel header (title + date nav) is ported from
// design/mockups/branch-page.html's `.booking-top`/`.datebar`; the
// mockup's left rail (gallery, reviews, map, amenity chips) is deliberately
// not built here — this task's file list is page.tsx/actions.ts/the grid
// component, and reviews/photos/maps belong to other, later slices.

/** Manila is UTC+8 with no DST, so a fixed offset is correct and stable. */
function manilaToday(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * `date` here comes straight from the public `?date=` query string — the
 * one input on this page a Server Component itself must validate, since
 * there is no Server Action boundary in front of it. Without this,
 * `loadBranchDay(slug, date)` builds `new Date(\`${date}T00:00:00+08:00\`)`
 * and calls `.toISOString()` on it unconditionally; for a shape-invalid
 * string (e.g. `?date=lol`) that throws an uncaught `RangeError: Invalid
 * time value`, 500-ing this public page for anyone who edits the URL.
 * Confirmed live before writing this — see task-9-report.md fix round 1.
 *
 * Also rejects a shape-valid but calendar-nonexistent date (`2026-02-30`)
 * via the same round-trip-through-`Date.UTC` check used in
 * `src/app/venues/[slug]/actions.ts`'s `isRealCalendarDate` — duplicated
 * here rather than shared, matching this codebase's existing pattern of
 * small per-file date helpers (e.g. `manilaWeekday` in both `hold.ts` and
 * `availability.ts`) instead of a new shared utils module.
 */
function isValidCalendarDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false
  const [year, month, day] = date.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  )
}

/**
 * Shifts a `YYYY-MM-DD` calendar date by `days`, with no timezone
 * arithmetic at all: parsing the date's own y/m/d components into
 * `Date.UTC` and shifting the day component is exact, because a calendar
 * date shift needs no notion of an offset. (An earlier approach that parsed
 * `${date}T00:00:00+08:00`, shifted with `setUTCDate`, and read the result
 * back with `toISOString().slice(0, 10)` was verified to be off by one in
 * both directions: parsing with an explicit +08:00 offset first converts to
 * a UTC instant on the *previous* calendar day, and shifting the ISO date
 * string never corrects for that. Confirmed directly in Node before writing
 * this version — see task-9-report.md.)
 */
function shiftDay(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

function formatDateLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export default async function BranchPage(props: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ date?: string; held?: string }>
}) {
  const { slug } = await props.params
  const { date, held } = await props.searchParams
  // Falls back to today rather than 404ing — a mistyped or stale `?date=`
  // is a harmless typo on a public page, not a broken resource.
  const day = date && isValidCalendarDate(date) ? date : manilaToday()

  const result = await loadBranchDay(slug, day)
  if (!result) notFound()

  const isToday = day === manilaToday()

  return (
    <main className="mx-auto flex max-w-[1120px] flex-col gap-6 bg-[var(--surface)] px-6 py-10">
      <header>
        <h1 className="text-3xl font-bold tracking-tight text-[var(--ink)]">
          {result.branch.name as string}
        </h1>
        <p className="mt-1 text-[var(--ink-soft)]">
          {result.branch.address as string}, {result.branch.city as string}
        </p>
      </header>

      {held && (
        <p
          role="status"
          className="rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--band-off)] px-4 py-3 text-sm text-[var(--court-deep)]"
        >
          Slot on hold — go ahead and pay to confirm it before the hold expires.
        </p>
      )}

      <section aria-label="Book a court" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-bold text-[var(--ink)]">Book a court</h2>
          <div className="flex items-center gap-2">
            <a
              href={`/venues/${slug}?date=${shiftDay(day, -1)}`}
              aria-label="Previous day"
              className="flex h-[var(--btn-h-sm)] w-[var(--btn-h-sm)] items-center justify-center rounded-[var(--btn-radius)] border border-[var(--hairline)] text-[var(--ink-soft)] hover:border-[var(--court)] hover:text-[var(--court-deep)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-[3px]"
            >
              ‹
            </a>
            <span className="font-semibold text-[var(--ink)]">{formatDateLabel(day)}</span>
            {isToday && (
              <span className="rounded-full bg-[var(--ink)] px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[.06em] text-[var(--ball)]">
                Today
              </span>
            )}
            <a
              href={`/venues/${slug}?date=${shiftDay(day, 1)}`}
              aria-label="Next day"
              className="flex h-[var(--btn-h-sm)] w-[var(--btn-h-sm)] items-center justify-center rounded-[var(--btn-radius)] border border-[var(--hairline)] text-[var(--ink-soft)] hover:border-[var(--court)] hover:text-[var(--court-deep)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-[3px]"
            >
              ›
            </a>
          </div>
        </div>

        {result.grid.length === 0 ? (
          <p className="text-[var(--ink-soft)]">No approved courts at this branch yet.</p>
        ) : (
          <AvailabilityGrid
            grid={result.grid}
            branchId={result.branch.id as string}
            slug={slug}
            date={day}
          />
        )}
      </section>
    </main>
  )
}
