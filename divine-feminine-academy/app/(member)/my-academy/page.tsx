import Link from 'next/link'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { contacts } from '@/db/schema'
import { Button, Card, CardBody, CardTitle, Rule } from '@/design-system/primitives'
import { Prose } from '@/design-system/patterns'
import { getChallengeState } from '@/db/queries/challenge'
import { choiceSummary } from '@/db/queries/her'
import { EnrollButton } from '@/features/challenge/EnrollButton'
import { nextUnlockAt } from '@/features/challenge/pacing'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'

const PROGRAM = 'me-vs-her'

/**
 * The member home. Never called "Dashboard".
 *
 * ONE primary action. Whatever she is meant to do next is the only thing that
 * looks like a button; everything else is quiet. The seven days are shown as
 * seven marks rather than a percentage, because the point is the next step,
 * not the completion rate.
 */
export default async function MyAcademyPage() {
  const actor = await getActor()

  let firstName: string | null = null
  if (actor.kind === 'user' && actor.contactId) {
    const [contact] = await db
      .select({ firstName: contacts.firstName })
      .from(contacts)
      .where(eq(contacts.id, actor.contactId))
      .limit(1)
    firstName = contact?.firstName ?? null
  }

  const ctx = await getQueryContext()
  const state =
    actor.kind === 'user' && actor.contactId
      ? await getChallengeState(ctx, actor.contactId, PROGRAM)
      : null
  const choices =
    actor.kind === 'user' && actor.contactId
      ? await choiceSummary(ctx, actor.contactId)
      : { total: 0, byArea: [] }

  const dayIsOpen =
    state !== null && state.unlock.currentDay <= state.unlock.unlockedThrough
  const finished = state?.unlock.isComplete ?? false

  return (
    <div className="mx-auto max-w-3xl px-5 py-12 md:px-8 md:py-16">
      <h1 className="text-3xl">
        {firstName ? `Welcome back, ${firstName}.` : 'Welcome back.'}
      </h1>

      {!state ? (
        <>
          <Prose className="mt-6">
            <p>
              Seven days to meet the version of you that shows up
              automatically, meet the woman underneath her, and learn what to
              do when they want different things.
            </p>
          </Prose>
          <EnrollButton className="mt-8" programSlug={PROGRAM} />
        </>
      ) : finished ? (
        <>
          <Prose className="mt-6">
            <p>
              You finished the seven days. Everything you wrote is still here,
              and so is the question.
            </p>
          </Prose>
        </>
      ) : dayIsOpen ? (
        <>
          <Prose className="mt-6">
            <p>
              Day {state.unlock.currentDay} of {state.durationDays} is open.
              About twenty minutes.
            </p>
          </Prose>
          <Button size="lg" className="mt-8" asChild>
            <Link href={`/my-academy/${PROGRAM}/day/${state.unlock.currentDay}`}>
              {state.completed === 0
                ? 'Begin Day 1'
                : `Open Day ${state.unlock.currentDay}`}
            </Link>
          </Button>
        </>
      ) : (
        <>
          <Prose className="mt-6">
            <p>
              You are up to date. Day {state.unlock.currentDay} opens{' '}
              {nextUnlockAt(
                new Date(),
                state.enrollment.timezoneAtStart,
              ).toLocaleDateString('en-US', {
                weekday: 'long',
                timeZone: state.enrollment.timezoneAtStart,
              })}{' '}
              morning.
            </p>
          </Prose>
          <Button size="lg" variant="secondary" className="mt-8" asChild>
            <Link href="/my-academy/her">Look at what you have named</Link>
          </Button>
        </>
      )}

      {/*
        THE TOOL.
        
        Once Day 7 is done this is the primary action on the page and it never
        leaves. ME VS. HER was always meant to outlive the challenge - a woman
        standing at a choice point eight months from now is the entire point
        of having built it.
      */}
      {finished && (
        <div className="mt-8">
          <Button size="lg" asChild>
            <Link href="/my-academy/me-vs-her/tool">ME VS. HER</Link>
          </Button>
          {choices.total > 0 && (
            <p className="mt-4 text-2xs text-ink-muted">
              You&rsquo;ve chosen HER {choices.total} time
              {choices.total === 1 ? '' : 's'}.
            </p>
          )}
        </div>
      )}

      {state && (
        <>
          <Rule tone="gilt" className="my-14" />
          <SevenDays
            total={state.durationDays}
            completed={state.completed}
            unlockedThrough={state.unlock.unlockedThrough}
          />
        </>
      )}

      <Rule tone="gilt" className="my-14" />

      {/* Never more than three cards visible at once. */}
      <div className="grid gap-5 md:grid-cols-2">
        <Card tone="flat">
          <CardTitle className="text-lg">HER</CardTitle>
          <CardBody className="text-xs">
            {choices.total > 0
              ? `You have chosen her ${choices.total} time${choices.total === 1 ? '' : 's'}.`
              : 'What you have named, and what you allowed yourself to want.'}
          </CardBody>
          <Link
            href="/my-academy/her"
            className="mt-5 inline-flex min-h-11 items-center text-xs text-clay-deep underline underline-offset-4"
          >
            Open
          </Link>
        </Card>

        <Card tone="flat">
          <CardTitle className="text-lg">Journal</CardTitle>
          <CardBody className="text-xs">
            Encrypted. Only you can read it — that includes us.
          </CardBody>
          <Link
            href="/my-academy/journal"
            className="mt-5 inline-flex min-h-11 items-center text-xs text-clay-deep underline underline-offset-4"
          >
            Open
          </Link>
        </Card>
      </div>
    </div>
  )
}

/**
 * Seven marks, not a percentage.
 *
 * A progress bar invites a woman to ask how far behind she is. Seven marks
 * answer a different question - which day is next - and say nothing about
 * speed.
 */
function SevenDays({
  total,
  completed,
  unlockedThrough,
}: {
  total: number
  completed: number
  unlockedThrough: number
}) {
  const days = Array.from({ length: total }, (_, i) => i + 1)
  return (
    <div>
      <p className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
        {completed} of {total} days
      </p>
      <ol className="mt-4 flex gap-2" aria-label={`${completed} of ${total} days finished`}>
        {days.map((day) => {
          const done = day <= completed
          const open = !done && day <= unlockedThrough
          return (
            <li
              key={day}
              className={[
                'h-1 flex-1 rounded-full',
                done ? 'bg-clay' : open ? 'bg-clay/40' : 'bg-rule',
              ].join(' ')}
            >
              <span className="sr-only">
                Day {day}
                {done ? ' finished' : open ? ' open' : ' not open yet'}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
