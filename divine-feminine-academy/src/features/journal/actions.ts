'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createEntry } from '@/db/queries/journal'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'

export type JournalState = { ok?: boolean; error?: string }

const schema = z.object({
  title: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1, 'Write something first.').max(100_000),
  area: z.enum(['herself', 'relationships', 'success', 'money']).optional(),
})

export async function writeEntry(
  _prev: JournalState,
  formData: FormData,
): Promise<JournalState> {
  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) {
    return { error: 'Sign in again to save this.' }
  }

  const raw = Object.fromEntries(formData.entries())
  const parsed = schema.safeParse({
    ...raw,
    area: raw.area === '' ? undefined : raw.area,
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'That did not save.' }
  }

  const ctx = await getQueryContext()
  await createEntry(ctx, {
    contactId: actor.contactId,
    title: parsed.data.title || undefined,
    body: parsed.data.body,
    area: parsed.data.area,
    source: 'free_write',
  })

  revalidatePath('/my-academy/journal')
  return { ok: true }
}
