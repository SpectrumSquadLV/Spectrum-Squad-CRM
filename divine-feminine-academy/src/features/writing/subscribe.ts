import 'server-only'

import { z } from 'zod'
import { db } from '@/db/client'
import { activityEvents } from '@/db/schema/activity'
import { findOrCreateLead, tagContact } from '@/db/queries/leads'
import { archetypes, isMode } from '@/features/quiz/archetypes'
import { joinArchetypeSequence } from '@/features/quiz/subscribe'
import { siteUrl } from '@/lib/auth/env'

/**
 * The tag that means "send me the writing".
 *
 * One tag, so the announcement job has exactly one audience to ask for. Every
 * article's own upgrade tag is added ALONGSIDE this one rather than instead of
 * it — the specific tag is for segmenting later, this one is the list.
 */
export const LETTERS_TAG = 'letters'

export const upgradeInput = z.object({
  /** Empty when she subscribed from the index rather than from a piece. */
  slug: z.string().trim().default(''),
  firstName: z.string().trim().min(1, 'Tell me what to call you.').max(80),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('That address does not look right.'),
})

export type UpgradeInput = z.infer<typeof upgradeInput>

export type UpgradeOutcome =
  | { ok: true; joinedSequence: boolean }
  | { ok: false; error: string }

/**
 * Take an email from the bottom of a piece of writing.
 *
 * Two outcomes, depending on the article:
 *
 *   - If it is about one of the four archetypes, she is put into that
 *     sequence, which starts sending immediately. She gets something today.
 *   - Otherwise she goes on the letters list and is told the truth: she will
 *     get the next one when it is written. No "check your inbox", because
 *     nothing is arriving in it right now, and a promise that is false within
 *     thirty seconds is how a list stops being opened.
 */
export async function subscribeFromArticle(input: {
  data: UpgradeInput
  /** Null when she subscribed from the index rather than from a piece. */
  articleId: string | null
  upgradeTag: string | null
  archetype: string | null
}): Promise<UpgradeOutcome> {
  const contactId = await findOrCreateLead(db, {
    email: input.data.email,
    firstName: input.data.firstName,
    source: input.data.slug ? `writing:${input.data.slug}` : 'writing:index',
  })
  if (!contactId) return { ok: false, error: 'That did not save. Try again.' }

  await tagContact(db, contactId, { slug: LETTERS_TAG, name: 'Letters' })

  if (input.upgradeTag) {
    const slug = input.upgradeTag
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (slug) await tagContact(db, contactId, { slug, name: input.upgradeTag })
  }

  await db.insert(activityEvents).values({
    contactId,
    eventType: 'writing.subscribed',
    entity: 'articles',
    entityId: input.articleId,
    metadata: { slug: input.data.slug, upgradeTag: input.upgradeTag },
  })

  if (input.archetype && isMode(input.archetype)) {
    await tagContact(db, contactId, {
      slug: `archetype-${archetypes[input.archetype].slug}`,
      name: archetypes[input.archetype].name,
    })
    await joinArchetypeSequence({
      db,
      contactId,
      mode: input.archetype,
      source: `writing:${input.data.slug}`,
      siteUrl: siteUrl(),
    })
    return { ok: true, joinedSequence: true }
  }

  return { ok: true, joinedSequence: false }
}
