/**
 * Which parts of a player's profile are filled in, and how far along they are.
 *
 * IMPORT-FREE ON PURPOSE — same reason as src/lib/profile/phone.ts: the
 * checklist panel is a client component and value-imports this.
 *
 * THREE STEPS, NOT FOUR. `avatar_url` is deliberately excluded: it is
 * auto-filled from Google at signup and this application has no avatar upload
 * path at all, so a player whose Google account has no photo would see a step
 * they cannot complete and a meter pinned below 100% forever. See the spec's
 * "Why avatar is not a step".
 *
 * `full_name` IS counted even though Google usually pre-fills it, so most
 * players start at 33% having done nothing — an already-earned tick reads as
 * momentum rather than a scolding, and a Google account with no name is real.
 */
export type ProfileStepKey = 'full_name' | 'phone' | 'city'

export type ProfileStep = {
  key: ProfileStepKey
  label: string
  done: boolean
}

export type ProfileCompletion = {
  steps: ProfileStep[]
  doneCount: number
  total: number
  percent: number
}

/** Non-null and not blank once trimmed — `"   "` is not a name. */
function filled(value: string | null): boolean {
  return value !== null && value.trim().length > 0
}

export function profileCompletion(profile: {
  fullName: string | null
  phone: string | null
  citySlug: string | null
}): ProfileCompletion {
  const steps: ProfileStep[] = [
    { key: 'full_name', label: 'Your name', done: filled(profile.fullName) },
    { key: 'phone', label: 'Mobile number', done: filled(profile.phone) },
    { key: 'city', label: 'Home city', done: filled(profile.citySlug) },
  ]
  const doneCount = steps.filter((step) => step.done).length
  return {
    steps,
    doneCount,
    total: steps.length,
    percent: Math.round((doneCount / steps.length) * 100),
  }
}
