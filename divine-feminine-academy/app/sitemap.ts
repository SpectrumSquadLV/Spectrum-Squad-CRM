import type { MetadataRoute } from 'next'
import { db } from '@/db/client'
import { listPublishedSlugs } from '@/db/queries/writing'
import { listEpisodeSlugs } from '@/db/queries/podcast'
import { listChallenges } from '@/db/queries/challenges'
import { siteUrl } from '@/lib/auth/env'
import { archetypeList } from '@/features/quiz/archetypes'

/**
 * The sitemap.
 *
 * Only PUBLIC, INDEXABLE pages belong here. Nothing behind a login, nothing
 * behind a token: a result page or a certificate listed here would hand a
 * woman's private page to a crawler, and the whole point of those tokens is
 * that only she has one.
 *
 * The four archetype pages are the reason this file exists. They are the pages
 * strangers land on when somebody shares her result, so they are the pages
 * that need to be findable.
 */
/** Reads the database and the noindex switch, so never baked at build. */
export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Nothing to offer a crawler that is being told to go away.
  if (process.env.SITE_NOINDEX === '1') return []

  const base = siteUrl().replace(/\/$/, '')
  const now = new Date()

  const paths = [
    { path: '', priority: 1 },
    { path: '/quiz', priority: 0.9 },
    ...archetypeList.map((a) => ({ path: `/quiz/${a.slug}`, priority: 0.8 })),
    // The destination, not the entry point: Divine Feminine outranks every
    // challenge here because it is what the site is actually for.
    { path: '/the-divine-feminine', priority: 0.95 },
    { path: '/challenges', priority: 0.9 },
    { path: '/podcast', priority: 0.9 },
    { path: '/writing', priority: 0.8 },
    { path: '/programs', priority: 0.6 },
    { path: '/about', priority: 0.5 },
    // /stories is deliberately absent. It is not published, and listing an
    // unpublished page is how a crawler finds one.
    { path: '/legal/disclaimer', priority: 0.2 },
    { path: '/legal/privacy', priority: 0.2 },
    { path: '/legal/terms', priority: 0.2 },
  ]

  /*
   * Published writing, read at request time.
   *
   * A static list would mean every new piece waited for a deploy to become
   * findable, which defeats the point of being able to publish from the admin.
   * A database that is unreachable must not take the whole sitemap down with
   * it, so a failure here drops the articles and keeps the fixed pages.
   */
  let written: MetadataRoute.Sitemap = []
  try {
    /*
     * Essays and episodes are fetched separately because they live at
     * different addresses. Listing an episode under /writing/<slug> would put
     * a permanent redirect in the sitemap, which is a crawl budget spent on
     * being told to go somewhere else.
     */
    const [essays, episodes, challenges] = await Promise.all([
      listPublishedSlugs(db, now, 'article'),
      listEpisodeSlugs(now),
      listChallenges(),
    ])

    written = [
      ...essays.map((piece) => ({
        url: `${base}/writing/${piece.slug}`,
        lastModified: piece.updatedAt,
        changeFrequency: 'monthly' as const,
        priority: 0.7,
      })),
      ...episodes.map((episode) => ({
        url: `${base}/podcast/${episode.slug}`,
        lastModified: episode.updatedAt,
        changeFrequency: 'monthly' as const,
        priority: 0.7,
      })),
      ...challenges.map((challenge) => ({
        url: `${base}/challenges/${challenge.slug}`,
        lastModified: now,
        changeFrequency: 'weekly' as const,
        priority: 0.8,
      })),
    ]
  } catch {
    written = []
  }

  return [
    ...paths.map(({ path, priority }) => ({
      url: `${base}${path}`,
      lastModified: now,
      changeFrequency: 'weekly' as const,
      priority,
    })),
    ...written,
  ]
}
