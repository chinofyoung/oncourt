import 'server-only'
import * as React from 'react'
import { render } from '@react-email/render'
import type { EmailPayload } from './payload'
import { BookingConfirmedEmail } from './templates/booking-confirmed'
import { BookingNewEmail } from './templates/booking-new'
import { BookingReminderEmail } from './templates/booking-reminder'
import { CourtModeratedEmail } from './templates/court-moderated'
import { ManualProofRejectedEmail } from './templates/manual-proof-rejected'
import { ManualProofSubmittedEmail } from './templates/manual-proof-submitted'
import { RefundRecordedEmail } from './templates/refund-recorded'

export type { EmailPayload } from './payload'

/**
 * Private, exhaustive switch from a payload to its subject line and its
 * React element. Kept as `React.createElement` rather than JSX because this
 * file is `.ts`, not `.tsx` -- JSX syntax is only legal in a `.tsx` file, and
 * splitting the switch into its own file just to get JSX syntax would be
 * more indirection than it's worth for five call sites.
 *
 * The switch is EXHAUSTIVE by construction: `kind` discriminates the union,
 * so adding a variant without a case here is a compile error (the `never`
 * check below), not a runtime surprise in the drainer at 3am.
 */
function select(payload: EmailPayload): { subject: string; element: React.ReactElement } {
  switch (payload.kind) {
    case 'booking_confirmed':
      return {
        subject: `Your booking at ${payload.booking.branchName} is confirmed`,
        element: React.createElement(BookingConfirmedEmail, { booking: payload.booking }),
      }
    case 'booking_new':
      return {
        subject: `New booking at ${payload.booking.branchName}`,
        element: React.createElement(BookingNewEmail, {
          booking: payload.booking,
          ownerName: payload.ownerName,
        }),
      }
    case 'booking_reminder':
      return {
        subject: `You play today at ${payload.booking.branchName}`,
        element: React.createElement(BookingReminderEmail, { booking: payload.booking }),
      }
    case 'court_moderated':
      return {
        subject: payload.approved
          ? `${payload.courtName} at ${payload.branchName} is now live`
          : `${payload.courtName} at ${payload.branchName} needs changes`,
        element: React.createElement(CourtModeratedEmail, {
          ownerName: payload.ownerName,
          branchName: payload.branchName,
          courtName: payload.courtName,
          approved: payload.approved,
          rejectionReason: payload.rejectionReason,
        }),
      }
    case 'manual_proof_submitted':
      return {
        subject: `Confirm payment for ${payload.booking.courtName} at ${payload.booking.branchName}`,
        element: React.createElement(ManualProofSubmittedEmail, {
          ownerName: payload.ownerName,
          booking: payload.booking,
        }),
      }
    case 'manual_proof_rejected':
      return {
        subject: `We couldn't confirm your payment for ${payload.booking.courtName}`,
        element: React.createElement(ManualProofRejectedEmail, {
          booking: payload.booking,
          rejectionReason: payload.rejectionReason,
        }),
      }
    case 'refund_recorded':
      return {
        subject: `Your refund for ${payload.branchName} has been processed`,
        element: React.createElement(RefundRecordedEmail, {
          playerName: payload.playerName,
          branchName: payload.branchName,
          courtName: payload.courtName,
          bookedOn: payload.bookedOn,
          amountCentavos: payload.amountCentavos,
          bookingCancelled: payload.bookingCancelled,
        }),
      }
    default: {
      const exhaustive: never = payload
      throw new Error(`No template for ${(exhaustive as { kind: string }).kind}`)
    }
  }
}

/**
 * The one place a payload becomes an email.
 *
 * Both parts are produced from the same component tree --
 * `render(..., { plainText: true })` derives the text part from the JSX
 * rather than from a second hand-maintained string, so the two can never
 * drift.
 */
export async function renderEmail(
  payload: EmailPayload,
): Promise<{ subject: string; html: string; text: string }> {
  const { subject, element } = select(payload)
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })])
  return { subject, html, text }
}
