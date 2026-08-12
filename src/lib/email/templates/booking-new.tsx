import * as React from 'react'
import { formatDateLabel, formatHourRange, formatPeso } from '@/lib/format'
import type { BookingEmailFacts } from '../payload'
import { BodyText, EmailLayout, FactBox, FactRow, PathCallout, greeting } from './layout'

/**
 * The owner's notification that someone booked a court. Points at the
 * dashboard rather than repeating the receipt -- the owner manages bookings
 * there, not from the inbox.
 */
export function BookingNewEmail({
  booking,
  ownerName,
}: {
  booking: BookingEmailFacts
  ownerName: string | null
}) {
  const timeLabel = formatHourRange(booking.startHour, booking.endHour)
  return (
    <EmailLayout preview={`${booking.courtName} at ${booking.branchName}, ${formatDateLabel(booking.bookedOn)}`}>
      <BodyText>{greeting(ownerName)}</BodyText>
      <BodyText>
        You have a new booking at <strong>{booking.branchName}</strong>.
      </BodyText>
      <FactBox>
        <FactRow label="Court" value={booking.courtName} />
        <FactRow label="Date" value={formatDateLabel(booking.bookedOn)} />
        <FactRow label="Time" value={timeLabel} />
        <FactRow label="Total charged" value={formatPeso(booking.totalChargedCentavos)} />
      </FactBox>
      <BodyText>
        See the full details in <PathCallout>/dashboard/bookings</PathCallout>.
      </BodyText>
    </EmailLayout>
  )
}
