'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/db/client'
import { activityEvents, herChoices, returnSessions } from '@/db/schema'
import { getActor } from '@/lib/auth/actor-server'
import { returnActions } from '@/blocks/types/return-practice/schema'

export type ReturnState = { ok?: boolean; error?: string }

const schema = z.object({
  whatHappened: z.string().trim().max(5000),
  feeling: z.string().trim().max(500),
  meaningMade: z.string().trim().max(5000),
  isItTrue: z.string().trim().max(5000),
  whatINeed: z.string().trim().max(5000),
  actionChosen: z.enum(returnActions).optional(),
  customAction: z.string().trim().max(200).optional(),
})

/**
 * The standalone RETURN practice.
 *
 * Reached on a bad day, from one tap, outside any lesson. Deliberately its own
 * action rather than going through the block machinery: she should never need
 * an active enrollment to come back to herself.
 */
export async function recordReturn(
  _prev: ReturnState,
  formData: FormData,
): Promise<ReturnState> {
  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) {
    return { error: 'Sign in again to save this.' }
  }

  const parsed = schema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { error: 'Some of that did not save.' }

  const input = parsed.data
  if (!input.whatHappened && !input.feeling) {
    return { error: 'Write something first, even a word.' }
  }

  const [session] = await db
    .insert(returnSessions)
    .values({
      contactId: actor.contactId,
      whatHappened: input.whatHappened || null,
      feeling: input.feeling || null,
      meaningMade: input.meaningMade || null,
      isItTrue: input.isItTrue || null,
      whatINeed: input.whatINeed || null,
      actionChosen: input.actionChosen ?? null,
      customAction: input.customAction || null,
    })
    .returning({ id: returnSessions.id })

  await db.insert(activityEvents).values({
    contactId: actor.contactId,
    eventType: 'return.recorded',
    entity: 'return_sessions',
    entityId: session?.id ?? null,
  })

  revalidatePath('/my-academy/return')
  return { ok: true }
}

/** She did the thing she committed to. That is an I CHOSE HER moment. */
export async function markReturnActionDone(
  sessionId: string,
): Promise<ReturnState> {
  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) {
    return { error: 'Sign in again.' }
  }

  const [session] = await db
    .select()
    .from(returnSessions)
    .where(eq(returnSessions.id, sessionId))
    .limit(1)

  // Her own session, or nothing. Never trust the id from the request alone.
  if (!session || session.contactId !== actor.contactId) {
    return { error: 'We could not find that.' }
  }
  if (session.actionCompletedAt) return { ok: true }

  await db
    .update(returnSessions)
    .set({ actionCompletedAt: new Date(), updatedAt: new Date() })
    .where(eq(returnSessions.id, sessionId))

  await db.insert(herChoices).values({
    contactId: actor.contactId,
    situation: session.whatHappened,
    oldResponse: session.meaningMade,
    herResponse: `Returned: ${session.customAction ?? session.actionChosen ?? 'chose herself'}`,
    reflection: session.whatINeed,
  })

  revalidatePath('/my-academy/return')
  revalidatePath('/my-academy/her/choices')
  return { ok: true }
}
