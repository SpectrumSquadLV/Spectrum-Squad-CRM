import { db } from '@/db/client'
import { listPublished } from '@/db/queries/writing'
import { excerpt } from '@/features/writing/markdown'
import { siteUrl } from '@/lib/auth/env'

/**
 * The writing feed. ESSAYS ONLY.
 *
 * It used to carry episodes too, with enclosures and iTunes tags, which was
 * right when this site was the only place the podcast existed. It is not any
 * more: Brown Girls Need Healing Too is hosted on RSS.com, and that feed is
 * the one Apple and Spotify already have.
 *
 * Two feeds carrying the same audio is not a tidiness problem, it is a real
 * one. A directory that finds both lists the show twice, splits the download
 * numbers between them, and points half of her listeners at a feed she does
 * not control the publishing schedule of. So this one stops pretending to be
 * a podcast feed: no enclosures, no iTunes namespace, no audio, and episodes
 * filtered out entirely.
 *
 * The podcast's feed is linked from /podcast and it is the RSS.com one.
 *
 * Everything is escaped by hand here, because this is a string of XML rather
 * than React. `escape` is applied to every single interpolated value below —
 * an apostrophe in a title is enough to produce a feed that no reader will
 * parse.
 */
export const dynamic = 'force-dynamic'

const escape = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

export async function GET() {
  const base = siteUrl().replace(/\/$/, '')
  // Essays only. An episode belongs to the RSS.com feed, and duplicating it
  // here is how a show ends up listed twice in a directory.
  const pieces = await listPublished(db, { kind: 'article', limit: 50 })

  const items = pieces
    .map((piece) => {
      const url = `${base}/writing/${piece.slug}`
      const description = piece.dek?.trim() || excerpt(piece.body, 300)

      return `    <item>
      <title>${escape(piece.title)}</title>
      <link>${escape(url)}</link>
      <guid isPermaLink="true">${escape(url)}</guid>
      <pubDate>${(piece.publishedAt ?? piece.createdAt).toUTCString()}</pubDate>
      ${piece.authorName ? `<dc:creator>${escape(piece.authorName)}</dc:creator>` : ''}
      <description>${escape(description)}</description>
    </item>`
    })
    .join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Divine Feminine</title>
    <link>${escape(base)}/writing</link>
    <atom:link href="${escape(base)}/writing/rss.xml" rel="self" type="application/rss+xml" />
    <description>Essays on the four rooms — Self, Love, Life and Wealth — and the versions of you that show up in them.</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`

  return new Response(xml, {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      // Short, because a feed reader polling a stale copy is how a new piece
      // takes a day to appear in somebody's app.
      'cache-control': 'public, max-age=300, s-maxage=300',
    },
  })
}
