import type { Metadata } from 'next'
import Link from 'next/link'
import { MemberTabBar } from '@/design-system/patterns'
import { SignOutButton } from '@/features/auth/SignOutButton'

/**
 * Every page under here reads the signed-in woman's own data, so none of it
 * may be prerendered and served to somebody else.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: { default: 'My Academy', template: '%s · My Academy' },
  robots: { index: false, follow: false },
}

export default function MemberLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-bone">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-plum focus:px-4 focus:py-2 focus:text-bone"
      >
        Skip to content
      </a>

      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4 md:px-8">
          <Link href="/my-academy" className="font-display text-sm leading-none">
            Divine Feminine
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/my-academy/account"
              className="inline-flex min-h-11 items-center px-3 text-2xs text-ink-muted hover:text-ink"
            >
              Account
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>

      {/* Bottom padding clears the mobile tab bar. */}
      <main id="main" className="pb-24 md:pb-0">
        {children}
      </main>

      <MemberTabBar />
    </div>
  )
}
