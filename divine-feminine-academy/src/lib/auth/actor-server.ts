import 'server-only'

import { cache } from 'react'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { contacts, userRoles } from '@/db/schema'
import { type Actor, guest, type Role } from '@/lib/permissions/actor'
import { isSupabaseConfigured } from './env'
import { createServerSupabase } from './server'

/**
 * Resolve the signed-in user into an Actor.
 *
 * Wrapped in React's `cache` so a render that calls it from several places
 * still hits the database once per request.
 *
 * Uses getUser(), not getSession(): getSession reads the cookie without
 * verifying it, so it can be spoofed. getUser revalidates with Supabase.
 */
export const getActor = cache(async (): Promise<Actor> => {
  if (!isSupabaseConfigured()) return guest

  let userId: string
  try {
    const supabase = await createServerSupabase()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return guest
    userId = user.id
  } catch {
    return guest
  }

  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.userId, userId))
    .limit(1)

  const roleRows = await db
    .select({ role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId))

  const roles: Role[] = roleRows.map((r) => r.role)
  // Everyone who can sign in is at least a member.
  if (!roles.includes('member')) roles.push('member')

  return {
    kind: 'user',
    userId,
    contactId: contact?.id ?? null,
    roles,
  }
})

/** The query context every db/queries function expects. */
export async function getQueryContext() {
  return { db, actor: await getActor() }
}
