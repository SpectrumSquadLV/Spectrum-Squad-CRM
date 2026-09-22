'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BookOpen, Compass, Heart, Sunrise } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

/**
 * Four tabs, not seven.
 *
 * There is no RETURN tab, and no RETURN anywhere else either: ME VS. HER is
 * the only framework in the product now, and a second one sitting beside it
 * asked a woman to remember two things on the day she can least afford to.
 */
const tabs = [
  { href: '/my-academy', label: 'Academy', icon: Compass, exact: true },
  { href: '/my-academy/today', label: 'Today', icon: Sunrise },
  { href: '/my-academy/her', label: 'HER', icon: Heart },
  // "Pages", matching THE PRIVATE PAGES on the home page. A tab and the
  // place it leads to should not have two different names.
  { href: '/my-academy/journal', label: 'Pages', icon: BookOpen },
]

export function MemberTabBar() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Member"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-rule bg-alabaster/95 backdrop-blur-sm md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="mx-auto flex max-w-lg">
        {tabs.map((tab) => {
          const active = tab.exact
            ? pathname === tab.href
            : pathname.startsWith(tab.href)
          const Icon = tab.icon
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-14 flex-col items-center justify-center gap-1 text-2xs',
                  active ? 'text-plum' : 'text-ink-muted',
                )}
              >
                <Icon aria-hidden size={18} strokeWidth={active ? 2 : 1.5} />
                {tab.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
