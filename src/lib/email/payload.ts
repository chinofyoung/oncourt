/**
 * What each email needs, snapshotted at enqueue time.
 *
 * A DISCRIMINATED UNION keyed on `kind` is what makes this slice type-safe end
 * to end: renderEmail switches exhaustively over it, so a new kind without a
 * template does not compile, and an enqueue site passing the wrong shape does
 * not compile either. The JSONB column is untyped at the database edge; this
 * file is the only thing standing between that and a runtime surprise.
 *
 * These are FACTS, not references. `courtName` is the name at the time of the
 * booking, not a join — the court can be renamed and a receipt must not change.
 *
 * NOTE: this file deliberately does NOT `import 'server-only'`. It is types
 * only (no runtime code, no secrets, nothing that touches the database), and
 * a later task's `/admin/emails` page benefits from being able to type-import
 * it from a Client Component without tripping the server-only guard. This is
 * a stated exception to the project's server-only rule, not an oversight.
 */

export type BookingEmailFacts = {
  playerName: string | null
  branchName: string
  courtName: string
  /** Manila calendar date, `YYYY-MM-DD`. */
  bookedOn: string
  /** Manila hours, 24h. */
  startHour: number
  endHour: number
  totalChargedCentavos: number
  bookingId: string
}

export type EmailPayload =
  | { kind: 'booking_confirmed'; booking: BookingEmailFacts }
  | { kind: 'booking_new'; booking: BookingEmailFacts; ownerName: string | null }
  | { kind: 'booking_reminder'; booking: BookingEmailFacts }
  | {
      kind: 'court_moderated'
      ownerName: string | null
      branchName: string
      courtName: string
      approved: boolean
      rejectionReason: string | null
    }
  | {
      kind: 'refund_recorded'
      playerName: string | null
      branchName: string
      courtName: string
      bookedOn: string
      amountCentavos: number
      bookingCancelled: boolean
    }

export type EmailKind = EmailPayload['kind']
