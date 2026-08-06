'use client'

import { useActionState } from 'react'
import {
  addBranchPhotoAction,
  addCourtPhotoAction,
  deleteBranchPhotoAction,
  deleteCourtPhotoAction,
  moveBranchPhotoAction,
  moveCourtPhotoAction,
  type ListingFormState,
} from './actions'
import { BORDERED_BUTTON, DARK_BUTTON, FIELD, FormMessage, LABEL } from './form-ui'
// ALLOWED_PHOTO_TYPES comes from the PURE photo module, never from
// src/lib/listings/photos.ts — that one is `server-only` and importing it
// here would throw the moment this component reached the client bundle.
import { ALLOWED_PHOTO_TYPES, photoUrl } from '@/lib/photos'

/**
 * Upload, reorder and delete, for branch photos and court photos alike.
 *
 * `kind` picks which pair of actions to bind — it never travels to the
 * server as a form field, because the guard differs by kind and a
 * client-chosen guard is not a guard. The hidden field each form does submit
 * is the branch id or the court id, whichever the bound action expects.
 *
 * Each photo row is its own component so it can own its own useActionState
 * hooks; hooks cannot be called inside a map.
 *
 * `canManage` is false for a staff member looking at branch photos: they see
 * the gallery, without the controls. The actions re-assert it regardless.
 */
const ACTIONS = {
  branch: {
    add: addBranchPhotoAction,
    remove: deleteBranchPhotoAction,
    move: moveBranchPhotoAction,
    idField: 'branchId',
    bucket: 'branch-photos',
  },
  court: {
    add: addCourtPhotoAction,
    remove: deleteCourtPhotoAction,
    move: moveCourtPhotoAction,
    idField: 'courtId',
    bucket: 'court-photos',
  },
} as const

function PhotoRow({
  kind,
  targetId,
  photo,
  isFirst,
  isLast,
}: {
  kind: 'branch' | 'court'
  targetId: string
  photo: { id: string; storagePath: string }
  isFirst: boolean
  isLast: boolean
}) {
  const config = ACTIONS[kind]
  const [moveState, moveAction, movePending] = useActionState<ListingFormState, FormData>(
    config.move,
    null,
  )
  const [removeState, removeAction, removePending] = useActionState<ListingFormState, FormData>(
    config.remove,
    null,
  )

  return (
    <li className="flex flex-col gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element -- the bucket is
          public and these are already-sized uploads; next/image would add a
          loader round trip for a dashboard thumbnail. */}
      <img
        src={photoUrl(config.bucket, photo.storagePath) ?? ''}
        alt=""
        className="h-[96px] w-[144px] rounded-[10px] object-cover"
      />
      <div className="flex flex-wrap gap-1.5">
        <form action={moveAction}>
          <input type="hidden" name={config.idField} value={targetId} />
          <input type="hidden" name="photoId" value={photo.id} />
          <input type="hidden" name="direction" value="up" />
          <button
            type="submit"
            disabled={isFirst || movePending}
            aria-label="Move photo earlier"
            className={BORDERED_BUTTON}
          >
            &uarr;
          </button>
        </form>
        <form action={moveAction}>
          <input type="hidden" name={config.idField} value={targetId} />
          <input type="hidden" name="photoId" value={photo.id} />
          <input type="hidden" name="direction" value="down" />
          <button
            type="submit"
            disabled={isLast || movePending}
            aria-label="Move photo later"
            className={BORDERED_BUTTON}
          >
            &darr;
          </button>
        </form>
        <form action={removeAction}>
          <input type="hidden" name={config.idField} value={targetId} />
          <input type="hidden" name="photoId" value={photo.id} />
          <button
            type="submit"
            disabled={removePending}
            aria-label="Delete photo"
            className={BORDERED_BUTTON}
          >
            {removePending ? 'Removing…' : 'Delete'}
          </button>
        </form>
      </div>
      <FormMessage state={moveState} />
      <FormMessage state={removeState} />
    </li>
  )
}

export function PhotoManager({
  kind,
  targetId,
  photos,
  canManage,
}: {
  kind: 'branch' | 'court'
  targetId: string
  photos: { id: string; storagePath: string }[]
  canManage: boolean
}) {
  const config = ACTIONS[kind]
  const [state, formAction, pending] = useActionState<ListingFormState, FormData>(config.add, null)

  return (
    <div className="flex flex-col gap-4">
      {photos.length === 0 ? (
        <p className="text-[13px] text-[var(--ink-soft)]">No photos yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-4">
          {photos.map((photo, index) =>
            canManage ? (
              <PhotoRow
                key={photo.id}
                kind={kind}
                targetId={targetId}
                photo={photo}
                isFirst={index === 0}
                isLast={index === photos.length - 1}
              />
            ) : (
              <li key={photo.id}>
                {/* eslint-disable-next-line @next/next/no-img-element -- see PhotoRow. */}
                <img
                  src={photoUrl(config.bucket, photo.storagePath) ?? ''}
                  alt=""
                  className="h-[96px] w-[144px] rounded-[10px] object-cover"
                />
              </li>
            ),
          )}
        </ul>
      )}

      {canManage && (
        <form action={formAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name={config.idField} value={targetId} />
          <div className="min-w-[240px] flex-1">
            <label className={LABEL} htmlFor={`photo-${kind}-${targetId}`}>
              Add a photo
            </label>
            <input
              id={`photo-${kind}-${targetId}`}
              name="photo"
              type="file"
              accept={ALLOWED_PHOTO_TYPES.join(',')}
              className={`${FIELD} py-1.5`}
            />
          </div>
          <button type="submit" disabled={pending} className={DARK_BUTTON}>
            {pending ? 'Uploading…' : 'Upload'}
          </button>
          <div className="w-full">
            <FormMessage state={state} />
            <p className="mt-1 text-[11.5px] text-[var(--ink-soft)]">
              JPEG, PNG or WebP, up to 5 MB. The first photo is the one players see first.
            </p>
          </div>
        </form>
      )}
    </div>
  )
}
