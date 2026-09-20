import type { Metadata, Viewport } from 'next'
import { Fraunces, Inter } from 'next/font/google'
import './globals.css'

const display = Fraunces({
  subsets: ['latin'],
  variable: '--font-display-family',
  display: 'swap',
  axes: ['SOFT', 'WONK', 'opsz'],
})

const sans = Inter({
  subsets: ['latin'],
  variable: '--font-sans-family',
  display: 'swap',
})

/**
 * Belt and braces with robots.txt.
 *
 * A crawler that ignores robots.txt may still respect a noindex meta tag, and
 * on a preview carrying unconfirmed crisis numbers that redundancy is worth
 * the two lines.
 */
const noindex = process.env.SITE_NOINDEX === '1'

export const metadata: Metadata = {
  ...(noindex ? { robots: { index: false, follow: false } } : {}),
  title: {
    default: 'Divine Feminine',
    template: '%s · Divine Feminine',
  },
  description:
    'A place to meet the woman you are becoming — and to keep choosing her.',
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
