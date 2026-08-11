import 'server-only'
import { AuthError, requireAdmin } from '@/lib/auth/guards'

/**
 * The admin form-action guard, shared.
 *
 * Lives in a plain module rather than beside the actions it guards: every
 * export of a 'use server' file (src/app/admin/actions.ts,
 * src/app/admin/settings/actions.ts) becomes a client-invokable endpoint, so a
 * guard used by more than one action file cannot live in either of them
 * without either duplicating it or publishing it as a second endpoint. This
 * also matches src/app/admin/actions.ts's own stated rule that logic lives
 * under src/lib/admin/, not in the 'use server' file itself.
 */
const NOT_ADMIN = 'That action is for admins only.'

/**
 * The guard, once. Returns the message to show, or null to proceed — every
 * action's first two lines.
 */
export async function refuseUnlessAdmin(): Promise<string | null> {
  try {
    await requireAdmin()
    return null
  } catch (error) {
    if (error instanceof AuthError) return NOT_ADMIN
    throw error
  }
}

/**
 * Shape-checked before an id reaches a `::uuid` cast, which would otherwise
 * raise 22P02. Shared here rather than left as src/app/admin/actions.ts's
 * local copy, because Task 6's actions file (and this one) need the identical
 * check and a 'use server' file cannot export a helper without publishing it
 * as a second client-invokable endpoint. src/app/admin/actions.ts keeps its
 * own copy — rewriting it is outside this task.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function idFrom(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '')
  return UUID_RE.test(value) ? value : null
}
