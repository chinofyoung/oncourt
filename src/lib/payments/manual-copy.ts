/**
 * User-facing copy for the manual payment rail. Pure data, zero imports, so a
 * client component can import these VALUES without dragging a server-only
 * module (and `@/db` behind it) into the browser bundle.
 */

export const MANUAL_SUBMIT_MESSAGES: Record<string, string> = {
  not_manual: 'This court takes payment online. Refresh and try again.',
  unknown_method: 'Choose one of the payment options shown.',
  no_file: 'Attach a screenshot of your transfer.',
  bad_type: 'Upload a JPEG, PNG or WebP image.',
  too_large: 'That image is over 5 MB. Upload a smaller one.',
  upload_failed: 'We could not save your screenshot. Try again.',
  slot_taken: 'Someone just booked this slot. Pick another time.',
  slot_elapsed: 'That time has already passed.',
  court_closed: 'The court is not open then.',
  court_unavailable: 'This court is not accepting bookings right now.',
  invalid_branch: 'Something is wrong with that court. Try again from the venue page.',
  invalid_input: 'Check the date and time and try again.',
  too_many_holds: 'You already have three bookings waiting. Finish one first.',
}

export const MANUAL_REVIEW_MESSAGES = {
  awaiting: 'Waiting for the court owner to confirm your payment.',
  approved: 'The owner confirmed your payment. Your booking is set.',
  rejected: 'The owner could not confirm your payment.',
  expired: 'The owner did not review your payment in time, so the slot was released.',
} as const

export function reviewDeadlineLabel(expiresAt: Date): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(expiresAt)
}
