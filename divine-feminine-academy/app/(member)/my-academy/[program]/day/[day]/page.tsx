import { notFound, redirect } from 'next/navigation'
import { Button } from '@/design-system/primitives'
import Link from 'next/link'
import { Eyebrow, Prose } from '@/design-system/patterns'
import { getBlock } from '@/blocks/registry'
import { siteImageMap } from '@/db/queries/images'
import {
  getChallengeState,
  getDay,
  getHerEvidence,
  getResponses,
} from '@/db/queries/challenge'
import { DayRunner, type RunnerBlock } from '@/features/challenge/DayRunner'
import { isDayUnlocked, nextUnlockAt } from '@/features/challenge/pacing'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'

export default async function DayPage({
  params,
}: {
  params: Promise<{ program: string; day: string }>
}) {
  const { program: programSlug, day } = await params
  const dayNumber = Number(day)
  if (!Number.isInteger(dayNumber) || dayNumber < 1) notFound()

  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) redirect('/login')

  const ctx = await getQueryContext()
  const state = await getChallengeState(ctx, actor.contactId, programSlug)
  if (!state) redirect('/my-academy')

  if (!isDayUnlocked(dayNumber, state.unlock)) {
    const opensAt = nextUnlockAt(new Date(), state.enrollment.timezoneAtStart)
    return (
      <div className="mx-auto max-w-2xl px-5 py-20 md:px-8">
        <Eyebrow>Day {dayNumber}</Eyebrow>
        <h1 className="mt-4 text-2xl">Not yet.</h1>
        <Prose className="mt-4">
          <p>
            This one opens{' '}
            {opensAt.toLocaleDateString('en-US', {
              weekday: 'long',
              timeZone: state.enrollment.timezoneAtStart,
            })}{' '}
            morning. One day at a time is the practice, not a restriction.
          </p>
        </Prose>
        <Button className="mt-8" asChild>
          <Link href="/my-academy">Back to your practice</Link>
        </Button>
      </div>
    )
  }

  const dayContent = await getDay(ctx, state.enrollment.versionId, dayNumber)
  if (!dayContent) notFound()

  const blocks: RunnerBlock[] = dayContent.blocks.map((b) => ({
    id: b.id,
    type: b.type,
    config: b.config,
    isRequired: b.isRequired,
    takesAnswer: Boolean(getBlock(b.type)?.responseSchema),
  }))

  const saved = await getResponses(
    ctx,
    state.enrollment.id,
    actor.contactId,
    blocks.map((b) => b.id),
  )

  // Only fetch her evidence when a block on this day actually asks for it.
  const needsEvidence = dayContent.blocks.some(
    (b) => getBlock(b.type)?.resolvesContext === 'her_evidence',
  )
  const evidence = needsEvidence
    ? await getHerEvidence(ctx, actor.contactId)
    : undefined

  // Same rule for her photograph: fetched only when a note on this day shows
  // it, so six of the seven days make no image query at all.
  const needsPortrait = dayContent.blocks.some(
    (b) => getBlock(b.type)?.resolvesContext === 'founder_portrait',
  )
  const portrait = needsPortrait
    ? ((await siteImageMap()).get('founder-note') ?? { desktop: null, mobile: null })
    : undefined

  return (
    <DayRunner
      programSlug={programSlug}
      dayNumber={dayNumber}
      dayTitle={dayContent.module.title}
      daySubtitle={dayContent.module.subtitle}
      totalDays={state.durationDays}
      blocks={blocks}
      initialResponses={Object.fromEntries(saved)}
      evidence={evidence}
      portrait={portrait}
      alreadyComplete={state.completed >= dayNumber}
    />
  )
}
