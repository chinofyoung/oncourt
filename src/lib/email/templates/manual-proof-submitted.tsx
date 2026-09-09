import * as React from 'react'
import { formatDateLabel, formatHourRange, formatPeso } from '@/lib/format'
import type { BookingEmailFacts } from '../payload'
import { BodyText, EmailLayout, FactBox, FactRow, PathCallout, greeting } from './layout'

/**
 * The owner's notification that a player has paid by bank transfer or
 * e-wallet directly and uploaded a screenshot as proof. Nothing is confirmed
 * yet -- the owner must open the dashboard and approve or reject the proof
 * before the booking is finalized, which is why this points at
 * /dashboard/payments rather than repeating a receipt.
 */
export function ManualProofSubmittedEmail({
  ownerName,
  booking,
}: {
  ownerName: string | null
  booking: BookingEmailFacts
}) {
  const timeLabel = formatHourRange(booking.startHour, booking.endHour)
  return (
    <EmailLayout
      preview={`Confirm ${formatPeso(booking.totalChargedCentavos)} for ${booking.courtName} at ${booking.branchName}`}
    >
      <BodyText>{greeting(ownerName)}</BodyText>
      <BodyText>
        {booking.playerName ?? 'A player'} says they paid you directly for a booking at{' '}
        <strong>{booking.branchName}</strong> and uploaded a screenshot as proof.
      </BodyText>
      <FactBox>
        <FactRow label="Court" value={booking.courtName} />
        <FactRow label="Date" value={formatDateLabel(booking.bookedOn)} />
        <FactRow label="Time" value={timeLabel} />
        <FactRow label="Amount" value={formatPeso(booking.totalChargedCentavos)} />
      </FactBox>
      <BodyText>
        Review the screenshot and confirm or reject the payment in{' '}
        <PathCallout>/dashboard/payments</PathCallout>. The slot stays held until you do, but only
        until your review window runs out.
      </BodyText>
    </EmailLayout>
  )
}
