import type { Metadata } from 'next'
import Link from 'next/link'
import { Button, Rule } from '@/design-system/primitives'
import {
  Eyebrow,
  Prose,
  PullQuote,
  Section,
  StaffNote,
} from '@/design-system/patterns'
import { siteImage } from '@/db/queries/images'
import { PhotoBand } from '@/features/images/Editorial'
import { imageSlot } from '@/features/images/slots'
import { SiteImage, SiteImageFrame } from '@/features/images/SiteImage'
import { listChallenges } from '@/db/queries/challenges'
import { featuredEpisode } from '@/db/queries/podcast'
import { formatMoney } from '@/features/commerce/pricing'
import { formatDuration } from '@/features/writing/markdown'
import { showName } from '@/features/podcast/show'
import {
  areaRule,
  pain,
  painIsWritten,
  possibility,
  possibilityIsWritten,
} from '@/features/home/copy'

/*
 * Dynamic because the photographs, the challenges and the latest episode all
 * come from the database, and the database is not reachable from the build. A
 * statically generated home page would be frozen with whatever was there at
 * build time — which, on a platform where the database sits on a private
 * network the builder cannot see, is nothing, forever.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Divine Feminine — Quiana Blake',
  description:
    'You know the life you want. The love, the money, the success, the freedom. So why does it still feel so hard to create it?',
  openGraph: {
    title: 'Divine Feminine',
    description:
      'You know the life you want. So why does it still feel so hard to create it?',
  },
}

/**
 * THE HOME PAGE.
 *
 * Fourteen sections, and the order of them is the argument.
 *
 * It opens on what she WANTS, not on what this site sells. It spends its
 * longest stretch on what she actually does in love, money, success and
 * manifestation — long enough that by the time anything is offered she has
 * already recognised herself several times. Only then does it name the
 * pattern, show the after, and arrive at the Divine Feminine.
 *
 * Divine Feminine is the destination. It gets three screens in the middle of
 * the page rather than a card in a row of cards, because a woman who has just
 * understood her own pattern needs to understand why deeper work is necessary
 * before she is shown a door. The challenges are the doors, and they come
 * after it — DB-driven, so publishing a money challenge is a row rather than
 * a rebuild.
 *
 * WHAT IS NOT HERE, deliberately:
 *
 * The pain copy. It is the most important writing on the site and it comes
 * out of Quiana, not out of this file. The layout is built for the exact
 * shape those lines take and the section does not render until they exist —
 * see src/features/home/copy.ts. A visitor sees a page that reads as
 * finished; only an admin sees what is outstanding.
 *
 * A Divine Feminine price. Nothing on this page states one, because none has
 * been decided, and inventing one so a button has something to say is how a
 * business ends up honouring a number it never chose.
 *
 * Testimonials. There are none yet, and there will be none until there are
 * real ones.
 */
export default async function HomePage() {
  const [hero, wine, manifesto, palm, childhood, shadow, challenges, episode] =
    await Promise.all([
      siteImage('home-hero'),
      siteImage('home-life'),
      siteImage('statement-portrait'),
      siteImage('divine-feminine-hero'),
      siteImage('about-story'),
      siteImage('me-vs-her-hero'),
      listChallenges(),
      featuredEpisode(),
    ])

  return (
    <>
      {/* ---------------------------------------------------------------- 1
        DESIRE. What she wants, before any method is mentioned.
        She is low in the frame with a wide field of empty plaster above her
        head, which is the only reason the largest type on the site can sit on
        this photograph at all. Nothing is ever placed over her.
      */}
      <PhotoBand
        images={hero}
        slot={imageSlot('home-hero')!}
        eyebrow="Quiana Blake"
        headline={
          <>
            You know the life
            <br />
            you want.
          </>
        }
        sub="The love. The money. The success. The freedom. The abundance."
        place="top-left"
        mobilePlace="top"
        priority
      />

      {/* ---------------------------------------------------------------- 2
        THE GAP. Typography only, and short. The loud thing has just happened.
      */}
      <Section className="pt-20 md:pt-28">
        <h2 className="text-3xl leading-tight md:text-5xl">
          So why does it still feel so <em>hard</em> to create it?
        </h2>
        <Prose className="mt-10 text-lg">
          <p>
            You are not lazy about it. You have read the books, done the work,
            said the affirmations and meant them.
          </p>
          <p>
            And somewhere underneath all of it, something keeps putting the
            same life back.
          </p>
        </Prose>
      </Section>

      {/* ------------------------------------------------------------- 3–6
        PAIN RECOGNITION. Love, Money, Success, Manifestation.

        The longest section on the page when it is written, and absent until
        it is. Each block is one word at display size over a stack of short
        behavioural lines — the shape Quiana's lines are written to, so they
        drop straight in with no layout work.
      */}
      {painIsWritten ? (
        <>
          <Section className="pt-24 md:pt-36">
            <Eyebrow>If you are honest</Eyebrow>
            <h2 className="mt-6 text-3xl md:text-5xl">
              You already know where it goes.
            </h2>

            <div className="mt-20 space-y-24 md:space-y-32">
              {pain.slice(0, 2).map((block) => (
                <PainBlock key={block.word} block={block} />
              ))}
            </div>
          </Section>

          {/*
            The wine, once, in the middle of the longest section.

            It is the only picture in this stretch and it interrupts the
            reading on purpose — four blocks of recognition in a row is more
            than anybody sits through without a breath. Which is also why the
            pain section is split in two around it rather than having the band
            nested inside: a full-bleed band inside a max-width Section is not
            full-bleed, it is a small inset box, and the first build of this
            made exactly that mistake.

            No words on it at any width: the frame is hedges, palms and a
            mountain range, and verify:photo-type measured the eyebrow at
            3.43:1 against it. A plate with the line beneath it is both
            readable and the better composition.
          */}
          <PhotoBand
            className="mt-24 md:mt-32"
            images={wine}
            slot={imageSlot('home-life')!}
            eyebrow="What it is for"
            headline={<>A Tuesday that feels like yours.</>}
            overlay={false}
          />

          <Section className="pt-20 md:pt-28">
            <div className="space-y-24 md:space-y-32">
              {pain.slice(2).map((block) => (
                <PainBlock key={block.word} block={block} />
              ))}
            </div>
          </Section>
        </>
      ) : (
        <>
          <Section className="pt-24 md:pt-32">
            <StaffNote what="the pain copy — Love, Money, Success, Manifestation">
              <p>
                This is the largest and most important section of the home page
                and it is not rendered, because none of it is written. A
                visitor sees the page go straight from the gap to the reframe,
                which reads as finished rather than unfinished.
              </p>
              <p>
                The structure is built and waiting in
                src/features/home/copy.ts. What it needs from you is the actual
                psychology: the specific things a woman does in each of the
                four areas — one behaviour per line, short enough to read in a
                second. Not feelings, not adjectives. The test is that she
                reads the LOVE block and thinks “how does she know I do that”.
              </p>
              <p>
                Send them the way you sent ME VS HER. Filling one area makes
                that block appear; the rest stay hidden until they are written
                too.
              </p>
            </StaffNote>
          </Section>

          {/* The picture still runs, so the page keeps its rhythm meanwhile. */}
          <PhotoBand
            className="mt-16 md:mt-24"
            images={wine}
            slot={imageSlot('home-life')!}
            eyebrow="What it is for"
            headline={<>A Tuesday that feels like yours.</>}
            overlay={false}
          />
        </>
      )}

      {/* ---------------------------------------------------------------- 7
        THE REFRAME. ME and HER get named here, not taught.
        She is seated to the right of this frame with a wall of empty plaster
        beside her, so the largest type on the site goes in that wall.
      */}
      <PhotoBand
        className="mt-20 md:mt-28"
        images={manifesto}
        slot={imageSlot('statement-portrait')!}
        eyebrow="The turn"
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

        <h2 className="mt-16 text-2xl leading-tight md:text-4xl">
          You don’t have a wanting problem.
          <br />
          You have a <strong>pattern</strong> problem.
        </h2>

        <Prose className="mt-8 text-lg">
          <p>
            There is a version of you who has been running things for a long
            time, and she has been good at it. Call her <strong>ME</strong>.
            Everything she does was once the safest thing available.
          </p>
          <p>
            And there is the one you keep catching glimpses of. Call her{' '}
            <strong>HER</strong>. She is not someone you become. She is someone
            you <em>return to</em>.
          </p>
        </Prose>
      </Section>

      {/* ---------------------------------------------------------------- 8
        THE POSSIBILITY. The after, in the same four areas.
        Palm: reaching up, looking up, smiling. Words never go on this one —
        a dried frond fills the upper half and type lands across all of it.
      */}
      <PhotoBand
        className="mt-20 md:mt-28"
        images={palm}
        slot={imageSlot('divine-feminine-hero')!}
        eyebrow="The other side of it"
        headline={<>Her whole life is different.</>}
        overlay={false}
      />

      {possibilityIsWritten ? (
        <Section className="pt-16 md:pt-20">
          <ul className="space-y-16 md:space-y-20">
            {possibility.map((block) => (
              <li key={block.word}>
                <h3
                  className={`border-l-2 pl-6 font-display text-3xl leading-none md:pl-10 md:text-5xl ${areaRule[block.area]}`}
                >
                  {block.word}
                </h3>
                <ul className="mt-8 space-y-5 md:space-y-6">
                  {block.lines.map((line) => (
                    <li
                      key={line}
                      className="measure-wide font-display text-lg leading-snug text-ink md:text-xl"
                    >
                      {line}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Section>
      ) : (
        <Section className="pt-16 md:pt-20">
          <StaffNote what="the after — what changes in each of the four areas">
            <p>
              The same four areas as the pain section, in the present tense.
              What she is actually doing differently once the pattern moves:
              behaviours again, not feelings.
            </p>
            <p>
              Same file — src/features/home/copy.ts, the `possibility` array.
              It is hidden until it is written, so the page reads straight from
              the photograph into the Divine Feminine.
            </p>
          </StaffNote>
        </Section>
      )}

      {/* ---------------------------------------------------------- 9, i–iii
        DIVINE FEMININE. Three screens, not a card.

        This is the whole point of the repositioning. A challenge gets a line
        in a list further down; this gets a chapter, arriving as the answer to
        a problem she now understands rather than as a product introduced to
        somebody still being convinced there is one.
      */}
      <Section className="pt-28 md:pt-40">
        <Rule tone="gilt" />
        <Eyebrow className="mt-12">The work itself</Eyebrow>
        <h2 className="mt-6 text-4xl leading-none md:text-6xl">
          The Divine Feminine
        </h2>
        <Prose className="mt-10 text-xl md:text-2xl">
          <p>
            You have already tried doing more. More discipline, more planning,
            more mornings that start at five.
          </p>
          <p>
            None of it touched the thing underneath, because the thing
            underneath is not a behaviour. It is who you are being while you do
            it.
          </p>
        </Prose>
      </Section>

      <Section className="pt-16 md:pt-20">
        <h3 className="text-2xl leading-tight md:text-4xl">
          What living as HER actually requires
        </h3>
        <Prose className="mt-8 text-lg">
          <p>
            Not a mindset. A different relationship with what you expect, what
            you notice, and what you accept as evidence — practised for long
            enough that it stops being a decision.
          </p>
          <p>
            That takes more than a few days, and it takes company. Which is
            what this is.
          </p>
        </Prose>

        <StaffNote what="what is actually inside the Divine Feminine">
          <p>
            The page architecture is built and the homepage chapter is built,
            but neither states what the programme contains, how long it runs,
            whether it is self-paced or lives in cohorts, or what a woman gets
            in the first week — because none of that has been written down yet
            and inventing it is not an option.
          </p>
          <p>
            Everything above this note is about the transformation rather than
            the curriculum, so it is true whatever the curriculum turns out to
            be. Nothing further goes public until you have described it.
          </p>
        </StaffNote>

        <PullQuote className="mt-16">
          You are not starting over. You are <em>coming back</em>.
        </PullQuote>

        <Button size="lg" className="mt-12" asChild>
          <Link href="/the-divine-feminine">Inside the Divine Feminine</Link>
        </Button>
      </Section>

      {/* --------------------------------------------------------------- 10
        CHOOSE YOUR DOOR. Every published challenge, from the database.
        ME VS HER is not named in this file. When there is a money challenge
        it appears here on its own.
      */}
      <Section className="pt-28 md:pt-36">
        <Rule tone="gilt" />
        <Eyebrow className="mt-12">Where to start</Eyebrow>
        <h2 className="mt-6 text-3xl md:text-5xl">
          Start with the thing that hurts most.
        </h2>
        <Prose className="mt-8 text-lg">
          <p>
            A challenge is short, specific, and on your phone. It is not the
            whole transformation — it is where the whole transformation starts
            being real.
          </p>
        </Prose>

        {challenges.length > 0 ? (
          <ul className="mt-14 divide-y divide-rule border-y border-rule">
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
                    <h3 className="font-display text-2xl leading-tight transition-colors group-hover:text-clay-deep md:text-3xl">
                      {challenge.title}
                    </h3>
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
        ) : (
          <StaffNote what="a published challenge" className="mt-12">
            <p>
              Nothing here is hard-coded: this list is every programme whose
              kind is “challenge” and whose status is “published”. None match,
              so the section shows nothing rather than an empty row.
            </p>
          </StaffNote>
        )}

        <p className="mt-10 text-sm text-ink-muted">
          Not ready to start?{' '}
          <Link
            href="/quiz"
            className="underline underline-offset-4 hover:text-clay-deep"
          >
            Find out which version of you is running the show
          </Link>{' '}
          — ninety seconds, free.
        </p>
      </Section>

      {/* --------------------------------------------------------------- 11
        BROWN GIRLS NEED HEALING TOO. The media arm, and for most women the
        first thing they ever meet. Episodes are synced from the show's own
        RSS feed, so this can never disagree with their podcast app.
      */}
      <Section className="pt-28 md:pt-36">
        <Rule tone="gilt" />
        <Eyebrow className="mt-12">The podcast</Eyebrow>
        <h2 className="mt-6 text-3xl md:text-5xl">{showName}</h2>
        <Prose className="mt-8 text-lg">
          <p>
            Conversations about what we carry — where it came from, what it has
            been costing, and what it takes to put it down.
          </p>
        </Prose>

        {episode ? (
          <div className="mt-12">
            <p className="text-2xs uppercase tracking-[0.18em] text-ink-muted">
              {[
                episode.episodeNumber ? `Episode ${episode.episodeNumber}` : null,
                formatDuration(episode.audioDurationSeconds),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <h3 className="mt-4 font-display text-2xl leading-snug">
              <Link
                href={`/podcast/${episode.slug}`}
                className="hover:text-clay-deep"
              >
                {episode.title}
              </Link>
            </h3>
            {episode.audioUrl && (
              <audio
                controls
                preload="none"
                src={episode.audioUrl}
                className="mt-6 w-full"
              >
                Your browser cannot play audio.{' '}
                <a href={episode.audioUrl}>Download the episode</a> instead.
              </audio>
            )}
          </div>
        ) : (
          <StaffNote what="the first podcast sync" className="mt-12">
            <p>
              No episodes are in the database yet, so this section shows the
              show and a link rather than a player. Press “Sync the podcast” in
              /admin/writing — it reads the RSS.com feed and imports
              everything on it.
            </p>
          </StaffNote>
        )}

        <Button variant="link" className="mt-8" asChild>
          <Link href="/podcast">Every episode</Link>
        </Button>
      </Section>

      {/* --------------------------------------------------------------- 12
        QUIANA. Where the philosophy came from.
        The childhood photograph and the shadow portrait, in that order: the
        girl who existed before she learned to manage herself, then the woman
        who went looking for her.
      */}
      <Section className="pt-28 md:pt-36">
        <Rule tone="gilt" />
        <Eyebrow className="mt-12">Who is asking</Eyebrow>
        <h2 className="mt-6 text-3xl md:text-5xl">
          These are not questions I read somewhere.
        </h2>

        <div className="mt-14 grid gap-10 sm:grid-cols-2">
          <PhotoFrame slot="about-story" images={childhood} />
          <PhotoFrame slot="me-vs-her-hero" images={shadow} />
        </div>

        <Prose className="mt-12 text-lg">
          <p>
            The girl on the left did not need to be told she was allowed to
            want things. Everything after that was learning to manage herself
            around what other people thought — and then spending years finding
            the way back.
          </p>
        </Prose>

        <StaffNote what="your origin story">
          <p>
            The structure is here and both photographs are placed, but the
            paragraph above is deliberately thin because your story has not
            been written down. It is the one thing on this page nobody else can
            supply, and it is what makes the rest of it credible.
          </p>
          <p>
            The longer version belongs on /about; this is the short one that
            earns the click.
          </p>
        </StaffNote>

        <Button variant="link" className="mt-8" asChild>
          <Link href="/about">More about me</Link>
        </Button>
      </Section>

      {/*
        13. PROOF. Built, and deliberately not rendered.

        There is a /stories architecture behind this and it stays unpublished
        until real women have said real things. An invented testimonial is the
        fastest way to lose the exact woman this page is written for, and a
        section that says "testimonials coming soon" is the second fastest.
      */}

      {/* --------------------------------------------------------------- 14
        FINAL CTA. Back to the life, not the process.
      */}
      <Section className="pb-32 pt-28 md:pt-40">
        <Rule tone="gilt" />
        <h2 className="mt-12 text-3xl leading-tight md:text-5xl">
          Who would you be if reality no longer decided how you feel about
          yourself?
        </h2>

        <div className="mt-12 flex flex-wrap gap-4">
          <Button size="lg" asChild>
            <Link href="/the-divine-feminine">The Divine Feminine</Link>
          </Button>
          {challenges[0] && (
            <Button size="lg" variant="quiet" asChild>
              <Link href={`/challenges/${challenges[0].slug}`}>
                Or start with {challenges[0].title}
              </Link>
            </Button>
          )}
        </div>

        <p className="mt-12 text-sm text-ink-muted">
          Education, not therapy.{' '}
          <Link
            href="/legal/disclaimer"
            className="underline underline-offset-4 hover:text-clay-deep"
          >
            What that means
          </Link>
          .
        </p>
      </Section>
    </>
  )
}

/**
 * One area of the pain section: the word, then the behaviours under it.
 *
 * Extracted because the section is split in two around the photograph, and
 * two copies of this markup is two places for them to drift apart.
 */
function PainBlock({ block }: { block: (typeof pain)[number] }) {
  return (
    <div>
      <div className={`border-l-2 pl-6 md:pl-10 ${areaRule[block.area]}`}>
        <h3 className="font-display text-4xl leading-none md:text-6xl">
          {block.word}
        </h3>
      </div>

      <ul className="mt-10 space-y-6 md:mt-12 md:space-y-8">
        {block.lines.map((line) => (
          <li
            key={line}
            className="measure-wide font-display text-xl leading-snug text-ink md:text-2xl"
          >
            {line}
          </li>
        ))}
      </ul>

      {block.close && (
        <p className="measure mt-10 text-base text-ink-soft md:text-lg">
          {block.close}
        </p>
      )}
    </div>
  )
}

/** A photograph in its own frame, at the shape its slot was cropped for. */
function PhotoFrame({
  slot,
  images,
}: {
  slot: string
  images: Awaited<ReturnType<typeof siteImage>>
}) {
  const definition = imageSlot(slot)
  if (!definition || !images) return null

  return (
    <SiteImageFrame slot={definition} className="rounded-xl">
      <SiteImage
        images={images}
        slot={definition}
        sizes="(min-width: 640px) 22rem, 100vw"
      />
    </SiteImageFrame>
  )
}
