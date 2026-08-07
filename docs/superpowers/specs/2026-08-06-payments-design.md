# Payments — Design

**Date:** 2026-08-06
**Status:** approved (user review 2026-08-06) — plan in progress
**Parent spec:** `2026-07-31-pickleball-court-booking-platform-design.md`
(Booking & payment flow, fee configuration)
**Related:** `2026-08-05-roles-and-staff-design.md` (only players can hold/pay),
`2026-08-06-listings-and-admin-design.md` (admin surface conventions)

## Problem

The booking loop dead-ends. `createHold` (`src/lib/booking/hold.ts`) creates a
`pending_payment` row with the court fee, platform fee and owner net computed
and `fee_config_snapshot` written — but `processor_fee_centavos` is hardcoded
`0` (the payment method is unknown at hold time), the action redirects to
`/venues/[slug]?held=<id>` which shows nothing, and **no code path in the
repository can move a booking to `confirmed`.** The cron sweeps unpaid holds to
`expired` 15 minutes later, so today every hold necessarily dies.

Consequences: `payments` — listed in the parent spec's data model and named in
its grant-hardening rule — does not exist; `processor_rates` is seeded but read
by nothing; and every surface built so far (earnings, receipts, the owner day
grid, player dashboards) can only display rows inserted by SQL seeding.

## Decisions (rulings from brainstorming, 2026-08-06)

| Question | Ruling |
|---|---|
| Build & verify strategy | **Real PayMongo integration**, verified by tests that POST synthetic events signed with the real HMAC scheme. No tunnel, no dev server. |
| Payment-method choice | **On our checkout page**, always — every session is restricted to one method. |
| Post-payment return | **"Confirming" state that polls briefly**, then falls back to "we'll email you". The webhook remains the only writer of `confirmed`. |
| Payment arriving after expiry | **Confirm if the slot is still free**; if it was retaken, leave the booking expired, record the payment, flag it for an admin refund. Never keep money for an unusable slot. |
| Confirmation emails | **Next slice.** The webhook gets a clean seam; a failing email must never break a confirmed booking. |

## Schema (one migration)

New `payment_status` enum (`pending | paid | failed`) and a `payments` table.
Creating a new enum type and using it in the same migration file is safe — the
in-transaction restriction applies only to `alter type ... add value`, which is
why the `blocked` status needed its own file in an earlier slice.

- `id uuid primary key default gen_random_uuid()`
- `booking_id uuid not null references bookings (id)` — **not unique**: a player
  may abandon one checkout session and start another, and each attempt is part
  of the audit trail. No `on delete` clause (RESTRICT), matching `reviews` —
  a booking with a payment must not vanish.
- `provider text not null default 'paymongo'`
- `provider_session_id text` — the checkout session
- `provider_payment_id text unique` — **the idempotency primitive.** A replayed
  webhook for the same payment raises 23505, which the handler translates to
  "already processed, 200 OK". Nullable because a session row may exist before
  any payment does.
- `payment_method text references processor_rates (payment_method)`
- `amount_centavos integer not null check (amount_centavos >= 0)`
- `processor_fee_centavos integer not null default 0 check (>= 0)`
- `status payment_status not null default 'pending'`
- `needs_refund boolean not null default false` — set when a payment lands for a
  slot that is no longer available (see the webhook rules). Queryable by admin;
  the screen itself is out of scope.
- `raw_event jsonb` — the last webhook payload, for audit
- `created_at`, `paid_at timestamptz`

Indexes on `booking_id` and on `needs_refund where needs_refund` (partial —
the admin query wants only the flagged few). RLS enabled, zero policies.

## Fee mathematics (`src/lib/payments/fees.ts`, pure)

`processor_rates` supplies `percentage_bps` and `fixed_fee_centavos` per method
(seeded: gcash 223bps, maya 200bps, card 350bps + ₱15). All arithmetic is
integer centavos; percentages are basis points; **no floats, ever.**

Let `courtFee` and `platformFee` come from the hold (already computed and
snapshotted). For the chosen method with rate `pct` (bps) and `fixed`:

- **bearer = `player`** — gross up so the platform is made whole after the
  processor takes its percentage *of the fee line itself* (the parent spec's
  formula):
  `totalCharged = ceil((courtFee + fixed) * 10000 / (10000 - pct))`,
  `transactionFee = totalCharged - courtFee`,
  `processorFee = totalCharged - courtFee`,
  `ownerNet = courtFee - platformFee`.
  By construction the grossed-up increment *is* what the processor takes, so
  `transactionFee` and `processorFee` are the same number; the plan pins that
  with a test applying the processor's own formula to `totalCharged` and
  asserting it rounds to the same value. Rounding is **up**, so the platform
  may keep at most one centavo and can never absorb a shortfall.
- **bearer = `owner`** — `totalCharged = courtFee`, `transactionFee = 0`,
  `processorFee = round(courtFee * pct / 10000) + fixed`,
  `ownerNet = courtFee - platformFee - processorFee`.
- **bearer = `platform`** (default) — `totalCharged = courtFee`,
  `transactionFee = 0`, `processorFee` as above,
  `ownerNet = courtFee - platformFee`. The processor fee comes out of the
  platform's own share: its retained margin is `platformFee - processorFee`,
  which may legitimately be negative on a small booking (documented, not
  prevented).

**The accounting identity, asserted for every method × bearer combination:**

```
totalCharged = ownerNet + platformRetained + processorFee
where platformRetained = platformFee - (bearer === 'platform' ? processorFee : 0)
```

Stated per bearer, that is `totalCharged = ownerNet + platformFee +
processorFee` for `player` and `owner`, and `totalCharged = ownerNet +
platformFee` for `platform` — the naive "always add the processor fee" form is
**wrong** for the platform bearer, where the fee is carved out of the platform's
share rather than added to the total. Verified against the parent spec's worked
₱1,000 / 10% / GCash examples: platform → 1000 = 900 + (100 − 22.30) + 22.30;
owner → 1000 = 877.70 + 100 + 22.30; player → **1022.81 = 900 + 100 + 22.81**.

*(Corrected 2026-08-06: an earlier draft of this line said ₱1,022.83, which was
an eyeballed figure, not the formula's. `ceil(100000 × 10000 ÷ 9777) = 102281`
centavos, and the processor's own 2.23% of ₱1,022.81 is ₱22.81 — the two agree
exactly at this amount. **The formula is authoritative; this example is
illustrative.** Where a worked figure and the formula ever disagree, the
formula wins and the example is the bug.)*

Rounding direction is fixed and tested; a booking may never under-collect. The
over-collection is bounded by one centavo (it can be non-zero for methods with
a fixed fee, e.g. card).

## Flow

1. **Hold** (unchanged): `createHoldAction` now redirects to
   `/bookings/[id]/checkout` instead of the dead `?held=` URL.
2. **Checkout** (`/bookings/[id]/checkout`, player-only): guarded by
   `requirePlayerPage`; the booking must be the caller's, `pending_payment`,
   and unexpired (an expired hold renders a "this hold expired" state with a
   link back to the venue, never a payable form). Shows the price breakdown and
   a required method choice. Submitting:
   - recomputes fees for the chosen method,
   - writes them to the booking — `update bookings set transaction_fee_centavos
     = …, total_charged_centavos = …, processor_fee_centavos = …,
     owner_net_centavos = …, fee_config_snapshot = <snapshot + method> where id
     = $ and player_id = $ and status = 'pending_payment'` (zero rows → a
     friendly stale-state message, no read-then-write race),
   - creates a PayMongo checkout session restricted to that method, inserts the
     `payments` row (`status='pending'`, session id recorded),
   - redirects to the hosted checkout URL.
3. **Return**: success → `/bookings/[id]?paid=1`, the existing receipt page,
   which renders a "confirming your payment" banner while the booking is still
   `pending_payment` and refreshes a few times before falling back to
   "we'll email you when it's confirmed". Cancel → back to checkout.
4. **Webhook** (`/api/webhooks/paymongo`, POST): see below. It is the only
   writer of `confirmed`.

## The webhook — the security centre of this slice

This is the **first public, unauthenticated write endpoint in the application.**
Every other write is behind a session guard; this one is behind a signature.

- Read the **raw request body**. Signature verification is over the exact bytes
  PayMongo sent; a parsed-and-restringified body will not verify.
- Verify the `Paymongo-Signature` header (timestamp + HMAC-SHA256 over
  `t.payload` with `PAYMONGO_WEBHOOK_SECRET`) using a **timing-safe
  comparison**. Reject with 401 on mismatch and log nothing sensitive.
- Reject events whose timestamp is older than a tolerance window (replay
  defence), with the tolerance stated as a named constant.
- **Idempotency:** insert the `payments` row keyed by `provider_payment_id`; a
  23505 means this payment is already recorded → return 200 without touching
  the booking.
- **Amount is reconciled against the session, not the booking.** A player who
  returns to checkout and picks a different method gets a second session; the
  first may still be payable, and for the `player` bearer the two sessions
  legitimately have *different* amounts. So the handler resolves the `payments`
  row by the event's session reference and compares the paid amount to **that
  row's** `amount_centavos` — the amount we ourselves quoted for that session.
  On confirm it reconciles the booking's money columns and
  `fee_config_snapshot` to the session actually paid. Comparing against the
  booking's current `total_charged_centavos` would wrongly reject a player who
  paid a real session we issued.
- **`payment.paid` handling**, in one transaction with the booking row locked
  `for update`:
  - paid ≠ that session's quoted amount → record the payment, set
    `needs_refund`, do **not** confirm, return 200.
  - **no matching session row at all** → return 200 and write **nothing**.
    (Corrected 2026-08-06: an earlier draft said "record the payment and flag
    it", which is impossible — `payments.booking_id` is `not null`, and with no
    session row there is no booking to attribute the payment to. An event we
    cannot tie to a session we issued is not ours to act on; acknowledging it
    stops the retries, and the provider dashboard remains the record.)
  - booking `pending_payment` → confirm and reconcile the money columns.
  - booking `expired` → re-check the slot with the same exclusion semantics the
    hold path uses; free → confirm (the player paid and nobody was harmed);
    taken → leave expired, set `needs_refund`, return 200.
  - booking already `confirmed` **by a different payment** → this is a genuine
    double charge: record the payment and set `needs_refund` so the money is
    visibly owed back. (A replay of the *same* payment never reaches here — the
    unique index catches it first.) Do not touch the booking.
  - `blocked`/`completed`/`refunded_manual` → record, flag, do not touch.
- Other event types → 200 and ignore (so PayMongo stops retrying). Non-2xx is
  reserved for signature failure and genuine server errors, where a retry is
  what we want.
- The handler is a Route Handler, not a Server Action, and is exempt from the
  action-coverage guard test by construction — the plan must state this
  explicitly so the exemption is a decision, not an oversight.

## Provider boundary

`src/lib/payments/provider.ts` defines the interface the parent spec calls for:

```ts
createCheckoutSession(input): Promise<{ sessionId: string; checkoutUrl: string }>
verifyWebhookSignature(rawBody: string, header: string, secret: string): boolean
parsePaidEvent(rawBody: string): PaidEvent | null
```

`src/lib/payments/paymongo.ts` implements it over `fetch` (server-only, secret
key from env, `AbortSignal.timeout` on every call — the lesson from the
geocoder). Tests fake `fetch` at the boundary and never contact PayMongo.

Environment: `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, and `SITE_URL`
(the public origin used to build the success/cancel redirect URLs). No
base-URL variable exists today — `.env.local` currently holds only the Supabase
trio, `DATABASE_URL` and `ADMIN_EMAILS` — and the redirect URLs are built
server-side when creating the session, so `SITE_URL` follows the server-secret
naming convention rather than `NEXT_PUBLIC_*`. Absent keys must fail loudly at
the call site with a clear message, never silently no-op.

## Testing

Hosted-DB discipline throughout (self-seeded, id-tracked teardown, repeat-run
safe, foreground, the config's 20s timeout):

- **Fee math:** every method × bearer combination; the gross/net/fee identity;
  rounding direction (never under-collect); the negative-platform-margin case;
  zero and large amounts.
- **Signature verification:** a correct signature accepts; a tampered body, a
  wrong secret, a malformed header, and a stale timestamp each reject.
- **Webhook handler** (synthetic signed events, real HMAC, no network):
  first `payment.paid` confirms; the identical event replayed is a no-op with
  the booking untouched; amount mismatch flags without confirming; expired +
  free slot confirms; expired + retaken slot flags and leaves expired; already
  confirmed is a no-op; unknown event type returns 200 and writes nothing.
- **Checkout write:** fees persisted per method; another player's booking
  refused; a non-`pending_payment` booking refused; an expired hold refused.
- **PayMongo client:** request shape, auth header, and timeout behaviour against
  a faked `fetch`.
- **Regression:** the existing hold tests stay green; `expire_stale_holds()` is
  unchanged.

## Out of scope

- Confirmation emails (next slice; the webhook exposes the seam).
- The admin refund screen — `needs_refund` is queryable, the UI ships with the
  payouts work.
- Automated payouts and the per-owner ledger.
- Cancellations and self-service refunds (parent spec: none in MVP).
- Saved payment methods, partial payments, multi-currency.
