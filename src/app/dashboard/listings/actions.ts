'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import {
  AuthError,
  requireBranchAccess,
  requireOwner,
  requireOwnerOf,
  requireUser,
} from '@/lib/auth/guards'
import { branchIdOfCourt } from '@/lib/courts/lookup'
import { geocodeAddress, type GeocodeResult } from '@/lib/geo/geocode'
import {
  BRANCH_FIELDS_FAILURE_MESSAGES,
  COURT_FIELDS_FAILURE_MESSAGES,
  parseBranchFields,
  parseCourtFields,
} from '@/lib/listings/fields'
import {
  BANDS_FAILURE_MESSAGES,
  HOURS_FAILURE_MESSAGES,
  parseOperatingHours,
  parseRateBands,
} from '@/lib/listings/schedule'
import {
  createBranch,
  createCourt,
  replaceOperatingHours,
  replaceRateBands,
  updateBranch,
  updateCourtFields,
  type CourtWriteResult,
} from '@/lib/listings/write'
import { addPhoto, deletePhoto, movePhoto, type PhotoTarget } from '@/lib/listings/photos'
import { serviceRoleStorage } from '@/lib/listings/storage'

/**
 * Listings management, for /dashboard/listings/*.
 *
 * This file exports nothing but thirteen async guarded actions and the
 * `ListingFormState` type they return — every OTHER export of a 'use server'
 * file becomes a client-invokable endpoint. All parsing and all SQL live in
 * the `import 'server-only'` modules under src/lib/listings/ and src/lib/
 * courts/, where they are unit-tested; the helpers below are module-private
 * for exactly that reason.
 *
 * TWO GUARD SHAPES, per the spec's permission table:
 *   - Branch-scoped writes (create branch, edit branch fields, create court)
 *     are OWNER-ONLY: requireOwner / requireOwnerOf. A submitted branchId is
 *     safe to guard on because every write is also scoped by that same id in
 *     its WHERE clause — the same argument src/app/dashboard/staff/actions.ts
 *     makes.
 *   - Court-scoped writes (court fields, operating hours, rate bands) are
 *     shared with staff: requireBranchAccess(branchId, 'manage_courts'), with
 *     branchId read from the COURT ROW, never from the form. That is what
 *     stops a staff member with a grant on branch A from editing branch B's
 *     court by submitting its id.
 *
 * Every action takes useActionState's (prevState, formData) shape. The
 * previous state is unused — each submission is judged on its own input — but
 * the parameter must exist for React to bind the action to the form's state.
 */
export type ListingFormState = { ok: true; message: string } | { error: string } | null

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOT_YOUR_BRANCH = "That branch isn't yours to manage."
const NO_COURT_ACCESS = "You don't have permission to manage courts at that branch."
const BAD_TARGET = "That doesn't look right — reload the page and try again."
const SAVED = 'Saved.'
const SAVED_AND_REQUEUED = 'Saved. This court is back in the approval queue.'

/**
 * Shape-checks an id before it reaches a guard that interpolates it into a
 * `::uuid` cast — a malformed value raises 22P02 and escapes as an unhandled
 * exception instead of a form error.
 */
function idFrom(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '')
  return UUID_RE.test(value) ? value : null
}

/** Maps a CourtWriteResult failure to a sentence, reusing the libraries' own message maps. */
function courtWriteMessage(reason: Extract<CourtWriteResult, { ok: false }>['reason']): string {
  if (reason === 'not_found') return 'That court no longer exists.'
  if (reason === 'no_operating_hours') {
    return "Set this court's opening hours before you price it."
  }
  // Narrowed to HoursFailure here and to BandsFailure below, so both message
  // maps are reused verbatim rather than restated — one wording per rule.
  if (reason === 'no_open_day' || reason === 'invalid_window') {
    return HOURS_FAILURE_MESSAGES[reason]
  }
  return BANDS_FAILURE_MESSAGES[reason]
}

/**
 * A branch edit changes what search and the public branch page render (city,
 * amenities, location, contact details), so those caches go too. Court edits
 * additionally change availability and pricing.
 */
function revalidateListing(branchId: string): void {
  revalidatePath('/dashboard/listings')
  revalidatePath(`/dashboard/listings/${branchId}`)
  revalidatePath('/dashboard')
  revalidatePath('/venues', 'layout')
  revalidatePath('/search')
  revalidatePath('/')
}

export async function createBranchAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  let user
  try {
    user = await requireOwner()
  } catch (error) {
    if (error instanceof AuthError) return { error: 'Only court owners can add a branch.' }
    throw error
  }

  const parsed = parseBranchFields(formData)
  if (!parsed.ok) return { error: BRANCH_FIELDS_FAILURE_MESSAGES[parsed.reason] }

  const result = await createBranch({ ownerId: user.id, fields: parsed.fields })
  if (!result.ok) {
    return { error: 'That branch name is taken too many times over — try a more specific one.' }
  }

  revalidateListing(result.branchId)
  // redirect() throws a control-flow signal Next catches, so it MUST be the
  // last statement and MUST NOT sit inside a try/catch that swallows it.
  redirect(`/dashboard/listings/${result.branchId}`)
}

export async function updateBranchAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const branchId = idFrom(formData, 'branchId')
  if (!branchId) return { error: NOT_YOUR_BRANCH }

  try {
    await requireOwnerOf(branchId)
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_YOUR_BRANCH }
    throw error
  }

  const parsed = parseBranchFields(formData)
  if (!parsed.ok) return { error: BRANCH_FIELDS_FAILURE_MESSAGES[parsed.reason] }

  const result = await updateBranch({ branchId, fields: parsed.fields })
  if (!result.ok) return { error: 'That branch no longer exists.' }

  revalidateListing(branchId)
  return { ok: true, message: SAVED }
}

export async function createCourtAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const branchId = idFrom(formData, 'branchId')
  if (!branchId) return { error: NOT_YOUR_BRANCH }

  try {
    await requireOwnerOf(branchId)
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_YOUR_BRANCH }
    throw error
  }

  const parsed = parseCourtFields(formData)
  if (!parsed.ok) return { error: COURT_FIELDS_FAILURE_MESSAGES[parsed.reason] }

  const result = await createCourt({ branchId, fields: parsed.fields })
  if (!result.ok) return { error: 'That branch no longer exists.' }

  revalidateListing(branchId)
  redirect(`/dashboard/listings/${branchId}/courts/${result.courtId}`)
}

/**
 * Resolves a submitted court id to its branch and checks `manage_courts` on
 * THAT branch. Returns null once the caller has been told why, so each court
 * action below is four lines of its own logic.
 *
 * requireUser() runs before branchIdOfCourt for the reason the blocks actions
 * document: without it an unauthenticated POST would still run the lookup and
 * learn from the response whether a given court id exists — a row-existence
 * oracle open to anyone.
 */
async function courtContext(
  formData: FormData,
): Promise<{ courtId: string; branchId: string } | { error: string }> {
  try {
    await requireUser()
  } catch (error) {
    if (error instanceof AuthError) return { error: NO_COURT_ACCESS }
    throw error
  }

  const courtId = idFrom(formData, 'courtId')
  if (!courtId) return { error: BAD_TARGET }

  const branchId = await branchIdOfCourt(courtId)
  // Same message as a malformed id: whether the court does not exist or the
  // id was forged, the caller learns only that the request was wrong.
  if (!branchId) return { error: BAD_TARGET }

  try {
    await requireBranchAccess(branchId, 'manage_courts')
  } catch (error) {
    if (error instanceof AuthError) return { error: NO_COURT_ACCESS }
    throw error
  }

  return { courtId, branchId }
}

export async function updateCourtAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const context = await courtContext(formData)
  if ('error' in context) return context

  const parsed = parseCourtFields(formData)
  if (!parsed.ok) return { error: COURT_FIELDS_FAILURE_MESSAGES[parsed.reason] }

  const result = await updateCourtFields({ courtId: context.courtId, fields: parsed.fields })
  if (!result.ok) return { error: courtWriteMessage(result.reason) }

  revalidateListing(context.branchId)
  return { ok: true, message: result.requeued ? SAVED_AND_REQUEUED : SAVED }
}

export async function updateOperatingHoursAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const context = await courtContext(formData)
  if ('error' in context) return context

  const parsed = parseOperatingHours(formData)
  if (!parsed.ok) return { error: HOURS_FAILURE_MESSAGES[parsed.reason] }

  const result = await replaceOperatingHours({ courtId: context.courtId, days: parsed.days })
  if (!result.ok) return { error: courtWriteMessage(result.reason) }

  revalidateListing(context.branchId)
  return { ok: true, message: result.requeued ? SAVED_AND_REQUEUED : SAVED }
}

export async function updateRateBandsAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const context = await courtContext(formData)
  if ('error' in context) return context

  const parsed = parseRateBands(formData)
  if (!parsed.ok) return { error: BANDS_FAILURE_MESSAGES[parsed.reason] }

  const result = await replaceRateBands({ courtId: context.courtId, bands: parsed.bands })
  if (!result.ok) return { error: courtWriteMessage(result.reason) }

  revalidateListing(context.branchId)
  return { ok: true, message: result.requeued ? SAVED_AND_REQUEUED : SAVED }
}

/**
 * Photos. Six actions rather than two with a `kind` field: the guard differs
 * by kind, and a kind read from the form would decide which guard runs —
 * exactly the confused-deputy shape the rest of this file avoids. Branch
 * photos are OWNER-ONLY (requireOwnerOf); court photos are shared with staff
 * holding manage_courts, with the branch resolved from the court row.
 *
 * None of these touches courts.status: photo edits never re-queue a court.
 */
const PHOTO_MESSAGES: Record<
  'no_file' | 'bad_type' | 'too_large' | 'upload_failed' | 'target_missing' | 'not_found' | 'delete_failed' | 'at_edge',
  string
> = {
  no_file: 'Choose a photo first.',
  bad_type: 'Photos must be JPEG, PNG or WebP.',
  too_large: 'That photo is over 5 MB — use a smaller one.',
  upload_failed: "That upload didn't go through. Try again.",
  target_missing: 'That listing no longer exists.',
  not_found: 'That photo is already gone.',
  delete_failed: "That photo couldn't be removed. Try again.",
  at_edge: 'That photo is already at the end.',
}

function photoFrom(formData: FormData): File | null {
  const file = formData.get('photo')
  return file instanceof File ? file : null
}

function directionFrom(formData: FormData): 'up' | 'down' | null {
  const direction = String(formData.get('direction') ?? '')
  return direction === 'up' || direction === 'down' ? direction : null
}

/** Guards a branch photo write and returns the target, or the message to show. */
async function branchPhotoTarget(
  formData: FormData,
): Promise<{ target: PhotoTarget; branchId: string } | { error: string }> {
  const branchId = idFrom(formData, 'branchId')
  if (!branchId) return { error: NOT_YOUR_BRANCH }
  try {
    await requireOwnerOf(branchId)
  } catch (error) {
    if (error instanceof AuthError) return { error: NOT_YOUR_BRANCH }
    throw error
  }
  return { target: { kind: 'branch', branchId }, branchId }
}

/** Same, for a court photo: manage_courts, with the branch read from the court row. */
async function courtPhotoTarget(
  formData: FormData,
): Promise<{ target: PhotoTarget; branchId: string } | { error: string }> {
  const context = await courtContext(formData)
  if ('error' in context) return context
  return { target: { kind: 'court', courtId: context.courtId }, branchId: context.branchId }
}

export async function addBranchPhotoAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const scope = await branchPhotoTarget(formData)
  if ('error' in scope) return scope

  const file = photoFrom(formData)
  if (!file) return { error: PHOTO_MESSAGES.no_file }

  const result = await addPhoto({ target: scope.target, file, storage: serviceRoleStorage() })
  if (!result.ok) return { error: PHOTO_MESSAGES[result.reason] }

  revalidateListing(scope.branchId)
  return { ok: true, message: 'Photo added.' }
}

export async function deleteBranchPhotoAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const scope = await branchPhotoTarget(formData)
  if ('error' in scope) return scope

  const photoId = idFrom(formData, 'photoId')
  if (!photoId) return { error: PHOTO_MESSAGES.not_found }

  const result = await deletePhoto({
    target: scope.target,
    photoId,
    storage: serviceRoleStorage(),
  })
  if (!result.ok) return { error: PHOTO_MESSAGES[result.reason] }

  revalidateListing(scope.branchId)
  return { ok: true, message: 'Photo removed.' }
}

export async function moveBranchPhotoAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const scope = await branchPhotoTarget(formData)
  if ('error' in scope) return scope

  const photoId = idFrom(formData, 'photoId')
  const direction = directionFrom(formData)
  if (!photoId || !direction) return { error: BAD_TARGET }

  const result = await movePhoto({ target: scope.target, photoId, direction })
  if (!result.ok) return { error: PHOTO_MESSAGES[result.reason] }

  revalidateListing(scope.branchId)
  return { ok: true, message: 'Order saved.' }
}

/**
 * Address -> coordinates for the branch form's map pin.
 *
 * requireOwner, per the spec: only a court owner can reach the branch form,
 * and this action calls an external service on the app's shared quota — an
 * unguarded endpoint would be a free geocoding proxy for anyone with the
 * action id.
 *
 * Returns null for every failure, including "not signed in as an owner". The
 * caller's answer to null is always the same — "place the pin by hand" — so
 * distinguishing the reasons would only leak which one it was.
 *
 * Takes a plain string rather than FormData: it is invoked imperatively from
 * the picker, not submitted by a form, because the branch form cannot nest a
 * second form inside itself.
 */
export async function geocodeAddressAction(query: string): Promise<GeocodeResult | null> {
  try {
    await requireOwner()
  } catch (error) {
    if (error instanceof AuthError) return null
    throw error
  }
  return geocodeAddress(query)
}

export async function addCourtPhotoAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const scope = await courtPhotoTarget(formData)
  if ('error' in scope) return scope

  const file = photoFrom(formData)
  if (!file) return { error: PHOTO_MESSAGES.no_file }

  const result = await addPhoto({ target: scope.target, file, storage: serviceRoleStorage() })
  if (!result.ok) return { error: PHOTO_MESSAGES[result.reason] }

  revalidateListing(scope.branchId)
  return { ok: true, message: 'Photo added.' }
}

export async function deleteCourtPhotoAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const scope = await courtPhotoTarget(formData)
  if ('error' in scope) return scope

  const photoId = idFrom(formData, 'photoId')
  if (!photoId) return { error: PHOTO_MESSAGES.not_found }

  const result = await deletePhoto({
    target: scope.target,
    photoId,
    storage: serviceRoleStorage(),
  })
  if (!result.ok) return { error: PHOTO_MESSAGES[result.reason] }

  revalidateListing(scope.branchId)
  return { ok: true, message: 'Photo removed.' }
}

export async function moveCourtPhotoAction(
  _prevState: ListingFormState,
  formData: FormData,
): Promise<ListingFormState> {
  const scope = await courtPhotoTarget(formData)
  if ('error' in scope) return scope

  const photoId = idFrom(formData, 'photoId')
  const direction = directionFrom(formData)
  if (!photoId || !direction) return { error: BAD_TARGET }

  const result = await movePhoto({ target: scope.target, photoId, direction })
  if (!result.ok) return { error: PHOTO_MESSAGES[result.reason] }

  revalidateListing(scope.branchId)
  return { ok: true, message: 'Order saved.' }
}
