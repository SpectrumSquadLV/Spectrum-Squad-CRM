import type { Metadata, Viewport } from 'next'
import { Ephesis, Fraunces, Inter } from 'next/font/google'
import './globals.css'
import { siteUrl } from '@/lib/auth/env'

/*
 * Both faces load their real italic.
 *
 * Without style: ['normal', 'italic'] the browser has no italic to use and
 * slants the upright one instead. In a sans that is merely a bit off; in a
 * display serif it is obviously wrong - the letterforms of a true italic are
 * drawn differently, not tilted - and this face carries every headline.
 */
const display = Fraunces({
  subsets: ['latin'],
  variable: '--font-display-family',
  display: 'swap',
  style: ['normal', 'italic'],
  axes: ['SOFT', 'WONK', 'opsz'],
})

/**
 * HER handwriting.
 *
 * Not a third typeface so much as a second VOICE. Quiana's serif tells a
 * woman the truth; every so often a line arrives in this hand - "you already
 * know", "there you are", "I was waiting for you" - and by Day 7 she should
 * recognise the handwriting before she has read the words. That is the whole
 * reason it exists, and it is why it must stay rare: a face used on every
 * screen stops being a voice and becomes a theme.
 *
 * Ephesis rather than any of the obvious scripts. The brief was a handwritten
 * note in the margin of a beautiful book, not a wedding invitation - so no
 * swash capitals, no copperplate flourishes, and enough irregularity in the
 * baseline that it reads as a hand rather than a font.
 *
 * Used only at display sizes. A script at 16px is a legibility problem
 * wearing a personality, and this one never appears small enough for that to
 * be true.
 */
const script = Ephesis({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-script-family',
  display: 'swap',
})

const sans = Inter({
  subsets: ['latin'],
  variable: '--font-sans-family',
  display: 'swap',
  style: ['normal', 'italic'],
})

/**
 * Belt and braces with robots.txt.
 *
 * A crawler that ignores robots.txt may still respect a noindex meta tag, and
 * on a preview carrying unconfirmed crisis numbers that redundancy is worth
 * the two lines.
 *
 * A function rather than a constant, because a constant is read once when the
 * module is first evaluated and frozen into whatever was prerendered. That is
 * what made this switch do nothing: the variable would be set on the running
 * service, and the pages would carry the metadata from a build that never saw
 * it. generateMetadata runs per request.
 */
export function generateMetadata(): Metadata {
  const noindex = process.env.SITE_NOINDEX === '1'

  return {
    /*
     * Every relative image and canonical URL on the site resolves against
     * this. Without it Next falls back to localhost, so a link shared to
     * Instagram or iMessage carried an og:image pointing at
     * http://localhost:8080 — which renders as a broken card everywhere
     * except the machine that made it. It showed up as a warning in the
     * production log rather than as anything visible on the page.
     */
    metadataBase: new URL(siteUrl()),
    ...(noindex ? { robots: { index: false, follow: false } } : {}),
    title: {
      default: 'Divine Feminine',
      template: '%s · Divine Feminine',
    },
    description:
      'A place to meet the woman you are becoming — and to keep choosing her.',
  }
}

export const viewport: Viewport = {
  themeColor: '#faf7f2',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${script.variable}`}>
      <body>{children}</body>
    </html>
  )
}
