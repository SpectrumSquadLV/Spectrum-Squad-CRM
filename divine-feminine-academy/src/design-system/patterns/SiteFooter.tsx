import Link from 'next/link'
import { Rule } from '@/design-system/primitives'

/*
 * The four columns are the four parts of the ecosystem, in the order a woman
 * moves through them: she hears the podcast, she starts a challenge, she does
 * the work. /stories is not listed anywhere - it is unpublished.
 */
const columns = [
  {
    heading: 'The work',
    links: [
      { href: '/the-divine-feminine', label: 'The Divine Feminine' },
      { href: '/challenges', label: 'Challenges' },
      { href: '/programs', label: 'Everything' },
    ],
  },
  {
    heading: 'Listen & read',
    links: [
      { href: '/podcast', label: 'Brown Girls Need Healing Too' },
      { href: '/writing', label: 'Writing' },
      { href: '/quiz', label: 'Which version of you?' },
      { href: '/assessment', label: 'Free assessment' },
    ],
  },
  {
    heading: 'About',
    links: [
      { href: '/about', label: 'Quiana' },
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
        <div className="grid gap-10 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          <div>
            <p className="font-display text-lg leading-tight">
              Divine Feminine
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
          <p>© {new Date().getFullYear()} Divine Feminine</p>
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
