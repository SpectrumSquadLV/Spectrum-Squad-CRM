import Link from 'next/link'
import { Button, Rule } from '@/design-system/primitives'

/**
 * Placeholder homepage.
 *
 * The real public site is Phase 2. This page exists so the Editorial surface
 * renders end to end and the tokens can be seen in place.
 */
export default function HomePage() {
  return (
    <main className="mx-auto max-w-4xl px-5 md:px-8">
      <div className="section-y">
        <p className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
          Divine Feminine Academy
        </p>

        <h1 className="mt-6 text-3xl md:text-4xl">
          She is not someone you become.
          <br />
          She is someone you return to.
        </h1>

        <p className="measure mt-8 text-lg text-ink-soft">
          A place to meet the woman you are becoming — and then to keep choosing
          her, on the ordinary days and the hard ones.
        </p>

        <div className="mt-10 flex flex-wrap gap-4">
          <Button size="lg" asChild>
            <Link href="/7-days-to-her">Start 7 Days to HER</Link>
          </Button>
          <Button size="lg" variant="secondary" asChild>
            <Link href="/academy">See the Academy</Link>
          </Button>
        </div>

        <Rule tone="gilt" className="mt-20" />

        <p className="mt-6 text-2xs text-ink-muted">
          Foundation build. The public site, the challenge engine and checkout
          are Phase 2 onward — see the Phase 1 architecture document.
        </p>
      </div>
    </main>
  )
}
