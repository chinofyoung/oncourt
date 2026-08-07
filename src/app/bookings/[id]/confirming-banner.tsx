'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { checkPaymentAction } from './actions'

/**
 * Deliberately short and deliberately finite. The webhook is the only PUSHED
 * writer of `confirmed`, and it normally lands within a second or two of the
 * redirect; 6 polls at 3s covers the slow case without turning a delayed
 * delivery into an endless spinner. Also the reconciliation fallback's
 * entire budget — see checkPaymentAction below — so a stuck payment gets at
 * most 6 active PayMongo checks, never an unbounded poll.
 */
export const POLL_INTERVAL_MS = 3_000
export const MAX_POLLS = 6

/**
 * Shown whenever a booking is still `pending_payment` AND has a started
 * checkout session AND that session has not already resolved to a refund-owed
 * outcome (see page.tsx's `awaitingConfirmation`) — regardless of `?paid=1`.
 * That covers both the player still sitting on the fresh success redirect AND
 * one who navigated away and came back an hour (or a day) later to find the
 * same "pending_payment" hold: either way, a session exists whose outcome is
 * unknown to us, and it is worth actively checking. The `refundOwed` carve-out
 * matters because that outcome is NOT unknown — handlePaidEvent
 * (src/lib/payments/webhook.ts) already resolved it (payment accepted, slot
 * gone, refund flagged) and is never going to confirm this booking, so
 * mounting this component would poll and then falsely tell the player to
 * keep waiting for a confirmation email that is not coming.
 *
 * WRITES, on this component's own bounded schedule: each tick calls
 * checkPaymentAction, a Server Action that actively asks PayMongo whether
 * this booking's checkout session was paid and, if so, runs the exact
 * confirmation the webhook runs (src/lib/payments/reconcile.ts). This is the
 * fallback for a webhook that never arrives — a local dev server at
 * http://localhost:3000 PayMongo cannot reach, or a dropped/delayed delivery
 * in production — and without it this component's only real path to
 * `confirmed` is a webhook that, in either case, is never coming.
 * router.refresh() then re-renders the receipt Server Component either way,
 * which is what actually shows the result once (and if) a confirmation —
 * pushed or pulled — has committed. A failed check (PayMongo unreachable, a
 * hold that is not this player's after all, whatever) is swallowed and still
 * falls through to router.refresh(), so a transient failure here degrades to
 * exactly the old "wait for the webhook" behavior rather than breaking the
 * banner.
 *
 * ONCE `attempts` REACHES MAX_POLLS, THIS GIVES UP FOR THE LIFE OF THIS
 * COMPONENT INSTANCE — `router.refresh()` alone does not remount it (Next.js
 * preserves client component state across a soft RSC refresh), so it never
 * re-arms itself on this page view. It is NOT permanently stuck, though: a
 * full reload of this URL (or navigating away and back) mounts a fresh
 * instance with `attempts` back at 0, which is a fresh bounded round of
 * checks. There is currently no in-page "check again" control for a player
 * who gives up scrolling and reloads before that happens; the smallest
 * addition, if wanted, would be a button here that just resets local state
 * (no new mechanism — it would re-arm the exact same effect).
 */
export function ConfirmingBanner({ bookingId }: { bookingId: string }) {
  const router = useRouter()
  const [attempts, setAttempts] = useState(0)

  useEffect(() => {
    if (attempts >= MAX_POLLS) return
    const timer = setTimeout(() => {
      setAttempts((count) => count + 1)
      checkPaymentAction(bookingId)
        .catch(() => {})
        .finally(() => router.refresh())
    }, POLL_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [attempts, bookingId, router])

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
