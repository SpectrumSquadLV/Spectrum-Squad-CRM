'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * RETURN, one tap from anywhere.
 *
 * Deliberately NOT a fifth tab: it is quiet until she needs it, and it stays
 * out of the way of the four things she uses every day. Hidden on the RETURN
 * page itself, and while she is inside a day - interrupting her mid-exercise
 * with an exit is the opposite of the point.
 */
export function ReturnAffordance() {
  const pathname = usePathname()

  const hidden =
    pathname.startsWith('/my-practice/return') || pathname.includes('/day/')

  if (hidden) return null

  return (
    <Link
      href="/my-practice/return"
      className="fixed bottom-20 right-4 z-30 inline-flex min-h-11 items-center gap-2 rounded-full border border-rule-strong bg-alabaster/95 px-4 text-2xs text-ink-soft shadow-raised backdrop-blur-sm hover:border-clay hover:text-clay-deep md:bottom-6 md:right-6"
    >
      <span aria-hidden className="block size-1.5 rounded-full bg-gilt" />
      Return
    </Link>
  )
}
