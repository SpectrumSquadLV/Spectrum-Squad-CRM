'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import { activityEvents, herChoices, programs } from '@/db/schema'
import { getActor } from '@/lib/auth/actor-server'

export type ToolState = { ok?: boolean; error?: string; count?: number }

const PROGRAM = 'me-vs-her'

/**
 * One run of the anytime tool.
 *
 * The challenge teaches the question; this is where she uses it, and it is
 * the reason the whole thing was built. A woman standing at a choice point
 * eight months after Day 7 is the point.
 *
 * Deliberately NOT routed through the lesson block machinery. This is not a
 * lesson: there is no enrollment, no day, no progress to advance, and a run
 * she abandons halfway is not an incomplete anything. It writes one row to
 * her HER profile and nothing else.
 *
 * Choosing ME is recorded as a run and does NOT increment the counter. "You've
 * chosen HER n times" counts HER, and inflating it with the times she chose
 * ME would make the one honest number in the product a lie.
 */
export async function recordToolRun(
  _prev: ToolState,
  formData: FormData,
): Promise<ToolState> {
  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) {
    return { error: 'Sign in to use this.' }
  }

  const field = (name: string) => String(formData.get(name) ?? '').trim()

  const decision = field('decision')
  const chosen = field('chosen')

  if (!decision) return { error: 'Tell me what you are deciding first.' }
  if (chosen !== 'me' && chosen !== 'her') {
    return { error: 'Choose ME or HER before you finish.' }
  }

  const [program] = await db
    .select({ id: programs.id })
    .from(programs)
    .where(eq(programs.slug, PROGRAM))
    .limit(1)

  /*
   * Only a HER run becomes a her_choices row.
   *
   * A ME run is still real and still recorded as an activity event - she
   * paused, she looked at both, she chose consciously, and that is the whole
   * method working. It just is not a time she chose HER.
   */
  if (chosen === 'her') {
    await db.insert(herChoices).values({
      contactId: actor.contactId,
      programId: program?.id ?? null,
      situation: decision,
      oldResponse: field('meWould') || null,
      herResponse: field('herWould') || null,
      reflection: field('herWhy') || null,
    })
  }

  await db.insert(activityEvents).values({
    contactId: actor.contactId,
    eventType: chosen === 'her' ? 'her.chosen' : 'me.chosen',
    entity: 'her_choices',
    metadata: { source: 'tool' },
  })

  revalidatePath('/my-academy')
  revalidatePath('/my-academy/her')
  return { ok: true }
}
