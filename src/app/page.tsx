import Link from "next/link";

// Root route placeholder for this foundation branch. This is deliberately
// not a marketing landing page (out of scope here, see CLAUDE.md) — just a
// minimal, on-brand entry point into the one real page this branch built
// (src/app/venues/[slug]/page.tsx). Colors and the CTA use the brand tokens
// from design/branding.md via the CSS variables globals.css defines
// (--surface/--ink/--ink-soft/--ball/--ball-ink/--btn-h/--btn-radius),
// the same pattern src/app/login/page.tsx already uses — not the
// bg-foreground/text-background Tailwind utilities the create-next-app
// scaffold generated, which no longer resolve to anything (the
// --color-background/--color-foreground @theme mapping they depended on was
// removed from src/app/globals.css).
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[1120px] flex-col items-center justify-center gap-6 px-6 text-center bg-[var(--surface)]">
      <h1 className="font-display text-3xl font-extrabold tracking-tight text-[var(--ink)]">
        oncourt
      </h1>
      <p className="max-w-md text-[var(--ink-soft)]">
        Book a pickleball court. Laro na.
      </p>
      <Link
        href="/venues/smash-zone-marikina"
        className="font-display inline-flex h-[var(--btn-h)] items-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-5 font-bold text-[var(--ball-ink)] transition-colors hover:bg-[var(--ball)]/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-[3px]"
      >
        Find open courts
      </Link>
    </main>
  );
}
