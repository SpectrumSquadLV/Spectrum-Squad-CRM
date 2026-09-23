import Link from 'next/link'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { contacts } from '@/db/schema'
import { getChallengeState } from '@/db/queries/challenge'
import { latestArchetype } from '@/db/queries/assessments'
import { choiceSummary, journalSummary } from '@/db/queries/her'
import { Aperture } from '@/features/academy/Aperture'
import { numeral } from '@/features/academy/library'
import { Place } from '@/features/academy/Place'
import { Reveal } from '@/features/academy/Reveal'
import { RoomCard } from '@/features/academy/Rooms'
import { rooms } from '@/features/academy/rooms'
import { EnrollButton } from '@/features/challenge/EnrollButton'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'
import { cn } from '@/lib/utils/cn'

const PROGRAM = 'me-vs-her'

/**
 * MY ACADEMY.
 *
 * The page answers five questions in the order a woman actually asks them:
 * where am I, what is this place, what am I in the middle of, what do I do
 * next, and what else is in here. Anything that does not answer one of those
 * is not on the page.
 *
 * THE HIERARCHY IS THE POINT, and it is the thing the previous version got
 * wrong. Divine Feminine Academy is the building. MY ACADEMY is her floor.
 * The rooms are what is on it. ME VS. HER is one experience inside one room.
 * A woman who cannot tell the challenge from the platform believes she bought
 * a seven-day thing, and leaves on day eight.
 *
 * So: a breadcrumb that names the building, a hero that names her floor, and
 * only then the challenge - clearly labelled as one experience rather than as
 * the whole place.
 *
 * Nothing about enrollment, pacing, locks, routes or data changed.
 */
export default async function MyAcademyPage() {
  const actor = await getActor()
  const ctx = await getQueryContext()
  const contactId = actor.kind === 'user' ? actor.contactId : null

  let firstName: string | null = null
  if (contactId) {
    const [contact] = await db
      .select({ firstName: contacts.firstName })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1)
    firstName = contact?.firstName ?? null
  }

  const state = contactId
    ? await getChallengeState(ctx, contactId, PROGRAM)
    : null
  const choices = contactId
    ? await choiceSummary(ctx, contactId)
    : { total: 0, byArea: [] }
  const journal = contactId
    ? await journalSummary(ctx, contactId)
    : { entries: 0, words: 0 }
  const archetype = contactId ? await latestArchetype(db, contactId) : null

  const dayIsOpen =
    state !== null && state.unlock.currentDay <= state.unlock.unlockedThrough

  /*
   * Percent finished, rounded DOWN.
   *
   * Rounding up would show "100%" to a woman with a day still to go, which is
   * the one number on this page she might actually check against her own
   * memory of what she has done.
   */
  const percent = state
    ? Math.floor((state.completed / state.durationDays) * 100)
    : 0

  return (
    <div className="mx-auto max-w-4xl px-5 py-10 md:px-8 md:py-16">
      {/* ------------------------------------------------ 1. where am I */}
      <Reveal>
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs uppercase tracking-[0.22em] text-ink-muted">
            <li>Divine Feminine Academy</li>
            <li aria-hidden className="text-rule-strong">
              /
            </li>
            <li className="text-ink" aria-current="page">
              My Academy
            </li>
          </ol>
        </nav>
      </Reveal>

      {/* ------------------------------------------- 2. what is this space */}
      <Reveal delay={1}>
        <h1 className="mt-7 font-display text-5xl leading-[0.98] text-ink md:text-7xl">
          My Academy
        </h1>
      </Reveal>

      <Reveal delay={2}>
        {/*
          Two lines, deliberately.
          
          Setting the script inline inside the serif made it wrap wherever the
          measure happened to break - "becoming" on one line, "HER." orphaned
          on the next - and a hand that large cannot share a baseline with
          type that small anyway. On its own line it reads as what it is: the
          same hand that writes to her inside the seven days, used once on
          this page so the words it lands on are the ones she remembers.
        */}
        <p className="mt-7 font-display text-2xl leading-snug text-ink-soft md:text-3xl">
          Your private space for
        </p>
        <p className="font-script text-5xl leading-[1.1] text-clay-deep md:text-6xl">
          becoming HER.
        </p>
      </Reveal>

      <Reveal delay={3}>
        <p className="measure-wide mt-7 text-base leading-relaxed text-ink-soft">
          Everything inside this space was created to help you uncover what has
          been keeping you from the love, money, success, and life you already
          know belongs to you.
        </p>
      </Reveal>

      {/* ------------------- 3 + 4. what am I doing, and where do I go next */}
      {state && (
        <Reveal delay={4}>
          <section
            aria-labelledby="continue-heading"
            className="mt-12 bg-plum-deep px-7 py-10 md:mt-16 md:px-12 md:py-14"
          >
            <div className="flex items-center gap-4">
              <h2
                id="continue-heading"
                className="text-2xs uppercase tracking-[0.22em] text-bone/60"
              >
                Continue your journey
              </h2>
              <span className="h-px flex-1 bg-bone/20" aria-hidden />
            </div>

            <p className="mt-8 font-display text-4xl leading-[1.02] text-bone md:text-5xl">
              ME VS. HER
            </p>
            <p className="mt-3 text-2xs uppercase tracking-[0.22em] text-bone/60">
              Seven-day transformation
            </p>

            {/*
              Her position, three ways, because different women read different
              things: the day she is on, the proportion done, and the shape of
              the week. The numerals are the same marks she sees on the day
              itself, so the page and the challenge agree.
            */}
            <div className="mt-9 flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <p className="font-display text-2xl text-bone">
                Day {state.unlock.currentDay} of {state.durationDays}
              </p>
              <p className="text-2xs uppercase tracking-[0.22em] text-bone/60">
                {percent}% complete
              </p>
            </div>

            <ol
              className="mt-6 flex items-baseline justify-between"
              aria-label={`${state.completed} of ${state.durationDays} days finished`}
            >
              {Array.from({ length: state.durationDays }, (_, i) => i + 1).map(
                (day) => {
                  const done = day <= state.completed
                  const here = day === state.unlock.currentDay && dayIsOpen
                  return (
                    <li
                      key={day}
                      className={cn(
                        'font-display text-sm tracking-[0.12em]',
                        done && 'text-bone/70',
                        here && 'text-bone',
                        !done && !here && 'text-bone/25',
                      )}
                    >
                      <span aria-hidden>{numeral(day)}</span>
                      <span className="sr-only">
                        {numeral(day)}
                        {done ? ' finished' : here ? ' open now' : ' not open yet'}
                      </span>
                      {here && (
                        <span aria-hidden className="mt-1 block h-px bg-bone/60" />
                      )}
                    </li>
                  )
                },
              )}
            </ol>

            <Link
              href={
                state.unlock.isComplete
                  ? '/my-academy/me-vs-her/tool'
                  : dayIsOpen
                    ? `/my-academy/${PROGRAM}/day/${state.unlock.currentDay}`
                    : '/my-academy/her'
              }
              className="group mt-10 inline-flex min-h-12 items-center gap-3 border border-bone/40 px-7 text-2xs uppercase tracking-[0.22em] text-bone outline-none transition-colors duration-500 hover:bg-bone hover:text-plum-deep focus-visible:ring-2 focus-visible:ring-bone motion-reduce:transition-none"
            >
              {state.unlock.isComplete
                ? 'Open ME VS. HER'
                : dayIsOpen
                  ? 'Continue your transformation'
                  : 'Return to what you have named'}
              <span
                aria-hidden
                className="transition-transform duration-500 ease-out group-hover:translate-x-1 motion-reduce:transition-none"
              >
                &rarr;
              </span>
            </Link>

            {!dayIsOpen && !state.unlock.isComplete && (
              <p className="mt-5 text-2xs text-bone/60">
                Day {state.unlock.currentDay} opens tomorrow morning. The day
                between is part of it.
              </p>
            )}
          </section>
        </Reveal>
      )}

      {/* She has not started the challenge yet. */}
      {!state && (
        <Reveal delay={4}>
          <section className="mt-12 border border-rule-strong bg-alabaster px-7 py-10 md:px-12 md:py-14">
            <p className="text-2xs uppercase tracking-[0.22em] text-clay-deep">
              Begin here
            </p>
            <p className="mt-6 font-display text-4xl leading-[1.02] md:text-5xl">
              ME VS. HER
            </p>
            <p className="measure mt-5 text-base leading-relaxed text-ink-soft">
              Seven days. The first woman you will meet here is you.
            </p>
            <EnrollButton className="mt-9" programSlug={PROGRAM} />
          </section>
        </Reveal>
      )}

      {/* --------------------------------- 5. what else exists in here */}
      <Reveal delay={5}>
        <div className="mt-14 flex items-center gap-4 md:mt-20">
          <h2 className="text-2xs uppercase tracking-[0.22em] text-ink-muted">
            Explore the Academy
          </h2>
          <span className="h-px flex-1 bg-rule" aria-hidden />
        </div>
      </Reveal>

      {/*
        Asymmetric on purpose. The open room spans the full width and the
        others sit beside each other beneath it, so the page never reads as a
        grid of four equivalent products.
      */}
      <Reveal delay={6}>
        <div className="mt-10 grid gap-5 md:grid-cols-2">
          {rooms.map((room, i) => {
            const href =
              room.key === 'archetype'
                ? archetype
                  ? '/quiz'
                  : '/quiz'
                : room.href

            const standing =
              room.key === 'archetype'
                ? archetype
                  ? `You came out as ${archetype.archetype}`
                  : 'Not taken yet'
                : room.key === 'challenges' && state
                  ? 'ME VS. HER in progress'
                  : null

            return (
              <div
                key={room.key}
                className={cn(room.scale === 'feature' && 'md:col-span-2')}
              >
                <RoomCard
                  room={room}
                  href={room.closed ? undefined : href}
                  standing={standing}
                />
              </div>
            )
          })}
        </div>
      </Reveal>

      {/* ------------------------------------------- what is already hers */}
      <Reveal delay={7}>
        <div className="mt-16 flex items-center gap-5 md:mt-20">
          <span className="h-px flex-1 bg-rule" aria-hidden />
          <Aperture size={24} className="opacity-70" />
          <span className="h-px flex-1 bg-rule" aria-hidden />
        </div>
      </Reveal>

      <Reveal delay={8}>
        <div className="mt-14 space-y-12">
          <Place
            title="HER"
            line="She is not someone you are becoming. She is what becomes visible when you stop hiding her."
            action="Enter her"
            href="/my-academy/her"
            standing={
              choices.total > 0
                ? `Chosen ${choices.total} time${choices.total === 1 ? '' : 's'}`
                : null
            }
          />

          <Place
            title="The private pages"
            line="Some things are meant to be written before they are ready to be spoken."
            action="Open"
            href="/my-academy/journal"
            standing={
              journal.entries > 0
                ? `${journal.entries} page${journal.entries === 1 ? '' : 's'}`
                : null
            }
          />
        </div>
      </Reveal>

      <Reveal delay={9}>
        <p className="mt-10 text-2xs leading-relaxed text-ink-muted">
          {firstName ? `${firstName}, your` : 'Your'} pages are encrypted with a
          key of your own. No admin screen in Divine Feminine can read them.
        </p>
      </Reveal>
    </div>
  )
}
