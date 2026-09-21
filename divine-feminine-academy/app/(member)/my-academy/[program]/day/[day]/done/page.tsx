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
        /*
         * Screen 16, and it is its own screen on purpose.
         *
         * The curriculum is explicit that the invitation never sits inside
         * the final close. FINAL CLOSE ends with "I am worthy of everything I
         * desire" — putting an offer in the same breath would turn the last
         * line of the week into a setup for a pitch.
         */
        <>
          <h1 className="mt-4 font-display text-3xl leading-tight tracking-tight md:text-4xl">
            YOU FOUND HER.
            <br />
            NOW LET&rsquo;S BUILD A LIFE THAT LOOKS LIKE HER.
          </h1>

          <Prose className="mt-8">
            <p>ME VS. HER taught you how to recognize the moment.</p>
            <p>
              The moment ME shows up.
              <br />
              The moment you pause.
              <br />
              The moment you realize you have a choice.
              <br />
              The moment you choose HER.
            </p>
            <p>But there&rsquo;s more underneath it.</p>
            <p>Why does ME show up in your relationships?</p>
            <p>Your money?</p>
            <p>Your success?</p>
            <p>The way you see yourself?</p>
            <p>
              What have you learned to believe about who you are, what
              you&rsquo;re worthy of, and what&rsquo;s possible for you?
            </p>
            <p>And what changes when those beliefs change?</p>
            <p>That&rsquo;s the work we do inside the Divine Feminine Academy.</p>
            <p>ME VS. HER was never about creating a new woman.</p>
            <p>Neither is the Academy.</p>
            <p>
              It&rsquo;s about removing everything that has convinced you that
              you aren&rsquo;t already her.
            </p>
            <p>You found HER.</p>
            <p>
              Now let&rsquo;s uncover what&rsquo;s been standing between HER and
              the life she actually desires.
            </p>
          </Prose>

          <div className="mt-10">
            <Button size="lg" asChild>
              <Link href="/academy">ENTER THE DIVINE FEMININE ACADEMY</Link>
            </Button>
            <p className="mt-4 text-2xs text-ink-muted">
              Your next chapter goes deeper.
            </p>
          </div>

          <Rule tone="gilt" className="my-14" />

          <Prose className="text-sm">
            <p>
              Everything you wrote this week is still yours, and ME VS. HER is
              on your home screen from now on — bring it any decision.
            </p>
          </Prose>
          <Button variant="secondary" className="mt-6" asChild>
            <Link href="/my-academy">Back to my academy</Link>
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
