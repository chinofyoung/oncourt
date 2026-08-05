/**
 * The staff permission vocabulary, in one place.
 *
 * Deliberately NOT `server-only`: the staff management form is a client
 * component and needs STAFF_PERMISSIONS and STAFF_PERMISSION_LABELS to render
 * its checkboxes. Nothing here touches the database or a session — it is a
 * list of four strings, their human labels, and set arithmetic over them.
 *
 * The four flags mirror branch_staff's four boolean columns exactly, and the
 * names ARE the column names: requireBranchAccess indexes a row object by the
 * permission string, so a rename here without a migration would silently deny
 * every check rather than fail loudly. Custom roles beyond these four are out
 * of scope (see the spec).
 */
export const STAFF_PERMISSIONS = [
  'view_bookings',
  'block_slots',
  'manage_courts',
  'view_earnings',
] as const

export type StaffPermission = (typeof STAFF_PERMISSIONS)[number]
export type StaffPermissions = Record<StaffPermission, boolean>

export const STAFF_PERMISSION_LABELS: Record<StaffPermission, string> = {
  view_bookings: 'View bookings',
  block_slots: 'Block slots',
  manage_courts: 'Manage courts',
  view_earnings: 'View earnings',
}

/**
 * Functions, not shared constants: a shared `ALL_PERMISSIONS` object would be
 * handed out by reference to every branch in loadDashboardAccess(), so one
 * caller mutating it would change every other branch's permissions.
 */
export function allPermissions(): StaffPermissions {
  return { view_bookings: true, block_slots: true, manage_courts: true, view_earnings: true }
}

export function noPermissions(): StaffPermissions {
  return { view_bookings: false, block_slots: false, manage_courts: false, view_earnings: false }
}

/**
 * branch_staff_some_permission's TypeScript mirror. Checked before the INSERT
 * so an empty checkbox set comes back as a form error rather than a 23514.
 */
export function hasAnyPermission(permissions: StaffPermissions): boolean {
  return STAFF_PERMISSIONS.some((permission) => permissions[permission])
}

/**
 * "Can this person do X anywhere they have access?" — drives which sidebar
 * items and page sections render. A section gated on the union can still show
 * a branch picker that is narrower than the union; the per-branch write guard
 * (requireBranchAccess) is the real boundary either way.
 */
export function unionPermissions(list: StaffPermissions[]): StaffPermissions {
  const result = noPermissions()
  for (const permissions of list) {
    for (const permission of STAFF_PERMISSIONS) {
      if (permissions[permission]) result[permission] = true
    }
  }
  return result
}

/**
 * An unchecked HTML checkbox submits nothing at all, so absence means false —
 * never "unchanged". That is why the edit form always renders all four
 * checkboxes: a partial form would silently revoke the ones it omitted.
 */
export function parsePermissions(formData: FormData): StaffPermissions {
  const result = noPermissions()
  for (const permission of STAFF_PERMISSIONS) {
    result[permission] = formData.get(permission) !== null
  }
  return result
}
