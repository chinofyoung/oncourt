/**
 * The stat tile both dashboards use. Kicker is mono/uppercase per
 * branding.md's "mono for data and eyebrows" rule; the value also renders
 * `font-mono` — branding.md mandates mono for prices/data, so this deviates
 * from the original plan/mockup sample (which used the display font for the
 * value) as a reviewed branding fix.
 * Card chrome matches branding.md's Cards entry (white, 20px radius,
 * --shadow-sm, no border).
 */
export function StatCard({ kicker, value }: { kicker: string; value: string }) {
  return (
    <div className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]">
      <span className="font-mono block text-[10.5px] tracking-[.14em] text-[var(--ink-soft)] uppercase">
        {kicker}
      </span>
      <div className="font-mono mt-2 text-[28px] leading-none font-bold tracking-[-0.02em] text-[var(--ink)]">
        {value}
      </div>
    </div>
  )
}
