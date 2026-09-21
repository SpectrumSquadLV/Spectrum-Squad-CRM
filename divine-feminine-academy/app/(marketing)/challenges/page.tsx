import type { Metadata } from 'next'
import Link from 'next/link'
import { Rule } from '@/design-system/primitives'
import { Eyebrow, Prose, Section, StaffNote } from '@/design-system/patterns'
import { listChallenges } from '@/db/queries/challenges'
import { formatMoney } from '@/features/commerce/pricing'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Challenges',
  description:
    'Short, specific work on one thing at a time. Each challenge is a way in; the Divine Feminine is where it goes.',
}

/**
 * The challenges index.
 *
 * ME VS HER is not hard-coded anywhere on this page, and that is the whole
 * design. Publishing a challenge about money, boundaries or receiving means
 * inserting a programme row and pressing publish - it appears here, it gets
 * its own page, and nobody touches a route file.
 */
export default async function ChallengesPage() {
  const challenges = await listChallenges()

  return (
    <>
      <Section className="pt-14 md:pt-24">
        <Eyebrow>Ways in</Eyebrow>
        <h1 className="mt-6 text-3xl md:text-5xl">
          Start with the thing that hurts most.
        </h1>
        <Prose className="mt-8 text-lg">
          <p>
            A challenge is short and it is specific. It takes one pattern — the
            one costing you money, or love, or the way you speak to yourself —
            and works on it for a few days, on your phone.
          </p>
          <p>
            It is not the whole transformation. It is where the whole
            transformation starts being real.
          </p>
        </Prose>
      </Section>

      <Section>
        <Rule tone="gilt" />

        {challenges.length === 0 ? (
          <>
            <StaffNote what="no challenge is published yet" className="mt-12">
              <p>
                This page lists every programme whose kind is “challenge” and
                whose status is “published”. Nothing matches, so a visitor sees
                an invitation to the Divine Feminine instead of an empty page.
              </p>
              <p>Publish one in /admin/programs and it appears here.</p>
            </StaffNote>
            <div className="mt-12">
              <h2 className="text-2xl">The doors are opening soon.</h2>
              <Prose className="mt-4">
                <p>
                  The first challenges are being written now. In the meantime,
                  the Divine Feminine is the work they all lead to.
                </p>
              </Prose>
              <Link
                href="/the-divine-feminine"
                className="mt-6 inline-flex min-h-11 items-center text-sm underline underline-offset-4 hover:text-clay-deep"
              >
                See the Divine Feminine
              </Link>
            </div>
          </>
        ) : (
          <ul className="mt-12 divide-y divide-rule border-y border-rule">
            {challenges.map((challenge) => (
              <li key={challenge.slug}>
                <Link
                  href={`/challenges/${challenge.slug}`}
                  className="group flex flex-col gap-3 py-8 md:flex-row md:items-baseline md:gap-8"
                >
                  <div className="md:w-40 md:shrink-0">
                    <Eyebrow>
                      {[
                        challenge.durationDays
                          ? `${challenge.durationDays} days`
                          : null,
                        challenge.offer
                          ? formatMoney(
                              challenge.offer.priceCents,
                              challenge.offer.currency,
                            )
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Eyebrow>
                  </div>
                  <div>
                    <h2 className="font-display text-2xl leading-tight transition-colors group-hover:text-clay-deep md:text-3xl">
                      {challenge.title}
                    </h2>
                    {challenge.subtitle && (
                      <p className="measure mt-3 text-base text-ink-soft">
                        {challenge.subtitle}
                      </p>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section className="pb-24">
        <Rule tone="gilt" />
        <h2 className="mt-12 text-2xl md:text-4xl">Where they all go</h2>
        <Prose className="mt-6 text-lg">
          <p>
            Every challenge is a door into the same room. The Divine Feminine is
            the room — the long work on who you are being with your money, your
            love, your name and your life.
          </p>
        </Prose>
        <Link
          href="/the-divine-feminine"
          className="mt-8 inline-flex min-h-11 items-center text-sm underline underline-offset-4 hover:text-clay-deep"
        >
          The Divine Feminine
        </Link>
      </Section>
    </>
  )
}
