import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * The coarse gate. (Next.js calls this file convention `proxy`; it was
 * `middleware` before Next 16.)
 *
 * Two jobs: refresh the Supabase session cookie on every request, and keep
 * signed-out visitors out of the member and admin route groups.
 *
 * This is NOT where authorization lives. Middleware only knows whether someone
 * is signed in. What they may read is decided by the actor context in the data
 * access layer, with row-level security behind it.
 */
const PROTECTED = ['/my-academy', '/admin']

/**
 * Keeping an unfinished site out of search results.
 *
 * The meta tag in the root layout covers pages rendered per request. It cannot
 * cover pages prerendered at build: their HTML is written before the variable
 * is ever read, so /legal/privacy and the rest went out indexable however the
 * switch was set. This header is the one place that runs on every request
 * whatever the page is, and Google treats X-Robots-Tag exactly as it treats
 * the meta tag.
 *
 * Removing SITE_NOINDEX is how the site goes live - a decision somebody makes,
 * not a default that happens to them.
 */
export async function proxy(request: NextRequest) {
  const response = await gate(request)

  if (process.env.SITE_NOINDEX === '1') {
    response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  }

  return response
}

async function gate(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const path = request.nextUrl.pathname

  /*
   * The living style guide is reachable without a login in development only.
   * It renders design tokens and nothing else - no data, no member content -
   * and needing Supabase configured just to look at a colour swatch is the
   * kind of friction that stops a style guide being used.
   *
   * NODE_ENV is 'production' in every real deploy, so this never applies there.
   */
  const isDevStyleGuide =
    process.env.NODE_ENV !== 'production' && path === '/admin/design'

  const isProtected =
    !isDevStyleGuide &&
    PROTECTED.some((p) => path === p || path.startsWith(`${p}/`))

  // Without credentials nothing can be verified, so protected routes must fail
  // closed rather than quietly letting everyone through.
  if (!url || !anonKey) {
    if (!isProtected) return response
    const login = request.nextUrl.clone()
    login.pathname = '/login'
    login.search = ''
    login.searchParams.set('error', 'session-required')
    return NextResponse.redirect(login)
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value)
        }
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options)
        }
      },
    },
  })

  // getUser(), not getSession(): getSession trusts the cookie without
  // verifying it. Do not reorder this above the cookie wiring.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user && isProtected) {
    const login = request.nextUrl.clone()
    login.pathname = '/login'
    login.search = ''
    login.searchParams.set('next', path)
    return NextResponse.redirect(login)
  }

  return response
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image files. The session cookie has
     * to be refreshed on real navigations, not on every icon request.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?)$).*)',
  ],
}
