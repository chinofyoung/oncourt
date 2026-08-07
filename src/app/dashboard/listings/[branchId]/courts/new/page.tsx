import { notFound, redirect } from 'next/navigation'
import { requireDashboardPage } from '@/lib/auth/page-guards'
import { branchIdsWith } from '@/lib/staff/access'
import { AddCourtForm } from './add-court-form'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Add a court, on its own page.
 *
 * Guards mirror ../page.tsx (the branch page) exactly: requireDashboardPage
 * admits an owner or any staff member with a manage_courts grant somewhere,
 * the UUID_RE shape check runs on branchId before it reaches any SQL (a
 * malformed value would otherwise raise 22P02 inside a guard/query instead of
 * a clean 404), and branchIdsWith(access, 'manage_courts') is the same
 * per-branch scoping check that page uses to keep staff off branches they
 * have no grant on — notFound() for all three failure shapes (bad id, no
 * grant, branch not managed), same as ../page.tsx, so none of them confirms
 * anything about a branch id to a caller who shouldn't see it.
 *
 * Creating a court is owner-only per the spec's permission table — staff
 * holding manage_courts can edit existing courts but not add new ones — so a
 * non-owner who reaches this URL is redirected back to the branch's Courts
 * tab rather than shown the form. That is the same precedent
 * src/app/dashboard/listings/new/page.tsx sets for a non-owner hitting the
 * add-branch form (redirect, not an error page); createCourtAction
 * re-asserts requireOwnerOf regardless of what this page does.
 *
 * `new` as a literal path segment takes precedence over the sibling dynamic
 * route at courts/[courtId]/page.tsx, so this page — not that one — handles
 * /courts/new. Confirmed there is no ambiguity even if that precedence were
 * somehow bypassed: courts/[courtId]/page.tsx shape-checks its own courtId
 * with the identical UUID_RE and calls notFound() on a non-UUID value, so
 * "new" 404s there too.
 */
export default async function NewCourtPage({
  params,
}: {
  params: Promise<{ branchId: string }>
}) {
  const { branchId } = await params
  const access = await requireDashboardPage('/dashboard/listings')

  if (!UUID_RE.test(branchId)) notFound()
  if (!branchIdsWith(access, 'manage_courts').includes(branchId)) notFound()
  if (!access.isOwner) redirect(`/dashboard/listings/${branchId}?tab=courts`)

  return <AddCourtForm branchId={branchId} />
}
