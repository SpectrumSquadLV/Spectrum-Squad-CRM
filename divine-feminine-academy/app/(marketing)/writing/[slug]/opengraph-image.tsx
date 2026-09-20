import { ImageResponse } from 'next/og'
import { db } from '@/db/client'
import { getPublishedArticle } from '@/db/queries/writing'
import { excerpt } from '@/features/writing/markdown'

/**
 * The card a shared piece arrives as.
 *
 * Built from the article's own title rather than a stock image, so every piece
 * gets a distinct card without anybody having to make one. No web fonts are
 * fetched — a build or a render that reaches out to a font CDN is one that
 * fails the first time the network is unkind.
 */
export const alt = 'Divine Feminine'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const article = await getPublishedArticle(db, slug)

  const title = article?.title ?? 'Divine Feminine'
  const standfirst =
    article?.dek?.trim() || (article ? excerpt(article.body, 140) : '')
  const kicker = article?.kind === 'episode' ? 'Listen' : 'Writing'

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#fffdfa',
          padding: '72px 80px',
          borderTop: '16px solid #4a2f44',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              fontSize: 26,
              letterSpacing: 6,
              textTransform: 'uppercase',
              color: '#7d5a4e',
            }}
          >
            {kicker}
          </div>
          <div
            style={{
              marginTop: 36,
              fontSize: title.length > 60 ? 64 : 84,
              lineHeight: 1.1,
              color: '#1a1614',
              maxWidth: 1000,
            }}
          >
            {title}
          </div>
          {standfirst && (
            <div
              style={{
                marginTop: 26,
                fontSize: 32,
                lineHeight: 1.35,
                color: '#443c37',
                maxWidth: 940,
              }}
            >
              {standfirst}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', fontSize: 28, color: '#6f645d' }}>
          Divine Feminine
        </div>
      </div>
    ),
    size,
  )
}
