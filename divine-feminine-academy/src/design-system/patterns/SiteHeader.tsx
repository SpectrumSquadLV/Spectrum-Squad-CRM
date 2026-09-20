'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { createClient } from '@/lib/auth/client'
import { cn } from '@/lib/utils/cn'

const links = [
  { href: '/quiz', label: 'The quiz' },
  { href: '/7-days-to-her', label: '7 Days to HER' },
  { href: '/academy', label: 'The Academy' },
  { href: '/writing', label: 'Writing' },
  { href: '/about', label: 'About' },
  { href: '/stories', label: 'Stories' },
]

/**
 * Resolves whether someone is signed in, in the browser.
 *
 * Deliberately not a server read: the marketing pages are statically
 * prerendered and must stay that way. Defaults to signed-out, which is the
 * correct first paint for the overwhelming majority of visitors.
 */
function useSignedIn() {
  const [signedIn, setSignedIn] = useState(false)

  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined

    try {
      const supabase = createClient()
      supabase.auth.getUser().then(({ data }) => {
        if (active) setSignedIn(Boolean(data.user))
      })
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        if (active) setSignedIn(Boolean(session?.user))
      })
      unsubscribe = () => data.subscription.unsubscribe()
    } catch {
      // Supabase is not configured. Signed-out is the right assumption.
    }

    return () => {
      active = false
      unsubscribe?.()
    }
  }, [])

  return signedIn
}

export function SiteHeader() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()
  const signedIn = useSignedIn()

  return (
    <header className="border-b border-rule bg-bone/90 backdrop-blur-sm sticky top-0 z-40">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-5 py-4 md:px-8">
        <Link
          href="/"
          className="font-display text-lg leading-none tracking-tight"
          onClick={() => setOpen(false)}
        >
          Divine Feminine
          <span className="block text-2xs uppercase tracking-[0.22em] text-clay-deep">
            Academy
          </span>
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-8 md:flex">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={pathname === l.href ? 'page' : undefined}
              className={cn(
                'text-xs transition-colors',
                pathname === l.href
                  ? 'text-ink'
                  : 'text-ink-muted hover:text-ink',
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="hidden md:block">
          <Button size="sm" variant={signedIn ? 'secondary' : 'primary'} asChild>
            <Link href={signedIn ? '/my-academy' : '/login'}>
              {signedIn ? 'My Academy' : 'Sign in'}
            </Link>
          </Button>
        </div>

        <button
          type="button"
          className="-mr-2 inline-flex h-11 w-11 items-center justify-center md:hidden"
          aria-expanded={open}
          aria-controls="site-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((v) => !v)}
        >
          <span aria-hidden className="relative block h-3 w-5">
            <span
              className={cn(
                'absolute inset-x-0 top-0 h-px bg-ink transition-transform duration-[--duration-quick]',
                open && 'translate-y-[6px] rotate-45',
              )}
            />
            <span
              className={cn(
                'absolute inset-x-0 top-1/2 h-px bg-ink transition-opacity duration-[--duration-quick]',
                open && 'opacity-0',
              )}
            />
            <span
              className={cn(
                'absolute inset-x-0 bottom-0 h-px bg-ink transition-transform duration-[--duration-quick]',
                open && '-translate-y-[6px] -rotate-45',
              )}
            />
          </span>
        </button>
      </div>

      {open && (
        <nav
          id="site-menu"
          aria-label="Main"
          className="border-t border-rule bg-bone px-5 py-4 md:hidden"
        >
          <ul className="flex flex-col">
            {links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="flex min-h-12 items-center text-sm text-ink-soft"
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
          <Button className="mt-4 w-full" asChild>
            <Link href={signedIn ? '/my-academy' : '/login'} onClick={() => setOpen(false)}>
              {signedIn ? 'My Academy' : 'Sign in'}
            </Link>
          </Button>
        </nav>
      )}
    </header>
  )
}
