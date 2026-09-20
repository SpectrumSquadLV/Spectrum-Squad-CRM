'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/db/client'
import { activityEvents, contacts, profiles } from '@/db/schema'
import { getActor } from '@/lib/auth/actor-server'
import { policy, require_ } from '@/lib/permissions/policy'

const schema = z.object({
  firstName: z.string().trim().min(1, 'Tell us what to call you.').max(80),
  lastName: z.string().trim().max(80).optional(),
  timezone: z.string().trim().min(1).max(64),
  dailyEmail: z.union([z.literal('on'), z.literal('')]).optional(),
  reminderHour: z.coerce.number().int().min(0).max(23),
})

export type AccountFormState = {
  ok?: boolean
  error?: string
  fieldErrors?: Record<string, string>
}

export async function updateAccount(
  _prev: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  const actor = await getActor()

  if (actor.kind !== 'user' || !actor.contactId) {
    return { error: 'Sign in again to save your details.' }
  }

  // The actor context decides, not the form. Email is deliberately NOT
  // editable here: changing it would move her auth identity too.
  require_(policy.contact.write(actor, actor.contactId))

  const parsed = schema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const key = issue.path[0]
      if (typeof key === 'string' && !fieldErrors[key]) {
        fieldErrors[key] = issue.message
      }
    }
    return { fieldErrors }
  }

  const input = parsed.data

  await db
    .update(contacts)
    .set({
      firstName: input.firstName,
      lastName: input.lastName || null,
      timezone: input.timezone,
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    })
    .where(eq(contacts.id, actor.contactId))

  await db
    .update(profiles)
    .set({
      displayName: input.firstName,
      notificationPrefs: {
        dailyEmail: input.dailyEmail === 'on',
        reminderHour: input.reminderHour,
      },
      updatedAt: new Date(),
    })
    .where(eq(profiles.contactId, actor.contactId))

  await db.insert(activityEvents).values({
    contactId: actor.contactId,
    eventType: 'account.updated',
    entity: 'contacts',
    entityId: actor.contactId,
  })

  revalidatePath('/my-practice/account')
  return { ok: true }
}
