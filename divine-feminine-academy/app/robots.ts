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
/*
 * Per request, never baked.
 *
 * robots.txt is static output by default, which means SITE_NOINDEX is read at
 * BUILD time and frozen into the file. Setting the variable on the running
 * service then does nothing at all, and the switch that is supposed to keep an
 * unfinished site out of Google silently is not connected to anything. Found
 * by setting it on a server started from a build made without it, which is
 * exactly how it would have been set in production.
 */
export const dynamic = 'force-dynamic'

export default function robots(): MetadataRoute.Robots {
  const base = siteUrl().replace(/\/$/, '')

  /*
   * A preview must not be findable.
   *
   * SITE_NOINDEX=1 shuts the whole site to crawlers. It exists because a
   * deployed preview carries placeholder curriculum and, more seriously, crisis
   * phone numbers nobody has confirmed yet — and a URL that exists can be
   * found, linked and indexed whether or not anybody was told about it.
   *
   * Removing the variable is how it goes live. That is deliberately a decision
   * somebody makes, rather than a default that happens to them.
   */
  if (process.env.SITE_NOINDEX === '1') {
    return {
      rules: { userAgent: '*', disallow: '/' },
    }
  }

  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/admin',
        '/my-academy',
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
