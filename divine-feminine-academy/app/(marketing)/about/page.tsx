import type { Metadata } from 'next'
import Link from 'next/link'
import { Button, Rule } from '@/design-system/primitives'
import { Eyebrow, Placeholder, Prose, Section } from '@/design-system/patterns'
import { siteImage } from '@/db/queries/images'
import { SiteImage } from '@/features/images/SiteImage'

/** The photograph comes from the database, which the build cannot reach. */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'About',
  description:
    'Who the Divine Feminine is for, what it is, and what it is not.',
}

export default async function AboutPage() {
  const portrait = await siteImage('about-portrait')

  return (
    <>
      <Section className="pt-14 md:pt-24">
        <Eyebrow>About</Eyebrow>
        <h1 className="mt-6 text-3xl md:text-4xl">Who this is for</h1>
        <Prose className="mt-8 text-lg">
          <p>
            For the woman who is functioning. Who is, by most measures, doing
            fine. Who has a version of herself she can see clearly and cannot
            seem to stay inside of.
          </p>
          <p>
            Not for fixing something broken. For returning to something that was
            always there and got quiet.
          </p>
        </Prose>
      </Section>

      <Section>
        <Rule tone="gilt" />
        <h2 className="mt-12 text-2xl">What this is not</h2>
        <Prose className="mt-4">
          <p>
            It is not therapy, and it is not a replacement for it. There is no
            diagnosis here and no clinician reading what you write. If what you
            are carrying needs professional care, this is not the thing — and
            saying so plainly matters more to us than signing you up.
          </p>
          <p>
            It is also not a course you watch. There is very little to watch.
            Almost all of it is you, writing, and then you, doing something
            differently.
          </p>
        </Prose>
        <Button variant="link" className="mt-4" asChild>
          <Link href="/legal/disclaimer">Read the full disclaimer</Link>
        </Button>
      </Section>

      <Section className="pb-24">
        {portrait && (
          <div className="mb-10 max-w-md">
            <SiteImage image={portrait} shape="portrait" />
          </div>
        )}
        <Placeholder label="Your bio goes here" note="not written yet">
          <Prose className="text-sm">
            <p>
              Who you are, why you built this, and what you went through that
              makes you the person to teach it. In your own words — this is the
              part of the page people actually read, and it is the one thing
              nobody else can write for you.
            </p>
            {!portrait && (
              <p>
                A photograph belongs here too — put one in under Photographs in
                the admin. Not stock photography: the positioning does not
                survive it.
              </p>
            )}
          </Prose>
        </Placeholder>
      </Section>
    </>
  )
}
