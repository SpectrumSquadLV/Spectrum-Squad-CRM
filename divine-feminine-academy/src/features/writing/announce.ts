import 'server-only'

import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { activityEvents } from '@/db/schema/activity'
import { articles } from '@/db/schema/content'
import { contactTags, contacts, tags } from '@/db/schema/identity'
import { sendToContact } from '@/features/email/send'
import { newWriting } from '@/features/email/templates'
import { unsubscribeUrl } from '@/lib/email/unsubscribe'
import { LETTERS_TAG } from './subscribe'

/**
 * Tell the list there is something new.
 *
 * This is what makes the opt-in on every piece worth having. Collecting
 * addresses with no way to write to them is the most common half-built
 * newsletter there is: it looks finished, it fills a table, and nobody ever
 * receives anything.
 *
 * Two guards worth keeping.
 *
 * `announcedAt` means an announcement happens ONCE. Editing a published piece,
 * changing its date, or re-running the job cannot send it again.
 *
 * `maxAgeHours` means back-dating is safe. Importing an archive, or publishing
 * something dated last month, must not mail the whole list about a piece that
 * is not new — so anything older than the window is marked announced without
 * being sent.
 */
export async function announceNewWriting(
  db: Db,
  siteUrl: string,
  now = new Date(),
  { maxAgeHours = 72, limit = 5 }: { maxAgeHours?: number; limit?: number } = {},
): Promise<{ announced: number; sent: number; skipped: number }> {
  const cutoff = new Date(now.getTime() - maxAgeHours * 3_600_000)
  const base = siteUrl.replace(/\/$/, '')

  const due = await db
    .select()
    .from(articles)
    .where(
      and(
        eq(articles.status, 'published'),
        lte(articles.publishedAt, now),
        isNull(articles.announcedAt),
      ),
    )
    .orderBy(articles.publishedAt)
    .limit(limit)

  let announced = 0
  let sent = 0
  let skipped = 0

  for (const article of due) {
    // Too old to be news. Marked so it is never reconsidered, and never sent.
    if (!article.publishedAt || article.publishedAt < cutoff) {
      await db
        .update(articles)
        .set({ announcedAt: now, updatedAt: now })
        .where(eq(articles.id, article.id))
      skipped++
      continue
    }

    const audience = await db
      .select({ id: contacts.id, firstName: contacts.firstName })
      .from(contacts)
      .innerJoin(contactTags, eq(contactTags.contactId, contacts.id))
      .innerJoin(tags, eq(tags.id, contactTags.tagId))
      .where(
        and(
          eq(tags.slug, LETTERS_TAG),
          isNull(contacts.archivedAt),
          isNull(contacts.emailOptedOutAt),
        ),
      )

    for (const woman of audience) {
      const rendered = newWriting({
        firstName: woman.firstName,
        title: article.title,
        dek: article.dek,
        url: `${base}/writing/${article.slug}`,
        kind: article.kind,
        unsubscribeUrl: unsubscribeUrl(base, woman.id),
      })

      const outcome = await sendToContact({
        db,
        contactId: woman.id,
        rendered,
        kind: 'lifecycle',
        templateSlug: 'newWriting',
        idempotencyKey: `article:${article.id}:${woman.id}`,
      })

      if (outcome.sent) sent++
    }

    /*
     * Marked announced even if some individual sends failed.
     *
     * Leaving it unmarked would re-scan this piece every hour forever for the
     * sake of an address that is suppressed or bouncing. The idempotency key
     * above is what actually guarantees nobody is mailed twice, so this flag
     * is about not re-reading work, not about correctness.
     */
    await db
      .update(articles)
      .set({ announcedAt: now, updatedAt: now })
      .where(eq(articles.id, article.id))

    await db.insert(activityEvents).values({
      contactId: null,
      eventType: 'writing.announced',
      entity: 'articles',
      entityId: article.id,
      metadata: { slug: article.slug, audience: audience.length },
    })

    announced++
  }

  return { announced, sent, skipped }
}

/** How many people would get the next announcement. */
export async function lettersAudienceSize(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contacts)
    .innerJoin(contactTags, eq(contactTags.contactId, contacts.id))
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(
      and(
        eq(tags.slug, LETTERS_TAG),
        isNull(contacts.archivedAt),
        isNull(contacts.emailOptedOutAt),
      ),
    )
  return row?.n ?? 0
}

export { gte }
