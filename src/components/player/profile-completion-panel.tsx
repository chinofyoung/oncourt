'use client'

import { useActionState, useState } from 'react'
import { CITIES } from '@/lib/geo/cities'
import { profileCompletion, type ProfileStepKey } from '@/lib/profile/completion'
import {
  updateCityAction,
  updateFullNameAction,
  updatePhoneAction,
  type ProfileFormState,
} from '@/app/bookings/profile-actions'

/**
 * The player's ONLY profile surface. `/dashboard/settings` is owner-only and
 * there is no `/account` page, so this panel is where a player's name, mobile
 * number and home city are both shown and edited.
 *
 * That is why it does NOT disappear at 100%: it collapses to a single line
 * with an Edit toggle instead. A vanishing panel would leave a player unable to
 * ever change the city they just set. If an `/account` page is built later,
 * revisit this.
 */
const CARD = 'rounded-[20px] bg-[var(--panel)] p-6 shadow-[var(--shadow-sm)] max-[560px]:p-5'
const KICKER = 'font-mono text-[11px] uppercase tracking-[.14em] text-[var(--court)]'
const LABEL = 'mb-1.5 block text-[13px] font-semibold text-[var(--ink)]'
const FIELD =
  'h-[var(--btn-h-sm)] w-full rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-3 text-sm text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--court)]'
const SAVE =
  'font-display inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] bg-[var(--ink)] px-4 text-[13px] font-bold text-[var(--ball)] transition-[filter,transform] duration-150 hover:brightness-[1.15] active:scale-[.98] motion-reduce:transition-none disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--court)]'
const EDIT_LINK =
  'text-sm font-semibold text-[var(--court)] hover:text-[var(--court-deep)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--court)]'
const ROW =
  'flex w-full items-center gap-2.5 py-2 text-left text-sm text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--court)]'

function Tick({ done }: { done: boolean }) {
  return done ? (
    <span
      aria-hidden
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--court)] text-[11px] font-bold text-white"
    >
      ✓
    </span>
  ) : (
    <span
      aria-hidden
      className="h-[18px] w-[18px] shrink-0 rounded-full border-[1.5px] border-dashed border-[var(--hairline)]"
    />
  )
}

function Message({ state }: { state: ProfileFormState }) {
  if (!state) return null
  return 'error' in state ? (
    <p className="mt-2 text-[13px] text-[#8A4A1E]">{state.error}</p>
  ) : (
    <p className="mt-2 text-[13px] text-[var(--court)]">{state.message}</p>
  )
}

function NameForm({ fullName }: { fullName: string | null }) {
  const [state, action, pending] = useActionState<ProfileFormState, FormData>(
    updateFullNameAction,
    null,
  )
  return (
    <form action={action} className="mt-1 mb-3 flex flex-col gap-2">
      <div>
        <label className={LABEL} htmlFor="profile-full-name">
          Your name
        </label>
        <input
          id="profile-full-name"
          name="fullName"
          type="text"
          required
          maxLength={80}
          defaultValue={fullName ?? ''}
          placeholder="Ana Cruz"
          className={FIELD}
        />
      </div>
      <div>
        <button type="submit" disabled={pending} className={SAVE}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <Message state={state} />
    </form>
  )
}

function PhoneForm({ phone }: { phone: string | null }) {
  const [state, action, pending] = useActionState<ProfileFormState, FormData>(
    updatePhoneAction,
    null,
  )
  return (
    <form action={action} className="mt-1 mb-3 flex flex-col gap-2">
      <div>
        <label className={LABEL} htmlFor="profile-phone">
          Mobile number
        </label>
        <input
          id="profile-phone"
          name="phone"
          type="tel"
          required
          inputMode="tel"
          defaultValue={phone ?? ''}
          placeholder="0917 123 4567"
          className={FIELD}
        />
      </div>
      <div>
        <button type="submit" disabled={pending} className={SAVE}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <Message state={state} />
    </form>
  )
}

function CityForm({ citySlug }: { citySlug: string | null }) {
  const [state, action, pending] = useActionState<ProfileFormState, FormData>(updateCityAction, null)
  return (
    <form action={action} className="mt-1 mb-3 flex flex-col gap-2">
      <div>
        <label className={LABEL} htmlFor="profile-city">
          Home city
        </label>
        <select
          id="profile-city"
          name="citySlug"
          required
          defaultValue={citySlug ?? ''}
          className={`select-chevron-dark ${FIELD}`}
        >
          <option value="" disabled>
            Choose your city
          </option>
          {CITIES.map((city) => (
            <option key={city.slug} value={city.slug}>
              {city.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <button type="submit" disabled={pending} className={SAVE}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <Message state={state} />
    </form>
  )
}

export function ProfileCompletionPanel(props: {
  fullName: string | null
  phone: string | null
  citySlug: string | null
}) {
  const { steps, doneCount, total, percent } = profileCompletion(props)
  const complete = doneCount === total
  // At 100% everything starts collapsed behind Edit; while incomplete the
  // first unfinished step is open, so the panel always has one obvious action.
  const [open, setOpen] = useState<ProfileStepKey | null>(
    complete ? null : (steps.find((step) => !step.done)?.key ?? null),
  )
  const [editing, setEditing] = useState(false)

  if (complete && !editing) {
    return (
      <section aria-label="Profile" className={`${CARD} mb-6 flex items-center gap-3`}>
        <Tick done />
        <p className="flex-1 text-sm font-semibold text-[var(--ink)]">Profile complete</p>
        <button type="button" onClick={() => setEditing(true)} className={EDIT_LINK}>
          Edit
        </button>
      </section>
    )
  }

  return (
    <section aria-label="Profile completion" className={`${CARD} mb-6`}>
      <span className={KICKER}>Your profile</span>
      <h2 className="font-display mt-1.5 text-[22px] font-bold tracking-[-0.02em] text-[var(--ink)]">
        {complete ? 'Profile complete' : 'Complete your profile'}
      </h2>

      <div className="mt-3 flex items-center gap-3">
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Profile completion"
          className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--band-off)]"
        >
          <div className="h-full rounded-full bg-[var(--court)]" style={{ width: `${percent}%` }} />
        </div>
        <span className="font-mono text-[12px] whitespace-nowrap text-[var(--ink-soft)]">
          {percent}% · {doneCount} of {total}
        </span>
      </div>

      <p className="mt-3 max-w-[520px] text-[13.5px] text-[var(--ink-soft)]">
        Your city sets where your searches start, so you see courts you can actually reach. Your
        phone lets a court reach you about a booking.
      </p>

      <ul className="mt-3 divide-y divide-[var(--hairline)]">
        {steps.map((step) => (
          <li key={step.key}>
            <button
              type="button"
              className={ROW}
              aria-expanded={open === step.key}
              onClick={() => setOpen(open === step.key ? null : step.key)}
            >
              <Tick done={step.done} />
              <span className="flex-1">
                {step.label}
                <span className="sr-only">{step.done ? ' — Completed' : ' — Not completed'}</span>
              </span>
              <span aria-hidden className="text-[var(--ink-soft)]">
                {open === step.key ? '−' : '+'}
              </span>
            </button>
            {open === step.key && step.key === 'full_name' && <NameForm fullName={props.fullName} />}
            {open === step.key && step.key === 'phone' && <PhoneForm phone={props.phone} />}
            {open === step.key && step.key === 'city' && <CityForm citySlug={props.citySlug} />}
          </li>
        ))}
      </ul>
    </section>
  )
}
