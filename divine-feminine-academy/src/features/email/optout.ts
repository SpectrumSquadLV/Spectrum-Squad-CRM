import 'server-only'

import { eq } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { activityEvents } from '@/db/schema/activity'
import { contacts } from '@/db/schema/identity'
import { verifyUnsubscribeToken } from '@/lib/email/unsubscribe'

/**
 * Take her off lifecycle email, from a link in her inbox.
 *
 * Out of the page so it can be tested directly — the thing worth proving is
 * that an unsigned or tampered token changes nothing, and that is awkward to
 * assert through a React server component.
 *
 * Idempotent, and it sets a flag rather than deleting anything: her orders,
 * her certificates and her sign-in links all have to keep working. She
 * unsubscribed from letters, not from her own account.
 */
export async function unsubscribeByToken(
  db: Db,
  token: string,
): Promise<boolean> {
  let contactId: string | null = null
  try {
    contactId = verifyUnsubscribeToken(decodeURIComponent(token))
  } catch {
    contactId = null
  }
  if (!contactId) return false

  const updated = await db
    .update(contacts)
    .set({ emailOptedOutAt: new Date(), updatedAt: new Date() })
    .where(eq(contacts.id, contactId))
    .returning({ id: contacts.id })

  // A validly signed token for a contact who no longer exists is not an error
  // worth showing her, but it is not a success either.
  if (updated.length === 0) return false

  await db.insert(activityEvents).values({
    contactId,
    eventType: 'email.unsubscribed',
    entity: 'contacts',
    entityId: contactId,
    metadata: {},
  })

  return true
}
