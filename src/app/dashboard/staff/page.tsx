import { requireOwnerPage } from '@/lib/auth/page-guards'
import { getBranchStaffForOwner } from '@/lib/staff/queries'
import { STAFF_PERMISSION_LABELS, STAFF_PERMISSIONS } from '@/lib/staff/permissions'
import { formatDateLabel } from '@/lib/format'
import { AddStaffForm, EditStaffForm, RevokeStaffForm } from './staff-forms'

const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

/**
 * Staff management — one card per branch.
 *
 * requireOwnerPage, NOT requireDashboardPage: staff management is owner-only
 * per the spec, so a staff member must not reach this page even though they
 * reach the rest of /dashboard. The sidebar hides the item for them
 * (`show: access.isOwner`), and this guard is the boundary for a typed URL —
 * it redirects a plain player to /bookings and a signed-out visitor to login.
 *
 * The same person can appear under several branches with different permissions:
 * one branch_staff row each, edited independently. That is why permissions are
 * rendered per row rather than per person.
 */
export default async function StaffPage() {
  const user = await requireOwnerPage('/dashboard/staff')
  const groups = await getBranchStaffForOwner(user.id)

  return (
    <>
      <header className="mb-8">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Staff
        </h1>
        <p className="mt-2 max-w-[560px] text-[15px] text-[var(--ink-soft)]">
          Give a front-desk colleague access to one branch&rsquo;s schedule without sharing your
          account. They keep their own player account and only see the branches you grant.
        </p>
      </header>

      {groups.length === 0 ? (
        <p className={EMPTY_PANEL}>
          No branches yet — add a branch first, then you can give colleagues access to it.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section
              key={group.branchId}
              aria-label={`Staff at ${group.branchName}`}
              className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]"
            >
              <h2 className="font-display mb-4 text-[17px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                {group.branchName}
              </h2>

              {group.staff.length > 0 ? (
                <ul className="mb-5 flex flex-col">
                  {group.staff.map((row, index) => (
                    <li
                      key={row.staffId}
                      className={`flex flex-wrap items-start justify-between gap-4 py-4 ${
                        index > 0 ? 'border-t border-[var(--hairline)]' : 'pt-0'
                      }`}
                    >
                      <div className="min-w-[200px]">
                        <div className="text-[13.5px] font-semibold text-[var(--ink)]">
                          {row.fullName ?? row.email}
                        </div>
                        {/* The email always shows, even when a display name
                            exists: it is the identifier the owner typed to add
                            them, and the only way to tell two colleagues with
                            the same name apart. */}
                        <div className="truncate text-[12.5px] text-[var(--ink-soft)]">
                          {row.email}
                        </div>
                        <div className="font-mono mt-1 text-[10.5px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                          Added {formatDateLabel(row.createdAt)}
                        </div>
                        {/* A read-only summary above the editable checkboxes:
                            the current grant at a glance, without reading four
                            checkbox states. Pill-shaped per branding.md, since
                            these are badges, not buttons. */}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {STAFF_PERMISSIONS.filter((permission) => row.permissions[permission]).map(
                            (permission) => (
                              <span
                                key={permission}
                                className="font-mono rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[10.5px] tracking-[.05em] text-[var(--court-deep)] uppercase"
                              >
                                {STAFF_PERMISSION_LABELS[permission]}
                              </span>
                            ),
                          )}
                        </div>
                      </div>

                      <div className="flex flex-1 flex-wrap items-start justify-end gap-4">
                        <EditStaffForm
                          staffId={row.staffId}
                          branchId={group.branchId}
                          permissions={row.permissions}
                        />
                        <RevokeStaffForm
                          staffId={row.staffId}
                          branchId={group.branchId}
                          label={row.fullName ?? row.email}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mb-5 text-[13px] text-[var(--ink-soft)]">
                  Nobody has access to this branch yet.
                </p>
              )}

              <div className="border-t border-[var(--hairline)] pt-5">
                <h3 className="font-display mb-3 text-[14px] font-bold tracking-[-0.01em] text-[var(--ink)]">
                  Add someone
                </h3>
                <p className="mb-3 text-[12.5px] text-[var(--ink-soft)]">
                  They need an OnCourt account already — ask them to sign in once first.
                </p>
                <AddStaffForm branchId={group.branchId} />
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  )
}
