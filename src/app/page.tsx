import Link from 'next/link'
import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { BranchCard } from '@/components/ui/branch-card'
import { getHomeData } from '@/lib/branches/queries'
import { CITIES, DEFAULT_CITY_SLUG } from '@/lib/geo/cities'
import { manilaToday } from '@/lib/date-manila'
import { formatHour } from '@/lib/format'
import { HOUR_OPTIONS, endHourOptions } from '@/lib/search/hours'
import { getOptionalUser } from '@/lib/auth/guards'
import { ownerCtaHref } from '@/lib/site/owner-cta'

// Ported from design/mockups/home.html. Structure: overlay Nav inside a
// relative hero (photo + solid rgba(6,20,13,.68) overlay per branding.md —
// no gradients), a plain GET search form, a browse-by-city strip built from
// `getHomeData()`'s raw city rows, the featured-branches grid, a static
// "how it works" band, an owner CTA, and the shared Footer. The mockup only
// sketches the hero/grid; the "how it works" and owner-CTA sections below
// are carried over too so the real home page matches the mockup's full
// content, not just the two data-driven pieces the task's code skeleton
// called out.
//
// Defect found vs. the mockup (branding.md wins per this task's brief):
// home.html uses TWO lime buttons on one page — the hero's `.search-btn`
// AND the owner-cta's `.cta-btn` both use `--ball`/`--ball-ink`. That
// directly violates branding.md's Controls rule, "Never two lime buttons in
// one view." The hero's lime search CTA is this page's one primary action,
// so the owner CTA below renders as a light button (--surface bg, --ink text)
// instead of lime — still a clear, high-contrast CTA against the dark
// --court-deep panel, just not competing with the hero's lime.
export default async function HomePage() {
  const { featured, cities, openNowCount } = await getHomeData()
  // A second session read on this page (<Nav> does its own): one claims read
  // and one indexed profiles lookup, so that the page's own owner CTA lands
  // somewhere useful instead of on /login for an owner who is already signed
  // in. App Router gives a Server Component no way to share <Nav>'s result.
  const user = await getOptionalUser()
  const today = manilaToday()

  // getHomeData() already returns one row per named city (slug, name,
  // branchCount) counted via the same radius search `/search?city=<slug>`
  // uses, so a chip's count always matches what clicking through to that
  // city actually shows — no string-matching against `CITIES` needed here
  // anymore, and a city with zero venues in radius simply has no row.
  const cityLinks = cities

  // The Time field's start/end hour lists come from `@/lib/search/hours`,
  // shared with `/search`'s float so the two search bars can't drift. This
  // form is a plain GET form with no client state, so the end list is the
  // unconditional one (`endHourOptions(undefined)` = 8 AM … midnight): a pair
  // that isn't a real span is dropped by `parseSearchParams`, so no client
  // validation here is load-bearing.
  const endHours = endHourOptions(undefined)

  return (
    <>
      <section className="relative">
        <Nav variant="overlay" />

        <header className="relative overflow-hidden pt-[148px] pb-[88px] max-[980px]:pt-[112px] max-[980px]:pb-14">
          <img
            src="https://images.unsplash.com/photo-1747027694225-cbf12dd20826?q=75&w=1800&auto=format&fit=crop"
            alt=""
            aria-hidden
            className="absolute inset-0 h-full w-full object-cover object-[center_62%]"
          />
          <div aria-hidden className="absolute inset-0 bg-[rgba(6,20,13,.68)]" />

          {/* The full-bleed padding formula, NOT `mx-auto max-w-[1120px]
              px-6` — the two are not the same column. `max-w` + `px-6`
              leaves 1072px of content inset 24px from where every other
              band on this page starts; the formula leaves exactly 1120px
              flush with them. Before this changed, the nav, `main` and the
              footer all began at x=95 on a 1309px viewport while this hero
              began at x=119, so the headline and search bar sat 24px inboard
              of the cards directly beneath them. See branding.md, Layout.
              Do NOT re-add `max-w-[1120px]` alongside this: the formula
              already caps the content, and a max-w on top would re-center a
              narrower box inside the padding and undo the alignment. */}
          <div className="relative z-[1] px-[max(24px,calc((100vw-1120px)/2))]">
            <span className="font-mono inline-flex items-center gap-2.5 text-[11.5px] tracking-[.16em] text-white/66 uppercase">
              <span aria-hidden className="h-px w-[22px] bg-[var(--ball)]" />
              Pickleball courts · Philippines
            </span>

            <h1 className="font-display mt-[18px] mb-[18px] max-w-[900px] text-[68px] leading-none font-bold tracking-[-0.035em] text-white max-[980px]:text-[44px] max-[560px]:text-[38px] max-[560px]:tracking-[-0.03em]">
              Pick a time. Pick a court.
              <br />
              <span className="text-[var(--ball)]">Game on.</span>
            </h1>
            <p className="max-w-[560px] text-[17px] font-normal text-white/75 max-[560px]:text-[15.5px]">
              Every court near you on one live grid — real prices, instant booking, paid with
              GCash, Maya, or card.
            </p>

            {/* None of the four controls below carry `outline-none`/
                `outline-hidden`: both utilities set `--tw-outline-style: none`
                unconditionally (Tailwind v4's outline utilities all resolve
                `outline-style` through that one shared custom property), and
                since a custom property's cascaded value is shared by every
                rule that reads it on the element, the unconditional `none`
                wins over `focus-visible:outline-2`'s `outline-style:
                var(--tw-outline-style)` even while focus-visible is active —
                confirmed via `getComputedStyle`, which kept reporting
                `outlineStyle: "none"` with the right color/width/offset
                otherwise applied. Simply not setting an outline utility for
                the unfocused state works instead: `outline-style`'s own
                initial value is `none`, so there is no ring until
                `focus-visible:outline-2` supplies one, with
                `--tw-outline-style` free to resolve to its `solid` preflight
                default at that point. */}
            <form
              method="get"
              action="/search"
              aria-label="Search courts"
              className="mt-11 grid grid-cols-[1.25fr_1fr_1fr_auto] items-center gap-2 rounded-[20px] border border-white/[.18] bg-white/[.09] p-2 shadow-[0_24px_48px_rgba(6,20,13,.35)] backdrop-blur-[22px] max-[980px]:grid-cols-2 max-[980px]:gap-1.5"
            >
              <div className="flex h-[var(--control-h)] min-w-0 flex-col justify-center rounded-[var(--btn-radius)] px-4 transition-colors hover:bg-white/[.07] max-[980px]:col-span-2">
                <label
                  htmlFor="home-search-city"
                  className="font-mono text-[10px] tracking-[.14em] text-white/55 uppercase"
                >
                  Where
                </label>
                <select
                  id="home-search-city"
                  name="city"
                  defaultValue={DEFAULT_CITY_SLUG}
                  className="select-chevron-light [color-scheme:dark] truncate bg-transparent text-[15.5px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--ball)]"
                >
                  {CITIES.map((city) => (
                    <option key={city.slug} value={city.slug} className="text-[var(--ink)]">
                      {city.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="relative flex h-[var(--control-h)] min-w-0 flex-col justify-center rounded-[var(--btn-radius)] border-l border-white/[.18] px-4 transition-colors hover:bg-white/[.07] max-[980px]:border-l-0 max-[560px]:col-span-2">
                <label
                  htmlFor="home-search-date"
                  className="font-mono text-[10px] tracking-[.14em] text-white/55 uppercase"
                >
                  Date
                </label>
                <input
                  id="home-search-date"
                  type="date"
                  name="date"
                  defaultValue={today}
                  min={today}
                  className="[color-scheme:dark] bg-transparent text-[15.5px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--ball)] [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-60 [&::-webkit-calendar-picker-indicator]:hover:opacity-100"
                />
              </div>

              {/* One Time field, two selects, spaced EN DASH between them —
                  branding.md's `7 – 9 AM` convention. The dash is decorative
                  (`aria-hidden`); the pairing is carried for assistive tech by
                  the field's own <label> plus an explicit accessible name on
                  each select. A fifth grid column was deliberately NOT added:
                  the end select rides inside the existing Time cell, and both
                  Date and Time go full width below 560px so two selects never
                  have to share ~150px. `min-w-0` all the way down is what
                  keeps the pair from forcing the form wider than the viewport
                  — branding.md's Layout rule says the page never scrolls
                  sideways. */}
              <div className="relative flex h-[var(--control-h)] min-w-0 flex-col justify-center rounded-[var(--btn-radius)] border-l border-white/[.18] px-4 transition-colors hover:bg-white/[.07] max-[980px]:border-l-0 max-[560px]:col-span-2">
                <label
                  htmlFor="home-search-hour"
                  className="font-mono text-[10px] tracking-[.14em] text-white/55 uppercase"
                >
                  Time
                </label>
                <div className="flex min-w-0 items-center gap-1.5">
                  <select
                    id="home-search-hour"
                    name="hour"
                    defaultValue=""
                    aria-label="Time from"
                    className="select-chevron-light [color-scheme:dark] min-w-0 flex-1 truncate bg-transparent text-[15.5px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--ball)]"
                  >
                    <option value="" className="text-[var(--ink)]">
                      Any time
                    </option>
                    {HOUR_OPTIONS.map((hour) => (
                      <option key={hour} value={hour} className="text-[var(--ink)]">
                        {formatHour(hour)}
                      </option>
                    ))}
                  </select>
                  <span aria-hidden className="text-[15.5px] text-white/55">
                    &ndash;
                  </span>
                  <select
                    id="home-search-until"
                    name="until"
                    defaultValue=""
                    aria-label="Time until"
                    className="select-chevron-light [color-scheme:dark] min-w-0 flex-1 truncate bg-transparent text-[15.5px] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--ball)]"
                  >
                    <option value="" className="text-[var(--ink)]">
                      &mdash;
                    </option>
                    {endHours.map((hour) => (
                      <option key={hour} value={hour} className="text-[var(--ink)]">
                        {formatHour(hour)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <button
                type="submit"
                className="font-display ml-2 inline-flex h-[var(--control-h)] items-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-[30px] text-[15.5px] font-bold tracking-[-0.01em] whitespace-nowrap text-[var(--ball-ink)] transition-[filter,transform] duration-150 hover:brightness-[1.06] active:scale-[.98] motion-reduce:transition-none max-[980px]:col-span-2 max-[980px]:mt-0.5 max-[980px]:ml-0 max-[980px]:justify-center"
              >
                Find a Court
              </button>
            </form>
          </div>
        </header>
      </section>

      {/* Full-bleed padding formula, not `mx-auto max-w-[1120px] px-6`: `body`
          (src/app/layout.tsx) is `flex flex-col`, and `main` is a direct flex
          item in that column. `margin: auto` on a flex item's cross axis
          (left/right, in a column-direction flex container) disables
          `align-self: stretch` per the flexbox spec, so `main` fell back to
          shrink-to-fit sizing instead of filling the viewport — confirmed via
          Playwright at a 375px viewport, on both `next dev` and a production
          build: `main` computed to 412px wide against a 375px `body`/`html`,
          overflowing the page horizontally. `Nav`/`Footer` already use this
          exact padding-based pattern (no `mx-auto`, no `max-w`) for the same
          reason — this brings `main` in line with them. It renders the same
          1120px content column: padding grows to `(100vw-1120px)/2` above
          1168px viewport width (leaving exactly 1120px of content) and
          clamps to 24px below it. */}
      <main className="px-[max(24px,calc((100vw-1120px)/2))]">
        <section aria-label="Courts near you" className="pt-[72px] max-[560px]:pt-14">
          <div className="mb-7 flex flex-wrap items-baseline gap-4">
            <div className="flex-1">
              {/* The one live indicator the brief asks for: pulsing dot +
                  mono-uppercase label reading `openNowCount`. Previously
                  split into two incomplete halves — a plain hero line that
                  had the count but no dot/mono/uppercase treatment, and this
                  kicker, which had the dot and styling but a static "Live
                  availability" string that never read the count. Unified
                  here instead of duplicating the number in both places. The
                  dot is `aria-hidden`; the meaning ("live") is carried by
                  the adjacent text, not by color or animation alone. */}
              <span className="font-mono mb-2 flex items-center gap-2 text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
                <span aria-hidden className="relative flex h-[7px] w-[7px]">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--court)] opacity-60 motion-reduce:animate-none" />
                  <span className="relative inline-flex h-[7px] w-[7px] rounded-full bg-[var(--court)]" />
                </span>
                {openNowCount} {openNowCount === 1 ? 'court' : 'courts'} open right now
              </span>
              <h2 className="font-display text-[30px] font-bold tracking-[-0.025em] max-[560px]:text-2xl">
                Open near you tonight
              </h2>
            </div>
            <Link
              href="/search"
              className="text-sm font-semibold whitespace-nowrap text-[var(--court)] hover:text-[var(--court-deep)]"
            >
              See all courts →
            </Link>
          </div>

          {featured.length > 0 ? (
            <div className="grid grid-cols-3 gap-[22px] max-[980px]:grid-cols-1">
              {featured.map((branch) => (
                <BranchCard key={branch.id} branch={branch} />
              ))}
            </div>
          ) : (
            <p className="rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]">
              No courts live yet — check back soon. New branches join every week.
            </p>
          )}
        </section>

        {cityLinks.length > 0 && (
          <section aria-label="Browse by city" className="pt-[72px] max-[560px]:pt-14">
            <div className="mb-7">
              <span className="font-mono mb-2 block text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
                Browse by city
              </span>
              <h2 className="font-display text-[30px] font-bold tracking-[-0.025em] max-[560px]:text-2xl">
                Where do you want to play?
              </h2>
            </div>
            <div className="flex flex-wrap gap-2.5">
              {cityLinks.map((city) => (
                <Link
                  key={city.slug}
                  href={`/search?city=${city.slug}`}
                  className="inline-flex h-[var(--btn-h-sm)] items-center gap-1.5 rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-4 text-sm font-semibold text-[var(--ink)] transition-colors hover:border-[var(--court)] hover:text-[var(--court-deep)]"
                >
                  {city.name}
                  <span className="font-normal text-[var(--ink-soft)]">
                    ({city.branchCount})
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section aria-label="How it works" className="pt-[72px] max-[560px]:pt-14">
          <div className="mb-7">
            <span className="font-mono mb-2 block text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
              How it works
            </span>
            <h2 className="font-display text-[30px] font-bold tracking-[-0.025em] max-[560px]:text-2xl">
              Three steps to game time
            </h2>
          </div>
          <div className="grid grid-cols-3 gap-10 max-[980px]:grid-cols-1">
            <div className="border-t border-[var(--ink)] pt-[18px]">
              <span className="font-mono text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
                01 — Search
              </span>
              <h3 className="font-display mt-2.5 mb-2 text-[19px] font-bold tracking-[-0.015em]">
                Find your slot
              </h3>
              <p className="text-sm text-[var(--ink-soft)]">
                Tell us when and where you want to play. Every open court nearby, with live
                availability and real prices.
              </p>
            </div>
            <div className="border-t border-[var(--ink)] pt-[18px]">
              <span className="font-mono text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
                02 — Book
              </span>
              <h3 className="font-display mt-2.5 mb-2 text-[19px] font-bold tracking-[-0.015em]">
                Pay online, locked in
              </h3>
              <p className="text-sm text-[var(--ink-soft)]">
                Pick your court and hours, pay with GCash, Maya, or card. Your slot is confirmed
                the moment payment clears.
              </p>
            </div>
            <div className="border-t border-[var(--ink)] pt-[18px]">
              <span className="font-mono text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
                03 — Play
              </span>
              <h3 className="font-display mt-2.5 mb-2 text-[19px] font-bold tracking-[-0.015em]">
                Show up and play
              </h3>
              <p className="text-sm text-[var(--ink-soft)]">
                Your confirmation is your court pass. We remind you on game day — just bring your
                paddle.
              </p>
            </div>
          </div>
        </section>

        <section
          id="for-owners"
          // The destination of every "List your court" link for a visitor who
          // is not an owner. scroll-mt keeps the heading clear of the top edge
          // when the browser jumps here.
          className="scroll-mt-8 mt-[84px] flex flex-wrap items-center gap-8 rounded-[28px] bg-[var(--court-deep)] p-14 max-[980px]:p-8 max-[560px]:mt-16"
          aria-label="For court owners"
        >
          <div className="min-w-[300px] flex-1">
            <span className="font-mono mb-3 block text-[11px] tracking-[.14em] text-[var(--ball)] uppercase">
              For court owners
            </span>
            <h2 className="font-display max-w-[520px] text-[34px] font-bold tracking-[-0.025em] text-white max-[560px]:text-[26px]">
              Own a court? Fill your off-peak hours.
            </h2>
            <p className="mt-3 max-w-[500px] text-[15px] text-[#DCE9DC]/75">
              List every court and branch you run, set your own rates by time of day, and get
              bookings paid upfront. Free to list — we only earn when you do.
            </p>
            <p className="mt-2 max-w-[500px] text-[13.5px] text-[#DCE9DC]/60">
              Owner accounts are set up by our team. Sign in once with Google, then contact us and
              we&rsquo;ll switch yours on.
            </p>
          </div>
          {/* Not lime: the hero's search CTA is already this page's one lime
              primary action, and branding.md forbids a second one in the
              same view. A light button reads as a strong CTA against this
              dark --court-deep panel without competing with the hero. */}
          <Link
            href={ownerCtaHref(user?.role ?? null)}
            className="font-display inline-flex h-[var(--btn-h)] items-center rounded-[var(--btn-radius)] bg-[var(--surface)] px-[34px] text-[15.5px] font-bold text-[var(--ink)] transition-[filter,transform] duration-150 hover:brightness-[.97] active:scale-[.98] motion-reduce:transition-none max-[560px]:w-full max-[560px]:justify-center"
          >
            List your court
          </Link>
        </section>
      </main>

      <Footer />
    </>
  )
}
