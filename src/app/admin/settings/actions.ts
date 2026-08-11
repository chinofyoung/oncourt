'use server'

import { revalidatePath } from 'next/cache'
import type { AdminFormState } from '@/app/admin/actions'
import { refuseUnlessAdmin } from '@/lib/admin/guard'
import { formatPeso } from '@/lib/format'
import { parsePercentToBps, parsePesosToCentavos } from '@/lib/money/units'
import {
  updatePlatformSettings,
  type FeeMode,
  type ProcessorFeeBearer,
} from '@/lib/admin/settings'

const FEE_MODES: FeeMode[] = ['percentage', 'flat']
const BEARERS: ProcessorFeeBearer[] = ['player', 'owner', 'platform']
const BAD_INPUT = "That doesn't look right — reload the page and try again."

/**
 * The write side of /admin/settings.
 *
 * default_platform_fee_value is one integer column whose unit depends on
 * default_platform_fee_mode — basis points under 'percentage', centavos under
 * 'flat'. The form therefore submits two separate fields (feePercent,
 * feePesos) with their units baked into the name, and this action reads ONLY
 * the one matching the submitted mode. It never falls back to the other field
 * when the first is empty — the form disables the inactive input so it
 * submits nothing, but the server does not trust that; the whole point of two
 * inputs is that the value's unit is never ambiguous, and reading the wrong
 * one would turn a 10% fee into a ₱10.00 flat fee with no number visibly
 * changing.
 */
export async function updateSettingsAction(
  _prevState: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const refusal = await refuseUnlessAdmin()
  if (refusal) return { error: refusal }

  const feeMode = String(formData.get('feeMode') ?? '')
  const bearer = String(formData.get('processorFeeBearer') ?? '')
  if (!FEE_MODES.includes(feeMode as FeeMode) || !BEARERS.includes(bearer as ProcessorFeeBearer)) {
    return { error: BAD_INPUT }
  }

  const feeValue =
    feeMode === 'percentage'
      ? parsePercentToBps(String(formData.get('feePercent') ?? ''))
      : parsePesosToCentavos(String(formData.get('feePesos') ?? ''))

  if (feeValue === null) {
    return {
      error:
        feeMode === 'percentage'
          ? 'Enter a fee percentage above 0 and no more than 100, with at most two decimals.'
          : 'Enter a flat fee above ₱0, with at most two decimals.',
    }
  }

  const holdRaw = String(formData.get('holdDurationMinutes') ?? '').trim()
  const holdDurationMinutes = /^\d+$/.test(holdRaw) ? Number(holdRaw) : Number.NaN

  const result = await updatePlatformSettings({
    feeMode: feeMode as FeeMode,
    feeValue,
    processorFeeBearer: bearer as ProcessorFeeBearer,
    holdDurationMinutes,
  })

  if (!result.ok) {
    return {
      error:
        result.reason === 'invalid_hold'
          ? 'Enter a hold duration between 5 and 120 whole minutes.'
          : result.reason === 'flat_fee_exceeds_cheapest_rate'
            ? // feeValue is guaranteed non-null here: this reason is only ever
              // returned for the flat branch above, which already required a
              // valid parsed number before calling updatePlatformSettings.
              `A flat fee of ${formatPeso(feeValue)} is more than the cheapest court hour on the platform (${formatPeso(result.cheapestRateCentavos)}). That booking would pay the owner nothing.`
            : 'That fee is out of range.',
    }
  }

  revalidatePath('/admin/settings')
  return { ok: true, message: 'Saved. New bookings from now on use these terms.' }
}
