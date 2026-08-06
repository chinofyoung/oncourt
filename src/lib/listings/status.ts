/**
 * The `court_status` enum, its labels, and the banner copy each status shows
 * on the court page.
 *
 * PURE — the court forms are client components and render these, so this
 * module must not be `server-only`. It is also the single home for the union
 * itself: src/lib/listings/queries.ts re-exports the type rather than
 * declaring a second copy, which is what keeps a future fifth status from
 * being added in one place and missed in the other.
 *
 * The banner copy is deliberately different in kind per status: pending and
 * rejected tell the owner what THEY do next, while suspended tells them the
 * next move is not theirs — suspension is an admin action and no edit on
 * this page reverses it (see the re-queue predicate in
 * src/lib/listings/write.ts).
 */
export type CourtStatus = 'pending' | 'approved' | 'rejected' | 'suspended'

/** Display order: what an owner wants to see first, not enum order. */
export const COURT_STATUSES = ['approved', 'pending', 'rejected', 'suspended'] as const

export const COURT_STATUS_LABELS: Record<CourtStatus, string> = {
  approved: 'Approved',
  pending: 'Pending',
  rejected: 'Rejected',
  suspended: 'Suspended',
}

export const COURT_STATUS_BANNERS: Record<CourtStatus, { title: string; body: string }> = {
  approved: {
    title: 'Approved',
    body: 'Players can find and book this court. Changing its hours, prices, or environment sends it back for approval.',
  },
  pending: {
    title: 'Awaiting approval',
    body: 'Our team is reviewing this court. It stays off search and your venue page until it is approved.',
  },
  rejected: {
    title: 'Changes needed',
    body: 'Fix the point below and save — any change to the hours, prices, or environment puts this court back in the queue automatically.',
  },
  suspended: {
    title: 'Suspended',
    body: 'This court has been taken off the market by our team. Editing it here will not restore it — contact support.',
  },
}
