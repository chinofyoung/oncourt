'use client'

import { useActionState, useEffect, useState, type ReactNode } from 'react'
import { formatPeso } from '@/lib/format'
import type { CheckoutView } from '@/lib/payments/queries'
import { FOCUS_RING } from '@/app/dashboard/listings/form-ui'
import { payAction, type CheckoutFormState } from './actions'

/** `mm:ss`, or null before the first client tick. */
function remainingLabel(msLeft: number): string {
  const seconds = Math.max(0, Math.floor(msLeft / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * Owns the one piece of state this page has: which method is selected. The
 * method changes the transaction fee and the total, so the chooser and the
 * price card cannot be separate client components — they share it.
 *
 * The server-rendered booking summary arrives as `children`, so the photo,
 * the address and the date formatting stay on the server and never enter the
 * client bundle.
 */
export function CheckoutForm(props: {
  view: CheckoutView
  canceled: boolean
  children: ReactNode
}) {
  const { view } = props
  const [state, formAction, pending] = useActionState<CheckoutFormState, FormData>(payAction, null)
  const [method, setMethod] = useState(view.methods[0]?.method ?? '')
  // Null until the first client tick, so the server render and the first
  // client render agree and there is no hydration mismatch.
  const [msLeft, setMsLeft] = useState<number | null>(null)

  const expiresAtMs = view.expiresAt ? Date.parse(view.expiresAt) : null

  useEffect(() => {
    if (expiresAtMs === null) return
    const tick = () => setMsLeft(expiresAtMs - Date.now())
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [expiresAtMs])

  const dead = msLeft !== null && msLeft <= 0
  const quote = view.methods.find((entry) => entry.method === method) ?? view.methods[0]

  return (
    <div className="grid grid-cols-1 items-start gap-7 min-[980px]:grid-cols-[1.4fr_1fr]">
      {/* Price card first on mobile, per design/mockups/checkout.html's order:1 —
          the number is what a player on a phone came here for. */}
      <section
        aria-label="Review your booking"
        className="order-2 rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)] min-[980px]:order-1"
      >
        <h2 className="font-display text-[19px] font-bold tracking-[-0.01em] text-[var(--ink)]">
          Review your booking
        </h2>

        <div className="mt-4">{props.children}</div>

        <div className="mt-5 flex flex-wrap items-center gap-4 rounded-[var(--btn-radius)] bg-[var(--band-off)] px-[18px] py-3.5">
          <span className="font-mono text-[26px] font-semibold tracking-[-0.01em] text-[var(--court-deep)]">
            {msLeft === null ? '—:—' : remainingLabel(msLeft)}
          </span>
          <span className="text-[13.5px] text-[var(--ink-soft)]">
            {dead
              ? 'This hold has expired. Pick your slots again to start a new one.'
              : "We're holding these slots for you"}
          </span>
        </div>

        <p className="font-mono mt-6 mb-2.5 text-[11px] tracking-[.12em] text-[var(--court)] uppercase">
          Payment method
        </p>
        <div className="flex flex-col gap-2.5">
          {view.methods.map((entry) => {
            const selected = entry.method === method
            return (
              <button
                key={entry.method}
                type="button"
                aria-pressed={selected}
                onClick={() => setMethod(entry.method)}
                className={`flex h-[var(--control-h)] w-full items-center justify-between rounded-[var(--btn-radius)] bg-[var(--panel)] px-4 text-left transition-colors duration-150 motion-reduce:transition-none ${
                  selected
                    ? 'border-[1.5px] border-[var(--ink)]'
                    : 'border border-[var(--hairline)] hover:border-[var(--court)]'
                } ${FOCUS_RING}`}
              >
                <span className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className={`h-[18px] w-[18px] shrink-0 rounded-full border-[1.5px] ${
                      selected
                        ? 'border-[var(--ink)] bg-[var(--ball)]'
                        : 'border-[var(--ink-soft)] bg-[var(--panel)]'
                    }`}
                  />
                  <span className="font-display text-[14.5px] font-semibold text-[var(--ink)]">
                    {entry.label}
                  </span>
                </span>
                <span
                  className={`font-mono text-[13.5px] ${selected ? 'text-[var(--ink)]' : 'text-[var(--ink-soft)]'}`}
                >
                  {entry.transactionFeeCentavos > 0
                    ? `+ ${formatPeso(entry.transactionFeeCentavos)}`
                    : 'No extra fee'}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      <section
        aria-label="Price details"
        className="order-1 rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)] min-[980px]:sticky min-[980px]:top-[84px] min-[980px]:order-2"
      >
        <h2 className="font-display text-[19px] font-bold tracking-[-0.01em] text-[var(--ink)]">
          Price details
        </h2>

        <div className="mt-4 flex justify-between gap-3 py-1.5 text-[14px] font-semibold text-[var(--ink)]">
          <span>Court fees</span>
          <span className="font-mono">{formatPeso(view.courtFeeCentavos)}</span>
        </div>

        {quote && quote.transactionFeeCentavos > 0 && (
          <>
            <div className="flex justify-between gap-3 py-1.5 text-[14px] text-[var(--ink)]">
              <span>Transaction fee ({quote.label})</span>
              <span className="font-mono">{formatPeso(quote.transactionFeeCentavos)}</span>
            </div>
            <p className="pb-1 text-[12px] text-[var(--ink-soft)]">
              Processor fee — based on your payment method
            </p>
          </>
        )}

        <hr className="my-2 border-0 border-t border-[var(--hairline)]" />

        <div className="font-display flex justify-between gap-3 pt-2.5 text-[16px] font-bold text-[var(--ink)]">
          <span>Total due</span>
          <span className="font-mono text-[20px] font-bold">
            {formatPeso(quote?.totalChargedCentavos ?? view.courtFeeCentavos)}
          </span>
        </div>

        {props.canceled && (
          <p role="status" className="mt-3 text-[12.5px] font-medium text-[var(--ink)]">
            Payment was cancelled. Your slots are still held — choose a method and try again.
          </p>
        )}

        <form action={formAction}>
          <input type="hidden" name="bookingId" value={view.bookingId} />
          <input type="hidden" name="paymentMethod" value={method} />
          {/* The ONE lime button in this view (branding.md: never two). */}
          <button
            type="submit"
            disabled={pending || dead || !quote}
            className={`font-display mt-4 flex h-[var(--btn-h)] w-full items-center justify-center rounded-[var(--btn-radius)] bg-[var(--ball)] text-[15.5px] font-bold text-[var(--ball-ink)] transition-[filter] duration-150 hover:brightness-[1.06] disabled:opacity-60 motion-reduce:transition-none ${FOCUS_RING}`}
          >
            {pending
              ? 'Taking you to PayMongo…'
              : dead
                ? 'Hold expired'
                : `Pay ${formatPeso(quote?.totalChargedCentavos ?? view.courtFeeCentavos)} with ${quote?.label ?? ''}`}
          </button>
        </form>

        {state && 'error' in state && (
          <p role="alert" className="mt-2 text-[12.5px] font-medium text-[var(--ink)]">
            {state.error}
          </p>
        )}

        <p className="font-mono mt-3.5 text-center text-[11.5px] leading-[1.5] text-[var(--ink-soft)]">
          Slot confirmed the moment payment clears. No cancellations — double-check your schedule.
        </p>
        <p className="mt-3 text-center text-[12px] text-[var(--ink-soft)]">Secured by PayMongo</p>
      </section>
    </div>
  )
}
