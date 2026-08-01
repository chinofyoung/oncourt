import 'server-only'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'

// @supabase/ssr 0.12.4's CookieMethodsServer type requires `getAll` and
// (optionally) `setAll` — the old get/set/remove shape is a deprecated
// overload that only exists for backwards compatibility. Confirmed against
// node_modules/@supabase/ssr/dist/module/types.d.ts and createServerClient.d.ts.
export async function createServerSupabaseClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        // `setAll`'s second parameter (`headers`) carries the
        // Cache-Control/Expires/Pragma headers a token refresh must attach
        // to the outgoing response so a CDN/reverse proxy never caches a
        // response carrying auth cookies (see SetAllCookies' JSDoc in
        // node_modules/@supabase/ssr/dist/module/types.d.ts). It is
        // intentionally unused here: `next/headers`'s `cookies()` has no
        // paired API for setting arbitrary outgoing response headers from a
        // Server Component, Server Action, or Route Handler — there is no
        // response object this function has access to attach them to (a
        // Route Handler that wants them would need to build its own
        // NextResponse and copy them over manually). `src/proxy.ts` is the
        // one place in this app that constructs the response directly, and
        // it does forward these headers; it runs on every navigation before
        // any Server Component renders, which is exactly where
        // createServerClient's own docs place the responsibility for
        // refreshing the session early enough to matter.
        setAll: (cookiesToSet) => {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // The proxy (src/proxy.ts) refreshes the session on every
            // navigation, so ignoring this here is correct.
          }
        },
      },
    },
  )
}
