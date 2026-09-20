import { db } from '@/db/client'
import { listPublished } from '@/db/queries/writing'
import { excerpt, formatDuration, plainText } from '@/features/writing/markdown'
import { siteUrl } from '@/lib/auth/env'

/**
 * One feed for both.
 *
 * An essay and an episode go in the same feed, and an episode additionally
 * carries an `<enclosure>` and the iTunes tags a podcast directory needs. Two
 * feeds would be two things to keep in step, and a reader who wants only audio
 * has `/listen`.
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
  const pieces = await listPublished(db, { limit: 50 })

  const items = pieces
    .map((piece) => {
      const url = `${base}/writing/${piece.slug}`
      const description = piece.dek?.trim() || excerpt(piece.body, 300)
      const duration = formatDuration(piece.audioDurationSeconds)

      const enclosure =
        piece.kind === 'episode' && piece.audioUrl
          ? `\n      <enclosure url="${escape(piece.audioUrl)}" length="${piece.audioSizeBytes ?? 0}" type="audio/mpeg" />` +
            (duration ? `\n      <itunes:duration>${escape(duration)}</itunes:duration>` : '') +
            `\n      <itunes:episodeType>full</itunes:episodeType>`
          : ''

      return `    <item>
      <title>${escape(piece.title)}</title>
      <link>${escape(url)}</link>
      <guid isPermaLink="true">${escape(url)}</guid>
      <pubDate>${(piece.publishedAt ?? piece.createdAt).toUTCString()}</pubDate>
      <description>${escape(description)}</description>
      ${piece.authorName ? `<itunes:author>${escape(piece.authorName)}</itunes:author>` : ''}
      <itunes:summary>${escape(plainText(piece.body).slice(0, 3900))}</itunes:summary>${enclosure}
    </item>`
    })
    .join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Divine Feminine</title>
    <link>${escape(base)}/writing</link>
    <atom:link href="${escape(base)}/writing/rss.xml" rel="self" type="application/rss+xml" />
    <description>Essays and episodes on the four rooms — Self, Love, Life and Wealth — and the versions of you that show up in them.</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <itunes:explicit>false</itunes:explicit>
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
