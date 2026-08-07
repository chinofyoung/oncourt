/**
 * Inline SVG icons for the amenity vocabulary (see amenity-chip.tsx for the
 * slug list). No icon library — this project doesn't have one, and adding
 * one is a dependency decision nobody asked for.
 *
 * Every icon: 24x24 viewBox, rendered at ~17px, `stroke="currentColor"` (plus
 * `fill="currentColor"` on the few filled dot accents) so it inherits
 * whatever text color surrounds it, and `aria-hidden` — the amenity's own
 * label is the accessible name, so the icon carries none of its own.
 *
 * Keyed by canonical slug (AMENITY_ICONS) so a new amenity and its icon land
 * in one place. CustomAmenityIcon is the neutral fallback for owner-defined
 * amenities, which have no slug to key off of.
 */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Icon({ children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={17}
      height={17}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

/**
 * A vector-drawn "P" (stem + bowl) rather than an SVG `<text>` glyph: a font
 * glyph's characters land in the element's `textContent` right alongside the
 * chip's own visible label, so `<span><svg>…<text>P</text></svg>Parking</span>`
 * reads back as "PParking" to anything walking the DOM by text content (copy,
 * text search, a future test) even though `aria-hidden` on the `<svg>`
 * correctly keeps it out of the ACCESSIBILITY tree. Every other icon here is
 * pure stroked paths for the same reason — this one just needs two of them
 * to read as a letterform.
 */
function ParkingIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="M9.2 7v10" />
      <path d="M9.2 7h3a2.6 2.6 0 0 1 0 5.2h-3" />
    </Icon>
  )
}

function ShowersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3v3.5" />
      <path d="M4.5 9.5h15" />
      <path d="M7.5 13.5v2M11.5 13.5v2M15.5 13.5v2M9.5 17.5v2M13.5 17.5v2" />
    </Icon>
  )
}

function LockersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="3" width="7.5" height="18" rx="1.2" />
      <rect x="13" y="3" width="7.5" height="18" rx="1.2" />
      <circle cx="9" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </Icon>
  )
}

/** Paddle rentals ("rentals" slug) — a pickleball paddle: face + handle. */
function PaddleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="3" width="12" height="13" rx="6" />
      <path d="M12 16v5" />
    </Icon>
  )
}

/** Ball rentals — a pickleball: a circle with its characteristic hole pattern. */
function BallIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="9" cy="9" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12.3" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="9" cy="15.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15.5" r="0.9" fill="currentColor" stroke="none" />
    </Icon>
  )
}

/** Ball machine rentals — a feed hopper with a ball launching out, distinct from the plain ball icon above. */
function BallMachineIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 10V6.5" />
      <path d="M12 10V6.5" />
      <rect x="4" y="10" width="12" height="9.5" rx="1.5" />
      <circle cx="18.5" cy="9.5" r="2.7" />
    </Icon>
  )
}

function CafeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 9.5h11.5v5.5a4.5 4.5 0 0 1-4.5 4.5h-2.5a4.5 4.5 0 0 1-4.5-4.5V9.5z" />
      <path d="M16.5 11h1a2.5 2.5 0 0 1 0 5h-1" />
      <path d="M9 5.3c0 .9-.9 1.1-.9 2M13 5.3c0 .9-.9 1.1-.9 2" />
    </Icon>
  )
}

/** Snacks — a folded snack-bag/pouch shape. */
function SnacksIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7.5 8L8.5 4h7l1 4" />
      <path d="M6.5 8h11l-1.15 10.7a2 2 0 0 1-2 1.8H9.65a2 2 0 0 1-2-1.8L6.5 8z" />
    </Icon>
  )
}

/** Neutral fallback for owner-defined custom amenities — a generic tag/label shape. */
export function CustomAmenityIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M11.5 3.5h5A2 2 0 0 1 18.5 5.5v5a2 2 0 0 1-.586 1.414l-7 7a2 2 0 0 1-2.828 0l-5-5a2 2 0 0 1 0-2.828l7-7A2 2 0 0 1 11.5 3.5z" />
      <circle cx="15" cy="8" r="1" fill="currentColor" stroke="none" />
    </Icon>
  )
}

/**
 * Single source of truth mapping a canonical amenity slug to its icon.
 * Shared by AmenityChip (venue page, branch cards, branch page) and the
 * owner's checkbox fieldset (branch-fieldset.tsx) so both places stay in
 * sync with one edit.
 */
export const AMENITY_ICONS: Record<string, (props: IconProps) => React.JSX.Element> = {
  parking: ParkingIcon,
  showers: ShowersIcon,
  lockers: LockersIcon,
  rentals: PaddleIcon,
  'ball-rentals': BallIcon,
  'ball-machine-rentals': BallMachineIcon,
  cafe: CafeIcon,
  snacks: SnacksIcon,
}
