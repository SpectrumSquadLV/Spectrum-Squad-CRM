import { ImageResponse } from 'next/og'
import { archetypeBySlug, archetypeList } from '@/features/quiz/archetypes'

/**
 * The share card.
 *
 * This is not decoration — it is most of the growth loop. A woman posts her
 * result, and what her friends see in the feed is this image. A link with no
 * card is a grey rectangle nobody taps, which would quietly waste the entire
 * quiz.
 *
 * Deliberately NOT her own result: this is the archetype's public page, so the
 * card carries the archetype and nothing about the woman who shared it.
 *
 * No web fonts are fetched. A build that reaches out to a font CDN is a build
 * that fails the first time the network is unkind, and the type here is large
 * enough that the default face is fine.
 */
export const alt = 'One of the four versions of you'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export function generateStaticParams() {
  return archetypeList.map((a) => ({ archetype: a.slug }))
}

export default async function Image({
  params,
}: {
  params: Promise<{ archetype: string }>
}) {
  const { archetype: slug } = await params
  const archetype = archetypeBySlug(slug)

  const name = archetype?.name ?? 'Which version of you?'
  const tagline =
    archetype?.tagline ?? 'Four versions of you. One of them is driving.'

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
            Divine Feminine
          </div>
          <div
            style={{
              marginTop: 40,
              fontSize: 104,
              lineHeight: 1.05,
              color: '#1a1614',
            }}
          >
            {name}
          </div>
          <div
            style={{
              marginTop: 28,
              fontSize: 40,
              lineHeight: 1.3,
              color: '#443c37',
              maxWidth: 940,
            }}
          >
            {tagline}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 28,
            color: '#6f645d',
          }}
        >
          <span>Which version of you is running the show?</span>
          <span style={{ color: '#4a2f44' }}>Take the free quiz</span>
        </div>
      </div>
    ),
    size,
  )
}
