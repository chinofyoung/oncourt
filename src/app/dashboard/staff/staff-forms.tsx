'use client'

import { useActionState } from 'react'
import {
  addStaffAction,
  revokeStaffAction,
  updateStaffAction,
  type StaffFormState,
} from './actions'
import {
  STAFF_PERMISSION_LABELS,
  STAFF_PERMISSIONS,
  type StaffPermissions,
} from '@/lib/staff/permissions'

const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

const CHECKBOX = `h-4 w-4 shrink-0 accent-[var(--court)] ${FOCUS_RING}`
const CHECK_LABEL =
  'inline-flex cursor-pointer items-center gap-1.5 text-[12.5px] text-[var(--ink)]'
const BORDERED_BUTTON =
  `inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3.5 text-[13px] font-semibold whitespace-nowrap text-[var(--ink)] hover:border-[var(--court)] disabled:opacity-60 ${FOCUS_RING}`

/**
 * The three staff forms. Client components for one reason: a Server Component
 * cannot render what a Server Action returns, so "no OnCourt account uses that
 * address" or "that person already has access" would look like nothing
 * happening. useActionState gives each return a home. Same pattern as
 * src/app/bookings/review-form.tsx.
 *
 * All four checkboxes are always rendered, in every form. An unchecked HTML
 * checkbox submits nothing at all, so parsePermissions() reads absence as false
 * — which means a form that omitted a checkbox would silently revoke that
 * permission. Rendering all four is what makes "the submitted set IS the new
 * set" true.
 *
 * There is no DOM test environment in this project (vitest.config.ts sets
 * environment: 'node'), so these are verified manually. The guarded actions
 * and the SQL underneath them are unit-tested.
 */
function PermissionCheckboxes({
  idPrefix,
  defaults,
}: {
  idPrefix: string
  defaults?: StaffPermissions
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <legend className="font-mono mb-1.5 text-[10.5px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
        Permissions
      </legend>
      {STAFF_PERMISSIONS.map((permission) => (
        <label key={permission} className={CHECK_LABEL} htmlFor={`${idPrefix}-${permission}`}>
          <input
            id={`${idPrefix}-${permission}`}
            type="checkbox"
            name={permission}
            defaultChecked={defaults?.[permission] ?? false}
            className={CHECKBOX}
          />
          {STAFF_PERMISSION_LABELS[permission]}
        </label>
      ))}
      {/* manage_courts has no effect yet — the courts slice that consults it
          hasn't shipped. Kept as a real, saveable checkbox rather than removed
          or disabled: the spec mandates all four permissions, and this line is
          what keeps checking it from being silently misleading in the
          meantime. */}
      <p className="w-full basis-full text-[11.5px] text-[var(--ink-soft)]">
        Court management arrives with the listings update — the permission is saved now and
        applies then.
      </p>
    </fieldset>
  )
}

function FormMessage({ state }: { state: StaffFormState }) {
  if (!state) return null
  return 'error' in state ? (
    <p role="alert" className="mt-2 text-[12.5px] font-medium text-[var(--ink)]">
      {state.error}
    </p>
  ) : (
    <p role="status" className="mt-2 text-[12.5px] font-medium text-[var(--court)]">
      {state.message}
    </p>
  )
}

export function AddStaffForm({ branchId }: { branchId: string }) {
  const [state, formAction, pending] = useActionState<StaffFormState, FormData>(addStaffAction, null)

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="branchId" value={branchId} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <label
            className="font-mono mb-1 block text-[10.5px] tracking-[.12em] text-[var(--ink-soft)] uppercase"
            htmlFor={`add-email-${branchId}`}
          >
            Email address
          </label>
          <input
            id={`add-email-${branchId}`}
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="colleague@example.com"
            className={`h-[var(--btn-h-sm)] w-full rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2.5 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-soft)] ${FOCUS_RING}`}
          />
        </div>

        {/* branding.md's alternative primary (--ink bg, --ball text), not lime:
            this page renders one Add form PER BRANCH, so a lime primary would
            put several competing primaries on screen. */}
        <button
          type="submit"
          disabled={pending}
          className={`font-display inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] bg-[var(--ink)] px-4 text-[13px] font-bold text-[var(--ball)] transition-[filter] duration-150 hover:brightness-[1.25] disabled:opacity-60 motion-reduce:transition-none ${FOCUS_RING}`}
        >
          {pending ? 'Adding…' : 'Add staff'}
        </button>
      </div>

      <PermissionCheckboxes idPrefix={`add-${branchId}`} />
      <FormMessage state={state} />
    </form>
  )
}

export function EditStaffForm({
  staffId,
  branchId,
  permissions,
}: {
  staffId: string
  branchId: string
  permissions: StaffPermissions
}) {
  const [state, formAction, pending] = useActionState<StaffFormState, FormData>(
    updateStaffAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="staffId" value={staffId} />
      <PermissionCheckboxes idPrefix={`edit-${staffId}`} defaults={permissions} />
      <button type="submit" disabled={pending} className={BORDERED_BUTTON}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      <div className="w-full">
        <FormMessage state={state} />
      </div>
    </form>
  )
}

export function RevokeStaffForm({
  staffId,
  branchId,
  label,
}: {
  staffId: string
  branchId: string
  label: string
}) {
  const [state, formAction, pending] = useActionState<StaffFormState, FormData>(
    revokeStaffAction,
    null,
  )

  return (
    <form action={formAction}>
      <input type="hidden" name="branchId" value={branchId} />
      <input type="hidden" name="staffId" value={staffId} />
      {/* No confirmation dialog: revoking is immediately reversible by adding
          the same address again (tests/staff/write.test.ts pins that), and it
          destroys no record. The accessible name names the person, so a screen
          reader user can tell several Revoke buttons apart. */}
      <button
        type="submit"
        disabled={pending}
        aria-label={`Revoke access for ${label}`}
        className={BORDERED_BUTTON}
      >
        {pending ? 'Revoking…' : 'Revoke'}
      </button>
      <FormMessage state={state} />
    </form>
  )
}
