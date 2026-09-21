'use client'

import { createBrowserClient } from '@supabase/ssr'
import { supabaseConfig } from './env'

/** Supabase client for Client Components. Never sees the service role key. */
export function createClient() {
  const { url, anonKey } = supabaseConfig()
  return createBrowserClient(url, anonKey)
}
