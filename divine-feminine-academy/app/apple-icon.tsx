import { ImageResponse } from 'next/og'

/**
 * The same mark as icon.svg, as the 180px PNG iOS needs.
 *
 * Why this exists at all: a woman who is told to come back for seven days is
 * being asked to keep something on her phone, and "Add to Home Screen" with
 * no apple-icon gives her a grey screenshot thumbnail of whatever page she
 * happened to be on. That is a poor object to ask someone to keep, and it is
 * the one icon on this platform a member actually looks at daily.
 *
 * Generated rather than committed as a binary so there is exactly ONE
 * definition of the mark in the repo that a person can read and edit. A
 * checked-in PNG drifts from icon.svg the first time either is touched, and
 * nobody notices because no test can see a picture.
 *
 * Satori draws CSS, not SVG paths, so the vessel is a bordered circle and the
 * gilt mark is a filled one - the same two elements as icon.svg, in the same
 * proportions, scaled from the sigils' 120 box to 180:
 *
 *   vessel  outer diameter 80/120 -> 120    stroke 9/120 -> 13.5
 *   dot     diameter       18/120 ->  27
 *
 * No rounded corners here on purpose. iOS masks the corners itself, so a
 * radius in the source gets clipped twice and the mark ends up sitting in a
 * visibly inset, slightly wrong-shaped tile.
 *
 * Colours are literal for the same reason as in icon.svg: this never sees
 * globals.css. plum-deep #35202f, bone #faf7f2, gilt #b2914f.
 */

export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#35202f',
        }}
      >
        <div
          style={{
            boxSizing: 'border-box',
            width: 120,
            height: 120,
            borderRadius: '50%',
            border: '13.5px solid #faf7f2',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: 27,
              height: 27,
              borderRadius: '50%',
              background: '#b2914f',
            }}
          />
        </div>
      </div>
    ),
    size,
  )
}
