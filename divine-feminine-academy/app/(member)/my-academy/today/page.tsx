import { redirect } from 'next/navigation'
import { getChallengeState } from '@/db/queries/challenge'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'

const PROGRAM = 'me-vs-her'

/**
 * "Today" is a shortcut, not a page: it sends her to whatever is actually next.
 * One tap from the tab bar to the only thing she needs to do.
 */
export default async function TodayPage() {
  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) redirect('/login')

  const ctx = await getQueryContext()
  const state = await getChallengeState(ctx, actor.contactId, PROGRAM)

  if (!state) redirect('/my-academy')
  redirect(`/my-academy/${PROGRAM}/day/${state.unlock.currentDay}`)
}
