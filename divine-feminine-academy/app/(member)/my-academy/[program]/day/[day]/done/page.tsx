import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Button, Rule } from '@/design-system/primitives'
import { Eyebrow, Prose } from '@/design-system/patterns'
import { getChallengeState } from '@/db/queries/challenge'
import { nextUnlockAt } from '@/features/challenge/pacing'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'

/**
 * The end of a day.
 *
 * Deliberately quiet: no confetti, no streak counter, no badge. An
 * acknowledgement and a clear reason to come back tomorrow.
 */
export default async function DayDonePage({
  params,
}: {
  params: Promise<{ program: string; day: string }>
}) {
  const { program: programSlug, day } = await params
  const dayNumber = Number(day)

  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) redirect('/login')

  const ctx = await getQueryContext()
  const state = await getChallengeState(ctx, actor.contactId, programSlug)
  if (!state) redirect('/my-academy')

  const finished = state.unlock.isComplete
  const opensAt = nextUnlockAt(new Date(), state.enrollment.timezoneAtStart)
  const nextDayName = opensAt.toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: state.enrollment.timezoneAtStart,
  })

  return (
    <div className="mx-auto max-w-2xl px-5 py-20 md:px-8">
      <Eyebrow>{finished ? 'Seven days' : `Day ${dayNumber}`}</Eyebrow>

      {finished ? (
        <>
          <h1 className="mt-4 text-3xl">You finished.</h1>
          <Prose className="mt-6">
            <p>
              Your HER Code is yours now, and so is everything else you wrote.
              None of it goes away when the week does.
            </p>
          </Prose>
          <div className="mt-10 flex flex-wrap gap-4">
            <Button size="lg" asChild>
              <Link href="/my-academy/her/code">See your HER Code</Link>
            </Button>
            <Button size="lg" variant="secondary" asChild>
              <Link href="/my-academy">Back to your practice</Link>
            </Button>
          </div>
          <Rule tone="gilt" className="my-14" />
          <h2 className="text-xl">What comes next</h2>
          <Prose className="mt-3 text-sm">
            <p>
              The Divine Feminine takes this deeper, across all four areas. It reads
              from everything you just built rather than starting you over.
            </p>
          </Prose>
          <Button variant="link" className="mt-3" asChild>
            <Link href="/the-divine-feminine">Read about the Divine Feminine</Link>
          </Button>
        </>
      ) : (
        <>
          <h1 className="mt-4 text-3xl">That is today.</h1>
          <Prose className="mt-6">
            <p>
              Day {dayNumber + 1} opens {nextDayName} morning. Nothing else is
              needed from you until then.
            </p>
          </Prose>
          <Button size="lg" className="mt-10" asChild>
            <Link href="/my-academy">Back to your practice</Link>
          </Button>
        </>
      )}
    </div>
  )
}
