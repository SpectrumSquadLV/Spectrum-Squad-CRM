import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { Button, Rule } from '@/design-system/primitives'
import { Eyebrow, Prose, Section } from '@/design-system/patterns'
import { getAttemptByToken } from '@/db/queries/assessments'
import { archetypes, isMode, modes } from '@/features/quiz/archetypes'
import { siteImage } from '@/db/queries/images'
import { SiteImage } from '@/features/images/SiteImage'

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

  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>
        {contact?.firstName
          ? `${contact.firstName}, meet your ME`
          : 'Meet your ME'}
      </Eyebrow>

      <h1 className="mt-6 text-4xl md:text-6xl">{archetype.name}</h1>
      <p className="mt-4 font-display text-xl text-clay-deep md:text-2xl">
        {archetype.tagline}
      </p>

      <Prose className="mt-8 text-lg">
        <p>{archetype.oneLiner}</p>
      </Prose>

      {secondary && (
        <p className="mt-6 rounded-lg border border-rule bg-alabaster px-5 py-4 text-sm text-ink-soft">
          You are close to a blend. <strong>{secondary.name}</strong> was
          almost as loud — which usually means the one you lead with depends on
          who is in the room.
        </p>
      )}

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

      {/* The full shape. She has earned the labels now. */}
      <section className="mt-14">
        <h2 className="font-display text-xl">All four, as you answered</h2>
        <ul className="mt-6 space-y-4">
          {modes.map((mode) => {
            const share = shares[mode] ?? 0
            return (
              <li key={mode}>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-sm text-ink-soft">
                    {modeLabels[mode]} · {archetypes[mode].name}
                  </span>
                  <span className="font-display text-lg">{share}%</span>
                </div>
                <div className="mt-2 h-1 rounded-full bg-linen">
                  <div
                    className={mode === primary ? 'h-1 rounded-full bg-plum' : 'h-1 rounded-full bg-clay'}
                    style={{ width: `${Math.min(100, Math.max(0, share))}%` }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
        <p className="mt-5 text-2xs text-ink-faint">
          All four of these are ME. This is the one who answers the door first.
        </p>
      </section>

      <Rule tone="gilt" className="my-14" />

      <section>
        <div className="flex items-start gap-6">
          {portrait && (
            <div className="hidden w-24 shrink-0 sm:block">
              <SiteImage image={portrait} shape="square" rounded="full" />
            </div>
          )}
          <h2 className="text-2xl md:text-3xl">So what happens to her?</h2>
        </div>
        <Prose className="mt-5 text-lg">
          <p>
            Nothing you would do to an enemy. ME is not one — she took a job
            nobody else was doing, and she has held it for years. Her whole
            task has been to make you feel good enough.
          </p>
          <p>
            You see her. You understand where she came from. You love her for
            it. You look honestly at what she has been creating. And then you
            meet <strong>HER</strong> — the version of you who is not trying to
            feel good enough, because she already knows she is.
          </p>
          <p>
            ME gets to retire. That is the whole of ME VS HER: seven days, one
            small thing a day, in your own time.
          </p>
        </Prose>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/me-vs-her">Start ME VS HER — $11</Link>
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
  )
}
