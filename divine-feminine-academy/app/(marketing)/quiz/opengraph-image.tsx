import { ImageResponse } from 'next/og'

/**
 * The card for the quiz itself — what she sees when the link is posted
 * anywhere other than a result page.
 */
export const alt = 'Which version of you is running the show?'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function Image() {
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
            Free · about 90 seconds
          </div>
          <div
            style={{
              marginTop: 40,
              fontSize: 92,
              lineHeight: 1.05,
              color: '#1a1614',
              maxWidth: 1000,
            }}
          >
            Which version of you is running the show?
          </div>
        </div>

        <div style={{ display: 'flex', fontSize: 32, color: '#443c37' }}>
          She fights. She runs. She freezes. She goes quiet.
        </div>
      </div>
    ),
    size,
  )
}
