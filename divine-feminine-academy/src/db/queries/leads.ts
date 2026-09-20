import 'server-only'

import { eq } from 'drizzle-orm'
import { contacts, contactTags, crmStages, tags } from '../schema'
import type { QueryContext } from './_context'

/**
 * Find a woman by email, or create her as a lead.
 *
 * ONE PERSON RECORD. A lead and a member are the same woman at different
 * moments, so an email that already exists is never a second row - it is her,
 * coming back. `acquisitionSource` is only set on creation, because the answer
 * to "where did she come from" is where she came from the FIRST time.
 *
 * No actor context: this runs for anonymous visitors on public pages, which is
 * the whole point of a lead magnet. It writes a contact and nothing else, and
 * it never returns anything about a woman who already exists beyond her id.
 */
export async function findOrCreateLead(
  db: QueryContext['db'],
  input: { email: string; firstName: string; source: string },
): Promise<string | null> {
  const email = input.email.trim().toLowerCase()

  const [existing] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.email, email))
    .limit(1)

  if (existing) {
    await db
      .update(contacts)
      .set({ lastActivityAt: new Date() })
      .where(eq(contacts.id, existing.id))
    return existing.id
  }

  const [defaultStage] = await db
    .select({ id: crmStages.id })
    .from(crmStages)
    .where(eq(crmStages.isDefault, true))
    .limit(1)

  const [created] = await db
    .insert(contacts)
    .values({
      email,
      firstName: input.firstName.trim(),
      acquisitionSource: input.source,
      crmStageId: defaultStage?.id ?? null,
      lastActivityAt: new Date(),
    })
    .returning({ id: contacts.id })

  return created?.id ?? null
}

/**
 * Put a tag on a contact, creating the tag if nobody has used it yet.
 *
 * Idempotent on both halves: re-tagging the same woman with the same tag is a
 * no-op rather than a duplicate row or an error, because segmentation writes
 * happen on every retake.
 */
export async function tagContact(
  db: QueryContext['db'],
  contactId: string,
  tag: { slug: string; name: string },
): Promise<void> {
  const [upserted] = await db
    .insert(tags)
    .values({ slug: tag.slug, name: tag.name })
    .onConflictDoUpdate({ target: tags.slug, set: { name: tag.name } })
    .returning({ id: tags.id })

  if (!upserted) return

  await db
    .insert(contactTags)
    .values({ contactId, tagId: upserted.id })
    .onConflictDoNothing()
}
