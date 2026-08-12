import { expect, test } from 'vitest'
import { renderEmail, type EmailPayload } from '@/lib/email/render'

const BOOKING = {
  playerName: 'Ana Cruz',
  branchName: 'Smash Zone – Marikina',
  courtName: 'Court 1',
  bookedOn: '2026-09-15',
  startHour: 17,
  endHour: 19,
  totalChargedCentavos: 73000,
  bookingId: '11111111-2222-3333-4444-555555555555',
}

test('every kind renders a subject, html, and a non-empty text part', async () => {
  // A text part is not optional: HTML-only mail is a spam-filter signal, and a
  // receipt landing in spam is the same as not sending it.
  const payloads: EmailPayload[] = [
    { kind: 'booking_confirmed', booking: BOOKING },
    { kind: 'booking_new', booking: BOOKING, ownerName: 'Smash Zone' },
    { kind: 'booking_reminder', booking: BOOKING },
    { kind: 'court_moderated', ownerName: 'Smash Zone', branchName: BOOKING.branchName, courtName: 'Court 2', approved: true, rejectionReason: null },
    { kind: 'refund_recorded', playerName: 'Ana Cruz', branchName: BOOKING.branchName, courtName: 'Court 1', bookedOn: '2026-09-15', amountCentavos: 73000, bookingCancelled: true },
  ]

  for (const payload of payloads) {
    const rendered = await renderEmail(payload)
    expect(rendered.subject.length, payload.kind).toBeGreaterThan(0)
    expect(rendered.html, payload.kind).toContain('<')
    expect(rendered.text.trim().length, payload.kind).toBeGreaterThan(0)
  }
})

test('the receipt carries the facts a player needs to show up and to reconcile', async () => {
  const { subject, html, text } = await renderEmail({ kind: 'booking_confirmed', booking: BOOKING })
  expect(subject).toContain('Smash Zone – Marikina')
  for (const body of [html, text]) {
    expect(body).toContain('Court 1')
    // formatPeso(73000) drops the trailing ".00" for a whole-peso amount
    // (src/lib/format.ts) — ₱730, not ₱730.00. A plain `toContain('₱730')`
    // would also pass if the template forgot to call formatPeso and printed
    // raw centavos ("₱73000"), so anchor with a negative lookahead for a
    // following digit to rule that out.
    expect(body).toMatch(/₱730(?!\d)/)
    // formatHourRange(17, 19) collapses a shared period to ONE label:
    // "5 – 7 PM", not "5 PM – 7 PM". Asserting on "5 PM" would fail.
    // The separator is an EN DASH (U+2013), not a hyphen.
    expect(body).toContain('5 – 7 PM')
    expect(body).toContain('Tue, Sep 15')  // formatDateLabel('2026-09-15')
  }
})

test('a rejection carries its reason and an approval does not invent one', async () => {
  const rejected = await renderEmail({
    kind: 'court_moderated', ownerName: 'Smash Zone', branchName: 'Smash Zone – Marikina',
    courtName: 'Court 2', approved: false, rejectionReason: 'Rate bands do not cover opening hours.',
  })
  expect(rejected.html).toContain('Rate bands do not cover opening hours.')
  expect(rejected.text).toContain('Rate bands do not cover opening hours.')

  const approved = await renderEmail({
    kind: 'court_moderated', ownerName: 'Smash Zone', branchName: 'Smash Zone – Marikina',
    courtName: 'Court 2', approved: true, rejectionReason: null,
  })
  // Per the subject table below: approval reads "is now live", rejection reads
  // "needs changes". Assert the real strings, not a loose keyword.
  expect(approved.subject).toContain('is now live')
  expect(rejected.subject).toContain('needs changes')
  // An approval must not leak the rejection branch's framing.
  expect(approved.text.toLowerCase()).not.toContain('needs changes')
})

test('a refund on a cancelled booking says so; one on an unconfirmed booking does not', async () => {
  const base = {
    kind: 'refund_recorded' as const, playerName: 'Ana Cruz',
    branchName: 'Smash Zone – Marikina', courtName: 'Court 1',
    bookedOn: '2026-09-15', amountCentavos: 73000,
  }
  const cancelled = await renderEmail({ ...base, bookingCancelled: true })
  const orphan = await renderEmail({ ...base, bookingCancelled: false })
  expect(cancelled.text).toContain('cancelled')
  expect(orphan.text).not.toContain('cancelled')
  // formatPeso(73000) drops the trailing ".00" for a whole-peso amount
  // (src/lib/format.ts) — ₱730, not ₱730.00. Anchored the same way as the
  // receipt test above, so a raw-centavos regression ("₱73000") still fails.
  expect(orphan.text).toMatch(/₱730(?!\d)/)
})

test('a missing player name does not render "null" at the reader', async () => {
  // Google gives us a name, but profiles.full_name is nullable and a hand-seeded
  // row can lack one. "Hi null," is the classic template bug.
  const { html, text } = await renderEmail({
    kind: 'booking_confirmed',
    booking: { ...BOOKING, playerName: null },
  })
  expect(html).not.toContain('null')
  expect(text).not.toContain('null')
})
