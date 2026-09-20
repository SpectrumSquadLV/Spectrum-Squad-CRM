import type { MetadataRoute } from 'next'
import { db } from '@/db/client'
import { listPublishedSlugs } from '@/db/queries/writing'
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
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl().replace(/\/$/, '')
  const now = new Date()

  const paths = [
    { path: '', priority: 1 },
    { path: '/quiz', priority: 0.9 },
    ...archetypeList.map((a) => ({ path: `/quiz/${a.slug}`, priority: 0.8 })),
    { path: '/7-days-to-her', priority: 0.9 },
    { path: '/academy', priority: 0.8 },
    { path: '/programs', priority: 0.6 },
    { path: '/writing', priority: 0.9 },
    { path: '/listen', priority: 0.7 },
    { path: '/assessment', priority: 0.6 },
    { path: '/about', priority: 0.5 },
    { path: '/stories', priority: 0.5 },
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
    const pieces = await listPublishedSlugs(db, now)
    written = pieces.map((piece) => ({
      url: `${base}/writing/${piece.slug}`,
      lastModified: piece.updatedAt,
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    }))
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
