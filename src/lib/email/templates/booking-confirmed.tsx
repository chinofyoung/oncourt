import * as React from 'react'
import { Text } from '@react-email/components'
import { formatDateLabel, formatHourRange, formatPeso } from '@/lib/format'
import type { BookingEmailFacts } from '../payload'
import { BodyText, EmailLayout, FactBox, FactRow, INK_SOFT, MONO_FONT, greeting } from './layout'

/**
 * The player's receipt. What a player needs to show up (court, date, time)
 * and to reconcile the charge (total), plus a booking reference for support.
 */
export function BookingConfirmedEmail({ booking }: { booking: BookingEmailFacts }) {
  const timeLabel = formatHourRange(booking.startHour, booking.endHour)
  return (
    <EmailLayout preview={`${booking.courtName} on ${formatDateLabel(booking.bookedOn)}, ${timeLabel}`}>
      <BodyText>{greeting(booking.playerName)}</BodyText>
      <BodyText>
        Your booking at <strong>{booking.branchName}</strong> is confirmed. See you on the court.
      </BodyText>
      <FactBox>
        <FactRow label="Court" value={booking.courtName} />
        <FactRow label="Date" value={formatDateLabel(booking.bookedOn)} />
        <FactRow label="Time" value={timeLabel} />
        <FactRow label="Total charged" value={formatPeso(booking.totalChargedCentavos)} />
      </FactBox>
      <BodyText>
        Bring a paddle and non-marking court shoes, and arrive 10 minutes early to warm up.
      </BodyText>
      <Text
        style={{
          fontFamily: MONO_FONT,
          fontSize: 12,
          color: INK_SOFT,
          margin: '20px 0 0',
        }}
      >
        Booking reference: {booking.bookingId}
      </Text>
    </EmailLayout>
  )
}
