# Email Notifications (Resend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the product spec's five lifecycle emails through Resend, so a player who pays gets a receipt, an owner learns about bookings and moderation decisions, and nothing is ever lost silently.

**Architecture:** An `email_outbox` table is written **inside the same transaction** as the state change that owes the email, so "booking confirmed" and "receipt owed" commit or fail together. A separate drainer — a `CRON_SECRET`-guarded Route Handler — claims rows with `for update skip locked`, renders React Email templates from a snapshotted JSONB payload, and sends through an `EmailProvider` interface. Failures retry on a fixed ladder and end up visible in a badged `/admin/emails` queue.

**Tech Stack:** Next.js 16 App Router + TypeScript, Supabase Postgres, Drizzle executing hand-written SQL, Vitest against the hosted database, `resend@6.19.0`, `@react-email/components@1.0.12`, `@react-email/render@2.1.0`.

**Spec:** `docs/superpowers/specs/2026-08-12-email-notifications-design.md`. Read it before Task 1. Where this plan and the spec disagree, the spec wins — raise the conflict rather than silently picking.

## Global Constraints

Every task's requirements implicitly include all of these.

- **Money is `integer` centavos**, rendered via `formatPeso` from `@/lib/format`. Never hand-rolled division. Dates via `formatDateLabel`; Manila helpers in `@/lib/date-manila`.
- **`bigint` comes back from the driver as a string.** Any `::bigint` in a select goes through `Number()` at the mapping edge.
- **Data access is `db.execute(sql\`...\`)` / `tx.execute(sql\`...\`)` only** — never the Drizzle query builder. Server-only modules start with `import 'server-only'`.
- **Never import `src/db/schema.ts`.** It is excluded in `tsconfig.json`; importing it resurfaces a `TS2304`.
- **All identifiers lowercase `snake_case`.** Index every FK explicitly.
- **RLS enabled with zero policies** on the new table. Never `force row level security`.
- **Migrations are idempotent.** `create table if not exists`, `create index if not exists`, `do $$ ... $$` blocks checking `pg_type` for enums. Inline table constraints inside `create table if not exists` are idempotent for free — do not wrap them in do-blocks.
- **Transactions pass `{ isolationLevel: 'read committed' }`** as the second argument to `db.transaction`, matching `src/lib/booking/hold.ts:310` and `src/lib/admin/write.ts:100`.
- **Route Handlers are NOT Server Actions.** They carry no `'use server'` directive and are therefore exempt from `tests/auth/action-coverage.test.ts` **by construction** — that test globs `src/**` and skips any file without the directive. `src/app/api/webhooks/paymongo/route.ts:5-16` documents this precedent. Never add `'use server'` to a Route Handler.
- **Pin `export const runtime = 'nodejs'`** on both new Route Handlers, matching the PayMongo webhook. `node:crypto` requires it.
- **All user-facing copy is English only.** No Taglish. `design/branding.md` is the design source of truth for the email templates' colors and type.
- **Tests run against the hosted database** over the Supavisor session pooler, port **5432** — never 6543. The database is shared and persistent: tests must pass on repeated runs and must never mutate the seeded singletons `platform_settings` / `processor_rates`.
- **Zero Resend quota may be consumed by the test suite.** Everything goes through the recording fake.
- **Run vitest in the foreground**, never backgrounded.
- **Known pre-existing failures, not yours:** `tests/schema/settings.test.ts` and `tests/booking/hold.test.ts:33` both hardcode `hold_duration_minutes: 15` while the live singleton is 5. Baseline is 2 failures. Do not fix them.
- **Pre-existing lint warnings: 9.** That count must not grow.
- **Do NOT run any state-changing git command.** No `git add`, no `git commit`, no branch/stash/checkout. Each task ends by reporting; the user commits.

---

### Task 1: Dependencies, the provider seam, and the Resend adapter

**Files:**
- Modify: `package.json` (add `resend`, `@react-email/components`, `@react-email/render`)
- Modify: `.env.local.example` (add `RESEND_API_KEY`, `CRON_SECRET`, `EMAIL_FROM`)
- Create: `src/lib/email/provider.ts`
- Create: `src/lib/email/resend.ts`
- Create: `src/lib/email/fake.ts`
- Create: `tests/email/resend.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // provider.ts
  export type EmailMessage = { to: string; subject: string; html: string; text: string }
  export type SendResult =
    | { ok: true; messageId: string }
    | { ok: false; retryable: boolean; error: string }
  export type EmailProvider = { send(msg: EmailMessage): Promise<SendResult> }
  export class EmailConfigError extends Error {}
  export function requiredEmailEnv(name: string): string
  export function classifyStatus(status: number): boolean   // true = retryable

  // fake.ts
  export type RecordedEmail = EmailMessage
  export function fakeProvider(opts?: { failWith?: { retryable: boolean; error: string }; failTimes?: number }): EmailProvider & { sent: RecordedEmail[] }

  // resend.ts
  export function resendProvider(): EmailProvider
  ```

- [ ] **Step 1: Install the dependencies**

```bash
npm install resend@6.19.0 @react-email/components@1.0.12 @react-email/render@2.1.0
```

Verify `package.json` lists all three under `dependencies` (not `devDependencies` — they run at request time in the drainer), and that `package-lock.json` updated.

- [ ] **Step 2: Add the env vars to the example file**

Append to `.env.local.example`, matching the commenting style already there:

```
# Resend API key (re_…) from the Resend dashboard. Server-only — never
# NEXT_PUBLIC_-prefixed.
RESEND_API_KEY=
# Shared secret the cron scheduler presents as a bearer token to
# /api/cron/drain-email and /api/cron/enqueue-reminders. Any long random
# string; rotate it by changing this and the scheduler together.
CRON_SECRET=
# The From header, e.g. "OnCourt <bookings@oncourt.ph>". The domain must be
# verified in Resend with SPF and DKIM records before real mail will send;
# until then only onboarding@resend.dev works, addressed to the account owner.
EMAIL_FROM=
```

Do **not** touch `.env.local` — it is the user's private file and they will fill these in themselves.

- [ ] **Step 3: Write the failing test**

Create `tests/email/resend.test.ts`. This task's testable surface is the classification rule and the fake — the adapter's HTTP call itself is exercised in the drain tests through the fake.

```ts
import { expect, test } from 'vitest'
import { classifyStatus } from '@/lib/email/provider'
import { fakeProvider } from '@/lib/email/fake'

const MSG = { to: 'a@example.test', subject: 'S', html: '<p>H</p>', text: 'H' }

test('5xx, 429 and network failures are retryable; other 4xx are not', () => {
  // The whole point of the retryable flag: "Resend is down, try again" must be
  // distinguishable from "that address is malformed, stop". Getting this
  // backwards means either giving up on a transient outage or retrying a
  // permanent rejection five times.
  expect(classifyStatus(500)).toBe(true)
  expect(classifyStatus(502)).toBe(true)
  expect(classifyStatus(503)).toBe(true)
  expect(classifyStatus(429)).toBe(true)
  expect(classifyStatus(400)).toBe(false)
  expect(classifyStatus(401)).toBe(false)
  expect(classifyStatus(403)).toBe(false)
  expect(classifyStatus(422)).toBe(false)
})

test('the fake records what it was asked to send and reports a message id', async () => {
  const provider = fakeProvider()
  const result = await provider.send(MSG)
  expect(result).toMatchObject({ ok: true })
  expect(provider.sent).toEqual([MSG])
})

test('the fake can fail a fixed number of times, then succeed', async () => {
  // Needed by the drain tests' backoff ladder: a row must retry and then land.
  const provider = fakeProvider({ failWith: { retryable: true, error: 'boom' }, failTimes: 2 })
  expect(await provider.send(MSG)).toEqual({ ok: false, retryable: true, error: 'boom' })
  expect(await provider.send(MSG)).toEqual({ ok: false, retryable: true, error: 'boom' })
  expect(await provider.send(MSG)).toMatchObject({ ok: true })
  expect(provider.sent).toHaveLength(1)
})

test('the fake can fail permanently', async () => {
  const provider = fakeProvider({ failWith: { retryable: false, error: 'bad address' } })
  expect(await provider.send(MSG)).toEqual({ ok: false, retryable: false, error: 'bad address' })
  expect(await provider.send(MSG)).toEqual({ ok: false, retryable: false, error: 'bad address' })
  expect(provider.sent).toEqual([])
})
```

- [ ] **Step 4: Run it and watch it fail**

```bash
npx vitest run tests/email/resend.test.ts
```

Expected: fails to resolve `@/lib/email/provider`.

- [ ] **Step 5: Write the provider interface**

Create `src/lib/email/provider.ts`:

```ts
import 'server-only'

export type EmailMessage = { to: string; subject: string; html: string; text: string }

/**
 * `retryable` is the load-bearing field of this whole slice.
 *
 * It is what separates "Resend is down, try again in five minutes" from "that
 * address is malformed, stop". The ADAPTER classifies; the drainer obeys and
 * never re-derives. Keeping the judgement here means the drainer has no
 * provider-specific knowledge at all, which is what makes swapping providers a
 * one-file change.
 */
export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; retryable: boolean; error: string }

export type EmailProvider = { send(msg: EmailMessage): Promise<SendResult> }

/**
 * Mirrors PaymentConfigError in src/lib/payments/provider.ts rather than
 * importing it: a missing RESEND_API_KEY is not a payment configuration
 * problem, and an error class whose name lies is worse than one more
 * four-line class.
 */
export class EmailConfigError extends Error {}

export function requiredEmailEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new EmailConfigError(`${name} is not set`)
  return value
}

/**
 * 5xx is Resend's problem and will pass. 429 is a rate limit, which is the
 * most retryable thing there is — the free tier's 100/day cap surfaces here,
 * and a reminder batch is exactly the shape that trips it. Everything else in
 * the 4xx range is our problem (bad key, unverified domain, malformed address)
 * and will fail identically on every retry, so five attempts would just delay
 * the admin finding out.
 */
export function classifyStatus(status: number): boolean {
  return status >= 500 || status === 429
}
```

- [ ] **Step 6: Write the recording fake**

Create `src/lib/email/fake.ts`:

```ts
import 'server-only'
import type { EmailMessage, EmailProvider, SendResult } from './provider'

export type RecordedEmail = EmailMessage

/**
 * The test double for every email test in this codebase. Zero Resend quota is
 * consumed by the suite — which matters concretely, because the free tier is
 * 100 sends a day and this suite runs many times a day.
 *
 * Lives in src/ rather than tests/ because src/lib/email/drain.ts takes an
 * EmailProvider parameter and a fixture importing across that boundary would
 * invert the dependency.
 */
export function fakeProvider(opts?: {
  failWith?: { retryable: boolean; error: string }
  /** Fail this many times, then start succeeding. Omit to fail forever. */
  failTimes?: number
}): EmailProvider & { sent: RecordedEmail[] } {
  const sent: RecordedEmail[] = []
  let failures = 0

  return {
    sent,
    async send(msg: EmailMessage): Promise<SendResult> {
      if (opts?.failWith) {
        const exhausted = opts.failTimes !== undefined && failures >= opts.failTimes
        if (!exhausted) {
          failures++
          return { ok: false, ...opts.failWith }
        }
      }
      sent.push(msg)
      return { ok: true, messageId: `fake_${sent.length}_${crypto.randomUUID()}` }
    },
  }
}
```

- [ ] **Step 7: Write the Resend adapter**

Create `src/lib/email/resend.ts`:

```ts
import 'server-only'
import { Resend } from 'resend'
import { classifyStatus, requiredEmailEnv, type EmailMessage, type EmailProvider, type SendResult } from './provider'

/**
 * The only file in this codebase that knows Resend exists.
 *
 * Constructed lazily inside send() rather than at module scope: reading
 * RESEND_API_KEY at import time would make every module that transitively
 * imports this one throw at build time on a machine without the key set.
 */
export function resendProvider(): EmailProvider {
  return {
    async send(msg: EmailMessage): Promise<SendResult> {
      try {
        const resend = new Resend(requiredEmailEnv('RESEND_API_KEY'))
        const { data, error } = await resend.emails.send({
          from: requiredEmailEnv('EMAIL_FROM'),
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        })

        if (error) {
          // The SDK surfaces a statusCode on API errors. When it is absent the
          // failure did not come from a response we can classify, so treat it
          // as retryable — a transient fault retried five times is cheap; a
          // real receipt abandoned on the first hiccup is not.
          const status = (error as { statusCode?: number }).statusCode
          return {
            ok: false,
            retryable: status === undefined ? true : classifyStatus(status),
            error: `${error.name}: ${error.message}`,
          }
        }
        if (!data?.id) {
          return { ok: false, retryable: true, error: 'Resend returned no message id' }
        }
        return { ok: true, messageId: data.id }
      } catch (cause) {
        // Network-level: DNS, TCP, timeout. Always retryable. A config error
        // is NOT — it will fail identically forever.
        const message = cause instanceof Error ? cause.message : String(cause)
        return { ok: false, retryable: cause instanceof EmailConfigError ? false : true, error: message }
      }
    },
  }
}
```

Add `EmailConfigError` to that file's imports from `./provider`.

- [ ] **Step 8: Run the tests**

```bash
npx vitest run tests/email/resend.test.ts
```

Expected: 4 passed.

- [ ] **Step 9: Gate and report (do not commit)**

```bash
npx tsc --noEmit && npm run lint
```

Report the three installed versions, the exported signatures verbatim, and confirm the lint warning count is still 9.

---

### Task 2: Migration, schema constraints, and fixture teardown

**Files:**
- Create: `supabase/migrations/20260812000000_email_outbox.sql`
- Create: `tests/schema/email-outbox.test.ts`
- Modify: `tests/helpers/fixtures.ts` (add `seedOutboxRow`; extend `teardownFixtures`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: table `email_outbox`; enums `email_kind`, `email_status`. Fixture `seedOutboxRow(opts: { kind: string; recipient?: string; payload?: object; bookingId?: string | null; courtId?: string | null; status?: 'pending' | 'sent' | 'failed'; attempts?: number; nextAttemptAt?: Date }): Promise<string>` returning the row id.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260812000000_email_outbox.sql`:

```sql
-- The email outbox. Every lifecycle email is enqueued here inside the same
-- transaction as the state change that owes it, then sent by a separate
-- drainer.
--
-- WHY A TABLE RATHER THAN A DIRECT SEND: src/lib/payments/webhook.ts:38-43
-- already drew the right line -- nothing that can fail on a third party may
-- happen inside the confirming transaction. A direct send after commit honours
-- that but loses the email with no record if Resend is down or the process
-- dies in the gap, and the player has already paid. An INSERT into a local
-- table cannot hang on a third party, so "this booking is confirmed" and "this
-- player is owed a receipt" can commit or fail together.
--
-- SAFE TO CREATE AND USE BOTH ENUMS IN THIS ONE FILE: the 55P04 restriction
-- applies to values added to an EXISTING type via `alter type ... add value`,
-- not to a brand-new `create type`. Same precedent as payment_status
-- (20260807090000_payments.sql) and payout_line_kind
-- (20260811000000_payouts_and_refunds.sql). Do not split this file.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'email_kind') then
    create type email_kind as enum (
      'booking_confirmed',  -- player: receipt
      'booking_new',        -- owner: someone booked your court
      'booking_reminder',   -- player: you play today
      'court_moderated',    -- owner: approved, or rejected with reason
      'refund_recorded'     -- player: your refund was processed
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'email_status') then
    create type email_status as enum ('pending', 'sent', 'failed');
  end if;
end $$;

create table if not exists email_outbox (
  id uuid primary key default gen_random_uuid(),
  kind email_kind not null,

  -- Snapshotted, not joined at send time: a profile's email address can
  -- change, and a receipt must go where it was owed when it was owed.
  recipient text not null,

  -- Exactly what the template needs, snapshotted at enqueue. Typed in
  -- TypeScript as a discriminated union keyed on `kind` (src/lib/email/
  -- payload.ts), which is what makes "every kind has a template and every
  -- enqueue site passes the matching shape" a compile-time guarantee.
  --
  -- Snapshotting the INPUTS rather than the rendered HTML is the pattern this
  -- codebase already uses twice (bookings.fee_config_snapshot,
  -- payout_bookings.net_centavos): a receipt shows what was true when payment
  -- landed even if the booking is later refunded, AND a template typo found
  -- after enqueueing is still fixed by a retry.
  payload jsonb not null,

  -- What this email is about. Both nullable: a booking email has no court_id,
  -- a court-moderation email has no booking. No `on delete` clause (Postgres
  -- default NO ACTION / RESTRICT), matching every other FK in this schema.
  booking_id uuid references bookings (id),
  court_id uuid references courts (id),

  status email_status not null default 'pending',
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  provider_message_id text,

  created_at timestamptz not null default now(),
  sent_at timestamptz,

  -- sent iff timestamped, the same shape as payouts_paid_has_timestamp.
  constraint email_outbox_sent_has_timestamp
    check ((status = 'sent') = (sent_at is not null))
);

-- THE IDEMPOTENCY PRIMITIVE. At most one receipt per booking, at most one
-- reminder per booking. Enqueue uses `on conflict do nothing`, so a webhook
-- replay is a no-op at the DATABASE level rather than by care -- the same
-- trick payments.provider_ref already plays.
--
-- Partial, and court_moderated is deliberately OUTSIDE it: court_id carries no
-- uniqueness, because a court can be edited, requeued to pending, and approved
-- again, and its owner should hear each time.
create unique index if not exists email_outbox_booking_kind_idx
  on email_outbox (kind, booking_id) where booking_id is not null;

-- The drain query. Partial on a column that is mostly not 'pending'.
create index if not exists email_outbox_due_idx
  on email_outbox (next_attempt_at) where status = 'pending';

-- The /admin/emails queue.
create index if not exists email_outbox_failed_idx
  on email_outbox (created_at) where status = 'failed';

-- Index every FK explicitly. The partial unique index above leads on `kind`
-- and so does not serve a booking_id lookup.
create index if not exists email_outbox_booking_id_idx on email_outbox (booking_id);
create index if not exists email_outbox_court_id_idx on email_outbox (court_id);

-- Deny-by-default, like every other table: the publishable key ships in the
-- browser and must never reach this table. Do NOT add policies, and do NOT use
-- `force row level security`.
alter table email_outbox enable row level security;
```

- [ ] **Step 2: Apply it**

```bash
export $(grep -E '^DATABASE_URL=' .env.local | xargs) && npx supabase db push --db-url "$DATABASE_URL"
```

Expected: applies cleanly.

- [ ] **Step 3: Prove idempotency by reading, not by re-pushing**

A second `db push` records the migration as already applied and **skips** it, so re-running proves nothing. Read your own file and confirm every statement is guarded: the `do $$` block checks `pg_type` for both enums, `create table` uses `if not exists`, all five `create index` use `if not exists`, and `enable row level security` is a no-op when already enabled. Inline table constraints need no guard.

State in your report which statement corresponds to which guard.

- [ ] **Step 4: Regenerate types**

```bash
npx drizzle-kit pull
```

`src/db/schema.ts` is generated bookkeeping and nothing imports it. It legitimately contains a `TS2304`-shaped error (drizzle-kit emits `profiles`' FK to `auth.users` without importing `users`) — that file is excluded in `tsconfig.json`, which is why `tsc` stays clean. Do NOT "fix" it and do NOT add to the exclude.

- [ ] **Step 5: Add the fixture**

Append to `tests/helpers/fixtures.ts`, after `seedPayoutLine`:

```ts
/**
 * An `email_outbox` row. Defaults describe a plausible pending receipt; every
 * field is overridable because the schema and drain tests exist specifically
 * to push each one over its edge.
 *
 * No teardown tracking of its own: teardownFixtures() deletes outbox rows by
 * tracked booking/court before it deletes those (both FKs are RESTRICT).
 */
export async function seedOutboxRow(opts: {
  kind: string
  recipient?: string
  payload?: object
  bookingId?: string | null
  courtId?: string | null
  status?: 'pending' | 'sent' | 'failed'
  attempts?: number
  nextAttemptAt?: Date
}): Promise<string> {
  const status = opts.status ?? 'pending'
  const result = await db.execute(sql`
    insert into email_outbox (
      kind, recipient, payload, booking_id, court_id,
      status, attempts, next_attempt_at, sent_at
    ) values (
      ${opts.kind}::email_kind,
      ${opts.recipient ?? `player-${crypto.randomUUID()}@example.test`},
      ${JSON.stringify(opts.payload ?? { placeholder: true })}::jsonb,
      ${opts.bookingId ?? null}::uuid,
      ${opts.courtId ?? null}::uuid,
      ${status}::email_status,
      ${opts.attempts ?? 0},
      ${(opts.nextAttemptAt ?? new Date()).toISOString()}::timestamptz,
      ${status === 'sent' ? new Date().toISOString() : null}::timestamptz
    )
    returning id
  `)
  return result.rows[0].id as string
}
```

- [ ] **Step 6: Extend `teardownFixtures`**

`email_outbox.booking_id` and `.court_id` are RESTRICT. A surviving outbox row blocks the bookings delete and the `auth.users` cascade, which would abort teardown and leak the run's rows into the shared, persistent database.

Insert this **before** the existing `delete from payout_bookings`:

```ts
  // Must precede the bookings delete AND the auth.users cascade:
  // email_outbox.booking_id and .court_id are NO ACTION (RESTRICT), like
  // payout_bookings, payments and reviews. The booking predicate mirrors the
  // bookings delete below exactly, so no row can be missed by a row a later
  // statement removes; the court predicate reaches rows whose booking_id is
  // null (court_moderated emails).
  await db.execute(sql`
    delete from email_outbox
    where booking_id in (
        select id from bookings
        where player_id = any (${sql.param(ids)}::uuid[])
           or created_by = any (${sql.param(ids)}::uuid[])
           or branch_id in (
             select id from branches where owner_id = any (${sql.param(ids)}::uuid[])
           )
      )
       or court_id in (
        select c.id from courts c
        join branches b on b.id = c.branch_id
        where b.owner_id = any (${sql.param(ids)}::uuid[])
      )
  `)
```

Then update the function's doc comment: the FK-safe order is now
`email_outbox → payout_bookings → payouts → reviews → payments → bookings → auth.users`.

- [ ] **Step 7: Write the schema tests**

Create `tests/schema/email-outbox.test.ts`:

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  manilaHour,
  seedBooking,
  seedBranchWithCourts,
  seedOutboxRow,
  seedPlayer,
  teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

const UNIQUE_VIOLATION = '23505'
const CHECK_VIOLATION = '23514'

function sqlStateOf(error: unknown): string | undefined {
  return (
    (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code
  )
}

async function expectSqlState(promise: Promise<unknown>, code: string) {
  try {
    await promise
  } catch (error) {
    expect(sqlStateOf(error)).toBe(code)
    return
  }
  throw new Error(`expected SQLSTATE ${code}, but the statement succeeded`)
}

test('a booking gets at most one email of each kind', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-09-02', 12), status: 'confirmed',
  })

  await seedOutboxRow({ kind: 'booking_confirmed', bookingId })
  // A DIFFERENT kind for the same booking is fine — the receipt and the
  // reminder are two emails.
  await seedOutboxRow({ kind: 'booking_reminder', bookingId })
  // A second receipt is not. This is what makes a webhook replay a no-op.
  await expectSqlState(
    seedOutboxRow({ kind: 'booking_confirmed', bookingId }),
    UNIQUE_VIOLATION,
  )
})

test('court emails are deliberately NOT deduplicated', async () => {
  // A court can be edited, requeued to pending, and approved again. Its owner
  // should hear each time, so court_id carries no uniqueness.
  const { courtIds } = await seedBranchWithCourts(1)
  await seedOutboxRow({ kind: 'court_moderated', courtId: courtIds[0] })
  await seedOutboxRow({ kind: 'court_moderated', courtId: courtIds[0] })

  const count = await db.execute(sql`
    select count(*)::int as n from email_outbox where court_id = ${courtIds[0]}::uuid
  `)
  expect(Number(count.rows[0].n)).toBe(2)
})

test('sent and sent_at must agree in both directions', async () => {
  await expectSqlState(
    db.execute(sql`
      insert into email_outbox (kind, recipient, payload, status, sent_at)
      values ('booking_confirmed'::email_kind, 'a@example.test', '{}'::jsonb,
              'sent'::email_status, null)
    `),
    CHECK_VIOLATION,
  )
  await expectSqlState(
    db.execute(sql`
      insert into email_outbox (kind, recipient, payload, status, sent_at)
      values ('booking_confirmed'::email_kind, 'a@example.test', '{}'::jsonb,
              'pending'::email_status, now())
    `),
    CHECK_VIOLATION,
  )
})

test('attempts cannot go negative', async () => {
  await expectSqlState(seedOutboxRow({ kind: 'booking_new', attempts: -1 }), CHECK_VIOLATION)
})
```

Note: the last two tests insert rows with no `booking_id`/`court_id`, so `teardownFixtures` will not reach them. That is deliberate and harmless — the check-violation rows never commit, and the `attempts: -1` row never commits either.

- [ ] **Step 8: Run the schema tests**

```bash
npx vitest run tests/schema/email-outbox.test.ts
```

Expected: 4 passed.

- [ ] **Step 9: Confirm nothing else regressed**

```bash
npx vitest run tests/schema tests/payouts tests/refunds
```

Expected: all pass except the known `tests/schema/settings.test.ts` baseline failure. The teardown change touches every suite, so a leak or FK error shows up here.

- [ ] **Step 10: Gate and report (do not commit)**

```bash
npx tsc --noEmit && npm run lint
```

---

### Task 3: Payload types, templates, and rendering

**Files:**
- Create: `src/lib/email/payload.ts`
- Create: `src/lib/email/templates/layout.tsx`
- Create: `src/lib/email/templates/booking-confirmed.tsx`
- Create: `src/lib/email/templates/booking-new.tsx`
- Create: `src/lib/email/templates/booking-reminder.tsx`
- Create: `src/lib/email/templates/court-moderated.tsx`
- Create: `src/lib/email/templates/refund-recorded.tsx`
- Create: `src/lib/email/render.ts`
- Create: `tests/email/render.test.ts`

**Interfaces:**
- Consumes: `EmailMessage` from Task 1 (the `subject`/`html`/`text` shape).
- Produces:
  ```ts
  // payload.ts — the discriminated union, keyed on `kind`
  export type BookingEmailFacts = {
    playerName: string | null
    branchName: string
    courtName: string
    /** Manila calendar date, `YYYY-MM-DD`. */
    bookedOn: string
    /** Manila hours, 24h. */
    startHour: number
    endHour: number
    totalChargedCentavos: number
    bookingId: string
  }
  export type EmailPayload =
    | { kind: 'booking_confirmed'; booking: BookingEmailFacts }
    | { kind: 'booking_new'; booking: BookingEmailFacts; ownerName: string | null }
    | { kind: 'booking_reminder'; booking: BookingEmailFacts }
    | { kind: 'court_moderated'; ownerName: string | null; branchName: string; courtName: string; approved: boolean; rejectionReason: string | null }
    | { kind: 'refund_recorded'; playerName: string | null; branchName: string; courtName: string; bookedOn: string; amountCentavos: number; bookingCancelled: boolean }
  export type EmailKind = EmailPayload['kind']

  // render.ts
  export async function renderEmail(payload: EmailPayload): Promise<{ subject: string; html: string; text: string }>
  ```

- [ ] **Step 1: Read the branding rules first**

Read `design/branding.md` before writing any template — colors, type, and the no-gradients rule apply. Email cannot use CSS variables (mail clients strip `:root`), so **resolve every token to its literal hex** in the templates and leave a comment saying which `branding.md` token each value came from. That is the one place in this codebase where duplicating a token value is correct.

- [ ] **Step 2: Write the failing tests**

Create `tests/email/render.test.ts`:

```ts
import { expect, test } from 'vitest'
import { renderEmail, type EmailPayload } from '@/lib/email/render'

const BOOKING = {
  playerName: 'Ana Cruz',
  branchName: 'Smash Zone – Marikina',
  courtName: 'Court 1',
  bookedOn: '2026-09-15',
  startHour: 17,
  endHour: 19,
  totalChargedCentavos: 73000,
  bookingId: '11111111-2222-3333-4444-555555555555',
}

test('every kind renders a subject, html, and a non-empty text part', async () => {
  // A text part is not optional: HTML-only mail is a spam-filter signal, and a
  // receipt landing in spam is the same as not sending it.
  const payloads: EmailPayload[] = [
    { kind: 'booking_confirmed', booking: BOOKING },
    { kind: 'booking_new', booking: BOOKING, ownerName: 'Smash Zone' },
    { kind: 'booking_reminder', booking: BOOKING },
    { kind: 'court_moderated', ownerName: 'Smash Zone', branchName: BOOKING.branchName, courtName: 'Court 2', approved: true, rejectionReason: null },
    { kind: 'refund_recorded', playerName: 'Ana Cruz', branchName: BOOKING.branchName, courtName: 'Court 1', bookedOn: '2026-09-15', amountCentavos: 73000, bookingCancelled: true },
  ]

  for (const payload of payloads) {
    const rendered = await renderEmail(payload)
    expect(rendered.subject.length, payload.kind).toBeGreaterThan(0)
    expect(rendered.html, payload.kind).toContain('<')
    expect(rendered.text.trim().length, payload.kind).toBeGreaterThan(0)
  }
})

test('the receipt carries the facts a player needs to show up and to reconcile', async () => {
  const { subject, html, text } = await renderEmail({ kind: 'booking_confirmed', booking: BOOKING })
  expect(subject).toContain('Smash Zone – Marikina')
  for (const body of [html, text]) {
    expect(body).toContain('Court 1')
    expect(body).toContain('₱730.00')     // formatPeso(73000)
    // formatHourRange(17, 19) collapses a shared period to ONE label:
    // "5 – 7 PM", not "5 PM – 7 PM". Asserting on "5 PM" would fail.
    // The separator is an EN DASH (U+2013), not a hyphen.
    expect(body).toContain('5 – 7 PM')
    expect(body).toContain('Tue, Sep 15')  // formatDateLabel('2026-09-15')
  }
})

test('a rejection carries its reason and an approval does not invent one', async () => {
  const rejected = await renderEmail({
    kind: 'court_moderated', ownerName: 'Smash Zone', branchName: 'Smash Zone – Marikina',
    courtName: 'Court 2', approved: false, rejectionReason: 'Rate bands do not cover opening hours.',
  })
  expect(rejected.html).toContain('Rate bands do not cover opening hours.')
  expect(rejected.text).toContain('Rate bands do not cover opening hours.')

  const approved = await renderEmail({
    kind: 'court_moderated', ownerName: 'Smash Zone', branchName: 'Smash Zone – Marikina',
    courtName: 'Court 2', approved: true, rejectionReason: null,
  })
  // Per the subject table below: approval reads "is now live", rejection reads
  // "needs changes". Assert the real strings, not a loose keyword.
  expect(approved.subject).toContain('is now live')
  expect(rejected.subject).toContain('needs changes')
  // An approval must not leak the rejection branch's framing.
  expect(approved.text.toLowerCase()).not.toContain('needs changes')
})

test('a refund on a cancelled booking says so; one on an unconfirmed booking does not', async () => {
  const base = {
    kind: 'refund_recorded' as const, playerName: 'Ana Cruz',
    branchName: 'Smash Zone – Marikina', courtName: 'Court 1',
    bookedOn: '2026-09-15', amountCentavos: 73000,
  }
  const cancelled = await renderEmail({ ...base, bookingCancelled: true })
  const orphan = await renderEmail({ ...base, bookingCancelled: false })
  expect(cancelled.text).toContain('cancelled')
  expect(orphan.text).not.toContain('cancelled')
  expect(orphan.text).toContain('₱730.00')
})

test('a missing player name does not render "null" at the reader', async () => {
  // Google gives us a name, but profiles.full_name is nullable and a hand-seeded
  // row can lack one. "Hi null," is the classic template bug.
  const { html, text } = await renderEmail({
    kind: 'booking_confirmed',
    booking: { ...BOOKING, playerName: null },
  })
  expect(html).not.toContain('null')
  expect(text).not.toContain('null')
})
```

- [ ] **Step 3: Run and watch them fail**

```bash
npx vitest run tests/email/render.test.ts
```

Expected: fails to resolve `@/lib/email/render`.

- [ ] **Step 4: Write the payload union**

Create `src/lib/email/payload.ts` with exactly the types in the Interfaces block above. Add this doc comment at the top:

```ts
/**
 * What each email needs, snapshotted at enqueue time.
 *
 * A DISCRIMINATED UNION keyed on `kind` is what makes this slice type-safe end
 * to end: renderEmail switches exhaustively over it, so a new kind without a
 * template does not compile, and an enqueue site passing the wrong shape does
 * not compile either. The JSONB column is untyped at the database edge; this
 * file is the only thing standing between that and a runtime surprise.
 *
 * These are FACTS, not references. `courtName` is the name at the time of the
 * booking, not a join — the court can be renamed and a receipt must not change.
 */
```

Note this file does **not** need `import 'server-only'` — it is types only, and the `/admin/emails` page benefits from being able to type-import it.

- [ ] **Step 5: Write the shared layout**

Create `src/lib/email/templates/layout.tsx`. It wraps every email: the OnCourt wordmark, a white content card on the app's surface color, and a footer line. Use `@react-email/components`' `Html`, `Head`, `Preview`, `Body`, `Container`, `Section`, `Text`, `Hr`.

Resolve `branding.md`'s tokens to literal hex with a comment naming each one — mail clients strip `:root`, so CSS variables cannot be used. Export:

```tsx
export function EmailLayout({ preview, children }: { preview: string; children: React.ReactNode })
```

`preview` is the inbox preview line and is required, not optional — an email whose preview text is the first line of boilerplate wastes the only thing a reader sees before opening.

- [ ] **Step 6: Write the five templates**

Each is a function component taking its payload variant and returning `EmailLayout`-wrapped content. Content, exactly:

| File | Subject | Body carries |
|---|---|---|
| `booking-confirmed.tsx` | `Your booking at {branchName} is confirmed` | greeting; court, date (`formatDateLabel`), time (`formatHourRange`), total (`formatPeso`); a "what to bring / arrive early" line; booking reference (`bookingId`) |
| `booking-new.tsx` | `New booking at {branchName}` | greeting to owner; court, date, time, total; a line pointing at `/dashboard/bookings` |
| `booking-reminder.tsx` | `You play today at {branchName}` | greeting; court, time today, address-free reminder to arrive early; booking reference |
| `court-moderated.tsx` | approved → `{courtName} at {branchName} is now live`; rejected → `{courtName} at {branchName} needs changes` | greeting to owner; the verdict; **the rejection reason verbatim when rejected**; a line pointing at `/dashboard/listings` |
| `refund-recorded.tsx` | `Your refund for {branchName} has been processed` | greeting; amount (`formatPeso`), court, original date; when `bookingCancelled`, a sentence saying the booking has been cancelled; when not, a sentence saying the payment did not complete a booking |

Every greeting must handle a null name — fall back to a plain "Hi," rather than interpolating. Every peso figure goes through `formatPeso`; every date through `formatDateLabel`; every time through `formatHourRange` / `formatHour`.

- [ ] **Step 7: Write the renderer**

Create `src/lib/email/render.ts`:

```ts
import 'server-only'
import { render } from '@react-email/render'
import type { EmailPayload } from './payload'
// ...template imports

export type { EmailPayload } from './payload'

/**
 * The one place a payload becomes an email.
 *
 * The switch is EXHAUSTIVE by construction: `kind` discriminates the union, so
 * adding a variant without a case here is a compile error, not a runtime
 * surprise in the drainer at 3am.
 *
 * Both parts are produced from the same component tree — `render(..., { plainText: true })`
 * derives the text part from the JSX rather than from a second hand-maintained
 * string, so the two can never drift.
 */
export async function renderEmail(
  payload: EmailPayload,
): Promise<{ subject: string; html: string; text: string }> {
  const { subject, element } = select(payload)
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ])
  return { subject, html, text }
}
```

`select(payload)` is a private exhaustive switch returning `{ subject, element }`. End it with a `never` check so a missing case fails the build:

```ts
default: {
  const exhaustive: never = payload
  throw new Error(`No template for ${(exhaustive as { kind: string }).kind}`)
}
```

- [ ] **Step 8: Run the tests**

```bash
npx vitest run tests/email/render.test.ts
```

Expected: 5 passed. If an assertion on rendered text fails because React Email escapes the `–` in "Smash Zone – Marikina" or the `₱`, fix the **assertion** to match real output — do not weaken it to a substring that would pass on a broken template.

- [ ] **Step 9: Gate and report (do not commit)**

```bash
npx tsc --noEmit && npm run lint
```

Report the rendered subject line of each of the five kinds verbatim, so a human can sanity-check the copy without running anything.

---

### Task 4: The outbox enqueue

**Files:**
- Create: `src/lib/email/outbox.ts`
- Create: `tests/email/outbox.test.ts`

**Interfaces:**
- Consumes: `EmailPayload` (Task 3); the `email_outbox` table (Task 2).
- Produces:
  ```ts
  export type SqlExecutor = { execute: typeof db.execute }
  export async function enqueueEmail(
    exec: SqlExecutor,
    input: { payload: EmailPayload; recipient: string; bookingId?: string | null; courtId?: string | null },
  ): Promise<void>
  export async function getFailedEmailCount(): Promise<number>
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/email/outbox.test.ts`. The two properties that matter: the enqueue joins the caller's transaction, and a replay is a no-op.

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { enqueueEmail, getFailedEmailCount } from '@/lib/email/outbox'
import {
  manilaHour, seedBooking, seedBranchWithCourts, seedOutboxRow, seedPlayer, teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

const ROLLBACK = new Error('rollback')

function facts(bookingId: string) {
  return {
    playerName: 'Ana Cruz', branchName: 'Fixture Branch', courtName: 'Court 1',
    bookedOn: '2026-09-20', startHour: 17, endHour: 19,
    totalChargedCentavos: 73000, bookingId,
  }
}

async function outboxCount(bookingId: string) {
  const r = await db.execute(sql`
    select count(*)::int as n from email_outbox where booking_id = ${bookingId}::uuid
  `)
  return Number(r.rows[0].n)
}

test('an enqueue joins the caller transaction and dies with it', async () => {
  // THE POINT OF THE OUTBOX: "booking confirmed" and "receipt owed" commit or
  // fail together. If the enqueue opened its own connection, a rolled-back
  // booking would still email the player.
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-09-20', 17), status: 'confirmed',
  })

  await expect(
    db.transaction(async (tx) => {
      await enqueueEmail(tx, {
        payload: { kind: 'booking_confirmed', booking: facts(bookingId) },
        recipient: 'ana@example.test',
        bookingId,
      })
      expect(await outboxCount(bookingId)).toBe(0) // not visible outside yet
      throw ROLLBACK
    }),
  ).rejects.toThrow(ROLLBACK)

  expect(await outboxCount(bookingId)).toBe(0)
})

test('a replay is a no-op, not an error', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-09-21', 17), status: 'confirmed',
  })
  const input = {
    payload: { kind: 'booking_confirmed' as const, booking: facts(bookingId) },
    recipient: 'ana@example.test',
    bookingId,
  }

  await enqueueEmail(db, input)
  await enqueueEmail(db, input)   // must not throw 23505
  expect(await outboxCount(bookingId)).toBe(1)
})

test('different kinds for one booking coexist', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-09-22', 17), status: 'confirmed',
  })
  await enqueueEmail(db, {
    payload: { kind: 'booking_confirmed', booking: facts(bookingId) },
    recipient: 'ana@example.test', bookingId,
  })
  await enqueueEmail(db, {
    payload: { kind: 'booking_reminder', booking: facts(bookingId) },
    recipient: 'ana@example.test', bookingId,
  })
  expect(await outboxCount(bookingId)).toBe(2)
})

test('the payload round-trips through jsonb intact', async () => {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  const bookingId = await seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour('2026-09-23', 17), status: 'confirmed',
  })
  await enqueueEmail(db, {
    payload: { kind: 'booking_confirmed', booking: facts(bookingId) },
    recipient: 'ana@example.test', bookingId,
  })
  const row = await db.execute(sql`
    select payload from email_outbox where booking_id = ${bookingId}::uuid
  `)
  expect(row.rows[0].payload).toMatchObject({
    kind: 'booking_confirmed',
    booking: { totalChargedCentavos: 73000, courtName: 'Court 1' },
  })
})

test('the failed count tracks the queue', async () => {
  const before = await getFailedEmailCount()
  await seedOutboxRow({ kind: 'booking_new', status: 'failed' })
  expect(await getFailedEmailCount()).toBe(before + 1)
})
```

The last test is a delta against `before`, never an absolute count — the database is shared and other suites create rows.

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run tests/email/outbox.test.ts
```

- [ ] **Step 3: Write the module**

Create `src/lib/email/outbox.ts`:

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { EmailPayload } from './payload'

/**
 * Structurally minimal so both `db` and a Drizzle transaction handle satisfy
 * it — the same type and the same reasoning as SqlExecutor in
 * src/lib/admin/settings.ts, verified there against drizzle-orm 0.45.2.
 */
export type SqlExecutor = { execute: typeof db.execute }

/**
 * Enqueue an email inside the CALLER'S transaction.
 *
 * `exec` is a parameter, not a captured `db`, and that is the entire design:
 * the enqueue must join the transaction that made the state change, so
 * "booking confirmed" and "receipt owed" commit or fail together. Passing `db`
 * here from inside a transaction would open a second connection and defeat it.
 *
 * `on conflict do nothing` against email_outbox_booking_kind_idx makes a
 * webhook replay a no-op at the DATABASE level rather than by care. It is
 * unconditional rather than kind-specific because the index is partial —
 * a row with a null booking_id (court_moderated) is not covered by it and so
 * can never conflict.
 */
export async function enqueueEmail(
  exec: SqlExecutor,
  input: {
    payload: EmailPayload
    recipient: string
    bookingId?: string | null
    courtId?: string | null
  },
): Promise<void> {
  await exec.execute(sql`
    insert into email_outbox (kind, recipient, payload, booking_id, court_id)
    values (
      ${input.payload.kind}::email_kind,
      ${input.recipient},
      ${JSON.stringify(input.payload)}::jsonb,
      ${input.bookingId ?? null}::uuid,
      ${input.courtId ?? null}::uuid
    )
    on conflict do nothing
  `)
}

/** Just the number, for the /admin nav badge. */
export async function getFailedEmailCount(): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as count from email_outbox where status = 'failed'
  `)
  return Number(result.rows[0].count)
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/email/outbox.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Gate and report (do not commit)**

```bash
npx tsc --noEmit && npm run lint
```

---

### Task 5: The drain loop

**Files:**
- Create: `src/lib/email/drain.ts`
- Create: `tests/email/drain.test.ts`

**Interfaces:**
- Consumes: `EmailProvider` (Task 1), `renderEmail` (Task 3), the table (Task 2).
- Produces:
  ```ts
  export const BACKOFF_MINUTES: readonly number[]   // [1, 5, 15, 60, 360]
  export const MAX_ATTEMPTS: number                  // 5
  export type DrainResult = { claimed: number; sent: number; retrying: number; failed: number }
  export async function drainOutbox(provider: EmailProvider, limit?: number): Promise<DrainResult>
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/email/drain.test.ts`. Cover: only-due claiming, success marking, retryable backoff, non-retryable terminal, max attempts, a throwing template, and concurrency.

```ts
import { afterAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { drainOutbox, MAX_ATTEMPTS } from '@/lib/email/drain'
import { fakeProvider } from '@/lib/email/fake'
import {
  manilaHour, seedBooking, seedBranchWithCourts, seedOutboxRow, seedPlayer, teardownFixtures,
} from '../helpers/fixtures'

afterAll(teardownFixtures)

const PAYLOAD = {
  kind: 'booking_confirmed',
  booking: {
    playerName: 'Ana Cruz', branchName: 'Fixture Branch', courtName: 'Court 1',
    bookedOn: '2026-09-25', startHour: 17, endHour: 19,
    totalChargedCentavos: 73000, bookingId: '11111111-2222-3333-4444-555555555555',
  },
}

async function seedDueRow(bookingId: string, over?: Partial<Parameters<typeof seedOutboxRow>[0]>) {
  return seedOutboxRow({ kind: 'booking_confirmed', payload: PAYLOAD, bookingId, ...over })
}

async function row(id: string) {
  const r = await db.execute(sql`
    select status::text as status, attempts, last_error, provider_message_id, sent_at,
           next_attempt_at, recipient
    from email_outbox where id = ${id}::uuid
  `)
  return r.rows[0]
}

async function seedBookingFor(date: string, hour: number) {
  const { branchId, courtIds } = await seedBranchWithCourts(1)
  const playerId = await seedPlayer()
  return seedBooking({
    courtId: courtIds[0], branchId, playerId,
    startsAt: manilaHour(date, hour), status: 'confirmed',
  })
}

test('a due row sends and is marked, with the provider message id kept', async () => {
  const bookingId = await seedBookingFor('2026-09-25', 17)
  const id = await seedDueRow(bookingId)
  const provider = fakeProvider()

  const result = await drainOutbox(provider, 50)
  expect(result.sent).toBeGreaterThanOrEqual(1)

  const r = await row(id)
  expect(r.status).toBe('sent')
  expect(r.sent_at).not.toBeNull()
  expect(r.provider_message_id).toBeTruthy()

  // The row's own recipient must be the one addressed — a drainer that sent
  // every email to the same address would still pass a looser assertion.
  const mine = provider.sent.find((m) => m.to === (r.recipient as string))
  expect(mine).toBeDefined()
  expect(mine!.subject).toContain('Fixture Branch')
  expect(mine!.text.trim().length).toBeGreaterThan(0)
})

test('a row not yet due is left alone', async () => {
  const bookingId = await seedBookingFor('2026-09-26', 17)
  const future = new Date(Date.now() + 60 * 60 * 1000)
  const id = await seedDueRow(bookingId, { nextAttemptAt: future })

  await drainOutbox(fakeProvider(), 50)
  expect((await row(id)).status).toBe('pending')
})

test('a retryable failure backs off and keeps the error', async () => {
  const bookingId = await seedBookingFor('2026-09-27', 17)
  const id = await seedDueRow(bookingId)
  const before = new Date()

  await drainOutbox(fakeProvider({ failWith: { retryable: true, error: 'resend 503' } }), 50)

  const r = await row(id)
  expect(r.status).toBe('pending')
  expect(Number(r.attempts)).toBe(1)
  expect(r.last_error).toContain('503')
  expect(new Date(r.next_attempt_at as string).getTime()).toBeGreaterThan(before.getTime())
})

test('a non-retryable failure goes terminal in one step', async () => {
  const bookingId = await seedBookingFor('2026-09-28', 17)
  const id = await seedDueRow(bookingId)

  await drainOutbox(fakeProvider({ failWith: { retryable: false, error: 'invalid address' } }), 50)

  const r = await row(id)
  expect(r.status).toBe('failed')
  expect(Number(r.attempts)).toBe(1)
  expect(r.last_error).toContain('invalid address')
})

test('the last allowed attempt goes terminal rather than retrying forever', async () => {
  const bookingId = await seedBookingFor('2026-09-29', 17)
  const id = await seedDueRow(bookingId, { attempts: MAX_ATTEMPTS - 1 })

  await drainOutbox(fakeProvider({ failWith: { retryable: true, error: 'still down' } }), 50)

  const r = await row(id)
  expect(r.status).toBe('failed')
  expect(Number(r.attempts)).toBe(MAX_ATTEMPTS)
})

test('a payload the templates cannot render fails that row without taking the batch down', async () => {
  const goodBooking = await seedBookingFor('2026-09-30', 17)
  const badBooking = await seedBookingFor('2026-09-30', 19)
  const good = await seedDueRow(goodBooking)
  const bad = await seedOutboxRow({
    kind: 'booking_confirmed',
    payload: { kind: 'nonsense' },   // renderEmail's exhaustive switch throws
    bookingId: badBooking,
  })

  await drainOutbox(fakeProvider(), 50)

  expect((await row(good)).status).toBe('sent')
  const r = await row(bad)
  expect(r.status).toBe('failed')
  expect(r.last_error).toBeTruthy()
})

test('two concurrent drains send each row exactly once', async () => {
  // `for update skip locked` is what makes this safe. Without it both drains
  // claim the same rows and every player gets two receipts.
  const ids: string[] = []
  for (let hour = 12; hour < 18; hour++) {
    const bookingId = await seedBookingFor('2026-10-01', hour)
    ids.push(await seedDueRow(bookingId))
  }

  const a = fakeProvider()
  const b = fakeProvider()
  await Promise.all([drainOutbox(a, 10), drainOutbox(b, 10)])

  const mine = await db.execute(sql`
    select status::text as status from email_outbox
    where id = any (${sql.param(ids)}::uuid[])
  `)
  expect(mine.rows.every((r) => r.status === 'sent')).toBe(true)
  expect(a.sent.length + b.sent.length).toBe(ids.length)
})
```

- [ ] **Step 2: Run and watch them fail**

```bash
npx vitest run tests/email/drain.test.ts
```

- [ ] **Step 3: Write the module**

Create `src/lib/email/drain.ts`. Structure: one transaction per row (so a slow send never holds a lock across the whole batch), claiming with `for update skip locked`.

```ts
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import type { EmailProvider } from './provider'
import { renderEmail } from './render'
import type { EmailPayload } from './payload'

/**
 * Attempt N waits BACKOFF_MINUTES[N-1] before the next try. A fixed list, not
 * a computed exponent: five values read more clearly as a list than as a
 * formula, and the 6-hour ceiling is a deliberate stop rather than an
 * exponent's accident.
 */
export const BACKOFF_MINUTES = [1, 5, 15, 60, 360] as const
export const MAX_ATTEMPTS = 5

export type DrainResult = { claimed: number; sent: number; retrying: number; failed: number }

/**
 * Claim due rows, render, send, mark.
 *
 * ONE TRANSACTION PER ROW, not one for the batch. A batch-wide transaction
 * would hold every claimed row's lock for the duration of every HTTP call, so
 * one slow send would stall the queue — and a crash mid-batch would roll back
 * sends that already left Resend, producing duplicates on the retry.
 *
 * `for update skip locked` is what makes concurrent drains safe: two runs
 * never claim the same row and neither blocks the other. (An advisory lock
 * would serialize the whole queue; skip-locked is the right primitive for a
 * work queue, unlike preparePayout's per-owner lock.)
 */
export async function drainOutbox(provider: EmailProvider, limit = 25): Promise<DrainResult>
```

The body: select ids to consider (`status = 'pending' and next_attempt_at <= now()`, ordered by `next_attempt_at`, limited), then for each id open a transaction that re-selects that row `for update skip locked` — zero rows means another drain took it, so skip — renders, sends, and applies the marking table below. `renderEmail` throwing is caught and treated as non-retryable.

| Outcome | Update |
|---|---|
| `ok: true` | `status = 'sent'`, `sent_at = now()`, `provider_message_id`, `attempts = attempts + 1` |
| retryable, `attempts + 1 < MAX_ATTEMPTS` | `attempts + 1`, `next_attempt_at = now() + BACKOFF_MINUTES[attempts] minutes`, `last_error` |
| retryable, `attempts + 1 >= MAX_ATTEMPTS` | `status = 'failed'`, `attempts + 1`, `last_error` |
| not retryable, or render threw | `status = 'failed'`, `attempts + 1`, `last_error` |

Cast the payload with `row.payload as EmailPayload` and let `renderEmail`'s exhaustive switch reject anything unexpected — that is the runtime guard for a column the database types only as `jsonb`.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run tests/email/drain.test.ts
```

Expected: 7 passed. If the concurrency test is flaky, re-run it in isolation first — this hosted database has known pool-contention timeouts under parallel load. Do **not** weaken the assertion.

- [ ] **Step 5: Gate and report (do not commit)**

```bash
npx tsc --noEmit && npm run lint
```

---

### Task 6: Wire the four enqueue sites

**Files:**
- Modify: `src/lib/payments/webhook.ts`
- Modify: `src/lib/admin/write.ts` (`approveCourt`, `rejectCourt` only)
- Modify: `src/lib/refunds/write.ts` (`recordPaymentRefund`)
- Create: `tests/email/enqueue-sites.test.ts`

**Interfaces:**
- Consumes: `enqueueEmail` (Task 4), `EmailPayload` (Task 3).
- Produces: no new exports. Behavior only.

- [ ] **Step 1: Read each site's transaction before changing it**

Read `src/lib/payments/webhook.ts` (especially the `CONFIRMING_OUTCOMES` branch and the comment at :38-43), `src/lib/admin/write.ts`'s `approveCourt` / `rejectCourt`, and `src/lib/refunds/write.ts`'s `recordPaymentRefund`. Every enqueue goes **inside** the existing transaction, using the `tx` handle already in scope.

- [ ] **Step 2: Write the failing tests**

Create `tests/email/enqueue-sites.test.ts` asserting, for each site, that a successful state change leaves the right outbox rows and an unsuccessful one leaves none:

- `approveCourt` on a pending court with a valid schedule → exactly one `court_moderated` row for that court, `payload.approved === true`, recipient is the owner's email.
- `approveCourt` on an already-approved court (returns `stale`) → **no** row.
- `rejectCourt` with a reason → one `court_moderated` row, `payload.approved === false`, `payload.rejectionReason` matching.
- `recordPaymentRefund` on a confirmed booking with a paid payment → one `refund_recorded` row, `payload.bookingCancelled === true`.
- `recordPaymentRefund` on an orphan (booking `expired`) → one `refund_recorded` row, `payload.bookingCancelled === false`.
- `recordPaymentRefund` replayed → still exactly one row.

Query the outbox directly with `db.execute` and assert on `kind`, `recipient`, and `payload` fields.

The webhook path is covered by the existing `tests/payments/` suite plus one addition there: a confirming outcome leaves exactly one `booking_confirmed` and one `booking_new` row; a non-confirming outcome leaves none. Add those assertions to the existing webhook test file rather than duplicating its elaborate setup.

- [ ] **Step 3: Run and watch them fail**

```bash
npx vitest run tests/email/enqueue-sites.test.ts
```

- [ ] **Step 4: Wire the webhook**

Inside the transaction, in the `CONFIRMING_OUTCOMES.has(outcome)` branch, after the booking UPDATE succeeds, load the facts needed for the payload (player name/email, owner name/email, branch and court names, Manila date and hours, `total_charged_centavos`) with one query and enqueue two rows: `booking_confirmed` to the player, `booking_new` to the branch owner.

Then **amend the comment at :38-43**. It currently says "nothing is sent from inside the transaction." That is still true and still the rule — but it now needs to distinguish enqueue from send, because an INSERT into a local table is exactly what belongs inside. Say so explicitly; do not delete the comment.

- [ ] **Step 5: Wire the two moderation transitions**

In `approveCourt` and `rejectCourt`, after the UPDATE returns a row, enqueue one `court_moderated` row with `courtId` set and `bookingId` null.

**Do NOT wire `suspendCourt` or `unsuspendCourt`.** The product spec's notification table lists approval and rejection only; suspension is an enforcement action an admin normally pairs with direct contact, and an automated "your court was suspended" with no explanation would be worse than silence. Add a one-line comment in each of those two functions saying they deliberately do not email, so the next reader does not assume it was an oversight.

- [ ] **Step 6: Wire the refund**

In `recordPaymentRefund`, after the payment stamp succeeds, enqueue one `refund_recorded` row when the booking has a `player_id` — a `blocked` row has none and carries no money. `payload.bookingCancelled` is the same boolean the function already returns as `bookingRefunded`.

- [ ] **Step 7: Run the tests**

```bash
npx vitest run tests/email tests/payments tests/admin tests/refunds
```

Expected: all pass.

- [ ] **Step 8: Gate and report (do not commit)**

```bash
npx tsc --noEmit && npm run lint
```

Report the amended `webhook.ts` comment verbatim.

---

### Task 7: The two cron Route Handlers

**Files:**
- Create: `src/app/api/cron/drain-email/route.ts`
- Create: `src/app/api/cron/enqueue-reminders/route.ts`
- Create: `src/lib/email/cron-auth.ts`
- Create: `src/lib/email/reminders.ts`
- Create: `tests/email/routes.test.ts`

**Interfaces:**
- Consumes: `drainOutbox` (Task 5), `enqueueEmail` (Task 4).
- Produces:
  ```ts
  // cron-auth.ts
  export function isAuthorizedCron(request: Request): boolean
  // reminders.ts
  export async function enqueueDayOfReminders(): Promise<{ enqueued: number }>
  ```

- [ ] **Step 1: Write the cron auth helper**

Create `src/lib/email/cron-auth.ts`. Compare the `Authorization: Bearer <CRON_SECRET>` header with `crypto.timingSafeEqual` over equal-length buffers, returning false rather than throwing when the header is missing, malformed, or a different length. Reading `CRON_SECRET` happens inside the function, not at module scope.

- [ ] **Step 2: Write the reminder query**

Create `src/lib/email/reminders.ts` with `enqueueDayOfReminders()`. It selects bookings where `status = 'confirmed'`, `starts_at` falls on today's Manila calendar date, **and `starts_at > now()`**, joined to their court, branch, and player, then enqueues one `booking_reminder` per booking.

The `starts_at > now()` condition is not redundant with the date filter: seeded courts open at 11:00, but nothing stops an owner setting a 06:00 opening hour, and a "you play today" email for a session already underway is worse than none.

The partial unique index makes a double run of this endpoint a no-op, so it is safe to retry.

- [ ] **Step 3: Write the failing tests**

Create `tests/email/routes.test.ts`:

- Both handlers return **401** with no `Authorization` header.
- Both return **401** with a wrong secret.
- Both return **200** with the right secret.
- `enqueueDayOfReminders` enqueues for a confirmed booking later today, and **not** for: one already started, one tomorrow, one that is `pending_payment`, one that is `blocked`.
- Running `enqueueDayOfReminders` twice enqueues once.

Import the route's `POST` directly and call it with a constructed `Request`. Set `process.env.CRON_SECRET` in the test and restore it afterwards.

Note for the "later today" case: the test must seed a booking on **today's** Manila date at an hour still in the future. Derive it from `manilaToday()` and the current Manila hour rather than hardcoding, or the test breaks depending on when it runs.

- [ ] **Step 4: Run and watch them fail**

```bash
npx vitest run tests/email/routes.test.ts
```

- [ ] **Step 5: Write the handlers**

Both are thin: verify with `isAuthorizedCron`, call the lib, return a JSON count. Both pin `export const runtime = 'nodejs'`.

Each gets a doc comment mirroring `src/app/api/webhooks/paymongo/route.ts:5-16`: these are Route Handlers, **not** Server Actions, they carry no `'use server'` directive, and they are therefore exempt from `tests/auth/action-coverage.test.ts` by construction. What stands in for a session guard is the bearer secret. Never add `'use server'`.

`drain-email` constructs the real `resendProvider()` and passes it to `drainOutbox`.

- [ ] **Step 6: Run the tests**

```bash
npx vitest run tests/email/routes.test.ts && npx vitest run tests/auth/action-coverage.test.ts
```

Expected: all pass, and action-coverage stays green **without** the new routes being added to it.

- [ ] **Step 7: Verify the endpoints by hand**

```bash
npm run build
```

Confirm both routes appear in the route list. Then start the dev server through the **preview tool** (never `npm run dev` via Bash) and check the 401 path:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3030/api/cron/drain-email
```

Expected: `401`.

- [ ] **Step 8: Gate and report (do not commit)**

```bash
npx tsc --noEmit && npm run lint
```

Report both curl results and the route list lines.

---

### Task 8: The `/admin/emails` surface

**Files:**
- Create: `src/app/admin/emails/page.tsx`
- Create: `src/app/admin/emails/actions.ts`
- Create: `src/app/admin/emails/retry-form.tsx`
- Modify: `src/app/admin/layout.tsx` (nav item + badge)
- Modify: `src/lib/email/outbox.ts` (add `getFailedEmails`, `retryEmail`)
- Modify: `tests/email/outbox.test.ts` (tests for both)

**Interfaces:**
- Consumes: `getFailedEmailCount` (Task 4); `refuseUnlessAdmin` and `idFrom` from `@/lib/admin/guard`; `AdminFormState` from `@/app/admin/actions`; `requireAdminPage` from `@/lib/auth/page-guards`.
- Produces: `retryEmailAction(prevState, formData)`.

- [ ] **Step 1: Read the precedents**

Read `src/app/admin/refunds/page.tsx` and `src/app/admin/refunds/actions.ts` — this page is the same shape with a simpler list. Also `src/app/admin/layout.tsx` for the nav item and badge, and `design/branding.md`.

**`FOCUS_RING` must NOT start with `outline-none`.** `branding.md` documents that the `outline-none focus-visible:outline-2` pairing silently kills the ring in Tailwind v4. Copy the corrected form from `src/app/admin/payouts/[ownerId]/page.tsx`.

- [ ] **Step 2: Add the queries and the retry write**

In `src/lib/email/outbox.ts`:

```ts
export type FailedEmail = {
  id: string
  kind: string
  recipient: string
  attempts: number
  lastError: string | null
  createdOn: string
}
export async function getFailedEmails(): Promise<FailedEmail[]>

export type RetryResult = { ok: true } | { ok: false; reason: 'already_moved' }
export async function retryEmail(id: string): Promise<RetryResult>
```

`retryEmail` is a **status-scoped UPDATE** (`where id = ? and status = 'failed'`) setting `status = 'pending'`, `attempts = 0`, `next_attempt_at = now()`, `last_error = null`. Zero rows means "it already moved" — the shape every other write in this codebase uses. Use `returning id` + `rows.length`, never `rowCount`.

No limit on `getFailedEmails` — this is a work list, and a silent truncation would read as "that's all of them" when it isn't.

- [ ] **Step 3: Write the tests for both**

Append to `tests/email/outbox.test.ts`: `getFailedEmails` returns a seeded failed row and not a pending one; `retryEmail` flips a failed row back to pending with `attempts` reset and the error cleared; a second `retryEmail` on the same row returns `{ ok: false, reason: 'already_moved' }`; `retryEmail` on an unknown uuid returns the same rather than throwing.

Run:

```bash
npx vitest run tests/email/outbox.test.ts
```

- [ ] **Step 4: Write the action**

Create `src/app/admin/emails/actions.ts` mirroring `src/app/admin/refunds/actions.ts`: `refuseUnlessAdmin()` first, `idFrom(formData, 'emailId')` for the shape check, then `retryEmail`. On success `revalidatePath('/admin/emails')`. Message on failure: "That email has already been retried or sent."

- [ ] **Step 5: Write the client form and the page**

`retry-form.tsx` is a `'use client'` component using `useActionState`, importing only from `./actions` and `@/app/dashboard/listings/form-ui`. It may **type**-import from `@/lib/...` but never value-import — a value import of anything reaching `@/db` passes `tsc` and `lint` and then 500s at runtime.

`page.tsx` is a Server Component calling `await requireAdminPage('/admin/emails')` first, then `getFailedEmails()`. The list shows kind, recipient, attempts, the last error, and the created date, newest first, each row carrying a `<RetryForm emailId={...} />` using `BORDERED_BUTTON`.

Empty state: word it as reassurance, not absence — an empty failed queue is the good state.

- [ ] **Step 6: Add the nav item and badge**

In `src/app/admin/layout.tsx`, add `{ href: '/admin/emails', label: 'Emails', badge: failedEmails }` after Refunds, where `failedEmails` comes from `getFailedEmailCount()` called alongside the existing counts. Update the layout's doc comment: Users and Bookings remain the only later slices.

- [ ] **Step 7: Gate**

```bash
npx vitest run tests/email tests/auth/action-coverage.test.ts && npx tsc --noEmit && npm run lint && npm run build
```

Expected: all pass, lint still 9 warnings, `/admin/emails` in the route list.

- [ ] **Step 8: Report (do not commit)**

---

### Task 9: Full-suite gate and verification

- [ ] **Step 1: Run the whole suite in the foreground**

```bash
npx vitest run
```

Expected: everything passes except the two known `hold_duration_minutes` failures. If a file times out, re-run it in isolation before treating it as a failure, and report which files needed isolating.

- [ ] **Step 2: Full gate**

```bash
npx tsc --noEmit && npm run lint && npm run build
```

Lint must be 9 warnings, 0 errors. Build must list `/api/cron/drain-email`, `/api/cron/enqueue-reminders`, and `/admin/emails`.

- [ ] **Step 3: Verify the public surfaces did not move**

Through the preview tool (never `npm run dev` in Bash), on port 3030: check `/`, `/search`, and one `/venues/[slug]` page render with no console errors. This slice touches no public page, so anything here is a regression.

- [ ] **Step 4: End-to-end walk against the real database**

`/admin/*` cannot be browsed without a session, so prove the loop with a scratch script in the **scratchpad directory, never the repo**: seed a confirmed booking, enqueue a `booking_confirmed` row, run `drainOutbox` with the **fake** provider, and confirm the row goes `sent` with a message id and that the rendered subject and text are non-empty. Then seed a failed row and confirm `retryEmail` returns it to `pending`.

Delete every seeded row afterward — the database is shared and persistent. FK-safe order: `email_outbox → payout_bookings → payouts → reviews → payments → bookings → auth.users`. Verify the cleanup and say so.

**Do not send a real email.** `RESEND_API_KEY` may not even be set, and the free tier is 100/day.

- [ ] **Step 5: Report (do not commit)**

Summarize files created and modified, test counts per file, the full-gate output, what step 4 showed, and anything the plan called for that did not ship.

---

## What this plan deliberately does not build

Carried from the spec's Out of scope, repeated so a reviewer does not read these as gaps:

- **Retry configuration in the UI.** The backoff ladder is a constant.
- **Email preferences / unsubscribe.** These are transactional, not marketing.
- **Bounce and complaint handling.** Resend can webhook these back; no handler, no suppression list.
- **Delivery/open tracking.** `provider_message_id` is stored so a send can be traced in Resend's dashboard; nothing is ingested.
- **Emails on suspend/unsuspend.** Two of four moderation transitions, deliberately.
- **Suppressing a reminder for a booking refunded after enqueue.** The exposure is minutes; see the spec's edge-case table.
- **SMS**, and **marketing email**. Phase 2 and out of scope respectively.

## Ops gate outside this plan

Real mail will not send until the `EMAIL_FROM` domain is verified in Resend with SPF and DKIM records — and that depends on a domain decision the project has not made, since the product spec still calls "OnCourt" a placeholder. Everything in this plan is buildable and testable without it, because the suite never touches Resend.
