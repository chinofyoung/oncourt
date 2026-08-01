import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export type Role = 'player' | 'owner' | 'admin'
export type SessionUser = { id: string; email: string; role: Role }

export class AuthError extends Error {
  constructor(readonly status: 401 | 403, message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

export async function requireUser(): Promise<SessionUser> {
  const supabase = await createServerSupabaseClient()
  const { data } = await supabase.auth.getClaims()

  const userId = data?.claims?.sub as string | undefined
  if (!userId) throw new AuthError(401, 'Not signed in')

  // Role comes from our own table, never from JWT metadata, which is
  // user-editable and therefore unsafe for authorization.
  const result = await db.execute(sql`
    select id, email, role from profiles where id = ${userId}::uuid
  `)
  const profile = result.rows[0]
  if (!profile) throw new AuthError(401, 'No profile for session')

  return { id: profile.id as string, email: profile.email as string, role: profile.role as Role }
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
