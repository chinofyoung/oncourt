import * as React from 'react'
import { Text } from '@react-email/components'
import { formatHourRange } from '@/lib/format'
import type { BookingEmailFacts } from '../payload'
import { BodyText, EmailLayout, FactBox, FactRow, INK_SOFT, MONO_FONT, greeting } from './layout'

/**
 * The day-of reminder. Deliberately address-free: the branch's physical
 * location isn't part of this payload's facts, and a reminder email is not
 * the place to look one up -- it just needs to get the player to show up on
 * time, on the right court.
 */
export function BookingReminderEmail({ booking }: { booking: BookingEmailFacts }) {
  const timeLabel = formatHourRange(booking.startHour, booking.endHour)
  return (
    <EmailLayout preview={`${booking.courtName} at ${booking.branchName}, ${timeLabel} today`}>
      <BodyText>{greeting(booking.playerName)}</BodyText>
      <BodyText>
        You play today at <strong>{booking.branchName}</strong>.
      </BodyText>
      <FactBox>
        <FactRow label="Court" value={booking.courtName} />
        <FactRow label="Time" value={`${timeLabel} today`} />
      </FactBox>
      <BodyText>Arrive 10 minutes early — courts get busy right around game time.</BodyText>
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
