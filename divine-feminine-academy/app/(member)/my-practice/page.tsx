import Link from 'next/link'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { contacts } from '@/db/schema'
import { Button, Card, CardBody, CardTitle, Rule } from '@/design-system/primitives'
import { Eyebrow, Prose } from '@/design-system/patterns'
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
 * looks like a button; everything else is quiet.
 */
export default async function MyPracticePage() {
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

  return (
    <div className="mx-auto max-w-3xl px-5 py-12 md:px-8 md:py-16">
      <Eyebrow>Welcome back</Eyebrow>
      <h1 className="mt-4 text-3xl">{firstName ? `Hello, ${firstName}.` : 'Hello.'}</h1>

      {!state ? (
        <>
          <Prose className="mt-6">
            <p>
              Seven days to meet the woman you keep catching glimpses of, and to
              learn the way back when you lose her.
            </p>
          </Prose>
          <EnrollButton className="mt-8" programSlug={PROGRAM} />
        </>
      ) : state.unlock.isComplete ? (
        <>
          <Prose className="mt-6">
            <p>
              You finished the seven days. Everything you wrote is still here,
              and so is the practice.
            </p>
          </Prose>
          <Button size="lg" className="mt-8" asChild>
            <Link href="/my-practice/her/code">See your HER Code</Link>
          </Button>
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
            <Link href={`/my-practice/${PROGRAM}/day/${state.unlock.currentDay}`}>
              {state.completed === 0 ? 'Begin Day 1' : `Open Day ${state.unlock.currentDay}`}
            </Link>
          </Button>
        </>
      ) : (
        <>
          <Prose className="mt-6">
            <p>
              You are up to date. Day {state.unlock.currentDay} opens{' '}
              {nextUnlockAt(new Date(), state.enrollment.timezoneAtStart).toLocaleDateString(
                'en-US',
                { weekday: 'long', timeZone: state.enrollment.timezoneAtStart },
              )}{' '}
              morning.
            </p>
          </Prose>
          <Button size="lg" variant="secondary" className="mt-8" asChild>
            <Link href="/my-practice/her">Look at what you have named</Link>
          </Button>
        </>
      )}

      <Rule tone="gilt" className="my-14" />

      {/* Never more than three cards visible at once. */}
      <div className="grid gap-5 md:grid-cols-3">
        <Card tone="flat">
          <CardTitle className="text-lg">HER</CardTitle>
          <CardBody className="text-xs">
            {choices.total > 0
              ? `You have chosen her ${choices.total} time${choices.total === 1 ? '' : 's'}.`
              : 'Your patterns and your responses, from Day 1 on.'}
          </CardBody>
          <Link
            href="/my-practice/her"
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
            href="/my-practice/journal"
            className="mt-5 inline-flex min-h-11 items-center text-xs text-clay-deep underline underline-offset-4"
          >
            Open
          </Link>
        </Card>

        <Card tone="flat">
          <CardTitle className="text-lg">Return</CardTitle>
          <CardBody className="text-xs">
            The practice for the bad days. One tap, from anywhere.
          </CardBody>
          <Link
            href="/my-practice/return"
            className="mt-5 inline-flex min-h-11 items-center text-xs text-clay-deep underline underline-offset-4"
          >
            Open
          </Link>
        </Card>
      </div>
    </div>
  )
}
