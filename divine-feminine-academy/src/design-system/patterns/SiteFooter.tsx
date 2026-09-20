import Link from 'next/link'
import { Rule } from '@/design-system/primitives'

const columns = [
  {
    heading: 'Start',
    links: [
      { href: '/7-days-to-her', label: '7 Days to HER' },
      { href: '/quiz', label: 'Which version of you?' },
      { href: '/assessment', label: 'Free assessment' },
      { href: '/academy', label: 'The Academy' },
      { href: '/programs', label: 'All programs' },
    ],
  },
  {
    heading: 'About',
    links: [
      { href: '/about', label: 'Who this is for' },
      { href: '/stories', label: 'Stories' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { href: '/legal/disclaimer', label: 'Not therapy' },
      { href: '/legal/privacy', label: 'Privacy' },
      { href: '/legal/terms', label: 'Terms' },
    ],
  },
]

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-rule bg-linen/50">
      <div className="mx-auto max-w-6xl px-5 py-14 md:px-8">
        <div className="grid gap-10 sm:grid-cols-2 md:grid-cols-4">
          <div>
            <p className="font-display text-lg leading-tight">
              Divine Feminine
              <span className="block text-2xs uppercase tracking-[0.22em] text-clay-deep">
                Academy
              </span>
            </p>
            <p className="mt-4 max-w-56 text-2xs text-ink-muted">
              She is not someone you become. She is someone you return to.
            </p>
          </div>

          {columns.map((col) => (
            <nav key={col.heading} aria-label={col.heading}>
              <h2 className="text-2xs uppercase tracking-[0.18em] text-ink-muted">
                {col.heading}
              </h2>
              <ul className="mt-4 space-y-1">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className="inline-flex min-h-9 items-center text-xs text-ink-soft hover:text-clay-deep"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <Rule tone="gilt" className="mt-12" />

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-2xs text-ink-muted">
          <p>© {new Date().getFullYear()} Divine Feminine Academy</p>
          <p>
            Education, not therapy.{' '}
            <Link href="/legal/disclaimer" className="underline underline-offset-2">
              What that means
            </Link>
          </p>
        </div>
      </div>
    </footer>
  )
}
