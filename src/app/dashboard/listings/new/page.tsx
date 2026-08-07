import { redirect } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { AddBranchForm } from '../branch-forms'

/**
 * Add a branch, on its own page.
 *
 * requireDashboardPage, NOT requireOwnerPage: a staff member can reach
 * /dashboard/listings (the manage_courts grant admits them there), so a
 * direct hit on this URL must land them somewhere sane rather than an error
 * page. Creating a branch is owner-only per the spec's permission table, so
 * they are bounced back to the cards — the same page requireOwnerPage would
 * have sent them to (/dashboard/listings has been their branches home all
 * along), just without the extra hop through /bookings for someone who was
 * never a player. createBranchAction re-asserts requireOwner regardless.
 *
 * The header (back-link, h1, description) and the "Add branch" submit both
 * live inside AddBranchForm now, not here — the button sits top-right of the
 * header and needs `pending` from useActionState, which only exists in that
 * client component. This Server Component keeps just the guard.
 */
export default async function NewBranchPage() {
  const access = await requireDashboardPage('/dashboard/listings')
  if (!access.isOwner) redirect('/dashboard/listings')

  return <AddBranchForm />
}
