import { NextResponse, type NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { isAdminEmail } from '@/lib/auth/admin-allowlist'
import { db } from '@/db'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const rawNext = searchParams.get('next') ?? '/'
  // Must be a same-origin path. A value like `next=https://evil.com` would
  // otherwise concatenate into `${origin}${next}` as
  // `http://localhost:3000https://evil.com` — not an open redirect (it
  // doesn't parse as a valid absolute URL to evil.com), but NextResponse's
  // internal validateURL throws on it, turning a bad query param into a 500
  // on the login path. Requiring a leading `/` keeps the redirect on-origin
  // and avoids that crash.
  const next = rawNext.startsWith('/') ? rawNext : '/'

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
