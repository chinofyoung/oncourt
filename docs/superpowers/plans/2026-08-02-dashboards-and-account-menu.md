# Dashboards & Account Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give signed-in users somewhere to go — an account menu with sign-out, a player dashboard at `/bookings`, and an owner dashboard at `/dashboard` — reading only from tables that already exist.

**Architecture:** Server Components read through two new server-only query modules (`src/lib/bookings/queries.ts`, `src/lib/owner/queries.ts`) that execute hand-written SQL via `db.execute(sql\`…\`)`. Page access is gated by redirect-flavored guards; Server Actions keep the throwing guards. Only two pieces are client components: the account menu dropdown and the login button. Tabs and filters are URL state (`?tab=`, `?day=`, `?branch=`), so almost nothing ships as client JS.

**Tech Stack:** Next.js 16 App Router (TypeScript), Tailwind v4 with brand tokens in `src/app/globals.css`, Drizzle `sql` template over Postgres (never the query builder), Supabase Auth (Google), Vitest against the hosted Supabase project.

**Spec:** `docs/superpowers/specs/2026-08-02-dashboards-and-account-menu-design.md`

## Global Constraints

- **Data access is server-only.** Every read/write goes through a Server Component, Server Action, or Route Handler guarded by `requireUser` / `requireOwner` / `requireOwnerOf` / `requireAdmin`. The browser never queries Postgres.
- **Never use the Drizzle query builder.** Only `db.execute(sql\`...\`)`. Do not import `src/db/schema.ts` — it is excluded from `tsconfig.json` and importing it resurfaces a `TS2304`.
- **Money is integer centavos, percentages integer basis points.** Never floats, never `numeric`. Coerce every numeric column out of the driver with `Number()` — the `pg` driver returns `numeric` as a string.
- **Identifiers are lowercase `snake_case`** in SQL; TypeScript is `camelCase`. Index every foreign key explicitly (no new tables here, so nothing to add).
- **No migration in this slice.** Every table needed already exists.
- **All user-facing copy is English only.** No Taglish (see the Language entry in `design/branding.md`).
- **Read `design/branding.md` before any UI work.** Solid colors only — no gradients, no glows. Cards: white, `border-radius: 20px`, `--shadow-sm`. Buttons: `--btn-h` 48px, `--btn-radius` 12px, display font weight 700. Mono (`font-mono`) for times, prices, and uppercase kickers. **Never two lime (`--ball`) buttons in one view.** Content column 1120px max. Breakpoints 980px and 560px. Focus ring `--court` on light, `--ball` on dark.
- **Manila time.** All day boundaries via `src/lib/date-manila.ts`. "Today" means today in Manila (UTC+8, no DST), never the server's zone.
- **Tests run against the hosted Supabase project** via `DATABASE_URL` in `.env.local` — the Supavisor session pooler on port **5432**, never 6543. The database is **shared and persistent**: tests must pass on repeated runs, must create their own rows under their own ids, must clean up after themselves, and must never mutate seeded singleton rows (`smash-zone-marikina` and the nine demo branches).
- **Booking status semantics.** `confirmed` and `completed` are real bookings. `pending_payment` is an unpaid hold and must never render as a booking on either dashboard. `expired` and `refunded_manual` are excluded from all earnings math.
- **Commit after every task.** Branch `dashboards-and-account-menu` already exists and holds the spec commit.

---

### Task 1: Role guard and redirect-flavored page guards

**Files:**
- Modify: `src/lib/auth/guards.ts` (add `requireOwner` after `requireAdmin`, around line 65)
- Create: `src/lib/auth/page-guards.ts`
- Test: `tests/auth/guards.test.ts` (append)

**Interfaces:**
- Consumes: `requireUser()`, `AuthError`, `SessionUser`, `Role` from `src/lib/auth/guards.ts`.
- Produces:
  - `requireOwner(): Promise<SessionUser>` — resolves for `owner` and `admin`, throws `AuthError(403)` for `player`.
  - `requireUserPage(next: string): Promise<SessionUser>` — redirects to `/login?next=<next>` when signed out.
  - `requireOwnerPage(next: string): Promise<SessionUser>` — as above, plus redirects a `player` to `/bookings`.

**Why two files:** `page-guards.ts` is separate because it imports `next/navigation`. `tests/auth/guards.test.ts` imports `guards.ts` directly in a plain Node environment; pulling `redirect()` into that module graph would drag Next's runtime into the test for no benefit.

- [ ] **Step 1: Write the failing tests**

Append to `tests/auth/guards.test.ts`. Note `requireOwner` must be added to the destructured import on line 31 of that file — change it to:

```ts
const { requireUser, requireAdmin, requireOwner, requireOwnerOf, getOptionalUser, AuthError } =
  await import('@/lib/auth/guards')
```

Then append:

```ts
test('requireOwner resolves for an owner, resolves for an admin, and rejects a player', async () => {
  const owner = await seedUser('owner')
  claims.value = { sub: owner.id, email: owner.email }
  await expect(requireOwner()).resolves.toMatchObject({ id: owner.id, role: 'owner' })

  // An admin passes the role gate without owning anything. Admin oversight of
  // OTHER owners' data lives at /admin/*, not here: the owner queries all
  // filter on owner_id, so an admin at /dashboard sees only branches they
  // themselves own.
  const admin = await seedUser('admin')
  claims.value = { sub: admin.id, email: admin.email }
  await expect(requireOwner()).resolves.toMatchObject({ role: 'admin' })

  const player = await seedUser('player')
  claims.value = { sub: player.id, email: player.email }
  await expect(requireOwner()).rejects.toMatchObject({ status: 403 })
})

test('requireOwner throws 401, not 403, when there is no session at all', async () => {
  // Distinguishes "not signed in" from "signed in but wrong role" — the page
  // guards branch on exactly this to choose redirect-to-login vs redirect-to-/bookings.
  await expect(requireOwner()).rejects.toMatchObject({ status: 401 })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run tests/auth/guards.test.ts
```

Expected: FAIL — `requireOwner is not a function`.

- [ ] **Step 3: Add `requireOwner` to `src/lib/auth/guards.ts`**

Insert after `requireAdmin` (line 65):

```ts
/**
 * Role-level owner gate: "is this person an owner at all", as opposed to
 * requireOwnerOf(branchId)'s "does this person own THAT branch". The owner
 * dashboard needs this one — it has no single branch id to check against, and
 * its queries scope themselves by owner_id in SQL.
 *
 * Admins pass. They are not granted other owners' data by passing: every owner
 * query filters on owner_id, so an admin here sees only what they own. Viewing
 * across owners is /admin/*'s job.
 */
export async function requireOwner(): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role !== 'owner' && user.role !== 'admin') throw new AuthError(403, 'Owners only')
  return user
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run tests/auth/guards.test.ts
```

Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 5: Create `src/lib/auth/page-guards.ts`**

```ts
import 'server-only'
import { redirect } from 'next/navigation'
import { AuthError, requireOwner, requireUser, type SessionUser } from '@/lib/auth/guards'

/**
 * Page-flavored guards. The guards in ./guards.ts throw AuthError, which is
 * right for a Server Action returning a result to a form. A Server Component
 * has no such channel — an uncaught throw renders the error boundary, which is
 * a worse answer than "sign in first". These redirect instead.
 *
 * `next` is the path to come back to after sign-in. It is a literal path from
 * the calling page, never user input, but it still goes through the same
 * same-origin check the callback applies (see src/lib/auth/next-path.ts, added
 * in Task 3) so there is exactly one definition of an acceptable `next`.
 */
export async function requireUserPage(next: string): Promise<SessionUser> {
  try {
    return await requireUser()
  } catch (error) {
    if (error instanceof AuthError) redirect(`/login?next=${encodeURIComponent(next)}`)
    throw error
  }
}

/**
 * Owner pages. A signed-out visitor goes to login; a signed-in PLAYER goes to
 * /bookings rather than an error page — that is where their dashboard actually
 * is, and telling them "403" when a correct destination exists is unhelpful.
 */
export async function requireOwnerPage(next: string): Promise<SessionUser> {
  try {
    return await requireOwner()
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.status === 401) redirect(`/login?next=${encodeURIComponent(next)}`)
      redirect('/bookings')
    }
    throw error
  }
}
```

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth/guards.ts src/lib/auth/page-guards.ts tests/auth/guards.test.ts
git commit -m "Add requireOwner role guard and redirect-flavored page guards"
```

---

### Task 2: Same-origin `next` helper, shared by login and callback

**Files:**
- Create: `src/lib/auth/next-path.ts`
- Modify: `src/app/auth/callback/route.ts:10-18` (replace the inline check with the helper)
- Test: `tests/auth/next-path.test.ts`

**Interfaces:**
- Produces: `safeNextPath(raw: string | null | undefined): string` — returns a same-origin path, defaulting to `/`.

**Why:** `route.ts:18` already implements this rule inline. Task 3's login page needs the same rule. Two copies of a security check drift; one tested function does not.

- [ ] **Step 1: Write the failing test**

Create `tests/auth/next-path.test.ts`:

```ts
import { expect, test } from 'vitest'
import { safeNextPath } from '@/lib/auth/next-path'

test('passes through a same-origin path', () => {
  expect(safeNextPath('/bookings')).toBe('/bookings')
  expect(safeNextPath('/dashboard/earnings?month=2026-08')).toBe('/dashboard/earnings?month=2026-08')
})

test('falls back to / for absent or empty input', () => {
  expect(safeNextPath(null)).toBe('/')
  expect(safeNextPath(undefined)).toBe('/')
  expect(safeNextPath('')).toBe('/')
})

test('rejects an absolute URL to another origin', () => {
  // `${origin}${next}` would concatenate into
  // "http://localhost:3000https://evil.com" — not an open redirect, but
  // NextResponse.redirect's internal validateURL throws on it, turning a
  // crafted query param into a 500 on the login path.
  expect(safeNextPath('https://evil.com')).toBe('/')
  expect(safeNextPath('http://evil.com/x')).toBe('/')
})

test('rejects a protocol-relative URL, which a leading-slash check alone accepts', () => {
  // "//evil.com" starts with "/" and IS a real cross-origin destination —
  // browsers read it as protocol-relative. This is the case a naive
  // startsWith('/') test lets through.
  expect(safeNextPath('//evil.com')).toBe('/')
  expect(safeNextPath('/\\evil.com')).toBe('/')
})

test('rejects a scheme-relative or non-path value', () => {
  expect(safeNextPath('javascript:alert(1)')).toBe('/')
  expect(safeNextPath('bookings')).toBe('/')
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npx vitest run tests/auth/next-path.test.ts
```

Expected: FAIL — cannot resolve `@/lib/auth/next-path`.

- [ ] **Step 3: Create `src/lib/auth/next-path.ts`**

No `server-only` import: this is a pure function with no data access, and the login page's client half may import it.

```ts
/**
 * Normalizes a `?next=` value to a path that is definitely on this origin.
 *
 * Consolidated from src/app/auth/callback/route.ts, which carried this rule
 * inline. Two copies of a redirect check drift apart; this one is tested.
 *
 * A leading "/" alone is NOT sufficient: "//evil.com" and "/\evil.com" both
 * start with a slash and both resolve cross-origin in a browser
 * (protocol-relative). So the second character must not be another slash or a
 * backslash.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return '/'
  if (!raw.startsWith('/')) return '/'
  if (raw.length > 1 && (raw[1] === '/' || raw[1] === '\\')) return '/'
  return raw
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx vitest run tests/auth/next-path.test.ts
```

Expected: PASS (all five tests).

- [ ] **Step 5: Use it in the callback route**

In `src/app/auth/callback/route.ts`, add the import and replace lines 10-18 (the `rawNext`/`next` block and its comment) with:

```ts
  // Same-origin only. See src/lib/auth/next-path.ts for why a leading-slash
  // check alone is insufficient; that rule is shared with the login page and
  // tested in tests/auth/next-path.test.ts.
  const next = safeNextPath(searchParams.get('next'))
```

Import: `import { safeNextPath } from '@/lib/auth/next-path'`.

- [ ] **Step 6: Typecheck and run the auth tests**

```bash
npx tsc --noEmit && npx vitest run tests/auth/
```

Expected: no type errors; all auth tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth/next-path.ts tests/auth/next-path.test.ts src/app/auth/callback/route.ts
git commit -m "Extract and test the same-origin next-path rule"
```

---

### Task 3: Sign-out action and the account menu

**Files:**
- Create: `src/app/auth/sign-out/actions.ts`
- Create: `src/components/site/account-menu.tsx`
- Modify: `src/components/site/nav.tsx:59-87` (replace the avatar badge branch)
- Test: `tests/auth/action-coverage.test.ts` (existing — must keep passing, no edit)

**Interfaces:**
- Consumes: `SessionUser` from `src/lib/auth/guards.ts`; `getOptionalUser()` in `Nav` (already there).
- Produces:
  - `signOutAction(): Promise<never>` — clears the session and redirects to `/`.
  - `<AccountMenu user={{ email, avatarUrl, role, fullName }} onDark={boolean} />`.

**No component test:** the project has no DOM test environment — `vitest.config.ts` sets `environment: 'node'`, and neither `jsdom` nor `@testing-library/react` is a dependency. Do **not** add them for this task; that is a toolchain decision outside this slice. The menu's behavior is verified in the browser in Task 13. Write the keyboard and ARIA behavior correctly the first time.

- [ ] **Step 1: Create the sign-out action**

`src/app/auth/sign-out/actions.ts`:

```ts
'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { AuthError, requireUser } from '@/lib/auth/guards'

/**
 * Signs out server-side, so cookie clearing goes through the same
 * @supabase/ssr cookie adapter that set them (src/lib/supabase/server.ts).
 * A client-side signOut() would leave the server's copy of the session cookie
 * to be reconciled by the proxy on the next navigation.
 *
 * requireUser() first, for two reasons. It satisfies the contract
 * tests/auth/action-coverage.test.ts enforces — every 'use server' file calls a
 * guard — and it is genuinely correct: signing out is an authenticated action.
 * But an AuthError here must NOT abort: a user whose session already expired
 * still has a stale cookie in their browser, and refusing to clear it would
 * leave them stuck looking signed in while every request 401s. So that case
 * falls through to the same signOut() + redirect.
 */
export async function signOutAction(): Promise<never> {
  try {
    await requireUser()
  } catch (error) {
    if (!(error instanceof AuthError)) throw error
  }

  const supabase = await createServerSupabaseClient()
  await supabase.auth.signOut()

  // The nav renders from getOptionalUser(), so any cached render of a page
  // showing the signed-in nav is now wrong.
  revalidatePath('/', 'layout')
  redirect('/')
}
```

- [ ] **Step 2: Confirm the action-coverage test still passes**

```bash
npx vitest run tests/auth/action-coverage.test.ts
```

Expected: PASS. If it fails naming `src/app/auth/sign-out/actions.ts`, the `requireUser` import was dropped — it must appear literally in the file.

- [ ] **Step 3: Create the account menu**

`src/components/site/account-menu.tsx`:

```tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { signOutAction } from '@/app/auth/sign-out/actions'

export type AccountMenuUser = {
  email: string
  fullName: string | null
  avatarUrl: string | null
  role: 'player' | 'owner' | 'admin'
}

/**
 * The nav's signed-in control. Replaces a bare avatar badge that was not a
 * link and had no menu, which left a signed-in user with no route to their
 * dashboard and no way to sign out at all.
 *
 * Client component because it owns disclosure state. Deliberately NOT using
 * roving arrow-key focus or role="menu"/role="menuitem": this is a short list
 * of links and one submit button, native Tab order already works, and
 * role="menu" would promise arrow-key semantics that then have to be built and
 * maintained. It is a disclosure (aria-expanded) over ordinary links.
 *
 * There is no Admin item. /admin/* does not exist yet in this slice, and an
 * item pointing at a 404 is worse than no item.
 */
export function AccountMenu({ user, onDark }: { user: AccountMenuUser; onDark: boolean }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Escape closes and returns focus to the trigger; a click outside closes.
  // Both listeners are only attached while open, so a closed menu costs nothing.
  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }

    function onPointerDown(event: PointerEvent) {
      if (containerRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  const isOwner = user.role === 'owner' || user.role === 'admin'
  const label = user.fullName ?? user.email
  const initial = (user.fullName ?? user.email).charAt(0).toUpperCase()

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="account-menu-panel"
        aria-label={`Account menu for ${label}`}
        className={`flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border outline-none transition-[filter] duration-150 hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
          onDark
            ? 'border-white/[.28] focus-visible:outline-[var(--ball)]'
            : 'border-[var(--hairline)] focus-visible:outline-[var(--court)]'
        }`}
      >
        {/* A null avatarUrl falls back to an initial badge rather than
            <img src="">, which the browser would request as the current page
            URL. Same reasoning as the badge this menu replaces. */}
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span
            aria-hidden
            className="flex h-full w-full items-center justify-center bg-[var(--court)] text-xs font-semibold text-white"
          >
            {initial}
          </span>
        )}
      </button>

      {open && (
        <div
          id="account-menu-panel"
          className="absolute right-0 top-[calc(100%+10px)] z-30 w-[232px] rounded-[20px] border border-[var(--hairline)] bg-[var(--panel)] p-2 shadow-[var(--shadow-lg)]"
        >
          <div className="border-b border-[var(--hairline)] px-3 pb-3 pt-2">
            <div className="truncate text-sm font-semibold text-[var(--ink)]">{label}</div>
            <div className="truncate text-[12.5px] text-[var(--ink-soft)]">{user.email}</div>
          </div>

          <Link
            href="/bookings"
            onClick={() => setOpen(false)}
            className="mt-2 block rounded-[10px] px-3 py-2.5 text-[13.5px] font-medium text-[var(--ink)] hover:bg-[var(--surface)]"
          >
            My bookings
          </Link>

          {isOwner && (
            <Link
              href="/dashboard"
              onClick={() => setOpen(false)}
              className="block rounded-[10px] px-3 py-2.5 text-[13.5px] font-medium text-[var(--ink)] hover:bg-[var(--surface)]"
            >
              Owner dashboard
            </Link>
          )}

          {/* A form POST, not an onClick fetch: sign-out is a state change and
              must not be reachable by a GET that a prefetch could fire. */}
          <form action={signOutAction} className="mt-1 border-t border-[var(--hairline)] pt-1">
            <button
              type="submit"
              className="block w-full rounded-[10px] px-3 py-2.5 text-left text-[13.5px] font-medium text-[var(--ink)] hover:bg-[var(--surface)]"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Wire it into the nav**

In `src/components/site/nav.tsx`, replace the entire `{user ? ( … ) : ( … )}` block (lines 59-87) with:

```tsx
          {user ? (
            <AccountMenu
              user={{
                email: user.email,
                fullName: user.fullName ?? null,
                avatarUrl: user.avatarUrl,
                role: user.role,
              }}
              onDark={onDark}
            />
          ) : (
            <Link
              href="/login"
              className={`text-sm font-semibold ${onDark ? 'text-white' : 'text-[var(--ink)]'}`}
            >
              Sign in
            </Link>
          )}
```

Add `import { AccountMenu } from '@/components/site/account-menu'` at the top. Also update the file's docstring: the "NOTE: the signed-in branch is UNVERIFIED / Google OAuth is not yet configured" paragraph (lines 17-19) is **stale** — OAuth is configured (verified 2026-08-02). Replace that paragraph with a line saying the signed-in branch renders the `AccountMenu`.

- [ ] **Step 5: `SessionUser` has no `fullName` — add it**

`loadSessionUser()` in `src/lib/auth/guards.ts` selects `id, email, role, avatar_url`. The menu needs the display name. Extend the type and the query:

- `SessionUser` (line 7): add `fullName: string | null`.
- The `select` (line 33): `select id, email, role, avatar_url, full_name from profiles where id = ${userId}::uuid`.
- The return mapping (lines 38-43): add `fullName: (profile.full_name as string | null) ?? null,`.

- [ ] **Step 6: Typecheck, lint, and run the full suite**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: no type errors; lint reports only the pre-existing `<img>` and unused-`table` warnings; all tests pass. The `guards.test.ts` assertions use `toMatchObject`, so the added `fullName` field does not break them.

- [ ] **Step 7: Commit**

```bash
git add src/app/auth/sign-out/actions.ts src/components/site/account-menu.tsx src/components/site/nav.tsx src/lib/auth/guards.ts
git commit -m "Add account menu with sign-out to the nav"
```

---

### Task 4: Thread `?next=` through login

**Files:**
- Create: `src/app/login/sign-in-button.tsx`
- Modify: `src/app/login/page.tsx` (convert to a Server Component)

**Interfaces:**
- Consumes: `safeNextPath` (Task 2).
- Produces: `<SignInButton next={string} />` — the client half, owning `pending`/`error` state and the `signInWithOAuth` call.

**Why split:** the page is currently `'use client'` end to end. Reading `searchParams` there needs `useSearchParams()` plus a Suspense boundary; as a Server Component it is a prop. It also stops shipping the photo panel, headings, and copy as client JS.

- [ ] **Step 1: Create the client button**

`src/app/login/sign-in-button.tsx` — move the `GoogleMark`, the `signIn` handler, and the button/error markup out of the current page verbatim, adding the `next` prop:

```tsx
'use client'

import { useState } from 'react'
import { createBrowserSupabaseClient } from '@/lib/supabase/client'

/**
 * Google's four-color "G", the official mark from Google's Identity sign-in
 * button assets (viewBox 0 0 48 48, one path per brand color). Inlined rather
 * than hotlinked so the button never renders a blank icon while an external
 * request is in flight, and so it inherits nothing from the button's `color`.
 *
 * aria-hidden: the button's own text already says "Continue with Google".
 */
function GoogleMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden focusable="false" className={className}>
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  )
}

/**
 * `next` arrives already normalized by safeNextPath() on the server. It is
 * appended to the callback URL, and the callback normalizes it again — the
 * value makes a round trip through Google in between, so re-checking on
 * arrival is not redundant.
 */
export function SignInButton({ next }: { next: string }) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function signIn() {
    setError(null)
    setPending(true)
    const supabase = createBrowserSupabaseClient()
    const callback = new URL('/auth/callback', window.location.origin)
    if (next !== '/') callback.searchParams.set('next', next)

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: callback.toString() },
    })
    // On success the browser navigates away, so only the failure path releases
    // the button.
    if (error) {
      setError(error.message)
      setPending(false)
    }
  }

  return (
    <>
      {/* branding.md, Controls: "On light panels a dark button (--ink bg,
          --ball text) is the alternative primary." Chosen over the lime
          primary because of the icon: Google's mark keeps its own four colors,
          and its yellow (#FBBC05) has almost no contrast on lime (--ball,
          #E8FF54), while all four read cleanly on --ink. */}
      <button
        onClick={signIn}
        disabled={pending}
        className="font-display mt-8 inline-flex h-[var(--btn-h)] w-full items-center justify-center gap-3 rounded-[var(--btn-radius)] bg-[var(--ink)] px-4 text-[15.5px] font-bold tracking-[-0.01em] text-[var(--ball)] outline-none transition-[filter,transform] duration-150 hover:brightness-[1.25] active:scale-[.98] disabled:pointer-events-none disabled:opacity-60 motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--court)] focus-visible:outline-offset-[3px]"
      >
        <GoogleMark className="h-[18px] w-[18px] shrink-0" />
        {pending ? 'Opening Google…' : 'Continue with Google'}
      </button>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-4 py-3 text-sm font-medium text-[var(--ink)]"
        >
          {error}
        </p>
      )}
    </>
  )
}
```

- [ ] **Step 2: Convert the page to a Server Component**

In `src/app/login/page.tsx`: delete the `'use client'` directive, the `useState` import, the `createBrowserSupabaseClient` import, the `GoogleMark` function, the `signIn` function, and the button/error JSX. Keep the entire split layout markup (photo panel, wordmark links, kicker, headline, copy) exactly as it is. Add:

```tsx
import { safeNextPath } from '@/lib/auth/next-path'
import { SignInButton } from './sign-in-button'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  const nextPath = safeNextPath(next)
  // …existing markup…
}
```

Render `<SignInButton next={nextPath} />` where the button and error block used to be. Also add to the file docstring: the error panel is understated because `design/branding.md` defines no danger token; introducing one is a branding change, which per `CLAUDE.md` requires editing that doc in the same turn.

- [ ] **Step 3: Typecheck and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors. `searchParams` is a Promise in Next 16 — it must be awaited.

- [ ] **Step 4: Verify in the browser, signed out**

Start the dev server with `preview_start` (config `oncourt-dev`, already in `.claude/launch.json`), then check:
- `/login` renders unchanged from before this task (split layout, Google button).
- `/login?next=/bookings` renders identically — `next` is invisible until sign-in.
- No console errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/login/page.tsx src/app/login/sign-in-button.tsx
git commit -m "Split login into server page and client button, thread ?next="
```

---

### Task 5: Player dashboard queries

**Files:**
- Create: `src/lib/bookings/queries.ts`
- Modify: `tests/helpers/fixtures.ts` (add and export `seedBooking`)
- Test: `tests/bookings/queries.test.ts`

**Interfaces:**
- Consumes: `db` from `@/db`; `sql` from `drizzle-orm`.
- Produces:

```ts
export type PlayerBookingStatus = 'confirmed' | 'completed'
export type PlayerBooking = {
  id: string
  courtName: string
  environment: 'indoor' | 'outdoor'
  branchName: string
  branchSlug: string
  branchAddress: string
  branchCity: string
  coverPhotoPath: string | null
  date: string        // YYYY-MM-DD, Manila
  startHour: number
  endHour: number
  status: PlayerBookingStatus
  totalChargedCentavos: number
  hasReview: boolean
}
export type PlayerReview = {
  id: string
  branchName: string
  branchSlug: string
  courtName: string
  rating: number
  body: string | null
  createdAt: string   // ISO
}
export type PlayerStats = {
  upcomingCount: number
  hoursPlayedThisMonth: number
  courtsVisited: number
  totalSpentCentavos: number
}
export type PlayerDashboard = {
  stats: PlayerStats
  upcoming: PlayerBooking[]
  past: PlayerBooking[]
  reviews: PlayerReview[]
}
export type BookingReceipt = {
  id: string
  courtName: string
  environment: 'indoor' | 'outdoor'
  branchName: string
  branchSlug: string
  branchAddress: string
  branchCity: string
  date: string
  startHour: number
  endHour: number
  status: string
  courtFeeCentavos: number
  transactionFeeCentavos: number
  totalChargedCentavos: number
  createdAt: string
}

export async function getPlayerDashboard(playerId: string): Promise<PlayerDashboard>
export async function getBookingReceipt(bookingId: string, playerId: string): Promise<BookingReceipt | null>
```

- [ ] **Step 1a: Add the shared booking fixture**

Both this task's tests and Task 9's need to insert bookings. Add it once, to
`tests/helpers/fixtures.ts`, next to `seedPlayer`/`seedBranchWithCourts`:

```ts
/**
 * Inserts a booking directly, bypassing the hold/pricing path — these tests
 * are about reads, not about how a booking comes to exist.
 *
 * No teardown tracking of its own: the caller's court/branch/player all come
 * from seedPlayer()/seedBranchWithCourts(), and teardownFixtures() already
 * deletes bookings by tracked player_id and by branches under tracked owners
 * before deleting the users themselves (bookings' FKs are RESTRICT, so that
 * ordering is required).
 *
 * Callers must choose non-overlapping hours per court: bookings_no_overlap is
 * an exclusion constraint, and two bookings on one court at one hour raise
 * 23P01.
 */
export async function seedBooking(opts: {
  courtId: string
  branchId: string
  playerId: string
  startsAt: Date
  hours?: number
  status?: 'pending_payment' | 'confirmed' | 'completed'
  totalCentavos?: number
}): Promise<string> {
  const hours = opts.hours ?? 1
  const endsAt = new Date(opts.startsAt.getTime() + hours * 3_600_000)
  const status = opts.status ?? 'completed'
  const total = opts.totalCentavos ?? 30000
  const platformFee = Math.round(total * 0.1)
  // pending_payment is the only status the CHECK constraint
  // (bookings_hold_has_expiry) requires an expires_at for.
  const expiresAt = status === 'pending_payment' ? new Date(Date.now() + 900_000) : null

  const result = await db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status, expires_at,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos,
      fee_config_snapshot
    ) values (
      ${opts.courtId}::uuid, ${opts.branchId}::uuid, ${opts.playerId}::uuid,
      ${opts.startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz,
      ${status}::booking_status, ${expiresAt ? expiresAt.toISOString() : null}::timestamptz,
      ${total}, 0, ${total}, ${platformFee}, 0, ${total - platformFee},
      '{"test": true}'::jsonb
    )
    returning id
  `)
  return result.rows[0].id as string
}
```

- [ ] **Step 1b: Write the failing tests**

Create `tests/bookings/queries.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBooking, seedBranchWithCourts, seedPlayer, teardownFixtures } from '../helpers/fixtures'
import { getBookingReceipt, getPlayerDashboard } from '@/lib/bookings/queries'

afterAll(teardownFixtures)

// A fixed past date well clear of the seeded demo bookings (2026-06-01..03)
// and of "now", so upcoming/past classification is unambiguous.
function pastAt(dayOffset: number, hour: number) {
  const d = new Date(Date.UTC(2026, 4, 10 + dayOffset, hour - 8, 0, 0)) // Manila hour
  return d
}
function futureAt(dayOffset: number, hour: number) {
  const base = new Date(Date.now() + dayOffset * 86_400_000)
  const iso = base.toISOString().slice(0, 10)
  return new Date(`${iso}T${String(hour).padStart(2, '0')}:00:00+08:00`)
}

test('returns only the calling player\'s bookings', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const mine = await seedPlayer()
  const theirs = await seedPlayer()

  await seedBooking({ courtId: courtIds[0], branchId, playerId: mine, startsAt: pastAt(0, 12) })
  await seedBooking({ courtId: courtIds[0], branchId, playerId: theirs, startsAt: pastAt(1, 12) })

  const dashboard = await getPlayerDashboard(mine)
  expect(dashboard.past).toHaveLength(1)
  expect(dashboard.stats.courtsVisited).toBe(1)
})

test('excludes pending_payment holds from every list and every stat', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const player = await seedPlayer()

  await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: futureAt(3, 13),
    status: 'pending_payment',
  })

  const dashboard = await getPlayerDashboard(player)
  expect(dashboard.upcoming).toEqual([])
  expect(dashboard.past).toEqual([])
  expect(dashboard.stats.upcomingCount).toBe(0)
  expect(dashboard.stats.totalSpentCentavos).toBe(0)
})

test('splits upcoming from past by end time, and counts hours and spend', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(2)
  const player = await seedPlayer()

  await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: futureAt(2, 19),
    hours: 2,
    status: 'confirmed',
    totalCentavos: 62290,
  })
  await seedBooking({
    courtId: courtIds[1],
    branchId,
    playerId: player,
    startsAt: pastAt(0, 15),
    hours: 1,
    status: 'completed',
    totalCentavos: 28000,
  })

  const dashboard = await getPlayerDashboard(player)
  expect(dashboard.upcoming).toHaveLength(1)
  expect(dashboard.upcoming[0].startHour).toBe(19)
  expect(dashboard.upcoming[0].endHour).toBe(21)
  expect(dashboard.past).toHaveLength(1)
  expect(dashboard.stats.upcomingCount).toBe(1)
  expect(dashboard.stats.courtsVisited).toBe(2)
  expect(dashboard.stats.totalSpentCentavos).toBe(62290 + 28000)
  // Every numeric field must be a number, not a string: the pg driver returns
  // numeric/bigint as strings, and a string here would break arithmetic and
  // formatPeso() silently.
  expect(typeof dashboard.stats.totalSpentCentavos).toBe('number')
  expect(typeof dashboard.stats.hoursPlayedThisMonth).toBe('number')
})

test('flags a past booking that already has a review, and lists the review', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: pastAt(2, 9),
  })

  await db.execute(sql`
    insert into reviews (booking_id, branch_id, player_id, rating, body)
    values (${bookingId}::uuid, ${branchId}::uuid, ${player}::uuid, 5, 'Great court.')
  `)

  const dashboard = await getPlayerDashboard(player)
  expect(dashboard.past[0].hasReview).toBe(true)
  expect(dashboard.reviews).toHaveLength(1)
  expect(dashboard.reviews[0].rating).toBe(5)
})

test('getBookingReceipt returns the fee breakdown for the owning player', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: player,
    startsAt: pastAt(3, 16),
    totalCentavos: 45000,
  })

  const receipt = await getBookingReceipt(bookingId, player)
  expect(receipt).toMatchObject({ id: bookingId, totalChargedCentavos: 45000 })
})

test('getBookingReceipt returns null for another player\'s booking', async () => {
  // Scoped in the SQL where clause, not checked after the fetch: a stranger
  // must not be able to distinguish "not yours" from "does not exist".
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const owner = await seedPlayer()
  const stranger = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0],
    branchId,
    playerId: owner,
    startsAt: pastAt(4, 16),
  })

  await expect(getBookingReceipt(bookingId, stranger)).resolves.toBeNull()
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run tests/bookings/queries.test.ts
```

Expected: FAIL — cannot resolve `@/lib/bookings/queries`.

- [ ] **Step 3: Implement the query module**

`src/lib/bookings/queries.ts`. Note the shared column list and the Manila extraction, which is how `date`/`startHour`/`endHour` are derived without a second round trip:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

export type PlayerBookingStatus = 'confirmed' | 'completed'

export type PlayerBooking = {
  id: string
  courtName: string
  environment: 'indoor' | 'outdoor'
  branchName: string
  branchSlug: string
  branchAddress: string
  branchCity: string
  coverPhotoPath: string | null
  date: string
  startHour: number
  endHour: number
  status: PlayerBookingStatus
  totalChargedCentavos: number
  hasReview: boolean
}

export type PlayerReview = {
  id: string
  branchName: string
  branchSlug: string
  courtName: string
  rating: number
  body: string | null
  createdAt: string
}

export type PlayerStats = {
  upcomingCount: number
  hoursPlayedThisMonth: number
  courtsVisited: number
  totalSpentCentavos: number
}

export type PlayerDashboard = {
  stats: PlayerStats
  upcoming: PlayerBooking[]
  past: PlayerBooking[]
  reviews: PlayerReview[]
}

export type BookingReceipt = {
  id: string
  courtName: string
  environment: 'indoor' | 'outdoor'
  branchName: string
  branchSlug: string
  branchAddress: string
  branchCity: string
  date: string
  startHour: number
  endHour: number
  status: string
  courtFeeCentavos: number
  transactionFeeCentavos: number
  totalChargedCentavos: number
  createdAt: string
}

/**
 * `confirmed` and `completed` only. A `pending_payment` row is an unpaid hold,
 * not a booking — showing one as "your booking" would tell a player they have
 * court time they have not paid for. `expired` and `refunded_manual` are not
 * bookings either.
 */
const REAL_BOOKING = sql`bk.status in ('confirmed', 'completed')`

/**
 * Manila-local calendar date and clock hours, extracted in SQL rather than
 * from a JS Date. `starts_at` is a timestamptz; reading its hour in the
 * server's zone would be wrong anywhere but UTC+8, and this app is
 * Philippines-only by design (see src/lib/date-manila.ts).
 */
const MANILA_PARTS = sql`
  to_char(bk.starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD') as date,
  extract(hour from (bk.starts_at at time zone 'Asia/Manila'))::int as start_hour,
  extract(hour from (bk.ends_at   at time zone 'Asia/Manila'))::int as end_hour
`

function toBooking(row: Record<string, unknown>): PlayerBooking {
  return {
    id: row.id as string,
    courtName: row.court_name as string,
    environment: row.environment as 'indoor' | 'outdoor',
    branchName: row.branch_name as string,
    branchSlug: row.branch_slug as string,
    branchAddress: row.branch_address as string,
    branchCity: row.branch_city as string,
    coverPhotoPath: (row.cover_photo_path as string | null) ?? null,
    date: row.date as string,
    startHour: Number(row.start_hour),
    endHour: Number(row.end_hour),
    status: row.status as PlayerBookingStatus,
    totalChargedCentavos: Number(row.total_charged_centavos),
    hasReview: row.has_review === true,
  }
}

/**
 * Everything /bookings renders, in four round trips: upcoming, past, reviews,
 * stats. Kept as separate statements rather than one CTE-heavy query because
 * each drives an independently rendered panel and the row shapes differ; a
 * single query would need to union incompatible shapes or return a wide
 * sparse row.
 *
 * "Upcoming" vs "past" splits on ends_at, not starts_at: a booking that
 * started an hour ago and runs for another hour is still court time you have
 * not used yet.
 */
export async function getPlayerDashboard(playerId: string): Promise<PlayerDashboard> {
  const columns = sql`
    bk.id, bk.status, bk.total_charged_centavos,
    c.name as court_name, c.environment,
    b.name as branch_name, b.slug as branch_slug,
    b.address as branch_address, b.city as branch_city,
    ph.storage_path as cover_photo_path,
    exists (select 1 from reviews rv where rv.booking_id = bk.id) as has_review,
    ${MANILA_PARTS}
  `

  const joins = sql`
    from bookings bk
    join courts c   on c.id = bk.court_id
    join branches b on b.id = bk.branch_id
    left join lateral (
      select bp.storage_path from branch_photos bp
      where bp.branch_id = b.id order by bp.sort_order, bp.id limit 1
    ) ph on true
    where bk.player_id = ${playerId}::uuid and ${REAL_BOOKING}
  `

  const upcoming = await db.execute(sql`
    select ${columns} ${joins} and bk.ends_at > now() order by bk.starts_at asc
  `)

  const past = await db.execute(sql`
    select ${columns} ${joins} and bk.ends_at <= now() order by bk.starts_at desc limit 50
  `)

  const reviews = await db.execute(sql`
    select rv.id, rv.rating, rv.body, rv.created_at,
           b.name as branch_name, b.slug as branch_slug, c.name as court_name
    from reviews rv
    join bookings bk on bk.id = rv.booking_id
    join courts c    on c.id = bk.court_id
    join branches b  on b.id = rv.branch_id
    where rv.player_id = ${playerId}::uuid
    order by rv.created_at desc, rv.id
  `)

  // hoursPlayedThisMonth counts only time already played (ends_at <= now())
  // inside the current Manila month, so a booking later this month does not
  // inflate it. courtsVisited counts distinct courts across all real
  // bookings. totalSpentCentavos sums every real booking, upcoming included —
  // that money is already charged.
  const stats = await db.execute(sql`
    select
      count(*) filter (where bk.ends_at > now())::int as upcoming_count,
      coalesce(sum(
        extract(epoch from (bk.ends_at - bk.starts_at)) / 3600
      ) filter (
        where bk.ends_at <= now()
          and date_trunc('month', bk.starts_at at time zone 'Asia/Manila')
            = date_trunc('month', now() at time zone 'Asia/Manila')
      ), 0)::float8 as hours_played_this_month,
      count(distinct bk.court_id)::int as courts_visited,
      coalesce(sum(bk.total_charged_centavos), 0)::bigint as total_spent_centavos
    from bookings bk
    where bk.player_id = ${playerId}::uuid and ${REAL_BOOKING}
  `)

  const row = stats.rows[0]

  return {
    stats: {
      upcomingCount: Number(row.upcoming_count),
      // Rounded for display: a 90-minute booking is 1.5 hours, and the stat
      // card shows a whole number.
      hoursPlayedThisMonth: Math.round(Number(row.hours_played_this_month)),
      courtsVisited: Number(row.courts_visited),
      totalSpentCentavos: Number(row.total_spent_centavos),
    },
    upcoming: upcoming.rows.map(toBooking),
    past: past.rows.map(toBooking),
    reviews: reviews.rows.map((rv) => ({
      id: rv.id as string,
      branchName: rv.branch_name as string,
      branchSlug: rv.branch_slug as string,
      courtName: rv.court_name as string,
      rating: Number(rv.rating),
      body: (rv.body as string | null) ?? null,
      createdAt: new Date(rv.created_at as string).toISOString(),
    })),
  }
}

/**
 * One booking's receipt, scoped to its player IN THE WHERE CLAUSE. Fetching by
 * id and comparing player_id afterward would leak existence: a stranger could
 * tell a real booking id (403) from a fake one (404). Here both are null.
 *
 * Not restricted to REAL_BOOKING: a receipt for an expired hold or a manually
 * refunded booking is a legitimate thing to look at.
 */
export async function getBookingReceipt(
  bookingId: string,
  playerId: string,
): Promise<BookingReceipt | null> {
  const result = await db.execute(sql`
    select bk.id, bk.status, bk.created_at,
           bk.court_fee_centavos, bk.transaction_fee_centavos, bk.total_charged_centavos,
           c.name as court_name, c.environment,
           b.name as branch_name, b.slug as branch_slug,
           b.address as branch_address, b.city as branch_city,
           ${MANILA_PARTS}
    from bookings bk
    join courts c   on c.id = bk.court_id
    join branches b on b.id = bk.branch_id
    where bk.id = ${bookingId}::uuid and bk.player_id = ${playerId}::uuid
  `)

  const row = result.rows[0]
  if (!row) return null

  return {
    id: row.id as string,
    courtName: row.court_name as string,
    environment: row.environment as 'indoor' | 'outdoor',
    branchName: row.branch_name as string,
    branchSlug: row.branch_slug as string,
    branchAddress: row.branch_address as string,
    branchCity: row.branch_city as string,
    date: row.date as string,
    startHour: Number(row.start_hour),
    endHour: Number(row.end_hour),
    status: row.status as string,
    courtFeeCentavos: Number(row.court_fee_centavos),
    transactionFeeCentavos: Number(row.transaction_fee_centavos),
    totalChargedCentavos: Number(row.total_charged_centavos),
    createdAt: new Date(row.created_at as string).toISOString(),
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run tests/bookings/queries.test.ts
```

Expected: PASS (six tests). If `getBookingReceipt` is handed a non-UUID string, Postgres raises `22P02` — the page callers validate shape before calling (Task 7), so the module itself does not.

- [ ] **Step 5: Run the tests a second time**

```bash
npx vitest run tests/bookings/queries.test.ts
```

Expected: PASS again. The shared database keeps rows between runs, so a test that only passes once is a broken test.

- [ ] **Step 6: Commit**

```bash
git add src/lib/bookings/queries.ts tests/bookings/queries.test.ts
git commit -m "Add player dashboard queries"
```

---

### Task 6: `/bookings` page

**Files:**
- Create: `src/app/bookings/page.tsx`
- Create: `src/components/dashboard/stat-card.tsx`
- Test: browser verification (Task 13); no DOM test environment exists

**Interfaces:**
- Consumes: `getPlayerDashboard` (Task 5), `requireUserPage` (Task 1), `Nav`/`Footer`, `formatPeso`/`formatHourRange`/`formatDateLabel` (`src/lib/format.ts`), `photoUrl` (`src/lib/photos.ts`).
- Produces: `<StatCard kicker={string} value={string} />` — reused by the owner dashboard in Task 10.

- [ ] **Step 1: Read the mockup**

Open `design/mockups/player-dashboard.html` and read the markup from line 284 to the end, plus the CSS above it for `.stat-card`, `.tabs`, `.booking-card`, `.past-row`, `.review-card`, and `.rail-card`. Match its structure and spacing. Where it disagrees with `design/branding.md`, branding.md wins — and note the mockup's review body text is Taglish, which the English-only rule forbids; write English copy.

- [ ] **Step 2: Create the shared stat card**

`src/components/dashboard/stat-card.tsx`:

```tsx
/**
 * The stat tile both dashboards use. Kicker is mono/uppercase per
 * branding.md's "mono for data and eyebrows" rule; the value is display font.
 * Card chrome matches branding.md's Cards entry (white, 20px radius,
 * --shadow-sm, no border).
 */
export function StatCard({ kicker, value }: { kicker: string; value: string }) {
  return (
    <div className="rounded-[20px] bg-[var(--panel)] p-5 shadow-[var(--shadow-sm)]">
      <span className="font-mono block text-[10.5px] tracking-[.14em] text-[var(--ink-soft)] uppercase">
        {kicker}
      </span>
      <div className="font-display mt-2 text-[28px] leading-none font-bold tracking-[-0.02em] text-[var(--ink)]">
        {value}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Create the page**

`src/app/bookings/page.tsx`. Structure: `Nav variant="solid"`, a `main` using the full-bleed padding formula (**not** `mx-auto max-w-[1120px]` — `body` is `flex flex-col` and an auto cross-axis margin on a flex item disables `align-self: stretch`, which made a page overflow horizontally at 375px; see the comment at `src/app/page.tsx:158`), page header, stat row, tabs, panel, `Footer`.

```tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { StatCard } from '@/components/dashboard/stat-card'
import { requireUserPage } from '@/lib/auth/page-guards'
import { getPlayerDashboard } from '@/lib/bookings/queries'
import { formatDateLabel, formatHourRange, formatPeso } from '@/lib/format'
import { photoUrl } from '@/lib/photos'

const TABS = ['upcoming', 'past', 'reviews'] as const
type Tab = (typeof TABS)[number]

/**
 * Tabs are URL state (?tab=), not client state. Each tab is a fresh server
 * render, so data cannot go stale inside a hidden panel, the view is
 * linkable, and it survives a reload. It also keeps this page entirely off
 * the client bundle.
 */
export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const user = await requireUserPage('/bookings')
  const { tab: rawTab } = await searchParams
  const tab: Tab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : 'upcoming'

  const { stats, upcoming, past, reviews } = await getPlayerDashboard(user.id)

  return (
    <>
      <Nav variant="solid" />
      <main className="px-[max(24px,calc((100vw-1120px)/2))] pb-[72px]">
        {/* header, stats, tabs, panels — see steps below */}
      </main>
      <Footer />
    </>
  )
}
```

Fill in, inside `main`:

**Header** — mono kicker `Player · {user.email}`, `h1` "My bookings" at 38px display, a muted subhead.

**Stat row** — `grid grid-cols-4 gap-4 max-[980px]:grid-cols-2` with four `StatCard`s: `Upcoming` / `String(stats.upcomingCount)`, `Hours played this month` / `String(stats.hoursPlayedThisMonth)`, `Courts visited` / `String(stats.courtsVisited)`, `Total spent` / `formatPeso(stats.totalSpentCentavos)`.

**Tabs** — three `Link`s to `?tab=…`, each with `aria-current={tab === t ? 'page' : undefined}`. Active tab: `--ink` text with a 2px `--ink` bottom border; inactive: `--ink-soft`, no border. Counts in the labels: `Upcoming ({upcoming.length})`, `Past ({past.length})`, `My reviews ({reviews.length})`. Use `Link`, not buttons — these are navigations.

**Upcoming panel** (`tab === 'upcoming'`) — one card per booking:

```tsx
<article
  key={booking.id}
  className="flex gap-5 rounded-[20px] bg-[var(--panel)] p-4 shadow-[var(--shadow-sm)] max-[560px]:flex-col"
>
  {photoUrl('branch-photos', booking.coverPhotoPath) && (
    <img
      src={photoUrl('branch-photos', booking.coverPhotoPath)!}
      alt=""
      className="h-[104px] w-[132px] shrink-0 rounded-[14px] object-cover max-[560px]:w-full"
    />
  )}
  <div className="min-w-0 flex-1">
    <div className="font-display text-[17px] font-bold tracking-[-0.015em] text-[var(--ink)]">
      {booking.branchName} — {booking.courtName} ({booking.environment})
    </div>
    <div className="font-mono mt-1.5 text-[12.5px] text-[var(--ink-soft)]">
      {formatDateLabel(booking.date)} · {formatHourRange(booking.startHour, booking.endHour)}
    </div>
    <div className="mt-1 text-[13.5px] text-[var(--ink-soft)]">
      {booking.branchAddress}, {booking.branchCity}
    </div>
  </div>
  <div className="flex flex-col items-end gap-2">
    <span className="font-mono text-[15px] font-semibold text-[var(--ink)]">
      {formatPeso(booking.totalChargedCentavos)}
    </span>
    <span className="rounded-full bg-[var(--band-off)] px-2.5 py-1 text-[11px] font-semibold text-[var(--court-deep)]">
      {booking.status === 'confirmed' ? 'Confirmed' : 'Completed'}
    </span>
    <Link
      href={`/bookings/${booking.id}`}
      className="inline-flex h-[var(--btn-h-sm)] items-center rounded-[var(--btn-radius)] border border-[var(--hairline)] px-3.5 text-[13px] font-semibold text-[var(--ink)] hover:border-[var(--court)]"
    >
      View receipt
    </Link>
  </div>
</article>
```

Below the list, the no-cancellations note from the spec: "Bookings are final — no cancellations. Contact the venue if something comes up."

**Past panel** — a table, not cards: date, venue + court, duration, amount, and an action cell holding either a `View receipt` link or, when `hasReview` is false, the review form from Task 7. Wrap it in `<div className="overflow-x-auto">` so it scrolls inside its own container on mobile per branding.md.

**Reviews panel** — one card per review: branch + court, date, rating (lime 7px dot with `--ink` outline plus the bold number, per branding.md's Rating entry), body text.

**Empty states** — every panel needs one, in a dashed-border panel matching `src/app/page.tsx:211`: "No upcoming bookings — find a court and book your next game." with a link to `/search`; "No past bookings yet."; "No reviews yet — you can review a court after you've played."

The `notFound` import above is unused on this page; drop it (it belongs to Task 8).

- [ ] **Step 4: Typecheck and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors; only the pre-existing warnings plus a new `<img>` warning for the booking photo, which matches how every other page in this app renders photos.

- [ ] **Step 5: Verify the signed-out redirect in the browser**

With the dev server running, navigate to `/bookings` while signed out. Expected: redirected to `/login?next=%2Fbookings`.

- [ ] **Step 6: Commit**

```bash
git add src/app/bookings/page.tsx src/components/dashboard/stat-card.tsx
git commit -m "Add player dashboard at /bookings"
```

---

### Task 7: Review creation

**Files:**
- Create: `src/app/bookings/actions.ts`
- Create: `src/app/bookings/review-form.tsx`
- Modify: `src/app/bookings/page.tsx` (render `<ReviewForm>` in the past panel's action cell)
- Test: `tests/bookings/review-action.test.ts`

**Interfaces:**
- Consumes: `requireUser`, `AuthError`, `db`, `revalidatePath`.
- Produces:
  - `type ReviewFormState = { ok: true } | { error: string } | null`
  - `createReviewAction(prevState: ReviewFormState, formData: FormData): Promise<ReviewFormState>` — the `useActionState` signature, so the form can render the error it returns.
  - `parseReviewInput(formData: FormData): ReviewInput | null` (exported, pure, tested)
  - `insertReviewIfEligible(input: ReviewInput & { playerId: string }): Promise<InsertResult>` (exported, tested)
  - `<ReviewForm bookingId={string} />`

**Why a pure parse helper:** the action itself calls `requireUser()`, which needs a session, so it is not directly unit-testable in a Node test. The eligibility SQL and the parse rules are the parts that can be wrong, so they are extracted and tested — `insertReviewIfEligible` for the SQL, `parseReviewInput` for the input rules.

- [ ] **Step 1: Write the failing tests**

Create `tests/bookings/review-action.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBranchWithCourts, seedPlayer, teardownFixtures } from '../helpers/fixtures'
import { insertReviewIfEligible, parseReviewInput } from '@/app/bookings/actions'

afterAll(teardownFixtures)

async function seedBookingWithStatus(status: 'confirmed' | 'completed', hour: number) {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const startsAt = new Date(Date.UTC(2026, 3, 12, hour - 8, 0, 0))
  const endsAt = new Date(startsAt.getTime() + 3_600_000)
  const result = await db.execute(sql`
    insert into bookings (
      court_id, branch_id, player_id, starts_at, ends_at, status,
      court_fee_centavos, transaction_fee_centavos, total_charged_centavos,
      platform_fee_centavos, processor_fee_centavos, owner_net_centavos, fee_config_snapshot
    ) values (
      ${courtIds[0]}::uuid, ${branchId}::uuid, ${playerId}::uuid,
      ${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz,
      ${status}::booking_status, 30000, 0, 30000, 3000, 0, 27000, '{"test": true}'::jsonb
    ) returning id
  `)
  return { bookingId: result.rows[0].id as string, playerId, branchId }
}

test('parseReviewInput accepts a valid submission', () => {
  const form = new FormData()
  form.set('bookingId', '11111111-2222-3333-4444-555555555555')
  form.set('rating', '4')
  form.set('body', '  Good surface.  ')
  expect(parseReviewInput(form)).toEqual({
    bookingId: '11111111-2222-3333-4444-555555555555',
    rating: 4,
    body: 'Good surface.',
  })
})

test('parseReviewInput rejects a non-UUID booking id', () => {
  // Without this, the id reaches a ::uuid cast and Postgres raises 22P02,
  // which would escape as an unhandled exception rather than a form error.
  const form = new FormData()
  form.set('bookingId', 'not-a-uuid')
  form.set('rating', '4')
  expect(parseReviewInput(form)).toBeNull()
})

test('parseReviewInput rejects out-of-range and non-integer ratings', () => {
  // The DB CHECK is rating between 1 and 5; catching it here turns a 23514
  // crash into a form error.
  for (const rating of ['0', '6', '4.5', 'five', '']) {
    const form = new FormData()
    form.set('bookingId', '11111111-2222-3333-4444-555555555555')
    form.set('rating', rating)
    expect(parseReviewInput(form)).toBeNull()
  }
})

test('parseReviewInput normalizes an empty body to null', () => {
  const form = new FormData()
  form.set('bookingId', '11111111-2222-3333-4444-555555555555')
  form.set('rating', '5')
  form.set('body', '   ')
  expect(parseReviewInput(form)?.body).toBeNull()
})

test('insertReviewIfEligible writes a review for the player\'s own completed booking', async () => {
  const { bookingId, playerId } = await seedBookingWithStatus('completed', 10)
  await expect(
    insertReviewIfEligible({ bookingId, playerId, rating: 5, body: 'Clean courts.' }),
  ).resolves.toEqual({ ok: true })

  const rows = await db.execute(sql`select rating from reviews where booking_id = ${bookingId}::uuid`)
  expect(rows.rows).toHaveLength(1)
  expect(Number(rows.rows[0].rating)).toBe(5)
})

test('insertReviewIfEligible reports already_reviewed on a second attempt', async () => {
  // reviews.booking_id is UNIQUE — the database is the authority, and the
  // action must translate 23505 rather than crash.
  const { bookingId, playerId } = await seedBookingWithStatus('completed', 11)
  await insertReviewIfEligible({ bookingId, playerId, rating: 4, body: null })
  await expect(
    insertReviewIfEligible({ bookingId, playerId, rating: 3, body: 'Changed my mind.' }),
  ).resolves.toEqual({ ok: false, reason: 'already_reviewed' })
})

test('insertReviewIfEligible refuses a booking that is not completed', async () => {
  const { bookingId, playerId } = await seedBookingWithStatus('confirmed', 12)
  await expect(
    insertReviewIfEligible({ bookingId, playerId, rating: 5, body: null }),
  ).resolves.toEqual({ ok: false, reason: 'not_eligible' })

  const rows = await db.execute(sql`select 1 from reviews where booking_id = ${bookingId}::uuid`)
  expect(rows.rows).toHaveLength(0)
})

test('insertReviewIfEligible refuses another player\'s booking and writes nothing', async () => {
  const { bookingId } = await seedBookingWithStatus('completed', 13)
  const stranger = await seedPlayer()
  await expect(
    insertReviewIfEligible({ bookingId, playerId: stranger, rating: 1, body: 'Never went.' }),
  ).resolves.toEqual({ ok: false, reason: 'not_eligible' })

  const rows = await db.execute(sql`select 1 from reviews where booking_id = ${bookingId}::uuid`)
  expect(rows.rows).toHaveLength(0)
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run tests/bookings/review-action.test.ts
```

Expected: FAIL — cannot resolve `@/app/bookings/actions`.

- [ ] **Step 3: Implement the action**

`src/app/bookings/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { AuthError, requireUser } from '@/lib/auth/guards'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY_LENGTH = 2000

export type ReviewInput = { bookingId: string; rating: number; body: string | null }

/**
 * Validates the form payload before any of it reaches SQL. Every rule here
 * corresponds to a database constraint that would otherwise raise and escape
 * as an unhandled exception: a non-UUID id hits a ::uuid cast (22P02), and a
 * rating outside 1..5 hits reviews' CHECK (23514).
 *
 * Exported for tests; the action below is the only production caller.
 */
export function parseReviewInput(formData: FormData): ReviewInput | null {
  const bookingId = String(formData.get('bookingId') ?? '')
  const rating = Number(formData.get('rating'))
  const rawBody = String(formData.get('body') ?? '').trim()

  if (!UUID_RE.test(bookingId)) return null
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null
  if (rawBody.length > MAX_BODY_LENGTH) return null

  return { bookingId, rating, body: rawBody.length > 0 ? rawBody : null }
}

export type InsertResult = { ok: true } | { ok: false; reason: 'already_reviewed' | 'not_eligible' }

/**
 * Inserts a review only if the booking is the caller's own and is completed.
 *
 * Eligibility lives in the INSERT's own SELECT, not in a prior read: a
 * check-then-insert would be a race, and a forged booking_id must insert
 * nothing rather than be rejected after the fact. `branch_id` is taken from
 * the booking row, never from the form — trusting client input there would let
 * a review be attached to any branch.
 *
 * Exported for tests; the action below is the only production caller.
 */
export async function insertReviewIfEligible(input: ReviewInput & { playerId: string }): Promise<InsertResult> {
  try {
    const result = await db.execute(sql`
      insert into reviews (booking_id, branch_id, player_id, rating, body)
      select bk.id, bk.branch_id, bk.player_id, ${input.rating}, ${input.body}
      from bookings bk
      where bk.id = ${input.bookingId}::uuid
        and bk.player_id = ${input.playerId}::uuid
        and bk.status = 'completed'
      returning id
    `)
    return result.rows.length > 0 ? { ok: true } : { ok: false, reason: 'not_eligible' }
  } catch (error) {
    // reviews.booking_id is UNIQUE; the constraint is the authority on
    // "one review per booking", so a duplicate is a normal outcome to report.
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') {
      return { ok: false, reason: 'already_reviewed' }
    }
    throw error
  }
}

export type ReviewFormState = { ok: true } | { error: string } | null

/**
 * useActionState's signature: (prevState, formData) => nextState. The previous
 * state is unused — each submission is judged on its own input — but the
 * parameter must exist for React to bind the action to the form's state.
 *
 * Returning state rather than only redirecting is what lets ReviewForm render
 * "You've already reviewed this booking" instead of appearing to do nothing.
 */
export async function createReviewAction(
  _prevState: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  let user
  try {
    user = await requireUser()
  } catch (error) {
    if (error instanceof AuthError) redirect('/login?next=%2Fbookings%3Ftab%3Dpast')
    throw error
  }

  const input = parseReviewInput(formData)
  if (!input) {
    return { error: "That review doesn't look right. Pick a rating from 1 to 5 and try again." }
  }

  const result = await insertReviewIfEligible({ ...input, playerId: user.id })

  if (!result.ok) {
    return {
      error:
        result.reason === 'already_reviewed'
          ? "You've already reviewed this booking."
          : 'You can only review a court after your booking is completed.',
    }
  }

  revalidatePath('/bookings')
  return { ok: true }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run tests/bookings/review-action.test.ts
```

Expected: PASS (eight tests).

- [ ] **Step 5: Confirm the action-coverage test still passes**

```bash
npx vitest run tests/auth/action-coverage.test.ts
```

Expected: PASS — `src/app/bookings/actions.ts` contains `requireUser`.

- [ ] **Step 6: Create the review form**

`src/app/bookings/review-form.tsx` — a client component, so the action's error
state has somewhere to render. This is the only client boundary on `/bookings`.

```tsx
'use client'

import { useActionState } from 'react'
import { createReviewAction, type ReviewFormState } from './actions'

/**
 * The one client component on this page. It exists for a specific reason: a
 * Server Component cannot render what a Server Action returns, so a failed
 * submission (already reviewed, not yet completed, forged input) would look
 * like nothing happening. useActionState gives the returned message a home.
 *
 * On success the action calls revalidatePath('/bookings'), so this row
 * re-renders from the server as reviewed and this form disappears — no local
 * success state to manage.
 */
export function ReviewForm({ bookingId }: { bookingId: string }) {
  const [state, formAction, pending] = useActionState<ReviewFormState, FormData>(
    createReviewAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="bookingId" value={bookingId} />

      <label className="sr-only" htmlFor={`rating-${bookingId}`}>
        Rating
      </label>
      <select
        id={`rating-${bookingId}`}
        name="rating"
        defaultValue="5"
        className="h-[var(--btn-h-sm)] rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2 text-[13px] text-[var(--ink)]"
      >
        <option value="5">5 — Excellent</option>
        <option value="4">4 — Good</option>
        <option value="3">3 — Okay</option>
        <option value="2">2 — Poor</option>
        <option value="1">1 — Bad</option>
      </select>

      <label className="sr-only" htmlFor={`body-${bookingId}`}>
        Review
      </label>
      <textarea
        id={`body-${bookingId}`}
        name="body"
        rows={2}
        maxLength={2000}
        placeholder="How was the court? (optional)"
        className="rounded-[var(--btn-radius)] border border-[var(--hairline)] bg-[var(--panel)] px-2.5 py-2 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-soft)]"
      />

      {/* Lime is this view's one primary action — the page's other buttons are
          bordered/neutral, so branding.md's "never two lime buttons in one
          view" holds even with several of these rows on screen, since they are
          all the same action repeated. */}
      <button
        type="submit"
        disabled={pending}
        className="font-display inline-flex h-[var(--btn-h-sm)] items-center justify-center rounded-[var(--btn-radius)] bg-[var(--ball)] px-3 text-[13px] font-bold text-[var(--ball-ink)] transition-[filter] duration-150 hover:brightness-[1.06] disabled:opacity-60 motion-reduce:transition-none"
      >
        {pending ? 'Saving…' : 'Leave a review'}
      </button>

      {state && 'error' in state && (
        <p role="alert" className="text-[12.5px] font-medium text-[var(--ink)]">
          {state.error}
        </p>
      )}
    </form>
  )
}
```

- [ ] **Step 7: Render it in the past panel**

In `src/app/bookings/page.tsx`, the past table's action cell renders
`<ReviewForm bookingId={booking.id} />` when `!booking.hasReview`, and when it
is true, the reviewed tag instead: a lime 7px dot with a 1.5px `--ink` border
(branding.md's Rating mark) plus the word "Reviewed".

- [ ] **Step 8: Typecheck, lint, full suite**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: all green apart from the pre-existing warnings.

- [ ] **Step 9: Commit**

```bash
git add src/app/bookings/actions.ts src/app/bookings/review-form.tsx src/app/bookings/page.tsx tests/bookings/review-action.test.ts
git commit -m "Add review creation from the past-bookings tab"
```

---

### Task 8: `/bookings/[id]` receipt page

**Files:**
- Create: `src/app/bookings/[id]/page.tsx`

**Interfaces:**
- Consumes: `getBookingReceipt` (Task 5), `requireUserPage` (Task 1), `formatPeso`/`formatHourRange`/`formatDateLabel`.

- [ ] **Step 1: Create the page**

```tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Nav } from '@/components/site/nav'
import { Footer } from '@/components/site/footer'
import { requireUserPage } from '@/lib/auth/page-guards'
import { getBookingReceipt } from '@/lib/bookings/queries'
import { formatDateLabel, formatHourRange, formatPeso } from '@/lib/format'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A booking's receipt.
 *
 * Both "no such booking" and "not your booking" render notFound(). That is
 * deliberate: a distinct 403 for someone else's id would confirm the row
 * exists. getBookingReceipt scopes by player_id in its where clause, so this
 * page never sees another player's row to begin with.
 *
 * The id is shape-checked before the query because a non-UUID string reaches a
 * ::uuid cast and raises 22P02 — a crawler hitting /bookings/foo would
 * otherwise 500 instead of 404.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await requireUserPage(`/bookings/${id}`)
  if (!UUID_RE.test(id)) notFound()

  const receipt = await getBookingReceipt(id, user.id)
  if (!receipt) notFound()

  const hours = receipt.endHour - receipt.startHour

  return (
    <>
      <Nav variant="solid" />
      <main className="px-[max(24px,calc((100vw-1120px)/2))] pb-[72px] pt-10">
        <Link href="/bookings" className="text-sm font-semibold text-[var(--court)]">
          ← Back to my bookings
        </Link>

        <div className="mt-6 max-w-[560px] rounded-[20px] bg-[var(--panel)] p-8 shadow-[var(--shadow-sm)]">
          <span className="font-mono block text-[11px] tracking-[.14em] text-[var(--court)] uppercase">
            Receipt
          </span>
          <h1 className="font-display mt-2 text-[26px] font-bold tracking-[-0.025em] text-[var(--ink)]">
            {receipt.branchName}
          </h1>
          <p className="mt-1 text-[14px] text-[var(--ink-soft)]">
            {receipt.courtName} ({receipt.environment}) · {receipt.branchAddress},{' '}
            {receipt.branchCity}
          </p>

          <dl className="mt-7 grid grid-cols-[auto_1fr] gap-x-8 gap-y-3 text-[14px]">
            <dt className="text-[var(--ink-soft)]">When</dt>
            <dd className="font-mono text-right text-[var(--ink)]">
              {formatDateLabel(receipt.date)} · {formatHourRange(receipt.startHour, receipt.endHour)}
            </dd>

            <dt className="text-[var(--ink-soft)]">Duration</dt>
            <dd className="font-mono text-right text-[var(--ink)]">
              {hours} {hours === 1 ? 'hour' : 'hours'}
            </dd>

            <dt className="text-[var(--ink-soft)]">Court fee</dt>
            <dd className="font-mono text-right text-[var(--ink)]">
              {formatPeso(receipt.courtFeeCentavos)}
            </dd>

            {/* Only shown when nonzero: the fee bearer is configurable
                (processor_fee_bearer), so a ₱0 line would be noise for the
                common case where the platform absorbs it. */}
            {receipt.transactionFeeCentavos > 0 && (
              <>
                <dt className="text-[var(--ink-soft)]">Transaction fee</dt>
                <dd className="font-mono text-right text-[var(--ink)]">
                  {formatPeso(receipt.transactionFeeCentavos)}
                </dd>
              </>
            )}

            <dt className="border-t border-[var(--hairline)] pt-3 font-semibold text-[var(--ink)]">
              Total charged
            </dt>
            <dd className="font-mono border-t border-[var(--hairline)] pt-3 text-right font-semibold text-[var(--ink)]">
              {formatPeso(receipt.totalChargedCentavos)}
            </dd>
          </dl>

          <p className="font-mono mt-6 text-[11px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
            Ref {receipt.id.slice(0, 8).toUpperCase()} · {receipt.status.replace('_', ' ')}
          </p>
        </div>
      </main>
      <Footer />
    </>
  )
}
```

- [ ] **Step 2: Typecheck and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/bookings/[id]/page.tsx"
git commit -m "Add booking receipt page"
```

---

### Task 9: Owner dashboard queries

**Files:**
- Create: `src/lib/owner/queries.ts`
- Test: `tests/owner/queries.test.ts`

**Interfaces:**
- Produces:

```ts
export type OwnerGridCourt = { courtId: string; courtName: string; branchName: string }
export type OwnerGridBooking = {
  bookingId: string
  courtId: string
  startHour: number
  endHour: number
  playerName: string
}
export type OwnerStats = {
  bookingsThisWeek: number
  occupancyPct: number | null
  grossCentavos: number
  netCentavos: number
}
export type OwnerPendingCourt = { id: string; name: string; branchName: string; createdAt: string }
export type OwnerActivity = { kind: 'booking' | 'review'; at: string; text: string }
export type OwnerOverview = {
  branchCount: number
  stats: OwnerStats
  courts: OwnerGridCourt[]
  openHour: number
  closeHour: number
  todaysBookings: OwnerGridBooking[]
  pendingCourts: OwnerPendingCourt[]
  activity: OwnerActivity[]
}
export type OwnerBookingRow = {
  bookingId: string
  date: string
  startHour: number
  endHour: number
  branchName: string
  courtName: string
  playerName: string
  status: string
  totalChargedCentavos: number
  ownerNetCentavos: number
}
export type OwnerEarningsRow = {
  branchId: string
  branchName: string
  bookingCount: number
  grossCentavos: number
  platformFeeCentavos: number
  netCentavos: number
}
export type OwnerEarnings = {
  month: string
  rows: OwnerEarningsRow[]
  totals: { bookingCount: number; grossCentavos: number; platformFeeCentavos: number; netCentavos: number }
}

export async function getOwnerOverview(ownerId: string, day: string): Promise<OwnerOverview>
export async function getOwnerBookings(
  ownerId: string,
  filters: { day: string; branchId?: string },
): Promise<OwnerBookingRow[]>
export async function getOwnerEarnings(ownerId: string, month: string): Promise<OwnerEarnings>
export async function getOwnerBranches(ownerId: string): Promise<{ id: string; name: string }[]>
```

- [ ] **Step 1: Write the failing tests**

Create `tests/owner/queries.test.ts`, importing the shared `seedBooking` added to `tests/helpers/fixtures.ts` in Task 5. Note its default status is `completed`; every owner test below that wants a `confirmed` booking passes `status` explicitly.

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { seedBooking, seedBranchWithCourts, seedPlayer, teardownFixtures } from '../helpers/fixtures'
import { getOwnerBookings, getOwnerBranches, getOwnerEarnings, getOwnerOverview } from '@/lib/owner/queries'

afterAll(teardownFixtures)

/** A Manila-local instant on a given YYYY-MM-DD at a given hour. */
function manilaAt(date: string, hour: number) {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+08:00`)
}

/** Today in Manila, matching src/lib/date-manila.ts's manilaToday(). */
function manilaToday() {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
}

test('getOwnerBranches returns only branches the caller owns', async () => {
  const mine = await seedBranchWithCourts(1)
  const theirs = await seedBranchWithCourts(1)

  const branches = await getOwnerBranches(mine.ownerId)
  const ids = branches.map((b) => b.id)
  expect(ids).toContain(mine.branchId)
  expect(ids).not.toContain(theirs.branchId)
})

test('getOwnerOverview counts only the caller\'s bookings and excludes holds', async () => {
  const mine = await seedBranchWithCourts(2)
  const theirs = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const today = manilaToday()

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 12),
    totalCentavos: 50000,
  })
  // A hold on the caller's own court: must not appear in the grid or stats.
  await seedBooking({
    courtId: mine.courtIds[1],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 14),
    status: 'pending_payment',
  })
  // Another owner's booking: must not leak in.
  await seedBooking({
    courtId: theirs.courtIds[0],
    branchId: theirs.branchId,
    playerId: player,
    startsAt: manilaAt(today, 16),
    totalCentavos: 99000,
  })

  const overview = await getOwnerOverview(mine.ownerId, today)
  expect(overview.branchCount).toBe(1)
  expect(overview.todaysBookings).toHaveLength(1)
  expect(overview.todaysBookings[0].startHour).toBe(12)
  expect(overview.stats.grossCentavos).toBe(50000)
  expect(overview.stats.netCentavos).toBe(50000 - 5000)
  expect(typeof overview.stats.grossCentavos).toBe('number')
})

test('getOwnerOverview lists pending courts awaiting approval', async () => {
  const mine = await seedBranchWithCourts(1)
  await db.execute(sql`
    insert into courts (branch_id, name, environment, status)
    values (${mine.branchId}::uuid, 'Court Pending', 'outdoor', 'pending')
  `)

  const overview = await getOwnerOverview(mine.ownerId, manilaToday())
  expect(overview.pendingCourts.map((c) => c.name)).toContain('Court Pending')
})

test('getOwnerOverview reports zero branches without throwing', async () => {
  // An owner who has not created a branch yet. The page renders an empty
  // state for this; the query must not divide by zero computing occupancy.
  const ownerId = await seedPlayer()
  await db.execute(sql`update profiles set role = 'owner' where id = ${ownerId}::uuid`)

  const overview = await getOwnerOverview(ownerId, manilaToday())
  expect(overview.branchCount).toBe(0)
  expect(overview.courts).toEqual([])
  expect(overview.stats.occupancyPct).toBeNull()
  expect(overview.stats.grossCentavos).toBe(0)
})

test('getOwnerBookings filters by day and by branch', async () => {
  const mine = await seedBranchWithCourts(1)
  const other = await seedBranchWithCourts(1)
  // Put the second branch under the same owner so the branch filter is
  // actually exercised rather than the ownership filter.
  await db.execute(
    sql`update branches set owner_id = ${mine.ownerId}::uuid where id = ${other.branchId}::uuid`,
  )
  const player = await seedPlayer()
  const today = manilaToday()

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 9),
  })
  await seedBooking({
    courtId: other.courtIds[0],
    branchId: other.branchId,
    playerId: player,
    startsAt: manilaAt(today, 10),
  })

  const all = await getOwnerBookings(mine.ownerId, { day: today })
  expect(all).toHaveLength(2)

  const filtered = await getOwnerBookings(mine.ownerId, { day: today, branchId: mine.branchId })
  expect(filtered).toHaveLength(1)
  expect(filtered[0].startHour).toBe(9)
})

test('getOwnerEarnings per-branch rows sum to the reported totals', async () => {
  const mine = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const today = manilaToday()
  const month = today.slice(0, 7)

  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 20),
    totalCentavos: 40000,
  })
  await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 21),
    totalCentavos: 60000,
  })

  const earnings = await getOwnerEarnings(mine.ownerId, month)
  const row = earnings.rows.find((r) => r.branchId === mine.branchId)
  expect(row).toBeDefined()
  expect(row!.grossCentavos).toBe(100000)
  expect(row!.bookingCount).toBe(2)
  // The invariant that matters: the rollup is the sum of its parts.
  expect(earnings.totals.grossCentavos).toBe(
    earnings.rows.reduce((sum, r) => sum + r.grossCentavos, 0),
  )
  expect(earnings.totals.netCentavos).toBe(
    earnings.rows.reduce((sum, r) => sum + r.netCentavos, 0),
  )
  // gross = net + platform fee, per row, with no float drift.
  expect(row!.grossCentavos).toBe(row!.netCentavos + row!.platformFeeCentavos)
})

test('getOwnerEarnings excludes expired and refunded bookings', async () => {
  const mine = await seedBranchWithCourts(1)
  const player = await seedPlayer()
  const today = manilaToday()
  const month = today.slice(0, 7)

  const bookingId = await seedBooking({
    courtId: mine.courtIds[0],
    branchId: mine.branchId,
    playerId: player,
    startsAt: manilaAt(today, 22),
    totalCentavos: 70000,
  })
  await db.execute(
    sql`update bookings set status = 'refunded_manual' where id = ${bookingId}::uuid`,
  )

  const earnings = await getOwnerEarnings(mine.ownerId, month)
  const row = earnings.rows.find((r) => r.branchId === mine.branchId)
  expect(row?.grossCentavos ?? 0).toBe(0)
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run tests/owner/queries.test.ts
```

Expected: FAIL — cannot resolve `@/lib/owner/queries`.

- [ ] **Step 3: Implement the query module**

`src/lib/owner/queries.ts`. Key points to implement exactly:

- Every query's `where` includes `b.owner_id = ${ownerId}::uuid`. Never filter ownership in TypeScript.
- `REAL_BOOKING` is the same `status in ('confirmed', 'completed')` rule as the player module. Define it locally; do not import across modules for a three-word fragment.
- `openHour`/`closeHour` for the grid come from `min(opens_hour)`/`max(closes_hour)` across the owner's approved courts for that Manila weekday, defaulting to `7`/`23` when the owner has no courts.
- `occupancyPct` is booked hours today over operating hours today, `null` when the denominator is zero (no courts, or none open today) — never a division by zero, and `null` renders as "—" rather than "0%".
- `bookingsThisWeek`, `grossCentavos`, `netCentavos` cover the Manila week containing `day`: `date_trunc('week', ${day}::date)` through `+ interval '7 days'`, compared against `bk.starts_at at time zone 'Asia/Manila'`.
- `playerName` is `coalesce(pr.full_name, split_part(pr.email, '@', 1))` — a profile created by the OAuth trigger may have a null `full_name`, and showing a raw email in a grid cell is worse than showing the local part.
- `activity` unions the most recent bookings and reviews across the owner's branches, ordered by time, limit 8. Build the human-readable string in SQL with `format()` or in TypeScript after the fetch — TypeScript is clearer; return the parts and compose there.
- `getOwnerEarnings(ownerId, month)` takes `YYYY-MM` and filters `date_trunc('month', bk.starts_at at time zone 'Asia/Manila') = ${month + '-01'}::date`. Compute `totals` in TypeScript by summing the rows, which is what makes the "rollup equals sum of parts" test meaningful rather than tautological.

Coerce every numeric column with `Number()`, and cast money sums to `::bigint` in SQL so a large month cannot silently overflow an `int4`.

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run tests/owner/queries.test.ts
```

Expected: PASS (seven tests).

- [ ] **Step 5: Run them again, and run the whole suite**

```bash
npx vitest run tests/owner/queries.test.ts && npm test
```

Expected: PASS both times; no regressions elsewhere.

- [ ] **Step 6: Commit**

```bash
git add src/lib/owner/queries.ts tests/owner/queries.test.ts
git commit -m "Add owner dashboard queries"
```

---

### Task 10: `/dashboard` shell and overview

**Files:**
- Create: `src/app/dashboard/layout.tsx`
- Create: `src/app/dashboard/page.tsx`
- Create: `src/components/dashboard/owner-day-grid.tsx`

**Interfaces:**
- Consumes: `getOwnerOverview` (Task 9), `requireOwnerPage` (Task 1), `StatCard` (Task 6).
- Produces: `<OwnerDayGrid courts={OwnerGridCourt[]} openHour={number} closeHour={number} bookings={OwnerGridBooking[]} />`.

- [ ] **Step 1: Read the mockup**

Open `design/mockups/owner-dashboard.html`. Read the CSS for `.shell`, `.side-nav`, `.nav-item`, `.topbar`, `.stat-card`, `.slots`, `.cell`, `.cell-fill`, `.activity`, and the markup from line 228. Two deliberate departures from it: **no Payouts panel** (no `payouts` table exists) and **no Branches & courts / Reviews / Settings nav items** (not built in this slice — a link to a 404 is worse than no link).

- [ ] **Step 2: Create the layout**

`src/app/dashboard/layout.tsx` — a sidebar plus content shell, guarded once here so no child page can forget:

```tsx
import Link from 'next/link'
import { Wordmark } from '@/components/site/wordmark'
import { requireOwnerPage } from '@/lib/auth/page-guards'

/**
 * Owner shell. The guard lives in the layout so every /dashboard/* page is
 * gated by construction rather than by each page remembering.
 *
 * Only implemented sections appear in the sidebar. The mockup also lists
 * Branches & courts, Reviews, and Settings; those are later slices, and a nav
 * item pointing at a 404 is worse than no item.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireOwnerPage('/dashboard')

  const items = [
    { href: '/dashboard', label: 'Overview' },
    { href: '/dashboard/bookings', label: 'Bookings' },
    { href: '/dashboard/earnings', label: 'Earnings' },
  ]

  return (
    <div className="flex min-h-dvh max-[980px]:flex-col">
      <aside className="flex w-[248px] shrink-0 flex-col gap-8 border-r border-[var(--hairline)] bg-[var(--panel)] p-6 max-[980px]:w-full max-[980px]:border-r-0 max-[980px]:border-b">
        <Link href="/" className="text-[20px] text-[var(--ink)]">
          <Wordmark />
        </Link>
        <nav className="flex flex-col gap-1 max-[980px]:flex-row max-[980px]:overflow-x-auto">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-[10px] px-3 py-2.5 text-[13.5px] font-medium whitespace-nowrap text-[var(--ink)] hover:bg-[var(--surface)]"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto flex items-center gap-2.5 max-[980px]:mt-0">
          <span
            aria-hidden
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--court)] text-[11px] font-semibold text-white"
          >
            {(user.businessName ?? user.fullName ?? user.email).charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-[var(--ink)]">
              {user.businessName ?? user.fullName ?? user.email}
            </div>
            <div className="font-mono text-[10px] tracking-[.12em] text-[var(--ink-soft)] uppercase">
              {user.role}
            </div>
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1 p-8 max-[560px]:p-5">{children}</div>
    </div>
  )
}
```

`SessionUser` has no `businessName`. Add it the same way Task 3 added `fullName`: extend the type, add `business_name` to the `select` in `loadSessionUser`, and map it as `businessName: (profile.business_name as string | null) ?? null`.

**Active-item styling:** the layout is a Server Component and cannot read the current path. Do not reach for `usePathname` — that would make the whole shell a client component. Instead each page sets its own heading, and the sidebar item styling stays uniform. If active highlighting is wanted later, extract just the nav into a small client component.

- [ ] **Step 3: Create the day grid**

`src/components/dashboard/owner-day-grid.tsx` — a server component rendering a table of hour rows × court columns, each cell filled with the player name when a booking covers that hour:

```tsx
import { formatHour } from '@/lib/format'
import type { OwnerGridBooking, OwnerGridCourt } from '@/lib/owner/queries'

/**
 * Today's bookings as time rows × court columns.
 *
 * Deliberately NOT a reuse of src/components/availability-grid.tsx. The two
 * look alike and mean different things: that grid shows prices and is
 * clickable to book, this one shows who booked and is not interactive.
 * Overloading one component with both would tangle the booking path with a
 * reporting view.
 *
 * Per branding.md's mobile rule, the table scrolls inside its own container
 * with a sticky first column; the page itself never scrolls sideways.
 */
export function OwnerDayGrid({
  courts,
  openHour,
  closeHour,
  bookings,
}: {
  courts: OwnerGridCourt[]
  openHour: number
  closeHour: number
  bookings: OwnerGridBooking[]
}) {
  if (courts.length === 0) {
    return (
      <p className="rounded-[14px] border border-dashed border-[var(--hairline)] px-5 py-10 text-center text-sm text-[var(--ink-soft)]">
        No courts yet. Once your courts are approved, the day&apos;s bookings show up here.
      </p>
    )
  }

  const hours = Array.from({ length: Math.max(closeHour - openHour, 0) }, (_, i) => openHour + i)

  // One lookup per (courtId, hour) rather than scanning `bookings` inside the
  // render loop: a booking spans startHour..endHour, so every covered hour
  // gets an entry pointing at the same booking.
  const byCell = new Map<string, OwnerGridBooking>()
  for (const booking of bookings) {
    for (let hour = booking.startHour; hour < booking.endHour; hour++) {
      byCell.set(`${booking.courtId}:${hour}`, booking)
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-left">
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-[1] bg-[var(--panel)]" />
            {courts.map((court) => (
              <th key={court.courtId} scope="col" className="px-3 pb-3 align-bottom">
                <span className="block text-[13px] font-semibold text-[var(--ink)]">
                  {court.branchName}
                </span>
                <span className="font-mono block text-[10.5px] tracking-[.1em] text-[var(--ink-soft)] uppercase">
                  {court.courtName}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {hours.map((hour) => (
            <tr key={hour}>
              <td className="font-mono sticky left-0 z-[1] bg-[var(--panel)] pr-4 py-1 text-[11.5px] whitespace-nowrap text-[var(--ink-soft)]">
                {formatHour(hour)}
              </td>
              {courts.map((court) => {
                const booking = byCell.get(`${court.courtId}:${hour}`)
                return (
                  <td key={court.courtId} className="px-1.5 py-1">
                    {booking ? (
                      <div className="truncate rounded-[8px] bg-[var(--court-deep)] px-2.5 py-1.5 text-[12px] font-semibold text-white">
                        {booking.playerName}
                      </div>
                    ) : (
                      <div className="h-[30px] rounded-[8px] bg-[var(--surface)]" />
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 4: Create the overview page**

`src/app/dashboard/page.tsx`. The layout already guarded, but this page needs the user id, so call `requireOwnerPage('/dashboard')` again — it is a cheap claims read plus one indexed profile lookup, and passing the user down from a layout is not possible in App Router.

Content: an `h1` "Overview" plus a mono kicker showing the Manila date; a four-up `StatCard` row (`Bookings this week`, `Occupancy` — `stats.occupancyPct === null ? '—' : `${stats.occupancyPct}%``, `Gross revenue`, `Net after fees`); a two-column split (`grid grid-cols-[1.6fr_1fr] gap-6 max-[980px]:grid-cols-1`) with the day grid in a `--panel` card on the left and the pending-approval card on the right; then a recent-activity card.

When `branchCount === 0`, render a single empty-state card instead of stats and grid: "No branches yet — once you add a branch and your courts are approved, this is where the day's bookings appear."

Use `manilaToday()` from `@/lib/date-manila` for the `day` argument.

- [ ] **Step 5: Typecheck and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors.

- [ ] **Step 6: Verify the two redirects in the browser**

Signed out, navigate to `/dashboard` → expect `/login?next=%2Fdashboard`. (The signed-in player→`/bookings` redirect is verified in Task 13, since it needs a session.)

- [ ] **Step 7: Commit**

```bash
git add src/app/dashboard/layout.tsx src/app/dashboard/page.tsx src/components/dashboard/owner-day-grid.tsx src/lib/auth/guards.ts
git commit -m "Add owner dashboard shell and overview"
```

---

### Task 11: `/dashboard/bookings` and `/dashboard/earnings`

**Files:**
- Create: `src/app/dashboard/bookings/page.tsx`
- Create: `src/app/dashboard/earnings/page.tsx`

**Interfaces:**
- Consumes: `getOwnerBookings`, `getOwnerEarnings`, `getOwnerBranches` (Task 9); `requireOwnerPage`; `shiftDay`/`manilaToday`/`isValidCalendarDate` from `@/lib/date-manila`; `formatPeso`/`formatHour`/`formatDateLabel`.

- [ ] **Step 1: Create the bookings page**

Filters are URL state: `?day=YYYY-MM-DD&branch=<uuid>`.

```tsx
export default async function OwnerBookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string; branch?: string }>
}) {
  const user = await requireOwnerPage('/dashboard/bookings')
  const { day: rawDay, branch: rawBranch } = await searchParams

  // An invalid or nonexistent date (?day=2026-02-30) falls back to today
  // rather than reaching a ::date cast and raising 22008.
  const day = rawDay && isValidCalendarDate(rawDay) ? rawDay : manilaToday()
  const branchId = rawBranch && UUID_RE.test(rawBranch) ? rawBranch : undefined

  const [branches, rows] = await Promise.all([
    getOwnerBranches(user.id),
    getOwnerBookings(user.id, { day, branchId }),
  ])
  // …
}
```

Render: an `h1` "Bookings"; a control row with prev/next day links (`?day=${shiftDay(day, -1)}`, preserving `branch`), the date label, a "Today" link when `day !== manilaToday()`, and a branch filter as a `<form method="get">` containing a `<select name="branch">` with an "All branches" option plus a submit button — a plain GET form, no client JS, matching how the home page's search form works. Then a table: time, branch, court, player, status, amount, your net. Wrap in `overflow-x-auto`. Empty state: "No bookings on this day."

Declare `const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` at module scope.

- [ ] **Step 2: Create the earnings page**

`?month=YYYY-MM`, defaulting to the current Manila month (`manilaToday().slice(0, 7)`). Validate with `/^\d{4}-(0[1-9]|1[0-2])$/` and fall back to the current month otherwise — an unvalidated value reaches a `::date` cast.

Render: an `h1` "Earnings"; prev/next month links; a four-up `StatCard` row from `totals` (`Bookings`, `Gross`, `Platform fee`, `Net`); then a per-branch table with a totals row in `<tfoot>`. Note in a comment that a zero-booking month renders an empty table plus zeroed totals, which is correct rather than an error.

- [ ] **Step 3: Typecheck and lint**

```bash
npx tsc --noEmit && npm run lint
```

Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/bookings/page.tsx src/app/dashboard/earnings/page.tsx
git commit -m "Add owner bookings and earnings pages"
```

---

### Task 12: Demo data and the stale-OAuth doc correction

**Files:**
- Modify: `supabase/seed.sql` (append)
- Create: `scripts/grant-demo-data.ts`
- Modify: `package.json` (add a `demo:grant` script)
- Modify: `docs/foundation-review-notes.md` (correct the OAuth claim)

**Interfaces:**
- Produces: `npm run demo:grant -- --email <address>` — makes a real signed-in account an owner with branches and bookings.

**Why a script and not seed data:** the account that signs in with Google is not known at seed time, and hardcoding a personal email into a committed seed file is wrong. The seed gets upcoming bookings for the three existing test players; the script attaches data to whoever actually signs in.

- [ ] **Step 1: Append upcoming bookings to the seed**

Add to the end of `supabase/seed.sql` a `do $$ … $$` block that, for each of the three seeded players (`dddddddd-…-dddddddddde1..e3`), inserts one `confirmed` booking on an approved court, dated relative to `now()` (tomorrow, +3 days, +5 days) at distinct hours inside the seeded operating window (7..23). Requirements:

- Deterministic ids via `md5(...)::uuid` so re-running is a no-op, matching the existing block's pattern at `seed.sql:282`.
- `on conflict (id) do nothing`.
- Pick courts from **different** branches per player so `bookings_no_overlap` can never fire between them.
- `expires_at` stays null — the CHECK only requires it for `pending_payment`.
- Money columns consistent: `total_charged_centavos = court_fee_centavos`, `platform_fee_centavos` 10%, `owner_net_centavos` the remainder.

- [ ] **Step 2: Apply the seed and confirm idempotency**

```bash
npx supabase db push --db-url "$DATABASE_URL"
```

Then apply the seed twice and confirm the second run changes nothing (`supabase db reset` is unavailable on a hosted project, so double-apply is how idempotency is proven here). Verify with a count before and after:

```bash
npx tsx -e "import{Pool}from'pg';import{loadEnvFile}from'node:process';loadEnvFile('.env.local');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query(\"select count(*) from bookings where status='confirmed'\").then(r=>{console.log(r.rows);return p.end()})"
```

- [ ] **Step 3: Write the grant script**

`scripts/grant-demo-data.ts`, following `scripts/seed-photos.ts`'s conventions exactly: its own standalone `pg` Pool (never importing anything under `src/`, which is gated by `server-only`), `loadEnvFile('.env.local')`, and a docstring explaining idempotency.

It must:
1. Require `--email <address>`; exit non-zero with a usage message otherwise.
2. Look up `profiles` by that email. If absent, exit with "sign in once at /login first, then re-run" — the profile row is created by the signup trigger, not by this script.
3. Set `role = 'owner'` (never demote an existing `admin` — use `where role <> 'admin'`).
4. Reassign one seeded brand's branches to that profile. Use the "Rally Republic" branches, selected by `name like 'Rally Republic%'`, and print which branches moved. **Print a warning** that this mutates seeded rows — it is a local dev utility and that is the point, but the change is visible on the public pages too (those branches' owner profile link changes).
5. Insert two `confirmed` upcoming bookings for that profile as a player, on courts belonging to a **different** brand, with deterministic `md5()` ids and `on conflict do nothing`.
6. Print a summary: profile id, role, branches owned, upcoming bookings.

Add to `package.json` scripts: `"demo:grant": "tsx scripts/grant-demo-data.ts"`.

- [ ] **Step 4: Correct the stale OAuth claim**

In `docs/foundation-review-notes.md`, fix the row 5 entry (line 51) and open item 2. They state Google sign-in is unconfigured; it is configured, verified 2026-08-02 via the authorize endpoint returning `302` to `accounts.google.com` with a real `client_id` (a disabled provider returns `400 Unsupported provider`). Do not delete the history — mark the original finding as superseded and record the verification, so the next reader learns the state changed rather than that the note was wrong.

Also correct line 217-221's claim that "the signed-in nav state has never rendered against a real session" once Task 13 has actually verified it. Do not pre-emptively edit that sentence before the verification happens.

- [ ] **Step 5: Run the full suite**

```bash
npm test
```

Expected: PASS. The new seed rows must not break `tests/branches/*` — those assert on the nine demo branches, and confirmed bookings on them affect `openNowCount` and availability. If a test breaks, the seed bookings are landing on hours a test asserts are free: move them to different hours rather than weakening the test.

- [ ] **Step 6: Commit**

```bash
git add supabase/seed.sql scripts/grant-demo-data.ts package.json docs/foundation-review-notes.md
git commit -m "Add demo bookings and grant script, correct stale OAuth note"
```

---

### Task 13: End-to-end verification with a real session

**Files:** none — this task produces evidence, not code.

**Blocking dependency:** requires the user to complete Google sign-in interactively. The assistant must not authenticate on their behalf.

- [ ] **Step 1: Start the dev server**

Use `preview_start` with config `oncourt-dev`.

- [ ] **Step 2: Verify every signed-out redirect**

Navigate to each and confirm the destination:
- `/bookings` → `/login?next=%2Fbookings`
- `/bookings/11111111-2222-3333-4444-555555555555` → `/login?next=%2Fbookings%2F1111…`
- `/dashboard` → `/login?next=%2Fdashboard`
- `/dashboard/bookings` → `/login?next=%2Fdashboard`  *(the layout guard fires first, so `next` is the layout's path — confirm this is what actually happens and record it either way)*
- `/dashboard/earnings` → as above

- [ ] **Step 3: Ask the user to sign in**

Ask them to complete the Google flow in the browser pane, and to say when they are back on the app. If the callback fails with a redirect error, the fix is adding `http://localhost:3000/**` to Supabase's URL Configuration → Redirect URLs; tell them that exact string.

- [ ] **Step 4: Confirm the session and grant demo data**

Verify the nav shows the account menu. Then:

```bash
npm run demo:grant -- --email <the address they signed in with>
```

- [ ] **Step 5: Verify the account menu**

- Click the avatar: menu opens, `aria-expanded` flips to true.
- Escape closes it and focus returns to the trigger.
- A click outside closes it.
- "My bookings" navigates to `/bookings`; "Owner dashboard" appears (the grant made them an owner) and navigates to `/dashboard`.
- Check with `read_page` that the trigger carries `aria-expanded` and `aria-controls`.

- [ ] **Step 6: Verify the player dashboard**

- `/bookings` renders stat cards with real numbers, and the upcoming tab lists the granted bookings.
- `?tab=past` and `?tab=reviews` render their panels; counts in the tab labels match the rows.
- A `View receipt` link opens `/bookings/[id]` with a fee breakdown whose total matches the card.
- `/bookings/not-a-uuid` renders a 404, not a 500.
- Submit a review on a completed past booking; the row re-renders as reviewed and the reviews tab count increases.
- Screenshot at 1280 and at 375; confirm no horizontal page overflow at 375 via
  `document.documentElement.scrollWidth > window.innerWidth`.

- [ ] **Step 7: Verify the owner dashboard**

- `/dashboard` renders stats, the day grid, and pending approvals.
- `/dashboard/bookings` day navigation changes the day and the list; the branch filter narrows it.
- `/dashboard/earnings` per-branch rows sum to the footer totals — check the arithmetic by eye against the rendered numbers.
- Screenshot at 1280 and 375; confirm the grid scrolls inside its own container and the page does not.

- [ ] **Step 8: Verify sign-out**

Click Sign out. Expected: back on `/`, nav shows "Sign in", and `/bookings` redirects to login again.

- [ ] **Step 9: Check the console and server logs**

`read_console_messages` (errors only) and `preview_logs` (level error). Both should be clean.

- [ ] **Step 10: Update the foundation notes and commit**

Now that the signed-in path is verified, correct `docs/foundation-review-notes.md`'s "signed-in nav state has never rendered against a real session" paragraph, recording what was verified and when.

```bash
git add docs/foundation-review-notes.md
git commit -m "Record end-to-end verification of the signed-in dashboards"
```

---

## Self-Review

**Spec coverage.** Every numbered scope item maps to a task: account menu → 3; sign-out → 3; `?next=` → 2, 4; `/bookings` → 6; receipt → 8; review creation → 7; `/dashboard` → 10; `/dashboard/bookings` → 11; `/dashboard/earnings` → 11; demo data → 12; doc correction → 12, 13. Guards → 1. Every "Out" item stays out; no task adds a migration, a payouts panel, CRUD, or an Admin menu item.

**Two gaps found and closed while reviewing.** `SessionUser` lacked `fullName` (needed by the menu) and `businessName` (needed by the owner shell); both are now explicit steps in Tasks 3 and 10 rather than discoveries mid-implementation. The spec's file list also omitted `src/lib/auth/next-path.ts` and `src/lib/auth/page-guards.ts`, which this plan adds as Tasks 2 and 1.

**Two pre-flight conflicts, resolved by the human before execution.** The first
draft of this plan mandated two things a code reviewer would correctly flag as
defects. Both were raised as a batched question and resolved toward the better
engineering, and the plan text above now reflects the resolutions:

1. **Duplicated test fixture.** Tasks 5 and 9 both needed a `seedBooking`
   helper, and the draft said to copy it into each test file. It now lives once
   in `tests/helpers/fixtures.ts` (Task 5, Step 1a) beside the other seeding
   helpers, and both test files import it. Note its default status is
   `completed`, which every current caller wants.
2. **Discarded action return.** The draft rendered the review form from a Server
   Component, which cannot display what a Server Action returns — a failed
   submission would have looked like nothing happening. Task 7 now adds
   `src/app/bookings/review-form.tsx`, a client component using
   `useActionState`, and `createReviewAction` takes the `(prevState, formData)`
   signature. This is the only client boundary on `/bookings`.

**No component tests exist for the three client components** (`AccountMenu`, `SignInButton`, `ReviewForm`). `vitest.config.ts` sets `environment: 'node'` and neither `jsdom` nor `@testing-library/react` is installed. Task 3 says explicitly not to add them here, and Task 13 covers the behavior in a browser instead. Anyone reading this plan should know that the account menu's keyboard behavior and the review form's error rendering are verified by hand, not by a test.
