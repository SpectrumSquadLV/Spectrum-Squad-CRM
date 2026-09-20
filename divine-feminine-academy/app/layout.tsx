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

export const metadata: Metadata = {
  title: {
    default: 'Divine Feminine Academy',
    template: '%s · Divine Feminine Academy',
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
