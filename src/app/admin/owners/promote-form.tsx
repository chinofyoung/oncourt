'use client'

import { useActionState } from 'react'
import {
  BORDERED_BUTTON,
  DARK_BUTTON,
  FIELD,
  FormMessage,
  LABEL,
} from '@/app/dashboard/listings/form-ui'
import {
  lookupPlayerAction,
  promoteOwnerAction,
  type AdminFormState,
  type OwnerLookupState,
} from '@/app/admin/actions'

/**
 * Two forms, one screen: find the account, then promote it.
 *
 * Both states live here because the second form only exists once the first has
 * an answer — a Server Component cannot hold that, and a `?email=` round trip
 * would publish someone's address into the URL bar, browser history and every
 * log in front of this app.
 *
 * The lookup returns the profile WHATEVER its role. Showing "that address
 * belongs to an owner already" is more useful to an admin who mistyped a
 * colleague's address than a flat "no match", and the promote form simply is
 * not rendered for a non-player — with promoteToOwner's role-scoped WHERE
 * clause as the real enforcement underneath.
 */
export function PromoteOwnerForm() {
  const [lookup, findPlayer, finding] = useActionState<OwnerLookupState, FormData>(
    lookupPlayerAction,
    null,
  )
  const [promotion, promote, promoting] = useActionState<AdminFormState, FormData>(
    promoteOwnerAction,
    null,
  )

  const player = lookup && 'player' in lookup ? lookup.player : null

  return (
    <div className="flex flex-col gap-6">
      <form action={findPlayer} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[260px] flex-1">
          <label className={LABEL} htmlFor="promote-email">
            Email address
          </label>
          <input
            id="promote-email"
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="owner@example.com"
            className={FIELD}
          />
        </div>
        <button type="submit" disabled={finding} className={BORDERED_BUTTON}>
          {finding ? 'Searching…' : 'Find account'}
        </button>
        <div className="w-full">
          {/* Only the failure arm renders here — a hit renders the card below,
              which says more than a sentence could. */}
          {lookup && 'error' in lookup && (
            <p role="alert" className="mt-2 text-[12.5px] font-medium text-[var(--ink)]">
              {lookup.error}
            </p>
          )}
        </div>
      </form>

      {player && (
        <div className="rounded-[20px] bg-[var(--surface)] p-5">
          <p className="font-mono text-[10.5px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
            Match
          </p>
          <p className="mt-1.5 text-[15px] font-semibold text-[var(--ink)]">
            {player.fullName ?? player.email}
          </p>
          <p className="text-[13px] text-[var(--ink-soft)]">
            {player.email} · {player.role}
          </p>

          {player.role !== 'player' ? (
            <p className="mt-3 text-[13.5px] text-[var(--ink)]">
              That account is already {player.role === 'owner' ? 'a court owner' : 'an admin'}, so
              there is nothing to promote.
            </p>
          ) : (
            <form action={promote} className="mt-4 flex flex-col gap-3">
              <input type="hidden" name="userId" value={player.id} />

              <div className="flex flex-wrap gap-3">
                <div className="min-w-[240px] flex-1">
                  <label className={LABEL} htmlFor="promote-business-name">
                    Business name
                  </label>
                  <input
                    id="promote-business-name"
                    name="businessName"
                    type="text"
                    required
                    maxLength={120}
                    placeholder="Smash Zone"
                    className={FIELD}
                  />
                </div>
                <div className="min-w-[240px] flex-1">
                  <label className={LABEL} htmlFor="promote-slug">
                    Web address
                  </label>
                  {/* Shape-checked here for a fast answer and again in
                      promoteToOwner, which is the authority; the UNIQUE index
                      on profiles.slug is the authority on collisions. */}
                  <input
                    id="promote-slug"
                    name="slug"
                    type="text"
                    required
                    pattern="[a-z0-9\-]+"
                    placeholder="smash-zone"
                    className={FIELD}
                  />
                  <p className="mt-1 text-[11.5px] text-[var(--ink-soft)]">
                    Lowercase letters, numbers and hyphens. Appears at /owners/&lt;address&gt;.
                  </p>
                </div>
              </div>

              <div>
                <button type="submit" disabled={promoting} className={DARK_BUTTON}>
                  {promoting ? 'Promoting…' : 'Promote to owner'}
                </button>
              </div>
              <FormMessage state={promotion} />
            </form>
          )}
        </div>
      )}
    </div>
  )
}
