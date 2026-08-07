'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Deliberately short and deliberately finite. The webhook is the only writer
 * of `confirmed`, and it normally lands within a second or two of the
 * redirect; 6 polls at 3s covers the slow case without turning a delayed
 * delivery into an endless spinner.
 */
export const POLL_INTERVAL_MS = 3_000
export const MAX_POLLS = 6

/**
 * Shown only while a booking the player just paid for is still
 * `pending_payment`.
 *
 * WRITES NOTHING. Its entire action is router.refresh(), which re-runs the
 * receipt Server Component; once the webhook has committed, that page renders
 * as `confirmed` and stops rendering this component at all — so there is no
 * success state to manage here and no way for a browser redirect to confirm a
 * booking.
 */
export function ConfirmingBanner() {
  const router = useRouter()
  const [attempts, setAttempts] = useState(0)

  useEffect(() => {
    if (attempts >= MAX_POLLS) return
    const timer = setTimeout(() => {
      setAttempts((count) => count + 1)
      router.refresh()
    }, POLL_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [attempts, router])

  const gaveUp = attempts >= MAX_POLLS

  return (
    <p
      role="status"
      className="mb-6 max-w-[560px] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--band-off)] px-4 py-3 text-sm text-[var(--court-deep)]"
    >
      {gaveUp
        ? "Still confirming with the payment provider. We'll email you the moment it's confirmed — you can safely close this page."
        : 'Confirming your payment… this usually takes a few seconds.'}
    </p>
  )
}
