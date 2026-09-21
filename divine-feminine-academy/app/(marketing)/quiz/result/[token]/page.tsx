import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { Button, Rule } from '@/design-system/primitives'
import { Eyebrow, Prose, Section } from '@/design-system/patterns'
import { getAttemptByToken } from '@/db/queries/assessments'
import { archetypes, isMode, modes } from '@/features/quiz/archetypes'
import { Sigil } from '@/features/quiz/Sigil'
import {
  areas as allAreas,
  areaLabels,
  type Area,
} from '@/features/assessment/scoring'
import { siteImage } from '@/db/queries/images'
import { SiteImage, SiteImageFrame } from '@/features/images/SiteImage'
import { imageSlot } from '@/features/images/slots'

export const metadata: Metadata = {
  title: 'Your result',
  robots: { index: false, follow: false },
}

const modeLabels: Record<string, string> = {
  fight: 'Fight',
  flight: 'Flight',
  freeze: 'Freeze',
  sulk: 'Sulk',
}

/* Labels come from the scoring module so no surface can drift from it. */

/** The hairline for each area. Thin rules and small marks, never a fill. */
const areaBar: Record<Area, string> = {
  herself: 'bg-area-herself',
  relationships: 'bg-area-relationships',
  money: 'bg-area-money',
  success: 'bg-area-success',
}

/**
 * Her result, opened from the quiz or from a link in her inbox.
 *
 * No login, and not indexed. The token is the credential. Asking a woman to
 * make an account before she can read something true about herself is where
 * the funnel dies - and it is also just a bad thing to do to somebody who has
 * answered twelve honest questions.
 */
export default async function QuizResultPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const found = await getAttemptByToken(db, token)
  const portrait = await siteImage('quiz-result')
  if (!found?.result) notFound()

  const { result, contact } = found

  const primary = result.archetype
  if (!isMode(primary)) notFound()

  const archetype = archetypes[primary]
  const secondary = isMode(result.secondaryArchetype)
    ? archetypes[result.secondaryArchetype]
    : null

  const shares = (result.categoryScores ?? {}) as Record<string, number>

  const areaShares = allAreas.map((area) => ({
    area,
    share: Number(shares[`area:${area}`] ?? 0),
  }))
  const hasAreas = areaShares.some((a) => a.share > 0)
  const loudestRaw = (result.categoryScores as Record<string, unknown> | null)?.loudest
  const loudest = allAreas.find((a) => a === loudestRaw) ?? null

  return (
    <>
      <Section className="pt-14 md:pt-24 pb-0">
      {/* ------------------------------------------------------------ 1
        WHERE IT IS LOUDEST.
        The domain bars come first and answer only one question: where is
        this showing up. They used to sit next to the archetype and compete
        with it, and the two are completely different revelations — this one
        is the room, the next one is what she does in it.
      */}
      {hasAreas ? (
        <>
          <Eyebrow>
            {contact?.firstName ? `${contact.firstName}, here it is` : 'Here it is'}
          </Eyebrow>
          <h1 className="mt-6 text-3xl leading-tight md:text-5xl">
            {loudest ? (
              <>
                Right now it is loudest in{' '}
                <em>{areaLabels[loudest].toLowerCase()}</em>.
              </>
            ) : (
              <>Here is where it is showing up.</>
            )}
          </h1>

          <ul className="mt-12 space-y-5">
            {areaShares.map(({ area, share }) => (
              <li key={area}>
                <div className="flex items-baseline justify-between gap-4">
                  <span
                    className={
                      area === loudest
                        ? 'font-display text-lg text-ink'
                        : 'text-sm text-ink-soft'
                    }
                  >
                    {areaLabels[area]}
                  </span>
                  <span className="font-display text-lg tabular-nums">
                    {share}
                  </span>
                </div>
                <div className="mt-2 h-1 rounded-full bg-linen">
                  <div
                    className={`h-1 rounded-full ${areaBar[area]}`}
                    style={{
                      width: `${Math.min(100, Math.max(0, share))}%`,
                      opacity: area === loudest ? 1 : 0.45,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Eyebrow>
          {contact?.firstName ? `${contact.firstName}, here it is` : 'Here it is'}
        </Eyebrow>
      )}

      {/* ------------------------------------------------------------ 2
        THE TURN. Type alone, and nothing else on the screen.
        This beat is the whole reason the two revelations stop competing.
      */}
      <div className="mt-24 md:mt-32">
        <p className="measure-wide font-display text-2xl leading-snug text-ink md:text-4xl">
          But where it shows up is only half the story.
        </p>
        <Prose className="mt-8 text-lg">
          <p>
            Here is what you tend to do when something threatens your sense of
            being enough.
          </p>
        </Prose>
      </div>

      </Section>

      {/* ------------------------------------------------------- 3 to 6
        THE REVEAL. Sigil, label, name, signature line — in that order,
        and nothing else in the frame.

        Edge to edge, outside the reading column, because this is the one
        ceremonial beat on the page. Inside the column it was a grey rectangle
        floating in a page of text, which is the opposite of what a reveal is
        supposed to feel like.
      */}
      <div className="mt-20 flex flex-col items-center gap-8 border-y border-rule bg-linen/50 px-5 py-20 text-center md:mt-28 md:py-32">
        <Sigil
          mode={primary}
          animate
          className="h-32 w-32 text-ink md:h-40 md:w-40"
        />

        <p className="text-2xs uppercase tracking-[0.3em] text-clay-deep">
          Your primary protector
        </p>

        <h2 className="font-display text-4xl leading-none tracking-[-0.02em] md:text-6xl">
          {archetype.name}
        </h2>

        <p className="measure font-display text-xl leading-snug text-ink-soft">
          {archetype.tagline}
        </p>

        {archetype.revealNote && (
          <p className="measure text-sm leading-relaxed text-ink-muted">
            {archetype.revealNote}
          </p>
        )}
      </div>

      <Section className="pt-16 pb-24">
      <Prose className="text-lg">
        <p>{archetype.oneLiner}</p>
      </Prose>

      {secondary && (
        <p className="mt-6 rounded-lg border border-rule bg-alabaster px-5 py-4 text-sm text-ink-soft">
          You’re close to a blend. <strong>{secondary.name}</strong> was
          almost as loud. Usually that means the one you lead with depends on
          who’s in the room.
        </p>
      )}

      {/* ------------------------------------------------------------ 7
        YOUR PROTECTIVE PATTERN. All four, hers distinguished, and said
        plainly: this is pattern recognition, not another box.
      */}
      <section className="mt-16">
        <h2 className="font-display text-xl">Your protective pattern</h2>
        <ul className="mt-6 space-y-4">
          {modes.map((mode) => {
            const share = Number(shares[mode] ?? 0)
            const mine = mode === primary
            return (
              <li key={mode}>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="flex items-center gap-2.5">
                    <Sigil
                      mode={mode}
                      variant="mark"
                      title={null}
                      className={
                        mine
                          ? 'h-5 w-5 shrink-0 text-plum'
                          : 'h-5 w-5 shrink-0 text-ink-faint'
                      }
                    />
                    <span
                      className={
                        mine
                          ? 'font-display text-lg text-ink'
                          : 'text-sm text-ink-soft'
                      }
                    >
                      {archetypes[mode].name}
                    </span>
                    <span className="text-2xs uppercase tracking-[0.14em] text-ink-faint">
                      {modeLabels[mode]}
                    </span>
                  </span>
                  <span className="font-display text-lg tabular-nums">
                    {share}
                  </span>
                </div>
                <div className="mt-2 h-1 rounded-full bg-linen">
                  <div
                    className={
                      mine ? 'h-1 rounded-full bg-plum' : 'h-1 rounded-full bg-clay'
                    }
                    style={{
                      width: `${Math.min(100, Math.max(0, share))}%`,
                      opacity: mine ? 1 : 0.5,
                    }}
                  />
                </div>
              </li>
            )
          })}
        </ul>

        <Prose className="mt-8 text-sm">
          <p>
            <strong>You are not one archetype.</strong> These scores reflect
            the protective strategies your answers suggest you reach for. Your
            highest is the one that appears to take the lead most often.
          </p>
          <p>
            This is pattern recognition, not another box — and it’s a
            reflective framework rather than any kind of diagnosis.
          </p>
        </Prose>
      </section>

      <Rule tone="gilt" className="my-12" />

      <div className="grid gap-12 md:grid-cols-2">
        <section>
          <h2 className="font-display text-xl">What it sounds like</h2>
          <ul className="mt-5 space-y-3">
            {archetype.soundsLike.map((line) => (
              <li
                key={line}
                className="border-l-2 border-gilt pl-4 font-display text-lg leading-snug"
              >
                “{line}”
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="font-display text-xl">What it looks like</h2>
          <ul className="mt-5 space-y-3 text-sm leading-relaxed text-ink-soft">
            {archetype.looksLike.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </div>

      <section className="mt-14 rounded-xl border border-rule bg-alabaster p-6 md:p-8">
        <h2 className="font-display text-xl">What she is protecting</h2>
        <Prose className="mt-4">
          <p>{archetype.protecting}</p>
        </Prose>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-xl">What it costs you</h2>
        <Prose className="mt-4">
          <p>{archetype.costs}</p>
        </Prose>
      </section>

      <section className="mt-14 rounded-xl border border-clay bg-plum-wash p-6 md:p-8">
        <p className="text-2xs uppercase tracking-[0.2em] text-plum">
          The return
        </p>
        <p className="mt-4 font-display text-2xl leading-snug">
          {archetype.theReturn}
        </p>
        <Prose className="mt-5">
          <p>{archetype.firstStep}</p>
        </Prose>
      </section>

      <Rule tone="gilt" className="my-14" />

      <section>
        <div className="flex items-start gap-6">
          {portrait && (
            <div className="hidden w-24 shrink-0 sm:block">
              <SiteImageFrame slot={imageSlot('quiz-result')!} className="rounded-full">
                <SiteImage images={portrait} slot={imageSlot('quiz-result')!} rounded="full" sizes="6rem" />
              </SiteImageFrame>
            </div>
          )}
          <h2 className="text-2xl md:text-3xl">So what happens to her?</h2>
        </div>
        <Prose className="mt-5 text-lg">
          <p>
            Nothing you’d do to an enemy. ME isn’t one. She took a job nobody
            else was doing and she’s held it for years, and the whole job has
            been making you feel good enough.
          </p>
          <p>
            You see her. You understand where she came from. You love her for
            it. You look honestly at what she’s been creating. And then you
            meet <strong>HER</strong> — the version of you who isn’t trying to
            feel good enough, because she already knows she is.
          </p>
          <p>
            ME gets to retire. That’s the whole of ME VS HER. Seven days, one
            small thing a day, in your own time.
          </p>
        </Prose>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/challenges/me-vs-her">Start ME VS HER</Link>
          </Button>
          <Button asChild variant="quiet" size="lg">
            <Link href={`/quiz/${archetype.slug}`}>Share this</Link>
          </Button>
        </div>
      </section>

      <p className="mt-12 text-2xs text-ink-faint">
        This is a reflective tool, not a diagnosis or therapy. If you are
        struggling, please talk to somebody — see our{' '}
        <Link href="/legal/disclaimer" className="underline underline-offset-4">
          disclaimer and support resources
        </Link>
        .
      </p>
      </Section>
    </>
  )
}
