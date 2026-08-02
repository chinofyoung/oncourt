import { photoUrl } from '@/lib/photos'

/**
 * Ported from design/mockups/branch-page.html's `.gallery`: a large lead shot
 * plus two side shots in a 2fr/1fr grid, rounded-[20px] per branding.md's
 * card radius. The mockup's `.shot-count` badge (e.g. "1 / 12") is adapted
 * into a "+N" badge on the last visible side shot, showing how many photos
 * aren't shown rather than the mockup's current-index framing (there's no
 * lightbox/carousel behind this static gallery to have a "current" index).
 *
 * Always renders exactly two side slots — even when there's only 0 or 1
 * extra photo — filling absent slots with the same flat `--band-off` block
 * the zero-photos path uses, so the grid never collapses into an
 * unbalanced/gappy layout.
 */
export function PhotoGallery({ photoPaths }: { photoPaths: string[] }) {
  if (photoPaths.length === 0) {
    return (
      <div
        role="img"
        aria-label="No photos yet"
        className="aspect-[16/10] w-full rounded-[20px] bg-[var(--band-off)]"
      />
    )
  }

  const [lead, ...rest] = photoPaths
  const leadUrl = photoUrl('branch-photos', lead)
  const sideSlots: (string | null)[] = [rest[0] ?? null, rest[1] ?? null]
  const remainingCount = Math.max(photoPaths.length - 1 - sideSlots.filter(Boolean).length, 0)

  return (
    <div className="grid grid-cols-[2fr_1fr] auto-rows-[120px] gap-1.5 overflow-hidden rounded-[20px]">
      <figure className="relative row-span-2 overflow-hidden">
        {leadUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={leadUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 bg-[var(--band-off)]" />
        )}
      </figure>

      {sideSlots.map((path, i) => {
        const isLast = i === sideSlots.length - 1
        const url = path ? photoUrl('branch-photos', path) : null
        return (
          <figure key={path ?? `empty-${i}`} className="relative overflow-hidden">
            {url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <div className="absolute inset-0 bg-[var(--band-off)]" />
            )}
            {isLast && remainingCount > 0 && (
              <span className="absolute bottom-2.5 right-2.5 z-[2] rounded-full bg-[rgba(14,42,31,.75)] px-2.5 py-1 font-mono text-[11.5px] text-white">
                +{remainingCount}
              </span>
            )}
          </figure>
        )
      })}
    </div>
  )
}
