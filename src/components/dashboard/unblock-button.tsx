'use client'

import { useActionState } from 'react'
import { deleteBlockAction, type BlockFormState } from '@/app/dashboard/blocks/actions'

const FOCUS_RING =
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-2'

/**
 * Frees a blocked slot. One instance per block row, so there are only ever as
 * many of these on a page as there are blocks that day.
 *
 * A client component for the same reason as BlockForm: the action can refuse
 * ("that block no longer exists" — someone else removed it, or the page is
 * stale) and a Server Component has nowhere to render that. On success the
 * action revalidates this route and the row disappears.
 *
 * Bordered, never lime: branding.md allows one lime button per view and the
 * block form's submit is it. Deliberately NOT a confirmation dialog — removing
 * a block is immediately reversible by blocking the slot again, and it destroys
 * no record anyone is owed (unlike a paid booking, which cannot be deleted at
 * all; see src/lib/blocks/write.ts's deleteBlock).
 *
 * `label` is the block's own label, folded into the accessible name so a screen
 * reader hears which of several Unblock buttons this is.
 */
export function UnblockButton({ blockId, label }: { blockId: string; label: string }) {
  const [state, formAction, pending] = useActionState<BlockFormState, FormData>(
    deleteBlockAction,
    null,
  )

  return (
    <form action={formAction}>
      <input type="hidden" name="blockId" value={blockId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Unblock ${label}`}
        className={`inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3 text-[12.5px] font-semibold whitespace-nowrap text-[var(--ink)] hover:border-[var(--court)] disabled:opacity-60 ${FOCUS_RING}`}
      >
        {pending ? 'Removing…' : 'Unblock'}
      </button>
      {state && 'error' in state && (
        <p role="alert" className="mt-1 text-[11.5px] font-medium text-[var(--ink)]">
          {state.error}
        </p>
      )}
    </form>
  )
}
