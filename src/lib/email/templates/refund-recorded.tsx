import * as React from 'react'
import { formatDateLabel, formatPeso } from '@/lib/format'
import { BodyText, EmailLayout, FactBox, FactRow, greeting } from './layout'

/**
 * The refund confirmation. Two distinct closing sentences depending on
 * whether the booking itself was cancelled, or whether the payment simply
 * never resulted in a confirmed booking in the first place (e.g. a hold that
 * expired before payment finished) -- the wording must not blur the two,
 * since one of them means "your court time is gone" and the other doesn't.
 */
export function RefundRecordedEmail({
  playerName,
  branchName,
  courtName,
  bookedOn,
  amountCentavos,
  bookingCancelled,
}: {
  playerName: string | null
  branchName: string
  courtName: string
  bookedOn: string
  amountCentavos: number
  bookingCancelled: boolean
}) {
  return (
    <EmailLayout preview={`${formatPeso(amountCentavos)} refunded for ${branchName}`}>
      <BodyText>{greeting(playerName)}</BodyText>
      <BodyText>
        We&rsquo;ve processed a refund for your booking at <strong>{branchName}</strong>.
      </BodyText>
      <FactBox>
        <FactRow label="Amount refunded" value={formatPeso(amountCentavos)} />
        <FactRow label="Court" value={courtName} />
        <FactRow label="Original date" value={formatDateLabel(bookedOn)} />
      </FactBox>
      {bookingCancelled ? (
        <BodyText>This booking has been cancelled — that court time is no longer held for you.</BodyText>
      ) : (
        <BodyText>
          This payment did not go on to complete a booking, so it has been refunded in full.
        </BodyText>
      )}
    </EmailLayout>
  )
}
