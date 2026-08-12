import { requireAdminPage } from '@/lib/auth/page-guards'
import { getFailedEmails } from '@/lib/email/outbox'
import { formatDateLabel } from '@/lib/format'
import { RetryForm } from './retry-form'

// Panel recipe (branding.md's Cards entry): white, 20px radius, --shadow-sm,
// no border. No FOCUS_RING constant here — unlike refunds/page.tsx or
// payouts/page.tsx, this page has no local Link or search field of its own;
// its one interactive control (Retry) lives entirely in retry-form.tsx, the
// same shape as src/app/admin/settings/page.tsx (a Server Component whose
// only control is a child client form) declares none either.
const EMPTY_PANEL =
  'rounded-[20px] border border-dashed border-[var(--hairline)] bg-[var(--panel)] px-6 py-12 text-center text-[var(--ink-soft)]'

/** `booking_new` -> `Booking new`. The enum's own words, not new copy invented
 *  per kind — same shape as refunds/page.tsx's statusLabel(). */
function kindLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ')
}

/**
 * The only place a human sees an email that failed — the whole reason the
 * outbox exists rather than a fire-and-forget send. A player who paid and
 * never got a receipt is exactly the case nobody finds out about otherwise.
 *
 * requireAdminPage again, even though the layout already ran it: App Router
 * cannot hand a layout's result to a page, and this page's own read
 * (getFailedEmails) is global — gated by construction beats gated by
 * assumption, the same rule every other /admin/* page states.
 *
 * NO PAGINATION, matching every other admin list, and NO LIMIT on the query
 * itself (see getFailedEmails) — this is a work list, not a paged report.
 */
export default async function AdminEmailsPage() {
  await requireAdminPage('/admin/emails')
  const failed = await getFailedEmails()

  return (
    <>
      <header className="mb-8">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.02em] text-[var(--ink)] max-[560px]:text-[22px]">
          Emails
        </h1>
        <p className="mt-2 max-w-[640px] text-[15px] text-[var(--ink-soft)]">
          Lifecycle emails that could not be sent after every retry the drain will make on its
          own — a receipt, a booking alert, a reminder, a moderation notice. Retrying here resets
          the attempt count so the next drain picks the row back up.
        </p>
      </header>

      {failed.length === 0 ? (
        <p className={EMPTY_PANEL}>
          Nothing stuck. Every lifecycle email has either sent, or is still waiting for its next
          scheduled attempt.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[20px] bg-[var(--panel)] shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead>
              <tr className="font-mono border-b border-[var(--hairline)] text-[11px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                <th className="py-3 pr-4 pl-5 font-normal">Kind</th>
                <th className="py-3 pr-4 font-normal">Recipient</th>
                <th className="py-3 pr-4 text-right font-normal">Attempts</th>
                <th className="py-3 pr-4 font-normal">Last error</th>
                <th className="py-3 pr-4 font-normal">Created</th>
                <th className="py-3 pr-5 font-normal">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {failed.map((email) => (
                <tr key={email.id} className="border-b border-[var(--hairline)] last:border-b-0">
                  <td className="py-4 pr-4 pl-5 text-[13.5px] text-[var(--ink)]">
                    {kindLabel(email.kind)}
                  </td>
                  <td className="py-4 pr-4 text-[13.5px] break-all text-[var(--ink)]">
                    {email.recipient}
                  </td>
                  <td className="font-mono py-4 pr-4 text-right text-[13.5px] text-[var(--ink)]">
                    {email.attempts}
                  </td>
                  <td className="max-w-[280px] py-4 pr-4 text-[13px] break-words text-[var(--ink-soft)]">
                    {email.lastError ?? '—'}
                  </td>
                  <td className="py-4 pr-4 text-[13.5px] whitespace-nowrap text-[var(--ink)]">
                    {formatDateLabel(email.createdOn)}
                  </td>
                  <td className="py-4 pr-5">
                    <RetryForm emailId={email.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
