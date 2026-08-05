import { NextResponse, type NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { isAdminEmail } from '@/lib/auth/admin-allowlist'
import { safeNextPath } from '@/lib/auth/next-path'
import { db } from '@/db'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  // Same-origin only. See src/lib/auth/next-path.ts for why a leading-slash
  // check alone is insufficient; that rule is shared with the login page and
  // tested in tests/auth/next-path.test.ts.
  const next = safeNextPath(searchParams.get('next'))

  if (!code) return NextResponse.redirect(`${origin}/login?error=missing_code`)

  const supabase = await createServerSupabaseClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) return NextResponse.redirect(`${origin}/login?error=exchange_failed`)

  const { data } = await supabase.auth.getClaims()
  const email = data?.claims?.email as string | undefined
  const userId = data?.claims?.sub as string | undefined

  // Promote allowlisted emails. Idempotent, and never demotes — an admin
  // removed from the allowlist is handled deliberately, not by a silent flip.
  if (userId && email && isAdminEmail(email)) {
    await db.execute(sql`
      update profiles set role = 'admin'
      where id = ${userId}::uuid and role <> 'admin'
    `)
  }

  return NextResponse.redirect(`${origin}${next}`)
}
