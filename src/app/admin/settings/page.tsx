import { requireAdminPage } from '@/lib/auth/page-guards'
import { getPlatformSettings } from '@/lib/admin/settings'
import { formatDateLabel } from '@/lib/format'
import { SettingsForm } from './settings-form'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)] max-[560px]:p-5'

/**
 * Platform fee configuration.
 *
 * The consequences panel is not decoration, for the same reason the promote
 * screen's is not: createHold snapshots the fee onto each booking row and
 * nothing downstream ever recomputes it, so a change here reaches bookings
 * made from now on and nothing else. That is the single most important thing
 * an admin needs to know before pressing Save, so it is stated above the form
 * rather than discovered afterwards.
 *
 * processor_rates (the GCash/Maya/card percentages) is deliberately absent:
 * those mirror PayMongo's published pricing rather than anything this business
 * sets, and a typo there under-collects silently on every transaction.
 */
export default async function AdminSettingsPage() {
  await requireAdminPage('/admin/settings')
  const settings = await getPlatformSettings()

  return (
    <>
      <header className="mb-6">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Settings
        </h1>
        <p className="mt-2 max-w-[620px] text-[15px] text-[var(--ink-soft)]">
          What the platform charges, who absorbs the payment processor&rsquo;s fee, and how long a
          court stays held while a player pays. Last changed {formatDateLabel(settings.updatedOn)}.
        </p>
      </header>

      <section
        aria-label="What changing these does"
        className="mb-6 rounded-[20px] bg-[var(--band-off)] px-5 py-4"
      >
        <h2 className="font-mono text-[11px] tracking-[.14em] text-[var(--court-deep)] uppercase">
          Before you save
        </h2>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] text-[var(--ink)]">
          <li>These terms apply to bookings made from the moment you save, and to nothing else.</li>
          <li>
            A hold already in progress keeps the fee it was quoted. Past bookings and their payouts
            are never repriced.
          </li>
          <li>
            An individual owner can be given different terms on the Owners page. Those override
            what is set here.
          </li>
        </ul>
      </section>

      <section aria-label="Platform fee settings" className={CARD}>
        <SettingsForm settings={settings} />
      </section>
    </>
  )
}
