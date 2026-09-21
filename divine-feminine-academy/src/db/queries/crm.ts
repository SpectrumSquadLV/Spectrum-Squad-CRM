import 'server-only'

import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm'
import {
  certificates,
  contactStageHistory,
  contactTags,
  contacts,
  crmNotes,
  crmStages,
  enrollments,
  followUps,
  herChoices,
  journalEntries,
  orders,
  programs,
  tags,
} from '../schema'
import { policy, require_ } from '@/lib/permissions/policy'
import type { QueryContext } from './_context'

/**
 * The CRM.
 *
 * ONE RULE ABOVE ALL OTHERS: nothing in this file selects
 * `journalEntries.bodyEncrypted`. Staff see that she wrote, when, how much and
 * in which area — never a word of what she wrote. There is deliberately no
 * function here that could return one, so no admin screen can accidentally
 * render it.
 */

export async function listStages({ db, actor }: QueryContext) {
  require_(policy.admin.viewPipeline(actor))
  return db.select().from(crmStages).orderBy(asc(crmStages.position))
}

export async function searchContacts(
  { db, actor }: QueryContext,
  options: { query?: string; stageId?: string; limit?: number } = {},
) {
  require_(policy.admin.viewPipeline(actor))

  const term = options.query?.trim()
  const filters = [isNull(contacts.archivedAt)]

  if (term) {
    const like = `%${term}%`
    const match = or(
      ilike(contacts.email, like),
      ilike(contacts.firstName, like),
      ilike(contacts.lastName, like),
    )
    if (match) filters.push(match)
  }
  if (options.stageId) filters.push(eq(contacts.crmStageId, options.stageId))

  return db
    .select({
      contact: contacts,
      stageName: crmStages.name,
      enrollmentCount: sql<number>`(
        SELECT count(*) FROM ${enrollments} WHERE ${enrollments.contactId} = ${contacts.id}
      )`,
      choiceCount: sql<number>`(
        SELECT count(*) FROM ${herChoices} WHERE ${herChoices.contactId} = ${contacts.id}
      )`,
    })
    .from(contacts)
    .leftJoin(crmStages, eq(crmStages.id, contacts.crmStageId))
    .where(and(...filters))
    .orderBy(desc(contacts.lastActivityAt), desc(contacts.createdAt))
    .limit(options.limit ?? 100)
}

/** Counts per stage, for the pipeline board. */
export async function pipelineCounts({ db, actor }: QueryContext) {
  require_(policy.admin.viewPipeline(actor))

  const rows = await db
    .select({
      stage: crmStages,
      count: sql<number>`(
        SELECT count(*) FROM ${contacts}
        WHERE ${contacts.crmStageId} = ${crmStages.id}
          AND ${contacts.archivedAt} IS NULL
      )`,
    })
    .from(crmStages)
    .orderBy(asc(crmStages.position))

  return rows.map((r) => ({ ...r.stage, count: Number(r.count) }))
}

/**
 * Everything the contact view shows about one woman.
 *
 * Read the journal block carefully: counts, dates, areas and word counts. The
 * ciphertext column is never selected, and there is no code path here that
 * could decrypt it even if it were.
 */
export async function getContactDetail(
  { db, actor }: QueryContext,
  contactId: string,
) {
  require_(policy.contact.read(actor, contactId))

  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1)
  if (!contact) return null

  const [stage] = contact.crmStageId
    ? await db
        .select()
        .from(crmStages)
        .where(eq(crmStages.id, contact.crmStageId))
        .limit(1)
    : []

  const enrolled = await db
    .select({
      enrollment: enrollments,
      programTitle: programs.title,
      programSlug: programs.slug,
    })
    .from(enrollments)
    .innerJoin(programs, eq(programs.id, enrollments.programId))
    .where(eq(enrollments.contactId, contactId))
    .orderBy(desc(enrollments.startedAt))

  const orderRows = await db
    .select()
    .from(orders)
    .where(eq(orders.contactId, contactId))
    .orderBy(desc(orders.placedAt))

  const notes = await db
    .select()
    .from(crmNotes)
    .where(eq(crmNotes.contactId, contactId))
    .orderBy(desc(crmNotes.pinned), desc(crmNotes.createdAt))

  const contactTagRows = await db
    .select({ tag: tags })
    .from(contactTags)
    .innerJoin(tags, eq(tags.id, contactTags.tagId))
    .where(eq(contactTags.contactId, contactId))

  const followUpRows = await db
    .select()
    .from(followUps)
    .where(eq(followUps.contactId, contactId))
    .orderBy(asc(followUps.dueAt))

  const history = await db
    .select({
      entry: contactStageHistory,
      toName: crmStages.name,
    })
    .from(contactStageHistory)
    .leftJoin(crmStages, eq(crmStages.id, contactStageHistory.toStageId))
    .where(eq(contactStageHistory.contactId, contactId))
    .orderBy(desc(contactStageHistory.changedAt))
    .limit(20)

  const certificateRows = await db
    .select({ certificate: certificates, programTitle: programs.title })
    .from(certificates)
    .innerJoin(programs, eq(programs.id, certificates.programId))
    .where(eq(certificates.contactId, contactId))

  const [choices] = await db
    .select({ n: sql<number>`count(*)` })
    .from(herChoices)
    .where(eq(herChoices.contactId, contactId))

  // METADATA ONLY. bodyEncrypted is deliberately absent from this select.
  const [journal] = await db
    .select({
      entries: sql<number>`count(*)`,
      words: sql<number>`coalesce(sum(${journalEntries.wordCount}), 0)`,
      lastAt: sql<Date | null>`max(${journalEntries.createdAt})`,
    })
    .from(journalEntries)
    .where(eq(journalEntries.contactId, contactId))

  return {
    contact,
    stage: stage ?? null,
    enrollments: enrolled,
    orders: orderRows,
    notes,
    tags: contactTagRows.map((r) => r.tag),
    followUps: followUpRows,
    history,
    certificates: certificateRows,
    herChoiceCount: Number(choices?.n ?? 0),
    journal: {
      entries: Number(journal?.entries ?? 0),
      words: Number(journal?.words ?? 0),
      lastAt: journal?.lastAt ?? null,
    },
  }
}

export async function listOpenFollowUps({ db, actor }: QueryContext) {
  require_(policy.admin.viewPipeline(actor))
  return db
    .select({ followUp: followUps, contact: contacts })
    .from(followUps)
    .innerJoin(contacts, eq(contacts.id, followUps.contactId))
    .where(eq(followUps.status, 'open'))
    .orderBy(asc(followUps.dueAt))
    .limit(50)
}

export async function listAllTags({ db, actor }: QueryContext) {
  require_(policy.admin.viewPipeline(actor))
  return db.select().from(tags).orderBy(asc(tags.name))
}
