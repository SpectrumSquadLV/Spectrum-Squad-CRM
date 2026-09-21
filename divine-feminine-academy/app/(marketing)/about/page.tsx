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
import { SiteImage, SiteImageFrame } from '@/features/images/SiteImage'
import { imageSlot } from '@/features/images/slots'
import { showName } from '@/features/podcast/show'
import { about } from '@/features/home/about'

/** The photographs come from the database, which the build cannot reach. */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'About Quiana',
  description:
    'Who is asking, why these questions are hers, and what the Divine Feminine is — and is not.',
}

/**
 * ABOUT.
 *
 * This page has one job the rest of the site cannot do: make a stranger
 * believe the person behind it has actually been where the copy says she has.
 * Nothing else here is a substitute for that.
 *
 * Which is why the two places her story goes are EMPTY rather than filled.
 * Quiana's origin story has not been written down, and a bio invented to fill
 * the space would be the single most damaging paragraph on the site - the one
 * thing a reader would be right to distrust everything else for. The
 * structure is built and the photographs are placed; the words are hers and
 * they land in src/features/home/about.ts without touching this file.
 *
 * Before this, the empty bio was a dashed amber box a VISITOR could read,
 * announcing that the bio was not written yet. That is now an admin-only note.
 */
export default async function AboutPage() {
  const [portrait, story] = await Promise.all([
    siteImage('about-portrait'),
    siteImage('about-story'),
  ])

  return (
    <>
      <Section className="pt-14 md:pt-24">
        <Eyebrow>Who is asking</Eyebrow>
        <h1 className="mt-6 text-3xl md:text-5xl">Quiana Blake</h1>
        <Prose className="mt-8 text-lg">
          <p>
            I did not read these questions somewhere. I lived inside them long
            enough to work out what was actually holding them in place.
          </p>
        </Prose>
      </Section>

      {/*
        THE ORIGIN. The girl before.
        Placed on its own at a size that says it matters, because the
        methodology turns on her: the version who existed before any of this
        was being managed for anybody else's benefit. Never cropped clever and
        never with words across her.
      */}
      <Section className="pt-16 md:pt-24">
        <Rule tone="gilt" />
        <div className="mt-14 grid gap-10 md:grid-cols-[minmax(0,22rem)_1fr] md:items-center md:gap-16">
          {story && (
            <SiteImageFrame slot={imageSlot('about-story')!} className="rounded-xl">
              <SiteImage
                images={story}
                slot={imageSlot('about-story')!}
                sizes="(min-width: 768px) 22rem, 100vw"
              />
            </SiteImageFrame>
          )}

          <div>
            <Eyebrow>Before</Eyebrow>
            <h2 className="mt-5 text-3xl md:text-4xl">
              She was not managing anything yet.
            </h2>
            <Prose className="mt-6">
              <p>
                There is a version of every woman who existed before she
                learned to read a room on the way into it — before she worked
                out which parts of herself were easier for other people to
                hold.
              </p>
              <p>
                She is not gone. She is who ME has been protecting the whole
                time.
              </p>
            </Prose>
          </div>
        </div>

        {/* Her story, when it exists. Paragraph by paragraph, in her words. */}
        {about.origin.length > 0 ? (
          <Prose className="mt-16 text-lg">
            {about.origin.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </Prose>
        ) : (
          <StaffNote what="your origin story" className="mt-16">
            <p>
              This is the most important writing on the site after the pain
              copy, and it is the one thing nobody else can produce. What
              happened, what you made it mean at the time, and the moment you
              noticed you had been running that meaning ever since.
            </p>
            <p>
              It goes in src/features/home/about.ts as `origin` — one string
              per paragraph. The photograph above and the layout around it are
              already built, so the words drop straight in.
            </p>
            <p>
              Nothing invented is on this page in the meantime. A visitor reads
              the photograph, the paragraph above it, and moves on.
            </p>
          </StaffNote>
        )}
      </Section>

      {/* THE PORTRAIT AND THE BIO. Who she is now. */}
      <Section>
        <Rule tone="gilt" />
        <div className="mt-14 grid gap-10 md:grid-cols-[1fr_minmax(0,24rem)] md:items-start md:gap-16">
          <div>
            <Eyebrow>Now</Eyebrow>
            <h2 className="mt-5 text-2xl md:text-4xl">
              Why I built this instead of another course
            </h2>

            {about.bio.length > 0 ? (
              <Prose className="mt-6 text-lg">
                {about.bio.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </Prose>
            ) : (
              <>
                <Prose className="mt-6 text-lg">
                  <p>
                    Because information was never the missing piece. I had
                    plenty of it, and my life kept coming back the same shape.
                  </p>
                  <p>
                    What changed things was going at what I expected — and then
                    building somewhere a woman could do that repeatedly,
                    privately, and without performing it for anybody.
                  </p>
                </Prose>
                <StaffNote what="your bio, in your own words">
                  <p>
                    The two paragraphs above are structural — true of the work,
                    but not yours. Who you are, what you did before this, and
                    what you went through that makes you the person to teach
                    it. This is the part of the page people actually read.
                  </p>
                  <p>
                    It goes in src/features/home/about.ts as `bio`, one string
                    per paragraph, and replaces those two paragraphs entirely.
                  </p>
                </StaffNote>
              </>
            )}
          </div>

          {portrait && (
            <SiteImageFrame
              slot={imageSlot('about-portrait')!}
              className="rounded-xl"
            >
              <SiteImage
                images={portrait}
                slot={imageSlot('about-portrait')!}
                sizes="(min-width: 768px) 24rem, 100vw"
              />
            </SiteImageFrame>
          )}
        </div>
      </Section>

      <Section>
        <Rule tone="gilt" />
        <h2 className="mt-12 text-2xl md:text-4xl">Who this is for</h2>
        <Prose className="mt-8 text-lg">
          <p>
            For the woman who is functioning. Who is, by most measures, doing
            fine. Who has a version of herself she can <em>see</em> clearly and
            cannot seem to <strong>stay inside of</strong>.
          </p>
          <p>
            Not for fixing something broken. For <em>returning</em> to
            something that was always there and got quiet.
          </p>
        </Prose>

        <PullQuote className="mt-12">
          She is not someone you become. She is someone you{' '}
          <em>return to</em>.
        </PullQuote>
      </Section>

      <Section>
        <h2 className="text-2xl md:text-4xl">What this is not</h2>
        <Prose className="mt-8 text-lg">
          <p>
            It is not therapy, and it is not a replacement for it. There is no
            diagnosis here and no clinician reading what you write. If what you
            are carrying needs professional care, this is not the thing — and
            saying so plainly matters more to me than signing you up.
          </p>
          <p>
            It is also not a course you watch. There is very little to watch.
            Almost all of it is you, writing, and then you, doing something
            differently.
          </p>
        </Prose>
        <Button variant="link" className="mt-6" asChild>
          <Link href="/legal/disclaimer">Read the full disclaimer</Link>
        </Button>
      </Section>

      {/* Where everything lives, for somebody who arrived here first. */}
      <Section className="pb-24">
        <Rule tone="gilt" />
        <h2 className="mt-12 text-2xl md:text-4xl">Where to find the rest</h2>
        <ul className="mt-10 divide-y divide-rule border-y border-rule">
          {[
            {
              href: '/the-divine-feminine',
              label: 'The Divine Feminine',
              note: 'The work itself. Everything else leads here.',
            },
            {
              href: '/challenges',
              label: 'Challenges',
              note: 'Short and specific. Where most women start.',
            },
            {
              href: '/podcast',
              label: showName,
              note: 'The podcast. Free, and the easiest way in.',
            },
            {
              href: '/writing',
              label: 'Writing',
              note: 'Essays on the four rooms.',
            },
          ].map((row) => (
            <li key={row.href}>
              <Link
                href={row.href}
                className="group flex flex-col gap-1 py-6 hover:text-clay-deep"
              >
                <span className="font-display text-xl">{row.label}</span>
                <span className="text-sm text-ink-soft">{row.note}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </>
  )
}
