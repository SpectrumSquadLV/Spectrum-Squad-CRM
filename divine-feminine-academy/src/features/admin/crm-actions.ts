'use server'

import { eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/db/client'
import {
  auditLog,
  contactStageHistory,
  contactTags,
  contacts,
  crmNotes,
  crmStages,
  followUps,
  tags,
} from '@/db/schema'
import { getActor } from '@/lib/auth/actor-server'
import { isAdmin, isStaff, type Actor } from '@/lib/permissions/actor'

export type CrmState = { ok?: boolean; error?: string }

async function requireStaff(): Promise<Actor | null> {
  const actor = await getActor()
  return isStaff(actor) ? actor : null
}

async function audit(
  actor: Actor,
  action: string,
  entityId: string,
  metadata: Record<string, unknown> = {},
) {
  await db.insert(auditLog).values({
    actorUserId: actor.kind === 'user' ? actor.userId : null,
    action,
    entity: 'contacts',
    entityId,
    metadata,
  })
}

const noteSchema = z.object({
  body: z.string().trim().min(1, 'Write something first.').max(8000),
  pinned: z.union([z.literal('on'), z.literal('')]).optional(),
})

export async function addNote(
  contactId: string,
  _prev: CrmState,
  formData: FormData,
): Promise<CrmState> {
  const actor = await requireStaff()
  if (!actor || actor.kind !== 'user') return { error: 'You do not have access.' }

  const parsed = noteSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the note.' }
  }

  await db.insert(crmNotes).values({
    contactId,
    authorId: actor.userId,
    body: parsed.data.body,
    pinned: parsed.data.pinned === 'on',
  })

  await audit(actor, 'crm.note_added', contactId)
  revalidatePath(`/admin/contacts/${contactId}`)
  return { ok: true }
}

export async function deleteNote(
  contactId: string,
  noteId: string,
): Promise<CrmState> {
  const actor = await requireStaff()
  if (!actor) return { error: 'You do not have access.' }

  await db.delete(crmNotes).where(eq(crmNotes.id, noteId))
  await audit(actor, 'crm.note_deleted', contactId, { noteId })
  revalidatePath(`/admin/contacts/${contactId}`)
  return { ok: true }
}

/** Move her along the pipeline, keeping the history of where she came from. */
export async function changeStage(
  contactId: string,
  stageId: string,
): Promise<CrmState> {
  const actor = await requireStaff()
  if (!actor) return { error: 'You do not have access.' }

  const [stage] = await db
    .select({ id: crmStages.id })
    .from(crmStages)
    .where(eq(crmStages.id, stageId))
    .limit(1)
  if (!stage) return { error: 'That stage does not exist.' }

  const [contact] = await db
    .select({ crmStageId: contacts.crmStageId })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1)
  if (!contact) return { error: 'That contact does not exist.' }
  if (contact.crmStageId === stageId) return { ok: true }

  await db
    .update(contacts)
    .set({ crmStageId: stageId, updatedAt: new Date() })
    .where(eq(contacts.id, contactId))

  await db.insert(contactStageHistory).values({
    contactId,
    fromStageId: contact.crmStageId,
    toStageId: stageId,
    changedBy: actor.kind === 'user' ? actor.userId : null,
  })

  await audit(actor, 'crm.stage_changed', contactId, {
    from: contact.crmStageId,
    to: stageId,
  })
  revalidatePath(`/admin/contacts/${contactId}`)
  revalidatePath('/admin/pipeline')
  return { ok: true }
}

const followUpSchema = z.object({
  dueAt: z.string().min(1, 'Pick a date.'),
  note: z.string().trim().max(2000).optional(),
})

export async function addFollowUp(
  contactId: string,
  _prev: CrmState,
  formData: FormData,
): Promise<CrmState> {
  const actor = await requireStaff()
  if (!actor || actor.kind !== 'user') return { error: 'You do not have access.' }

  const parsed = followUpSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the date.' }
  }

  const dueAt = new Date(parsed.data.dueAt)
  if (Number.isNaN(dueAt.getTime())) return { error: 'That date did not parse.' }

  await db.insert(followUps).values({
    contactId,
    dueAt,
    assignedTo: actor.userId,
    note: parsed.data.note || null,
  })

  await audit(actor, 'crm.follow_up_added', contactId)
  revalidatePath(`/admin/contacts/${contactId}`)
  return { ok: true }
}

export async function completeFollowUp(
  contactId: string,
  followUpId: string,
): Promise<CrmState> {
  const actor = await requireStaff()
  if (!actor) return { error: 'You do not have access.' }

  await db
    .update(followUps)
    .set({ status: 'done', completedAt: new Date(), updatedAt: new Date() })
    .where(eq(followUps.id, followUpId))

  revalidatePath(`/admin/contacts/${contactId}`)
  revalidatePath('/admin/pipeline')
  return { ok: true }
}

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

export async function addTag(
  contactId: string,
  _prev: CrmState,
  formData: FormData,
): Promise<CrmState> {
  const actor = await requireStaff()
  if (!actor) return { error: 'You do not have access.' }

  const name = String(formData.get('name') ?? '').trim()
  if (!name) return { error: 'Name the tag first.' }

  const slug = slugify(name)
  if (!slug) return { error: 'That name has no letters in it.' }

  const [tag] = await db
    .insert(tags)
    .values({ name, slug })
    .onConflictDoUpdate({ target: tags.slug, set: { name } })
    .returning()

  if (!tag) return { error: 'That did not save.' }

  await db
    .insert(contactTags)
    .values({ contactId, tagId: tag.id })
    .onConflictDoNothing({ target: [contactTags.contactId, contactTags.tagId] })

  revalidatePath(`/admin/contacts/${contactId}`)
  return { ok: true }
}

export async function removeTag(
  contactId: string,
  tagId: string,
): Promise<CrmState> {
  const actor = await requireStaff()
  if (!actor) return { error: 'You do not have access.' }

  await db
    .delete(contactTags)
    .where(
      sql`${contactTags.contactId} = ${contactId} AND ${contactTags.tagId} = ${tagId}`,
    )

  revalidatePath(`/admin/contacts/${contactId}`)
  return { ok: true }
}

/**
 * Archive rather than delete.
 *
 * Her orders, payments and certificates are financial and legal records; a
 * hard delete would take them with her. Erasing what she WROTE is a different
 * operation, and it is done by destroying her encryption key.
 */
export async function archiveContact(contactId: string): Promise<CrmState> {
  const actor = await requireStaff()
  if (!actor || !isAdmin(actor)) return { error: 'Only an admin can do that.' }

  await db
    .update(contacts)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(contacts.id, contactId))

  await audit(actor, 'crm.contact_archived', contactId)
  revalidatePath('/admin/contacts')
  return { ok: true }
}
