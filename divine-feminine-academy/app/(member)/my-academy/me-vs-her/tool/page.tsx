import type { Metadata } from 'next'
import Link from 'next/link'
import { Button } from '@/design-system/primitives'
import { Prose } from '@/design-system/patterns'
import { getChallengeState } from '@/db/queries/challenge'
import { choiceSummary } from '@/db/queries/her'
import { MeVsHerTool } from '@/features/challenge/MeVsHerTool'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'

export const metadata: Metadata = {
  title: 'ME VS. HER',
  robots: { index: false, follow: false },
}

const PROGRAM = 'me-vs-her'

/**
 * The tool, available forever once Day 7 is done.
 *
 * Gated on FINISHING rather than on enrolling, because the framework only
 * means anything to a woman who has been through all seven days. Handing it
 * to somebody on Day 2 would be handing her four questions with no ME and no
 * HER behind them.
 */
export default async function ToolPage() {
  const actor = await getActor()
  const ctx = await getQueryContext()

  const state =
    actor.kind === 'user' && actor.contactId
      ? await getChallengeState(ctx, actor.contactId, PROGRAM)
      : null

  // Narrowed for the compiler and for the reader: state only exists when she
  // is a signed-in contact, so the two conditions are really one.
  if (actor.kind !== 'user' || !actor.contactId || !state?.unlock.isComplete) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16 md:px-8">
        <h1 className="text-3xl">ME VS. HER</h1>
        <Prose className="mt-6">
          <p>
            This opens when you finish Day 7. It is the question you take with
            you afterwards, and it needs the seven days behind it to mean
            anything.
          </p>
        </Prose>
        <Button className="mt-8" asChild>
          <Link href="/my-academy">Back to my academy</Link>
        </Button>
      </div>
    )
  }

  const choices = await choiceSummary(ctx, actor.contactId)

  return (
    <div className="mx-auto max-w-3xl px-5 py-12 md:px-8 md:py-16">
      <MeVsHerTool choiceCount={choices.total} />
    </div>
  )
}
