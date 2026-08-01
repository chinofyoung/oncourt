import { type NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

// Next.js 16.2.12 renamed the "middleware.ts" convention to "proxy.ts" (see
// node_modules/next/dist/lib/constants.js: PROXY_FILENAME = 'proxy', and the
// migration-guide error thrown when both files exist:
// node_modules/next/dist/build/index.js ~line 645, linking
// https://nextjs.org/docs/messages/middleware-to-proxy). The generated
// handler template (node_modules/next/dist/build/templates/middleware.js)
// looks up `mod.proxy` (falling back to `mod.default`) for a file at
// `proxy`/`src/proxy`, and throws `ProxyMissingExportError` if the export is
// missing — so the exported function here must be named `proxy`, not
// `middleware`.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        // `headers` (Cache-Control/Expires/Pragma) must land on the response
        // whenever cookies are set here, so a CDN/reverse proxy in front of
        // this app never caches a response carrying auth cookies (see
        // SetAllCookies' JSDoc in
        // node_modules/@supabase/ssr/dist/module/types.d.ts, and the actual
        // header values sent by applyServerStorage in
        // node_modules/@supabase/ssr/dist/module/cookies.js). Its shape per
        // the installed types is `Record<string, string>`.
        setAll: (cookiesToSet, headers) => {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
          for (const [key, value] of Object.entries(headers)) {
            response.headers.set(key, value)
          }
        },
      },
    },
  )

  // Refreshes the token and writes the new cookies via setAll above.
  await supabase.auth.getClaims()

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
