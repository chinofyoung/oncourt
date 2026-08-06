import Link from 'next/link'
import { BRAND_NAME, Wordmark } from '@/components/site/wordmark'
import { OWNER_CTA_ANCHOR } from '@/lib/site/owner-cta'

/**
 * Ported from design/mockups/home.html's <footer> — light band (--surface
 * page background, hairline top border), plain (non-onDark) wordmark, four
 * nav links, and a copyright line. Columns stack at the 560px breakpoint
 * (branding.md, Layout).
 */
export function Footer() {
  return (
    <footer className="mt-[72px] flex items-center gap-6 border-t border-[var(--hairline)] px-[max(24px,calc((100vw-1120px)/2))] py-7 pb-10 text-[13px] text-[var(--ink-soft)] max-[560px]:flex-col max-[560px]:items-start max-[560px]:gap-3.5">
      <Link href="/">
        <Wordmark className="text-lg text-[var(--ink)]" />
      </Link>
      <nav className="flex flex-1 gap-5 max-[560px]:flex-wrap">
        <Link href="/search" className="text-[var(--ink-soft)] hover:text-[var(--ink)]">
          Find courts
        </Link>
        {/* The anchor, not the session-aware destination <Nav> uses: this
            footer renders on public pages that resolve no session at all, and
            a claims read plus a profile lookup on every footer render to
            relabel one link is not a trade worth making. */}
        <Link href={OWNER_CTA_ANCHOR} className="text-[var(--ink-soft)] hover:text-[var(--ink)]">
          List your court
        </Link>
        <Link href="/help" className="text-[var(--ink-soft)] hover:text-[var(--ink)]">
          Help
        </Link>
        <Link href="/terms" className="text-[var(--ink-soft)] hover:text-[var(--ink)]">
          Terms
        </Link>
      </nav>
      <span>© 2026 {BRAND_NAME} · Philippines</span>
    </footer>
  )
}
