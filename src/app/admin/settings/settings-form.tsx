'use client'

import { useActionState, useState } from 'react'
import { DARK_BUTTON, FIELD, FormMessage, LABEL } from '@/app/dashboard/listings/form-ui'
import { formatBpsAsPercent, formatCentavosAsPesos } from '@/lib/money/units'
import type { AdminFormState } from '@/app/admin/actions'
import type { FeeMode, PlatformSettings } from '@/lib/admin/settings'
import { updateSettingsAction } from './actions'

const BEARERS: { value: string; label: string; help: string }[] = [
  { value: 'player', label: 'Player pays', help: 'Added on top of the court fee at checkout.' },
  { value: 'owner', label: 'Owner pays', help: "Deducted from the owner's net for the booking." },
  { value: 'platform', label: 'Platform pays', help: 'Absorbed out of our own margin.' },
]

export function SettingsForm({ settings }: { settings: PlatformSettings }) {
  const [state, submit, saving] = useActionState<AdminFormState, FormData>(
    updateSettingsAction,
    null,
  )
  const [mode, setMode] = useState<FeeMode>(settings.feeMode)

  // The stored value is dual-unit, so each input is seeded only when the
  // stored mode matches it. Switching modes shows an empty field rather than
  // reinterpreting the other unit's number.
  const percentValue = settings.feeMode === 'percentage' ? formatBpsAsPercent(settings.feeValue) : ''
  const pesosValue = settings.feeMode === 'flat' ? formatCentavosAsPesos(settings.feeValue) : ''

  return (
    <form action={submit} className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-3">
        <legend className={LABEL}>Platform fee</legend>

        <label className="flex items-baseline gap-2 text-[13.5px] text-[var(--ink)]">
          <input
            type="radio"
            name="feeMode"
            value="percentage"
            checked={mode === 'percentage'}
            onChange={() => setMode('percentage')}
          />
          A percentage of every booking
        </label>
        <label className="flex flex-col gap-1 pl-6">
          <span className="text-[12.5px] text-[var(--ink-soft)]">Percent (0–100)</span>
          <input
            type="text"
            inputMode="decimal"
            name="feePercent"
            defaultValue={percentValue}
            disabled={mode !== 'percentage'}
            className={FIELD}
          />
        </label>

        <label className="flex items-baseline gap-2 text-[13.5px] text-[var(--ink)]">
          <input
            type="radio"
            name="feeMode"
            value="flat"
            checked={mode === 'flat'}
            onChange={() => setMode('flat')}
          />
          A flat amount per booking
        </label>
        <label className="flex flex-col gap-1 pl-6">
          <span className="text-[12.5px] text-[var(--ink-soft)]">Pesos</span>
          <input
            type="text"
            inputMode="decimal"
            name="feePesos"
            defaultValue={pesosValue}
            disabled={mode !== 'flat'}
            className={FIELD}
          />
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className={LABEL}>Who absorbs the payment processor&rsquo;s fee</legend>
        {BEARERS.map((bearer) => (
          <label key={bearer.value} className="flex items-baseline gap-2 text-[13.5px] text-[var(--ink)]">
            <input
              type="radio"
              name="processorFeeBearer"
              value={bearer.value}
              defaultChecked={settings.processorFeeBearer === bearer.value}
            />
            <span>
              {bearer.label}{' '}
              <span className="text-[12.5px] text-[var(--ink-soft)]">{bearer.help}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Hold duration</span>
        <span className="text-[12.5px] text-[var(--ink-soft)]">
          How long a court stays reserved while a player pays. 5 to 120 whole
          minutes — below 5, a PayMongo redirect often can&rsquo;t complete in
          time, so the hold dies mid-payment and creates refund work.
        </span>
        <input
          type="number"
          name="holdDurationMinutes"
          min={5}
          max={120}
          step={1}
          defaultValue={settings.holdDurationMinutes}
          className={FIELD}
        />
      </label>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving} className={DARK_BUTTON}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
      <FormMessage state={state} />
    </form>
  )
}
