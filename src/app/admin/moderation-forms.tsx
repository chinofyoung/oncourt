'use client'

import { useActionState, useState } from 'react'
import {
  BORDERED_BUTTON,
  DARK_BUTTON,
  FormMessage,
  TEXTAREA,
} from '@/app/dashboard/listings/form-ui'
import {
  approveCourtAction,
  rejectCourtAction,
  suspendCourtAction,
  unsuspendCourtAction,
  type AdminFormState,
} from './actions'

/**
 * The queue's controls. Client components for the same reason the listings and
 * staff forms are: a Server Component cannot render what a Server Action
 * returned, so "that court has already moved on" would look like nothing
 * happening.
 *
 * The control classes come from the listings form-ui module rather than being
 * redeclared. Despite its path it is a route-agnostic set of class strings and
 * one message renderer, and FOCUS_RING in particular is the string reviews
 * caught missing four times in an earlier slice — one definition is the point.
 * AdminFormState and ListingFormState are the same shape, so FormMessage
 * accepts either.
 *
 * NO LIME BUTTON anywhere on this page: the queue repeats its controls once
 * per court, and branding.md forbids two lime buttons in one view. Approve is
 * branding.md's alternative primary (--ink bg, --ball text), which is what the
 * mockup's .btn-approve already is; Reject is the bordered secondary.
 *
 * There is no DOM test environment in this project (vitest.config.ts sets
 * environment: 'node'), so these are verified in the final manual pass. The
 * guarded actions and the SQL underneath them are unit-tested.
 */
export function ApprovalForms({
  courtId,
  blockedReason,
}: {
  courtId: string
  /** Non-null when the court's schedule would make approveCourt() refuse. */
  blockedReason: string | null
}) {
  const [approveState, approve, approving] = useActionState<AdminFormState, FormData>(
    approveCourtAction,
    null,
  )
  const [rejectState, reject, rejecting] = useActionState<AdminFormState, FormData>(
    rejectCourtAction,
    null,
  )
  const [rejectOpen, setRejectOpen] = useState(false)

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <form action={approve}>
          <input type="hidden" name="courtId" value={courtId} />
          {/* Disabled, not hidden: the admin should see that approving is the
              normal next step AND why it is unavailable. The server refuses
              independently — approveCourt() is the enforcement, this is the
              explanation. */}
          <button
            type="submit"
            disabled={approving || blockedReason !== null}
            className={DARK_BUTTON}
            title={blockedReason ?? undefined}
          >
            {approving ? 'Approving…' : 'Approve'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => setRejectOpen((open) => !open)}
          aria-expanded={rejectOpen}
          className={BORDERED_BUTTON}
        >
          {rejectOpen ? 'Cancel' : 'Reject…'}
        </button>
      </div>

      <FormMessage state={approveState} />

      {rejectOpen && (
        <form action={reject} className="border-t border-[var(--hairline)] pt-4">
          <input type="hidden" name="courtId" value={courtId} />
          <label className="sr-only" htmlFor={`reject-reason-${courtId}`}>
            Reason for rejecting this court
          </label>
          {/* `required` is a convenience, never the rule: rejectCourt() trims
              and refuses an empty reason server-side, which is what a form
              posted without JavaScript hits. */}
          <textarea
            id={`reject-reason-${courtId}`}
            name="reason"
            required
            rows={3}
            placeholder="What does the owner need to change?"
            className={TEXTAREA}
          />
          <p className="mt-2 text-[12.5px] text-[var(--ink-soft)]">
            The owner sees this on the court page. Any edit to its hours, rates or environment puts
            it back in this queue.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button type="submit" disabled={rejecting} className={BORDERED_BUTTON}>
              {rejecting ? 'Rejecting…' : 'Confirm rejection'}
            </button>
          </div>
          <FormMessage state={rejectState} />
        </form>
      )}

      {blockedReason && (
        <p role="status" className="text-[12.5px] font-medium text-[var(--ink)]">
          {blockedReason}
        </p>
      )}
    </div>
  )
}

/**
 * Suspend and unsuspend, one component. The two differ only in which action
 * they post to and what the button says — the hook is still called exactly
 * once per render, with the action chosen before the call, so hook order never
 * varies.
 */
export function StatusToggleForm({
  courtId,
  kind,
  blockedReason = null,
}: {
  courtId: string
  kind: 'suspend' | 'unsuspend'
  /**
   * Non-null when the court's schedule would make unsuspendCourt() refuse —
   * that write gates on the identical courtScheduleWarning check approveCourt()
   * does (a schedule that tiled cleanly at approval time can go stale during a
   * suspension), so this tab needs the same advance warning the pending queue
   * shows, not just a postback error after the click. Never set for 'suspend':
   * suspending is never schedule-gated.
   */
  blockedReason?: string | null
}) {
  const [state, submit, pending] = useActionState<AdminFormState, FormData>(
    kind === 'suspend' ? suspendCourtAction : unsuspendCourtAction,
    null,
  )
  const label = kind === 'suspend' ? 'Suspend' : 'Put back on the market'

  return (
    <form action={submit} className="mt-3">
      <input type="hidden" name="courtId" value={courtId} />
      <button
        type="submit"
        disabled={pending || blockedReason !== null}
        title={blockedReason ?? undefined}
        className={BORDERED_BUTTON}
      >
        {pending ? 'Saving…' : label}
      </button>
      <FormMessage state={state} />
      {blockedReason && (
        <p role="status" className="mt-2 text-[12.5px] font-medium text-[var(--ink)]">
          {blockedReason}
        </p>
      )}
    </form>
  )
}
