import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'

export type PaymentMethodKind = 'bank' | 'ewallet'

export type OwnerPaymentMethod = {
  id: string
  kind: PaymentMethodKind
  institution: string
  accountName: string
  accountNumber: string
  qrStoragePath: string | null
  position: number
}

export type PaymentMethodInput = {
  kind: PaymentMethodKind
  institution: string
  accountName: string
  accountNumber: string
}

export type PaymentMethodResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'invalid_input' | 'not_found' | 'limit_reached' }

/**
 * A ceiling, not a product rule: the player has to read this list and pick
 * one, and an unbounded list is a denial-of-service on the checkout page.
 */
export const MAX_PAYMENT_METHODS = 8

export const QR_BUCKET = 'payment-qr' as const

/** Every field is required and non-blank. Returns null when the input is bad. */
function clean(input: PaymentMethodInput): PaymentMethodInput | null {
  const institution = input.institution.trim()
  const accountName = input.accountName.trim()
  const accountNumber = input.accountNumber.trim()
  if (!institution || !accountName || !accountNumber) return null
  if (input.kind !== 'bank' && input.kind !== 'ewallet') return null
  if (institution.length > 80 || accountName.length > 120 || accountNumber.length > 64) return null
  return { kind: input.kind, institution, accountName, accountNumber }
}

export async function listPaymentMethods(ownerId: string): Promise<OwnerPaymentMethod[]> {
  const result = await db.execute(sql`
    select id, kind::text as kind, institution, account_name, account_number,
           qr_storage_path, position
    from owner_payment_methods
    where owner_id = ${ownerId}::uuid
    order by position, id
  `)
  return result.rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as PaymentMethodKind,
    institution: row.institution as string,
    accountName: row.account_name as string,
    accountNumber: row.account_number as string,
    qrStoragePath: (row.qr_storage_path as string | null) ?? null,
    position: Number(row.position),
  }))
}

export async function countPaymentMethods(ownerId: string): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as n from owner_payment_methods where owner_id = ${ownerId}::uuid
  `)
  return Number(result.rows[0].n)
}

/**
 * Appends to the end of the owner's list.
 *
 * The count and the insert share one transaction so two concurrent adds cannot
 * both pass the ceiling check, and so `position` cannot collide.
 */
export async function addPaymentMethod(
  ownerId: string,
  input: PaymentMethodInput,
): Promise<PaymentMethodResult> {
  const fields = clean(input)
  if (!fields) return { ok: false, reason: 'invalid_input' }

  return db.transaction(
    async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'pay-methods:' + ownerId}))`)

      const existing = await tx.execute(sql`
        select coalesce(max(position) + 1, 0)::int as next, count(*)::int as n
        from owner_payment_methods where owner_id = ${ownerId}::uuid
      `)
      if (Number(existing.rows[0].n) >= MAX_PAYMENT_METHODS) {
        return { ok: false as const, reason: 'limit_reached' as const }
      }

      const inserted = await tx.execute(sql`
        insert into owner_payment_methods
          (owner_id, kind, institution, account_name, account_number, position)
        values (
          ${ownerId}::uuid, ${fields.kind}::payment_method_kind,
          ${fields.institution}, ${fields.accountName}, ${fields.accountNumber},
          ${Number(existing.rows[0].next)}
        )
        returning id
      `)
      return { ok: true as const, id: inserted.rows[0].id as string }
    },
    { isolationLevel: 'read committed' },
  )
}

/**
 * Owner-scoped by construction: `owner_id` is in the WHERE clause, never
 * trusted from the form. Zero rows means "not yours, or gone" -- the same
 * answer either way, so one owner can't probe for another's method ids.
 */
export async function updatePaymentMethod(
  ownerId: string,
  methodId: string,
  input: PaymentMethodInput,
): Promise<PaymentMethodResult> {
  const fields = clean(input)
  if (!fields) return { ok: false, reason: 'invalid_input' }

  const result = await db.execute(sql`
    update owner_payment_methods set
      kind = ${fields.kind}::payment_method_kind,
      institution = ${fields.institution},
      account_name = ${fields.accountName},
      account_number = ${fields.accountNumber}
    where id = ${methodId}::uuid and owner_id = ${ownerId}::uuid
    returning id
  `)
  if (result.rows.length === 0) return { ok: false, reason: 'not_found' }
  return { ok: true, id: result.rows[0].id as string }
}

/**
 * Deleting is always allowed, even when a proof points at this method: the
 * proof carries paid_to_snapshot, so the record of what was paid survives.
 * The FK is ON DELETE SET NULL for exactly this reason.
 *
 * Resequences the survivors so `position` stays a dense 0..n-1 run, the same
 * thing movePhoto does in src/lib/listings/photos.ts.
 */
export async function removePaymentMethod(
  ownerId: string,
  methodId: string,
): Promise<PaymentMethodResult> {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'pay-methods:' + ownerId}))`)

      const deleted = await tx.execute(sql`
        delete from owner_payment_methods
        where id = ${methodId}::uuid and owner_id = ${ownerId}::uuid
        returning id
      `)
      if (deleted.rows.length === 0) return { ok: false as const, reason: 'not_found' as const }

      // `m.owner_id = ownerId` is redundant with `ordered`'s own `where
      // owner_id = ...` today (ids are globally-unique UUIDs, so the join
      // can't cross owners either way) -- but that safety property belongs
      // at the write site, not one level down in a subquery. Stated here
      // too, so a later edit that loosens `ordered` can't silently widen
      // this UPDATE to every owner's rows with nothing at the write site to
      // catch it.
      await tx.execute(sql`
        update owner_payment_methods m set position = ordered.rn - 1
        from (
          select id, row_number() over (order by position, id) as rn
          from owner_payment_methods where owner_id = ${ownerId}::uuid
        ) ordered
        where m.id = ordered.id
          and m.owner_id = ${ownerId}::uuid
          and m.position <> ordered.rn - 1
      `)

      return { ok: true as const, id: deleted.rows[0].id as string }
    },
    { isolationLevel: 'read committed' },
  )
}
