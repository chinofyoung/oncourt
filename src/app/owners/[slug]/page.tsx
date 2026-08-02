import { notFound } from 'next/navigation'
import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { BranchCard } from '@/components/ui/branch-card'
import { getOwnerProfile } from '@/lib/branches/queries'

// Ported from design/mockups/owner-profile.html, trimmed to what
// `getOwnerProfile` (src/lib/branches/queries.ts) actually returns. The
// mockup's cover photo, aggregate rating, bio, stat-strip (courts/price
// range), and "Latest reviews" section all depend on data `OwnerProfile`
// does not carry (no per-owner cover photo, no owner-level rating rollup,
// no bio column, no reviews-by-owner query) — rather than fabricate those
// from BranchSummary rows or invent a query the brief never asked for, this
// page renders only what's real: identity (name), branch count, and the
// branch grid.
//
// Logo: `profile.logoPath` can never resolve to a URL — no Storage bucket
// was ever provisioned for owner logos (`PhotoBucket` in src/lib/photos.ts
// only allows 'branch-photos' | 'court-photos'), a gap logged as a
// follow-up needing a migration. Rather than invent a bucket name (which
// would 404) or call photoUrl() with a wrong bucket, this renders the same
// initial-letter fallback badge as the branch page's owner strip
// (src/app/venues/[slug]/page.tsx), so the two pages agree.
//
// `main` uses the px-[max(24px,calc((100vw-1120px)/2))] full-bleed padding
// pattern (matching Nav/Footer/the venue page), not `mx-auto max-w-[1120px]`
// — `main` is a direct child of `<body>`, which src/app/layout.tsx makes a
// `flex flex-col` container, and cross-axis auto margins on a flex item is
// exactly the pattern that caused a real 375px overflow bug earlier in this
// plan. The task-12 brief's own sample `page.tsx` still shows `mx-auto
// max-w-[1120px]` — that sample is not followed here for that reason.
export default async function OwnerPage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params
  const profile = await getOwnerProfile(slug)
  if (!profile) notFound()

  // `||`, not `??` — businessName/fullName can be an empty string as well as
  // null/undefined, and `??` only guards the latter. An owner row with
  // business_name = '' would slip an empty heading past a `??` chain; this
  // exact trap was flagged on the branch page's owner strip in an earlier
  // review round and is guarded against here from the start.
  const displayName = profile.businessName || profile.fullName || profile.slug
  const branchCount = profile.branches.length
  const branchCountLabel = `${branchCount} ${branchCount === 1 ? 'branch' : 'branches'}`

  return (
    <>
      <Nav variant="solid" />

      <main className="flex flex-col gap-10 bg-[var(--surface)] px-[max(24px,calc((100vw-1120px)/2))] py-10">
        <header className="flex flex-wrap items-center justify-between gap-6 border-b border-[var(--hairline)] pb-8">
          <div className="flex items-center gap-4">
            <span
              aria-hidden
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-[var(--hairline)] bg-[var(--court)] text-2xl font-semibold text-white"
            >
              {displayName.charAt(0).toUpperCase()}
            </span>
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[.08em] text-[var(--court)]">
                Court owner
              </p>
              <h1 className="text-3xl font-bold leading-tight tracking-tight text-[var(--ink)]">
                {displayName}
              </h1>
            </div>
          </div>
          <p className="font-mono text-[13.5px] uppercase tracking-[.06em] text-[var(--ink-soft)]">
            {branchCountLabel}
          </p>
        </header>

        <section aria-label="Branches">
          <div className="mb-7">
            <p className="mb-2 font-mono text-[11px] uppercase tracking-[.14em] text-[var(--court)]">
              Branches
            </p>
            <h2 className="text-[28px] font-bold tracking-tight text-[var(--ink)]">
              All locations
            </h2>
          </div>

          {profile.branches.length === 0 ? (
            <p className="rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] p-8 text-center text-[var(--ink-soft)]">
              {displayName} doesn&apos;t have any bookable branches yet — check back soon.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-[22px] max-[980px]:grid-cols-1">
              {profile.branches.map((branch) => (
                <BranchCard key={branch.id} branch={branch} />
              ))}
            </div>
          )}
        </section>
      </main>

      <Footer />
    </>
  )
}
