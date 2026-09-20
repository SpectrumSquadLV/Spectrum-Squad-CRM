import 'server-only'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { supabaseConfig } from './env'

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * In a Server Component cookies are read-only, so setAll is a no-op there.
 * Middleware is what actually refreshes the session cookie.
 */
export async function createServerSupabase() {
  const { url, anonKey } = supabaseConfig()
  const cookieStore = await cookies()

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Called from a Server Component. Middleware refreshes the session.
        }
      },
    },
  })
}
