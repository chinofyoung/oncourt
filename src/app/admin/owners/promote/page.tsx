import Link from 'next/link'
import { requireAdminPage } from '@/lib/auth/page-guards'
import { PromoteOwnerForm } from './promote-form'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)] max-[560px]:p-5'
const BACK_LINK =
  'text-[13px] font-medium text-[var(--court)] hover:text-[var(--court-deep)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--court)]'

/**
 * Promote a player into a vetted owner.
 *
 * Split out of /admin/owners when that route became the owners directory. The
 * "Before you promote" panel is right for a page an admin navigates to
 * deliberately and wrong stacked above a directory they open to look something
 * up — so promotion got its own route rather than sharing one.
 *
 * Self-serve promotion does not exist any more (the roles slice removed it),
 * so this screen is the ONLY way an owner account comes into being outside of
 * hand-run SQL. requireAdminPage again on top of the layout's — the two-layer
 * pattern.
 *
 * The consequences panel is not decoration. promoteToOwner deletes every
 * branch_staff grant the person holds, in the same transaction as the role
 * flip, and an owner account can never hold a paid booking again because roles
 * are exclusive (requirePlayer rejects owners and admins). The admin is doing
 * that to someone else's account, so both facts are stated before the button
 * rather than discovered after it.
 */
export default async function AdminPromoteOwnerPage() {
  await requireAdminPage('/admin/owners/promote')

  return (
    <>
      <header className="mb-6">
        <Link href="/admin/owners" className={BACK_LINK}>
          &larr; All owners
        </Link>
        <h1 className="font-display mt-2 text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Promote a player
        </h1>
        <p className="mt-2 max-w-[620px] text-[15px] text-[var(--ink-soft)]">
          Turn an existing player account into a court owner. They have to have signed in at least
          once — this creates no account, it only changes one.
        </p>
      </header>

      <section
        aria-label="What promotion does"
        className="mb-6 rounded-[20px] bg-[var(--band-off)] px-5 py-4"
      >
        <h2 className="font-mono text-[11px] tracking-[.14em] text-[var(--court-deep)] uppercase">
          Before you promote
        </h2>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] text-[var(--ink)]">
          <li>
            Every staff access they hold at other venues is revoked. An account is never both an
            owner and someone else&rsquo;s staff.
          </li>
          <li>
            They stop being able to book courts — anywhere, including their own. An owner account
            is a business account.
          </li>
          <li>
            Their bookings so far are untouched, and the web address you choose is public at
            /owners/&lt;address&gt;.
          </li>
          <li>This cannot be undone from this screen.</li>
        </ul>
      </section>

      <section aria-label="Promote a player" className={CARD}>
        <PromoteOwnerForm />
      </section>
    </>
  )
}
