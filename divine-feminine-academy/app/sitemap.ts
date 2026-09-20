import type { MetadataRoute } from 'next'
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
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl().replace(/\/$/, '')
  const now = new Date()

  const paths = [
    { path: '', priority: 1 },
    { path: '/quiz', priority: 0.9 },
    ...archetypeList.map((a) => ({ path: `/quiz/${a.slug}`, priority: 0.8 })),
    { path: '/7-days-to-her', priority: 0.9 },
    { path: '/academy', priority: 0.8 },
    { path: '/programs', priority: 0.6 },
    { path: '/assessment', priority: 0.6 },
    { path: '/about', priority: 0.5 },
    { path: '/stories', priority: 0.5 },
    { path: '/legal/disclaimer', priority: 0.2 },
    { path: '/legal/privacy', priority: 0.2 },
    { path: '/legal/terms', priority: 0.2 },
  ]

  return paths.map(({ path, priority }) => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority,
  }))
}
