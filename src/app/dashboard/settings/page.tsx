import { redirect } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { getOwnerSettings, LOGO_BUCKET } from '@/lib/owner/settings'
import { MAX_BUSINESS_NAME_LENGTH } from '@/lib/staff/write'
import { photoUrl } from '@/lib/photos'
import { BusinessNameForm, LogoForm } from './settings-forms'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)]'

const NOTICE =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

/**
 * Brand identity: business name, logo, and the slug the team controls.
 *
 * OWNER-ONLY, gated inline rather than by requireOwnerPage. The sibling pages
 * all resolve requireDashboardPage and then narrow; requireOwnerPage's 403
 * target is /bookings, and bouncing a staff member out of the dashboard
 * entirely for opening a page they merely cannot use is the wrong answer.
 * /dashboard is where they belong. The sidebar hides the item for them
 * (`show: access.isOwner`), and every action re-asserts requireOwner.
 *
 * Staff never see this page at all: there is no branch-scoped permission that
 * opens it, because a business name is not branch-shaped.
 */
export default async function SettingsPage() {
  const access = await requireDashboardPage('/dashboard/settings')
  if (!access.isOwner) redirect('/dashboard')

  // Null for an ADMIN, who passes access.isOwner (it is the same
  // `role === 'owner' || role === 'admin'` predicate requireOwner uses) but
  // has no business identity. Saying so beats rendering a form whose every
  // submission would come back not_an_owner.
  const settings = await getOwnerSettings(access.user.id)

  return (
    <>
      <header className="mb-8">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Settings
        </h1>
        <p className="mt-2 max-w-[560px] text-[15px] text-[var(--ink-soft)]">
          How your business appears to players across OnCourt.
        </p>
      </header>

      {settings === null ? (
        <p className={NOTICE}>
          Your account isn&rsquo;t a court-owner account, so there&rsquo;s nothing to set up here.
        </p>
      ) : (
        <div className="flex max-w-[560px] flex-col gap-5">
          <section aria-labelledby="business-name-heading" className={CARD}>
            <h2
              id="business-name-heading"
              className="font-display mb-1 text-[15px] font-bold tracking-[-0.01em] text-[var(--ink)]"
            >
              Business name
            </h2>
            <p className="mb-4 text-[13px] text-[var(--ink-soft)]">
              Shown on your brand page and on every branch you list.
            </p>
            <BusinessNameForm
              businessName={settings.businessName}
              maxLength={MAX_BUSINESS_NAME_LENGTH}
            />
          </section>

          <section aria-labelledby="logo-heading" className={CARD}>
            <h2
              id="logo-heading"
              className="font-display mb-1 text-[15px] font-bold tracking-[-0.01em] text-[var(--ink)]"
            >
              Logo
            </h2>
            <p className="mb-4 text-[13px] text-[var(--ink-soft)]">
              A square image works best. Without one, players see the first letter of your business
              name.
            </p>
            <LogoForm logoUrl={photoUrl(LOGO_BUCKET, settings.logoPath)} />
          </section>

          <section aria-labelledby="brand-link-heading" className={CARD}>
            <h2
              id="brand-link-heading"
              className="font-display mb-1 text-[15px] font-bold tracking-[-0.01em] text-[var(--ink)]"
            >
              Brand link
            </h2>
            {/* READ-ONLY, deliberately. The slug is in every public URL that
                points at this owner; changing it would break links players
                already have, so it stays an admin decision. Rendered as text,
                not a disabled input — a disabled field invites a fight with it. */}
            <p className="font-mono text-[13px] break-all text-[var(--ink)]">
              {settings.slug ? `/owners/${settings.slug}` : '—'}
            </p>
            <p className="mt-2 text-[13px] text-[var(--ink-soft)]">
              Your brand link is set by our team — contact us to change it.
            </p>
          </section>
        </div>
      )}
    </>
  )
}
