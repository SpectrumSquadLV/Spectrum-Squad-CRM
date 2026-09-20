import type { Metadata } from 'next'
import Link from 'next/link'
import { Button, Rule } from '@/design-system/primitives'
import { Eyebrow, Placeholder, Prose, Section } from '@/design-system/patterns'

export const metadata: Metadata = {
  title: 'The Academy',
  description:
    'The deeper work, across Self, Love, Life and Wealth — for women who have already met HER and want to stay.',
}

export default function AcademyPage() {
  return (
    <>
      <Section className="pt-14 md:pt-24">
        <Eyebrow>The Academy</Eyebrow>
        <h1 className="mt-6 text-3xl md:text-4xl">
          Seven days will show you who she is.
          <br />
          This is where you stay.
        </h1>
        <Prose className="mt-8 text-lg">
          <p>
            The challenge gives you the practice. The Academy gives you the
            time, the depth and the company to make it the way you actually
            live — across all four areas, not just the one that hurts most right
            now.
          </p>
        </Prose>
      </Section>

      <Section>
        <Rule tone="gilt" />
        <Placeholder
          label="Needs your input"
          note="curriculum and format not written"
          className="mt-12"
        >
          <Prose className="text-sm">
            <p>
              This page needs the real shape of the Academy before it can sell
              anything: how long it runs, what is in it, whether it is
              self-paced or cohort-based, and what a woman actually gets in the
              first week.
            </p>
            <p>
              The structure underneath supports any of those. The copy cannot be
              written without you.
            </p>
          </Prose>
        </Placeholder>
      </Section>

      <Section>
        <h2 className="text-2xl">What carries over</h2>
        <Prose className="mt-4">
          <p>
            Everything. Your HER profile, every pattern you named, every time
            you logged choosing her, your RETURN practice and your HER Code — it
            is all already in your account, and the Academy builds on top of it
            rather than starting you over.
          </p>
          <p>
            This is the part a course platform cannot do. It does not know who
            you are becoming. This does.
          </p>
        </Prose>
      </Section>

      <Section className="pb-24">
        <Rule tone="gilt" />
        <Placeholder
          label="Pricing not final"
          note="one-time vs payment plan undecided"
          className="mt-12"
        >
          <p className="text-xs text-ink-soft">
            The architecture document has this at $1,000, with a payment plan
            and a refund window still to be decided. Nothing is charged until
            checkout is built, and the price itself will be a row in the{' '}
            <code className="text-clay-deep">offers</code> table — not written
            into this page.
          </p>
        </Placeholder>

        <div className="mt-12">
          <h2 className="text-2xl">Start with the seven days</h2>
          <Prose className="mt-4">
            <p>
              The Academy is not the first step, and you should not take it
              until you have met her. Do the week first.
            </p>
          </Prose>
          <Button size="lg" className="mt-8" asChild>
            <Link href="/7-days-to-her">Start 7 Days to HER</Link>
          </Button>
        </div>
      </Section>
    </>
  )
}
