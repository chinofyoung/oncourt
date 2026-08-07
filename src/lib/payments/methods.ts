/**
 * The closed set of payment methods this application offers.
 *
 * PURE and importable from a client component — the checkout method chooser
 * renders these labels. No `server-only` import.
 *
 * This list is deliberately a CODE constant even though `processor_rates` is
 * an admin-editable table. A method needs three things to actually work: a
 * rate row (so we can price it), a display label (so we can name it), and a
 * PayMongo `payment_method_types` mapping (so we can restrict the session to
 * it). Only the first of those lives in the database, so a method inserted
 * into `processor_rates` alone is unpriceable UI and unusable at the provider.
 * A test in tests/payments/fees.test.ts asserts these keys and the seeded
 * `processor_rates` keys are the same set, so the two can never silently
 * diverge.
 *
 * Order is the display order on the checkout page, and matches
 * design/mockups/checkout.html: GCash, Maya, card.
 */
export const PAYMENT_METHODS = [
  { key: 'gcash', label: 'GCash' },
  { key: 'maya', label: 'Maya' },
  { key: 'card', label: 'Credit/Debit card' },
] as const

export type PaymentMethodKey = (typeof PAYMENT_METHODS)[number]['key']

/** The gate on form input. A method not in this list never reaches SQL. */
export function isPaymentMethod(value: string): value is PaymentMethodKey {
  return PAYMENT_METHODS.some((method) => method.key === value)
}
