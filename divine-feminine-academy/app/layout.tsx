import type { Metadata, Viewport } from 'next'
import { Fraunces, Inter } from 'next/font/google'
import './globals.css'

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
    <html lang="en" className={`${display.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  )
}
