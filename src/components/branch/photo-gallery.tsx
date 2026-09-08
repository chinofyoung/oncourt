'use client'

import { useEffect, useRef, useState } from 'react'
import { photoUrl } from '@/lib/photos'

/**
 * The venue page's photo surface. This went through two intermediate shapes
 * before landing here, and the history matters for anyone reading this file
 * cold:
 *
 * 1. Originally a boxed 2fr/1fr grid inside a 360px left rail (the page's
 *    very first version, ported from design/mockups/branch-page.html's
 *    `.gallery`).
 * 2. Split into `heroLeadPhoto()` + `PhotoThumbs` when the lead photo became
 *    a full-bleed backdrop with venue identity text on top of it, in a dark
 *    overlay.
 * 3. That full-bleed treatment was rejected by the user after visual review
 *    (no text over photos, at all), and shrank to a plain full-width photo
 *    BANNER with no text on it — `heroLeadPhoto`/`PhotoThumbs` still existed
 *    as two exports at that point, riding inside the banner.
 * 4. **This shape:** the user then asked for the gallery to stop being
 *    full-bleed entirely and sit inside the page's normal 1120px content
 *    column instead, as a 2fr/1fr grid (mirroring the ORIGINAL shape from
 *    step 1, just 1120px wide instead of 360px), with every photo clickable
 *    into a lightbox. `heroLeadPhoto` and `PhotoThumbs` are recombined back
 *    into one `PhotoGallery` export — there is no longer a full-bleed
 *    backdrop distinct from a thumbnail strip, so the split that motivated
 *    two exports no longer applies.
 *
 * `'use client'`: the lightbox needs click handlers, keyboard navigation, and
 * open/closed state, none of which a Server Component can hold. `photoUrl`
 * (src/lib/photos.ts) has zero imports of its own — no `server-only`, no
 * `@/db` — so importing it here as a value is safe; it does not pull the
 * server-only chain a client component must avoid.
 */

const MAX_THUMBS = 4

/** Grid placement for a thumbnail among 1-4 shown, so the 2x2 thumbnail grid
 *  never leaves a dead empty cell: 1 thumbnail fills the whole column, 2
 *  stack as full-width rows, 3 puts the odd one on its own full-width row,
 *  4 is the plain 2x2. Same reasoning as the About/Location `col-span-2`
 *  trick elsewhere on this page — an empty grid cell reads as a layout bug,
 *  not as "there's nothing more to show here." */
function thumbSpanClass(count: number, index: number): string {
  if (count === 1) return 'col-span-2 row-span-2'
  if (count === 2) return 'col-span-2 row-span-1'
  if (count === 3 && index === 2) return 'col-span-2 row-span-1'
  return 'col-span-1 row-span-1'
}

function ExpandIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </svg>
  )
}

function ChevronLeftIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 5l-7 7 7 7" />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  )
}

/** A single photo tile: the clickable surface shared by the lead photo and
 *  every thumbnail. `isLead` only changes the corner icon (expand vs. none —
 *  every tile opens the same lightbox, so only the lead needs a signifier
 *  that the whole gallery is browsable; thumbnails already look like small
 *  versions of one, which reads as "more photos" on its own). */
function GalleryTile({
  url,
  index,
  total,
  isLead,
  badge,
  className,
  onOpen,
}: {
  url: string | null
  index: number
  total: number
  isLead: boolean
  badge?: number
  className: string
  onOpen: (index: number) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(index)}
      aria-label={`View photo ${index + 1} of ${total}`}
      className={`group relative overflow-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-[var(--court)] ${className}`}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- public bucket, already-sized upload.
        <img
          src={url}
          alt=""
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-[cubic-bezier(0.2,0.7,0.3,1)] group-hover:scale-[1.045] motion-reduce:transition-none motion-reduce:transform-none"
        />
      ) : (
        <div aria-hidden className="absolute inset-0 bg-[var(--band-off)]" />
      )}
      {isLead && (
        <span
          aria-hidden
          className="absolute bottom-3 right-3 flex h-8 w-8 items-center justify-center rounded-full bg-[rgba(14,42,31,.75)] text-white"
        >
          <ExpandIcon />
        </span>
      )}
      {badge !== undefined && badge > 0 && (
        <span
          aria-hidden
          className="absolute bottom-1.5 right-1.5 rounded-full bg-[rgba(14,42,31,.75)] px-2 py-0.5 font-mono text-[10.5px] text-white"
        >
          +{badge}
        </span>
      )}
    </button>
  )
}

export function PhotoGallery({ photoPaths, name }: { photoPaths: string[]; name: string }) {
  const urls = photoPaths.map((p) => photoUrl('branch-photos', p))
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  // Sync the dialog's native open state to React state rather than the other
  // way around — `onClose` below (fired for BOTH a programmatic .close() and
  // the native Escape/backdrop "cancel" path) is the single place that turns
  // openIndex back to null, so the two can never disagree.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (openIndex !== null && !dialog.open) dialog.showModal()
    else if (openIndex === null && dialog.open) dialog.close()
  }, [openIndex])

  if (urls.length === 0) {
    return <div aria-hidden className="h-[380px] rounded-[20px] bg-[var(--band-off)] max-[980px]:h-[220px]" />
  }

  const thumbUrls = urls.slice(1, 1 + MAX_THUMBS)
  const remaining = urls.length - 1 - thumbUrls.length

  function open(index: number) {
    setOpenIndex(index)
  }
  function close() {
    // Calls setOpenIndex(null) directly rather than relying solely on the
    // `onClose` handler below: onClose IS the single writer that turns
    // openIndex back to null (see the comment on the effect above), but if it
    // ever failed to fire for some reason, the button would be the only path
    // back and the gallery would wedge open permanently. Setting state here
    // too keeps this path self-sufficient while onClose remains the backstop
    // for the native Escape/backdrop-dismiss paths, which have no button to
    // attach this to.
    dialogRef.current?.close()
    setOpenIndex(null)
  }
  function next() {
    setOpenIndex((i) => (i === null ? null : (i + 1) % urls.length))
  }
  function prev() {
    setOpenIndex((i) => (i === null ? null : (i - 1 + urls.length) % urls.length))
  }
  function handleDialogKeyDown(e: React.KeyboardEvent<HTMLDialogElement>) {
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      next()
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      prev()
    }
  }

  return (
    <>
      {/* When there are no thumbnails (a branch with 0 or 1 total photos),
          collapse to a single column instead of leaving grid-cols-[2fr_1fr]'s
          1fr track unconditionally reserved with nothing to fill it — that
          left a blank ~374px gutter beside the lead photo. Same "never leave
          a dead cell" reasoning as thumbSpanClass above, just applied to the
          outer grid instead of the thumb column. Do not hardcode
          grid-cols-[2fr_1fr] here again without this guard. */}
      <div
        className={`grid h-[380px] gap-2 max-[980px]:h-auto max-[980px]:grid-cols-1 ${
          thumbUrls.length > 0 ? 'grid-cols-[2fr_1fr]' : 'grid-cols-1'
        }`}
      >
        <GalleryTile
          url={urls[0]}
          index={0}
          total={urls.length}
          isLead
          className="h-full rounded-[20px] max-[980px]:h-[220px]"
          onOpen={open}
        />

        {thumbUrls.length > 0 && (
          <div className="grid grid-cols-2 grid-rows-2 gap-2 max-[980px]:flex max-[980px]:h-auto max-[980px]:flex-wrap">
            {thumbUrls.map((url, i) => {
              const index = i + 1
              const isLast = i === thumbUrls.length - 1
              return (
                <GalleryTile
                  key={index}
                  url={url}
                  index={index}
                  total={urls.length}
                  isLead={false}
                  badge={isLast ? remaining : undefined}
                  className={`rounded-[10px] ${thumbSpanClass(thumbUrls.length, i)} max-[980px]:h-[72px] max-[980px]:w-[96px]`}
                  onOpen={open}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* Lightbox. Native <dialog> + showModal() per design/branding.md's
          Modal convention: focus trapping, Escape-to-close, and an inert
          background come free, which a hand-rolled overlay would have to
          reimplement and could get wrong. Left as React state rather than
          this project's usual `?query=` convention for a modal — a photo
          lightbox is ephemeral browsing UI on top of a page whose OWN state
          is the `?date=` param, and stacking a second query param here
          didn't seem worth it for something nobody needs to link to
          mid-browse. Flagging this as a deliberate call, not an oversight,
          since branding.md's Modal entry states the URL convention
          generally. */}
      <dialog
        ref={dialogRef}
        aria-label={openIndex !== null ? `${name} — Photo ${openIndex + 1} of ${urls.length}` : undefined}
        onClose={() => setOpenIndex(null)}
        onKeyDown={handleDialogKeyDown}
        className="m-auto w-[min(920px,92vw)] overflow-hidden rounded-[20px] bg-[var(--ink)] p-0 backdrop:bg-[rgba(6,20,13,.45)]"
      >
        {openIndex !== null && (
          <div className="relative flex h-[min(640px,80vh)] items-center justify-center bg-[var(--ink)]">
            {urls[openIndex] ? (
              // eslint-disable-next-line @next/next/no-img-element -- public bucket, already-sized upload.
              <img
                src={urls[openIndex]!}
                alt=""
                className="h-full w-full object-contain"
              />
            ) : (
              <div aria-hidden className="h-full w-full bg-[var(--band-off)]" />
            )}

            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-[rgba(14,42,31,.75)] text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--ball)]"
            >
              <CloseIcon />
            </button>

            {urls.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={prev}
                  aria-label="Previous photo"
                  className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-[rgba(14,42,31,.75)] text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--ball)]"
                >
                  <ChevronLeftIcon />
                </button>
                <button
                  type="button"
                  onClick={next}
                  aria-label="Next photo"
                  className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-[rgba(14,42,31,.75)] text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--ball)]"
                >
                  <ChevronRightIcon />
                </button>
                {/* role="status": a changed aria-label on an already-open
                    dialog is not re-announced, so without this an
                    assistive-tech user pressing Next/Previous gets zero
                    feedback that the photo changed. Kept visible — the count
                    is useful to every user, not just a screen-reader one. */}
                <p
                  role="status"
                  className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-[rgba(14,42,31,.75)] px-3 py-1 font-mono text-[11px] text-white"
                >
                  {openIndex + 1} / {urls.length}
                </p>
              </>
            )}
          </div>
        )}
      </dialog>
    </>
  )
}
