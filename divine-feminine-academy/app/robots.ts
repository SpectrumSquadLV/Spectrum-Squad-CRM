import type { MetadataRoute } from 'next'
import { siteUrl } from '@/lib/auth/env'

/**
 * Crawling rules.
 *
 * The disallow list is the important half. Every path here either belongs to
 * one woman or belongs to the business, and none of it should ever appear in
 * a search result - least of all `/quiz/result`, which is her own answers.
 * The individual pages also carry `robots: noindex`; this is the belt to that
 * pair of braces, because a crawler that ignores one may respect the other.
 */
export default function robots(): MetadataRoute.Robots {
  const base = siteUrl().replace(/\/$/, '')

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/admin',
        '/my-practice',
        '/api',
        '/auth',
        '/quiz/result',
        '/assessment/results',
        '/checkout',
        '/unsubscribe',
      ],
    },
    sitemap: `${base}/sitemap.xml`,
  }
}
