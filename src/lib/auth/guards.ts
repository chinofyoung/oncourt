import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export type Role = 'player' | 'owner' | 'admin'
export type SessionUser = { id: string; email: string; role: Role; avatarUrl: string | null }

export class AuthError extends Error {
  constructor(readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * Resolves the current session down to a `SessionUser`, or `null` if there is
 * none — either no `sub` claim at all, or a claim with no matching `profiles`
 * row. `requireUser()` and `getOptionalUser()` both call this single path so
 * the claims/profile-lookup logic is never duplicated; they only differ in
 * what they do with a `null` result (throw vs. return it).
 */
async function loadSessionUser(): Promise<SessionUser | null> {
  const supabase = await createServerSupabaseClient()
  const { data } = await supabase.auth.getClaims()

  const userId = data?.claims?.sub as string | undefined
  if (!userId) return null

  // Role comes from our own table, never from JWT metadata, which is
  // user-editable and therefore unsafe for authorization.
  const result = await db.execute(sql`
    select id, email, role, avatar_url from profiles where id = ${userId}::uuid
  `)
  const profile = result.rows[0]
  if (!profile) return null

  return {
    id: profile.id as string,
    email: profile.email as string,
    role: profile.role as Role,
    avatarUrl: (profile.avatar_url as string | null) ?? null,
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await loadSessionUser()
  if (!user) throw new AuthError(401, 'Not signed in')
  return user
}

/**
 * The current user, or null when signed out. Unlike requireUser(), this
 * never throws or redirects — the public pages render for anonymous
 * visitors, and the nav only needs to know which of two states to draw.
 */
export async function getOptionalUser(): Promise<SessionUser | null> {
  return loadSessionUser()
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role !== 'admin') throw new AuthError(403, 'Admin only')
  return user
}

export async function requireOwnerOf(branchId: string): Promise<SessionUser> {
  const user = await requireUser()
  if (user.role === 'admin') return user

  const result = await db.execute(sql`
    select 1 from branches where id = ${branchId}::uuid and owner_id = ${user.id}::uuid
  `)
  if (result.rows.length === 0) throw new AuthError(403, 'Not your branch')
  return user
}
