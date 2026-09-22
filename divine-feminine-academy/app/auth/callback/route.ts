import { NextResponse } from 'next/server'
import { linkUserToContact } from '@/lib/auth/actions'
import { requestOrigin } from '@/lib/auth/env'
import { createServerSupabase } from '@/lib/auth/server'

/**
 * Magic-link landing. Exchanges the code for a session, then links the
 * authenticated user to her contact row before sending her onward.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)

  /*
   * NOT `new URL(request.url).origin`, and this one signed a woman in and
   * then sent her nowhere.
   *
   * Behind Railway's proxy the server is reached on its own internal address,
   * so request.url reads https://localhost:8080 however the browser got here.
   * Every redirect below was built from that: the session cookie was set
   * correctly on the real domain, the sign-in genuinely worked, and then the
   * last line of it bounced her to a host that does not exist.
   *
   * It looks exactly like a broken login. It is a correct login with a wrong
   * forwarding address, which is worse, because everything you would check -
   * the link, the keys, the redirect allow-list - is already right.
   */
  const origin = await requestOrigin()
  const code = searchParams.get('code')
  const rawNext = searchParams.get('next') ?? '/my-academy'

  // Only ever redirect within this site: an open redirect here would let a
  // crafted link bounce a signed-in woman to somebody else's page.
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//')
    ? rawNext
    : '/my-academy'

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing-code`)
  }

  const supabase = await createServerSupabase()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error || !data.user?.email) {
    return NextResponse.redirect(`${origin}/login?error=link-expired`)
  }

  const meta = data.user.user_metadata as {
    first_name?: string
    timezone?: string
  }

  try {
    await linkUserToContact(
      data.user.id,
      data.user.email,
      meta.first_name,
      meta.timezone,
    )
  } catch {
    // She is signed in either way; the link-up retries on her next sign-in.
  }

  return NextResponse.redirect(`${origin}${next}`)
}
