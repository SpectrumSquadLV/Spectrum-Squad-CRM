import type { Metadata } from 'next'
import Link from 'next/link'
import { Button, Rule } from '@/design-system/primitives'
import { Eyebrow, Prose, PullQuote, Section } from '@/design-system/patterns'
import { siteImage } from '@/db/queries/images'
import { PhotoBand } from '@/features/images/Editorial'
import { imageSlot } from '@/features/images/slots'

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
    'She is not someone you become. She is someone you return to. Money, love, and the way you speak to yourself when no one is listening.',
}

/**
 * The home page.
 *
 * Built as a scroll rather than a stack of cards, and pointed at what changes
 * rather than at the way in. The quiz used to have a section of its own two
 * screens down; it is a single line near the end now, because a woman arriving
 * here is not looking for a quiz, she is looking for her money, her love and
 * the way she speaks to herself when nobody is listening.
 *
 * The rhythm is deliberate and alternating: an enormous photograph, then a
 * quiet page of words, then an enormous photograph. Two loud things in a row
 * cancel each other out.
 */

const lives = [
  {
    word: 'Money',
    line: 'What you believe you are allowed to want, and what you have been charging for it.',
    rule: 'border-area-wealth',
  },
  {
    word: 'Love',
    line: 'What you accept. What you stopped asking for. Who you become to keep the peace.',
    rule: 'border-area-love',
  },
  {
    word: 'Yourself',
    line: 'How you speak to yourself when no one is listening, and whether you would say it to anybody else.',
    rule: 'border-area-self',
  },
]

export default async function HomePage() {
  const [hero, life, manifesto] = await Promise.all([
    siteImage('home-hero'),
    siteImage('home-life'),
    siteImage('statement-portrait'),
  ])

  return (
    <>
      {/*
        The opening. She is looking up and out of frame, and the words sit in
        the plaster above her head - the reason that crop keeps so much empty
        ground. Nothing is ever placed over her.
      */}
      <PhotoBand
        images={hero}
        slot={imageSlot('home-hero')!}
        eyebrow="Quiana Blake"
        headline={
          <>
            You don’t need
            <br />
            to find her.
          </>
        }
        sub="She’s already there."
        place="top-left"
        mobilePlace="top"
        priority
      />

      <Section className="pt-20 md:pt-28">
        <Prose className="text-xl md:text-2xl">
          <p>
            There is a version of you who already knows what she wants, says it
            out loud, and does not apologise for the wanting. You have met her.
            You have just not been able to <em>stay</em> with her.
          </p>
        </Prose>

        <div className="mt-12 flex flex-wrap gap-4">
          <Button size="lg" asChild>
            <Link href="/me-vs-her">Start ME VS HER — $11</Link>
          </Button>
          <Button size="lg" variant="quiet" asChild>
            <Link href="/the-divine-feminine">The full course</Link>
          </Button>
        </div>
      </Section>

      {/* Quiet, and entirely words. The loud thing is coming. */}
      <Section className="pt-24 md:pt-32">
        <Eyebrow>Where it shows up</Eyebrow>
        <h2 className="mt-6 text-3xl md:text-5xl">
          It is never only in one room.
        </h2>
        <Prose className="mt-6 text-lg">
          <p>
            It is the same woman making the same choice, in three different
            lights. Change it in one and the others move on their own.
          </p>
        </Prose>

        <ul className="mt-16 space-y-14">
          {lives.map((life) => (
            <li key={life.word} className={`border-l-2 pl-6 md:pl-10 ${life.rule}`}>
              <h3 className="font-display text-4xl leading-none md:text-6xl">
                {life.word}
              </h3>
              <p className="measure mt-4 text-base text-ink-soft md:text-lg">
                {life.line}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      {/*
        What all of that is actually for.
        The only frame on the page that shows a life rather than a portrait,
        and it comes straight after the three things that change. One sentence
        on it and nothing else - the picture is doing the arguing.

        No words on this one at any width. There is no flat ground in it: the
        frame is hedges, palms and a mountain range, and verify:photo-type
        measured the eyebrow at 3.43:1 against it. A plate with the line under
        it is both readable and the better composition.
      */}
      <PhotoBand
        className="mt-24 md:mt-32"
        images={life}
        slot={imageSlot('home-life')!}
        eyebrow="What it is for"
        headline={<>A Tuesday that feels like yours.</>}
        overlay={false}
      />

      {/*
        The turn. She is seated to the right of this frame with a wall of empty
        plaster beside her, so the largest type on the site goes in that wall.
      */}
      <PhotoBand
        className="mt-20 md:mt-24"
        images={manifesto}
        slot={imageSlot('statement-portrait')!}
        eyebrow="Day five"
        headline={
          <>
            The problem
            <br />
            is you.
          </>
        }
        sub="And that is the best news you will ever receive."
        place="left"
        mobilePlace="top"
      />

      <Section className="pt-20 md:pt-28">
        <Prose className="text-lg">
          <p>
            Not what was done to you. Not what you were handed. Not the part
            that was never yours to carry.
          </p>
          <p>
            The part of the pattern that <strong>belongs to you</strong> —
            because that is the part you can reach, and the part that moves
            when you do.
          </p>
        </Prose>

        <PullQuote className="mt-16">
          You are not starting over. You are <em>coming back</em>.
        </PullQuote>
      </Section>

      <Section className="pt-24 md:pt-32">
        <Rule tone="gilt" />
        <h2 className="mt-12 text-2xl md:text-4xl">
          What you write here stays yours
        </h2>
        <Prose className="mt-6 text-lg">
          <p>
            Your journal is encrypted before it reaches our database. Not
            hidden behind a permission setting — <em>encrypted</em>, so that
            nobody who works here can read it, including me.
          </p>
          <p>
            We can see <em>that</em> you wrote. We cannot see <em>what</em> you
            wrote. That is on purpose, and it is not going to change.
          </p>
        </Prose>
        <Button variant="link" className="mt-6" asChild>
          <Link href="/legal/privacy">How that works</Link>
        </Button>
      </Section>

      <Section className="pb-32 pt-24 md:pt-32">
        <Rule tone="gilt" />
        <h2 className="mt-12 text-3xl md:text-5xl">Seven days.</h2>
        <Prose className="mt-6 text-lg">
          <p>
            About twenty minutes a day, on your phone, starting whenever you
            do. You will need somewhere to be honest.
          </p>
        </Prose>
        <Button size="lg" className="mt-10" asChild>
          <Link href="/me-vs-her">Begin — $11</Link>
        </Button>

        {/*
          The quiz, in one line.
          It used to have a section two screens up, which pointed the whole page
          at the way in rather than at what changes.
        */}
        <p className="mt-12 text-sm text-ink-muted">
          Not ready to start?{' '}
          <Link href="/quiz" className="underline underline-offset-4 hover:text-clay-deep">
            Find out which version of you is running the show
          </Link>{' '}
          — ninety seconds, free.
        </p>
      </Section>
    </>
  )
}
