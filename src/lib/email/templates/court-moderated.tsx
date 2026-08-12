import * as React from 'react'
import { BodyText, EmailLayout, FactBox, FactRow, PathCallout, greeting } from './layout'

/**
 * The moderation verdict for a court listing. Approval and rejection are two
 * genuinely different messages, not one template with a swapped adjective --
 * an approval must never leak the rejection branch's framing, and a
 * rejection must carry its reason verbatim (never paraphrased or invented).
 */
export function CourtModeratedEmail({
  ownerName,
  branchName,
  courtName,
  approved,
  rejectionReason,
}: {
  ownerName: string | null
  branchName: string
  courtName: string
  approved: boolean
  rejectionReason: string | null
}) {
  const preview = approved
    ? `${courtName} at ${branchName} is now live`
    : `${courtName} at ${branchName} needs changes`
  return (
    <EmailLayout preview={preview}>
      <BodyText>{greeting(ownerName)}</BodyText>
      {approved ? (
        <BodyText>
          Good news — <strong>{courtName}</strong> at <strong>{branchName}</strong> has been
          approved and is now live and bookable by players.
        </BodyText>
      ) : (
        <>
          <BodyText>
            <strong>{courtName}</strong> at <strong>{branchName}</strong> needs a few changes
            before it can go live.
          </BodyText>
          {rejectionReason ? (
            <FactBox>
              <FactRow label="Reason" value={rejectionReason} />
            </FactBox>
          ) : null}
        </>
      )}
      <BodyText>
        Manage this listing any time in <PathCallout>/dashboard/listings</PathCallout>.
      </BodyText>
    </EmailLayout>
  )
}
