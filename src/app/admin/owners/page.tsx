import Link from 'next/link'
import { requireAdminPage } from '@/lib/auth/page-guards'
import { getAdminOwners, type AdminOwnerBranchRow, type AdminOwnerRow } from '@/lib/admin/owners'
import { getPlatformSettings, type PlatformSettings } from '@/lib/admin/settings'
import { STAFF_PERMISSION_LABELS, STAFF_PERMISSIONS } from '@/lib/staff/permissions'
import { formatDateLabel } from '@/lib/format'
import { formatBpsAsPercent, formatCentavosAsPesos } from '@/lib/money/units'
import { OwnerFeeForm } from './owner-fee-form'

const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)] max-[560px]:p-5'
const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--court)]'
const CHIP =
  'font-mono rounded-full border border-[var(--hairline)] bg-[var(--surface)] px-2 py-0.5 text-[10px] tracking-[.1em] text-[var(--ink-soft)] uppercase'
const EMPTY = 'text-[13px] text-[var(--ink-soft)]'

const BEARER_LABELS: Record<PlatformSettings['processorFeeBearer'], string> = {
  player: 'Player pays the processor fee',
  owner: 'Owner pays the processor fee',
  platform: 'Platform pays the processor fee',
}

/** Business name, then real name, then the address they signed up with. */
function displayName(owner: AdminOwnerRow): string {
  return owner.businessName ?? owner.fullName ?? owner.email
}

/** Sum of courts across every branch, for the owner-level counts line. */
function courtTotal(owner: AdminOwnerRow): number {
  return owner.branches.reduce((total, branch) => total + branch.courtCount, 0)
}

/**
 * The effective platform fee this owner's bookings actually use: their
 * override when one is set, otherwise the platform default — named with its
 * real number rather than shown as the bare word "default", using the same
 * formatBpsAsPercent/formatCentavosAsPesos round-trip helpers the override
 * form itself uses to seed its inputs.
 */
function effectiveFeeLabel(owner: AdminOwnerRow, settings: PlatformSettings): string {
  const isOverride = owner.feeMode !== null && owner.feeValue !== null
  const mode = isOverride ? owner.feeMode! : settings.feeMode
  const value = isOverride ? owner.feeValue! : settings.feeValue
  const amount = mode === 'percentage' ? `${formatBpsAsPercent(value)}%` : `₱${formatCentavosAsPesos(value)}`
  return isOverride ? `${amount} (override)` : `Platform default (${amount})`
}

/** Same inherit-or-override naming as effectiveFeeLabel, for the bearer. */
function effectiveBearerLabel(owner: AdminOwnerRow, settings: PlatformSettings): string {
  const isOverride = owner.processorFeeBearer !== null
  const bearer = isOverride ? owner.processorFeeBearer! : settings.processorFeeBearer
  return isOverride ? `${BEARER_LABELS[bearer]} (override)` : `${BEARER_LABELS[bearer]} (platform default)`
}

function BranchRow({ branch }: { branch: AdminOwnerBranchRow }) {
  return (
    <li className="border-t border-[var(--hairline)] px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[14px] font-semibold text-[var(--ink)]">{branch.name}</span>
        <span className="text-[13px] text-[var(--ink-soft)]">{branch.city}</span>
        <span className="font-mono text-[11.5px] text-[var(--ink-soft)]">
          {branch.courtCount === 0
            ? 'No courts yet.'
            : `${branch.courtCount} ${branch.courtCount === 1 ? 'court' : 'courts'}`}
        </span>
        {branch.pendingCourtCount > 0 && (
          <Link
            href="/admin"
            aria-label={`${branch.pendingCourtCount} pending ${branch.pendingCourtCount === 1 ? 'court' : 'courts'} at ${branch.name}`}
            className={`font-mono text-[11.5px] text-[var(--court-deep)] underline ${FOCUS_RING}`}
          >
            {branch.pendingCourtCount} pending
          </Link>
        )}
      </div>

      {branch.staff.length === 0 ? (
        <p className={`mt-2 ${EMPTY}`}>No staff.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {branch.staff.map((person) => (
            <li key={person.staffId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-[13px] text-[var(--ink)]">{person.email}</span>
              {person.fullName && (
                <span className="text-[12.5px] text-[var(--ink-soft)]">{person.fullName}</span>
              )}
              {STAFF_PERMISSIONS.filter((permission) => person.permissions[permission]).map(
                (permission) => (
                  <span key={permission} className={CHIP}>
                    {STAFF_PERMISSION_LABELS[permission]}
                  </span>
                ),
              )}
              <span className="font-mono text-[11px] text-[var(--ink-soft)]">
                since {formatDateLabel(person.grantedOn)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * Every owner, their branches, and who staffs each branch.
 *
 * Cards rather than a table: the content is two levels of nesting with
 * variable-length badge lists, which a table cannot express without colspan
 * tricks. This follows /dashboard/staff, the codebase's existing
 * entity-with-nested-detail shape.
 *
 * Read-only. Promotion lives at /admin/owners/promote.
 */
export default async function AdminOwnersPage() {
  await requireAdminPage('/admin/owners')
  const [owners, settings] = await Promise.all([getAdminOwners(), getPlatformSettings()])

  return (
    <>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
            Owners
          </h1>
          <p className="mt-2 text-[15px] text-[var(--ink-soft)]">
            {owners.length === 1 ? '1 owner' : `${owners.length} owners`}, their branches, and who
            has staff access to each.
          </p>
        </div>
        <Link
          href="/admin/owners/promote"
          className={`rounded-[var(--btn-radius)] bg-[var(--ink)] px-4 py-2.5 text-[13.5px] font-semibold text-[var(--panel)] hover:bg-[var(--court-deep)] ${FOCUS_RING}`}
        >
          Promote a player
        </Link>
      </header>

      {owners.length === 0 ? (
        <section className={CARD}>
          <p className={EMPTY}>No owners yet. Promote a player to create the first one.</p>
        </section>
      ) : (
        <ul className="flex flex-col gap-4">
          {owners.map((owner) => (
            <li key={owner.id}>
              <section aria-label={displayName(owner)} className={CARD}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="font-display text-[18px] font-bold text-[var(--ink)]">
                    {displayName(owner)}
                  </h2>
                  <span className={CHIP}>{owner.role}</span>
                </div>

                <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-[var(--ink-soft)]">
                  <span>{owner.email}</span>
                  {owner.slug && (
                    <Link href={`/owners/${owner.slug}`} className={`text-[var(--court)] underline ${FOCUS_RING}`}>
                      /owners/{owner.slug}
                    </Link>
                  )}
                  <span className="font-mono text-[11.5px]">
                    joined {formatDateLabel(owner.joinedOn)}
                  </span>
                </div>

                <p className="font-mono mt-3 text-[11.5px] tracking-[.06em] text-[var(--ink-soft)]">
                  {owner.branches.length} {owner.branches.length === 1 ? 'branch' : 'branches'} ·{' '}
                  {courtTotal(owner)} {courtTotal(owner) === 1 ? 'court' : 'courts'} ·{' '}
                  {owner.staffCount} staff
                </p>

                {owner.branches.length === 0 ? (
                  <p className={`mt-3 ${EMPTY}`}>No branches yet.</p>
                ) : (
                  <ul className="mt-3 rounded-[var(--btn-radius)] border border-[var(--hairline)]">
                    {owner.branches.map((branch) => (
                      <BranchRow key={branch.id} branch={branch} />
                    ))}
                  </ul>
                )}

                <div className="mt-4 border-t border-[var(--hairline)] pt-3.5">
                  <p className="text-[13px] text-[var(--ink)]">
                    {effectiveFeeLabel(owner, settings)} · {effectiveBearerLabel(owner, settings)}
                  </p>
                  <div className="mt-2">
                    <OwnerFeeForm owner={owner} />
                  </div>
                </div>
              </section>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
