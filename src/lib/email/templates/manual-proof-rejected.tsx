import * as React from 'react'
import { formatDateLabel, formatHourRange } from '@/lib/format'
import type { BookingEmailFacts } from '../payload'
import { BodyText, EmailLayout, FactBox, FactRow, greeting } from './layout'

/**
 * The player's notification that the owner could not confirm their transfer
 * screenshot. Nothing is refunded here -- OnCourt never held this money to
 * begin with, which is the whole point of this rail -- so this is a
 * rejection, not a refund: the slot has simply gone back on sale for someone
 * else to book.
 */
export function ManualProofRejectedEmail({
  booking,
  rejectionReason,
}: {
  booking: BookingEmailFacts
  rejectionReason: string
}) {
  const timeLabel = formatHourRange(booking.startHour, booking.endHour)
  return (
    <EmailLayout preview={`We couldn't confirm your payment for ${booking.courtName}`}>
      <BodyText>{greeting(booking.playerName)}</BodyText>
      <BodyText>
        <strong>{booking.branchName}</strong> could not confirm your payment for the booking
        below, so it has not been held for you.
      </BodyText>
      <FactBox>
        <FactRow label="Court" value={booking.courtName} />
        <FactRow label="Date" value={formatDateLabel(booking.bookedOn)} />
        <FactRow label="Time" value={timeLabel} />
        <FactRow label="Reason" value={rejectionReason} />
      </FactBox>
      <BodyText>
        The time slot has been released. If you believe this is a mistake, contact{' '}
        {booking.branchName} directly, or make a new booking with a clearer screenshot of your
        payment.
      </BodyText>
    </EmailLayout>
  )
}
