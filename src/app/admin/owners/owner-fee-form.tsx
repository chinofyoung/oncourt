'use client'

import { useActionState, useState } from 'react'
import { DARK_BUTTON, FIELD, FormMessage, LABEL } from '@/app/dashboard/listings/form-ui'
import { formatBpsAsPercent, formatCentavosAsPesos } from '@/lib/money/units'
import type { AdminFormState } from '@/app/admin/actions'
import type { AdminOwnerRow } from '@/lib/admin/owners'
import type { FeeMode, ProcessorFeeBearer } from '@/lib/admin/settings'
import { updateOwnerFeeOverrideAction } from '../actions'

type FeeChoice = 'inherit' | FeeMode
type BearerChoice = 'inherit' | ProcessorFeeBearer

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--court)]'
const SELECT = `h-[var(--btn-h-sm)] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2.5 text-[13px] text-[var(--ink)] ${FOCUS_RING}`

// Same three choices and same explanations as SettingsForm's BEARERS array
// (src/app/admin/settings/settings-form.tsx) — this form changes one
// specific owner's net, so per final whole-branch review item #5, it needs
// the explanation more, not less, than the platform-wide default.
const BEARERS: { value: ProcessorFeeBearer; label: string; help: string }[] = [
  { value: 'player', label: 'Player pays', help: 'added on top of the court fee at checkout' },
  { value: 'owner', label: 'Owner pays', help: "deducted from the owner's net for the booking" },
  { value: 'platform', label: 'Platform pays', help: 'absorbed out of our own margin' },
]

/**
 * The per-owner override on the Owners directory — one instance per owner
 * card. Same dual-unit hazard as SettingsForm, at smaller scale:
 * platform_fee_value is one integer column whose unit depends on
 * platform_fee_mode, so feePercent and feePesos are two separate inputs, each
 * seeded only when the owner's stored mode matches it, and the inactive one
 * stays disabled so it submits nothing. The action does not trust that either
 * — it reads only the field matching the submitted feeChoice.
 *
 * 'inherit' is a third feeChoice state, not an empty field: choosing it
 * clears both columns together (profiles_fee_override_pair requires both
 * null or both set). processorFeeBearer is a separate, independently
 * nullable column, so it gets its own 'inherit' option rather than sharing
 * feeChoice's.
 */
export function OwnerFeeForm({ owner }: { owner: AdminOwnerRow }) {
  const [state, submit, saving] = useActionState<AdminFormState, FormData>(
    updateOwnerFeeOverrideAction,
    null,
  )
  const [feeChoice, setFeeChoice] = useState<FeeChoice>(owner.feeMode ?? 'inherit')

  // Seeded only when the stored mode matches — never from the other unit's
  // number. Switching feeChoice shows an empty field, not a reinterpreted one.
  const percentValue =
    owner.feeMode === 'percentage' && owner.feeValue !== null
      ? formatBpsAsPercent(owner.feeValue)
      : ''
  const pesosValue =
    owner.feeMode === 'flat' && owner.feeValue !== null ? formatCentavosAsPesos(owner.feeValue) : ''

  const bearerChoice: BearerChoice = owner.processorFeeBearer ?? 'inherit'

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="ownerId" value={owner.id} />

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Platform fee</span>
          <select
            name="feeChoice"
            value={feeChoice}
            onChange={(event) => setFeeChoice(event.target.value as FeeChoice)}
            className={SELECT}
          >
            <option value="inherit">Platform default</option>
            <option value="percentage">Custom percentage</option>
            <option value="flat">Custom flat fee</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>Percent (0–100)</span>
          <input
            type="text"
            inputMode="decimal"
            name="feePercent"
            defaultValue={percentValue}
            disabled={feeChoice !== 'percentage'}
            className={`${FIELD} w-28`}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>Pesos</span>
          <input
            type="text"
            inputMode="decimal"
            name="feePesos"
            defaultValue={pesosValue}
            disabled={feeChoice !== 'flat'}
            className={`${FIELD} w-28`}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={LABEL}>Who absorbs the processor&rsquo;s fee</span>
          <select
            name="processorFeeBearer"
            defaultValue={bearerChoice}
            className={SELECT}
          >
            <option value="inherit">Platform default</option>
            {BEARERS.map((bearer) => (
              <option key={bearer.value} value={bearer.value}>
                {bearer.label} — {bearer.help}
              </option>
            ))}
          </select>
        </label>

        <button type="submit" disabled={saving} className={DARK_BUTTON}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <FormMessage state={state} />
    </form>
  )
}
