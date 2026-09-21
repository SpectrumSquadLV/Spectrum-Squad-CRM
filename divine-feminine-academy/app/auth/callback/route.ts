import { NextResponse } from 'next/server'
import { linkUserToContact } from '@/lib/auth/actions'
import { createServerSupabase } from '@/lib/auth/server'

/**
 * Magic-link landing. Exchanges the code for a session, then links the
 * authenticated user to her contact row before sending her onward.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
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
