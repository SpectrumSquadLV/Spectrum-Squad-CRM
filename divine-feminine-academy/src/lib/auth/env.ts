/**
 * Supabase configuration, read lazily.
 *
 * Read at call time rather than module scope so a build without credentials
 * still succeeds - the failure then happens where it is actionable, not in a
 * stack trace from a prerender worker.
 */
export function supabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. Copy .env.example to .env.local.',
    )
  }

  return { url, anonKey }
}

export function isSupabaseConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  )
}

export function siteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
}

/**
 * Where this request actually arrived, for links we put in an email.
 *
 * NOT `siteUrl()`, and the difference cost an evening. NEXT_PUBLIC_SITE_URL is
 * inlined at BUILD time, so a magic link carries whatever that variable said
 * when the image was built - which on a deploy that was built before the
 * variable was corrected means every link in every inbox points at
 * `localhost:$PORT` forever. The variable reads correctly in the dashboard,
 * the deploy is green, and the emails are still wrong. There is nothing on
 * screen anywhere to tell you.
 *
 * The request knows better than the build does. `host` is what the browser
 * asked for and `x-forwarded-proto` is what the proxy terminated, so this is
 * right on Railway, behind any CDN, on a custom domain, and in local dev,
 * without anybody having to remember to set anything.
 *
 * Falls back to the configured value when there is no request to read, which
 * is what happens in a script or a build-time render.
 */
export async function requestOrigin(): Promise<string> {
  try {
    const { headers } = await import('next/headers')
    const h = await headers()
    const host = h.get('x-forwarded-host') ?? h.get('host')
    if (host) {
      const proto =
        h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
      return `${proto}://${host}`
    }
  } catch {
    // No request context. Fall through.
  }
  return siteUrl()
}
