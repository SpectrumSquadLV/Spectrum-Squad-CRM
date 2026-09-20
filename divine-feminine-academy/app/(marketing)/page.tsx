import type { Metadata } from 'next'
import Link from 'next/link'
import { Button, Rule } from '@/design-system/primitives'
import { Eyebrow, Prose, PullQuote, Section } from '@/design-system/patterns'
import { archetypeList } from '@/features/quiz/archetypes'
import { siteImage } from '@/db/queries/images'
import { SiteImage } from '@/features/images/SiteImage'
import { StatementBand } from '@/features/images/StatementBand'

/*
 * Dynamic because the photographs come from the database, and the database is
 * not reachable from the build. A statically generated home page would be
 * frozen with whatever was in the slots at build time - which, on a platform
 * where the database sits on a private network the builder cannot see, is
 * nothing, forever.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Divine Feminine',
  description:
    'She is not someone you become. She is someone you return to. A seven-day practice, and a place that remembers who you are becoming.',
}

const areas = [
  {
    name: 'Self',
    line: 'How you speak to yourself when no one is listening.',
    rule: 'border-area-self',
  },
  {
    name: 'Love',
    line: 'What you accept, and what you stopped asking for.',
    rule: 'border-area-love',
  },
  {
    name: 'Life',
    line: 'The days you are living versus the ones you meant to.',
    rule: 'border-area-life',
  },
  {
    name: 'Wealth',
    line: 'What you believe you are allowed to want.',
    rule: 'border-area-wealth',
  },
]

export default async function HomePage() {
  const [hero, statement, close] = await Promise.all([
    siteImage('home-hero'),
    siteImage('statement-portrait'),
    siteImage('home-close'),
  ])

  return (
    <>
      {/*
        * Wider when there is a photograph, because the editorial measure was
        * set for a single column of text. Put a 20rem portrait beside it and
        * the headline is left with under 400px, which breaks "She is not
        * someone you become" across seven lines.
        */}
      <Section className="pt-14 md:pt-24" width={hero ? 'wide' : 'default'}>
        <div
          className={
            hero
              ? 'grid items-center gap-10 md:grid-cols-[1fr_minmax(0,19rem)] md:gap-16'
              : undefined
          }
        >
          <div>
            <Eyebrow>Divine Feminine</Eyebrow>
            <h1 className="mt-6 text-3xl md:text-4xl">
              She is not someone you become.
              <br />
              She is someone you return to.
            </h1>
            <Prose className="mt-8 text-lg">
              <p>
                There is a version of you who already knows what she wants, says
                it out loud, and does not apologise for the wanting. You have met
                her. You have just not been able to stay with her.
              </p>
              <p>Seven days. One practice. A way back.</p>
            </Prose>

            <div className="mt-10 flex flex-wrap gap-4">
              <Button size="lg" asChild>
                <Link href="/me-vs-her">Start ME VS HER</Link>
              </Button>
              <Button size="lg" variant="secondary" asChild>
                <Link href="/quiz">Take the quiz</Link>
              </Button>
            </div>
          </div>

          {hero && (
            <div className="order-first md:order-none">
              <SiteImage image={hero} shape="portrait" priority />
            </div>
          )}
        </div>
      </Section>

      <StatementBand
        className="mt-6"
        image={statement}
        eyebrow="Day five"
        headline={
          <>
            The problem
            <br />
            is you.
          </>
        }
        answer="And that is the best news you will ever receive."
        footnote={
          <>
            Not what was done to you. Not what you were handed. The part of the
            pattern that belongs to you — because that is the part you can
            reach, and the part that moves when you do.
          </>
        }
      />

      <Section>
        <Rule tone="gilt" />
        <h2 className="mt-12 text-2xl">Start by meeting her</h2>
        <Prose className="mt-4">
          <p>
            Before any of it, there is one useful question: when something
            frightens you, which version of you takes the wheel? There are four
            of her, and ninety seconds will tell you which one has been driving.
          </p>
        </Prose>

        <ul className="mt-10 grid gap-3 sm:grid-cols-2">
          {archetypeList.map((a) => (
            <li key={a.slug}>
              <Link
                href={`/quiz/${a.slug}`}
                className="block h-full rounded-xl border border-rule bg-alabaster p-5 transition-colors hover:border-clay"
              >
                <h3 className="font-display text-lg">{a.name}</h3>
                <p className="mt-1.5 text-2xs text-ink-muted">{a.tagline}</p>
              </Link>
            </li>
          ))}
        </ul>

        <div className="mt-10">
          <Button size="lg" asChild>
            <Link href="/quiz">Take the quiz — free</Link>
          </Button>
        </div>
      </Section>

      <Section>
        <Rule tone="gilt" />
        <h2 className="mt-12 text-2xl">Four places it shows up</h2>
        <Prose className="mt-4">
          <p>
            The pattern is never only in one room. It is the same woman making
            the same choice, in four different lights.
          </p>
        </Prose>

        <ul className="mt-12 grid gap-px sm:grid-cols-2">
          {areas.map((area) => (
            <li key={area.name} className={`border-l-2 pl-5 py-2 ${area.rule}`}>
              <h3 className="font-display text-xl">{area.name}</h3>
              <p className="mt-1 max-w-xs text-xs text-ink-muted">{area.line}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section>
        <Rule tone="gilt" />
        <h2 className="mt-12 text-2xl">How it works</h2>

        <ol className="mt-10 space-y-10">
          <li>
            <Eyebrow>One</Eyebrow>
            <h3 className="mt-2 font-display text-xl">You name her</h3>
            <Prose className="mt-2 text-sm">
              <p>
                On the first day you write two columns. What sets you off, how
                you respond now, and how HER would respond instead. That becomes
                your profile, and the platform keeps it.
              </p>
            </Prose>
          </li>
          <li>
            <Eyebrow>Two</Eyebrow>
            <h3 className="mt-2 font-display text-xl">You practise choosing her</h3>
            <Prose className="mt-2 text-sm">
              <p>
                Over the week you go after the belief underneath the pattern,
                the audience you are performing for, and the behaviour you keep
                repeating. Then you log it, in real time, every time you choose
                HER instead.
              </p>
            </Prose>
          </li>
          <li>
            <Eyebrow>Three</Eyebrow>
            <h3 className="mt-2 font-display text-xl">You learn the way back</h3>
            <Prose className="mt-2 text-sm">
              <p>
                You will lose her. Everyone does. The practice that matters is
                not staying — it is returning, and knowing exactly how. That is
                the part you keep for good.
              </p>
            </Prose>
          </li>
        </ol>

        <PullQuote className="mt-16">
          You are not starting over. You are coming back.
        </PullQuote>
      </Section>

      <Section>
        <Rule tone="gilt" />
        <div className="mt-12">
          <h2 className="text-2xl">What you write here stays yours</h2>
          <Prose className="mt-4">
            <p>
              Your journal is encrypted before it reaches our database. Not
              hidden behind a permission setting — encrypted, so that nobody who
              works here can read it, including the woman who built this.
            </p>
            <p>
              We can see that you wrote. We cannot see what you wrote. That is
              on purpose, and it is not going to change.
            </p>
          </Prose>
          <Button variant="link" className="mt-4" asChild>
            <Link href="/legal/privacy">How that works</Link>
          </Button>
        </div>
      </Section>

      <Section className="pb-24">
        <div className="overflow-hidden rounded-xl border border-rule bg-alabaster">
          {close && (
            <SiteImage image={close} shape="landscape" rounded="none" />
          )}
          <div className="p-8 md:p-14">
          <h2 className="text-2xl">Seven days.</h2>
          <Prose className="mt-4">
            <p>
              Start today. You will need about twenty minutes, and somewhere to
              be honest.
            </p>
          </Prose>
          <Button size="lg" className="mt-8" asChild>
            <Link href="/me-vs-her">Begin</Link>
          </Button>
          </div>
        </div>
      </Section>
    </>
  )
}
