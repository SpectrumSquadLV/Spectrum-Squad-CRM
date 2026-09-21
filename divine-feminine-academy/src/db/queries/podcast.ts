import 'server-only'

import { and, desc, eq, isNotNull, lte, ne } from 'drizzle-orm'
import { db } from '@/db/client'
import { articles } from '@/db/schema/content'

/**
 * Brown Girls Need Healing Too, for the public site.
 *
 * Episodes are articles with kind 'episode' - one table, because an episode
 * and an essay are the same object with a different medium, and splitting them
 * would mean two of every query, two admin screens and two feeds.
 *
 * Everything here is read-only and published-only. Writing episodes is the
 * sync's job, and it is the only thing that writes what the feed owns.
 */

export type Episode = typeof articles.$inferSelect

const live = (now: Date) =>
  and(
    eq(articles.kind, 'episode'),
    eq(articles.status, 'published'),
    lte(articles.publishedAt, now),
  )

export async function listEpisodes(
  options: { limit?: number; offset?: number; now?: Date } = {},
): Promise<Episode[]> {
  const now = options.now ?? new Date()
  return db
    .select()
    .from(articles)
    .where(live(now))
    .orderBy(desc(articles.publishedAt))
    .limit(options.limit ?? 100)
    .offset(options.offset ?? 0)
}

export async function getEpisode(
  slug: string,
  now = new Date(),
): Promise<Episode | null> {
  const [row] = await db
    .select()
    .from(articles)
    .where(and(eq(articles.slug, slug), live(now)))
    .limit(1)
  return row ?? null
}

/**
 * The one to lead with.
 *
 * Featured if Quiana has featured one, otherwise the newest. Deliberately not
 * "the newest, always": an episode she wants at the top of the page for a
 * launch should stay there when a new one publishes, and `featuredAt` is the
 * column the sync is forbidden to touch precisely so that choice survives.
 */
export async function featuredEpisode(now = new Date()): Promise<Episode | null> {
  const [featured] = await db
    .select()
    .from(articles)
    .where(and(live(now), isNotNull(articles.featuredAt)))
    .orderBy(desc(articles.featuredAt))
    .limit(1)

  if (featured) return featured

  const [newest] = await listEpisodesLimited(now)
  return newest ?? null
}

async function listEpisodesLimited(now: Date) {
  return db
    .select()
    .from(articles)
    .where(live(now))
    .orderBy(desc(articles.publishedAt))
    .limit(1)
}

/** The next few, for the bottom of an episode page. */
export async function otherEpisodes(
  to: Episode,
  limit = 3,
  now = new Date(),
): Promise<Episode[]> {
  return db
    .select()
    .from(articles)
    .where(and(live(now), ne(articles.id, to.id)))
    .orderBy(desc(articles.publishedAt))
    .limit(limit)
}

/** Episode slugs for the sitemap. */
export async function listEpisodeSlugs(
  now = new Date(),
): Promise<{ slug: string; updatedAt: Date }[]> {
  return db
    .select({ slug: articles.slug, updatedAt: articles.updatedAt })
    .from(articles)
    .where(live(now))
    .orderBy(desc(articles.publishedAt))
}
