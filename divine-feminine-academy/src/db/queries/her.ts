import 'server-only'

import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  herChoices,
  herCodes,
  herPatterns,
  journalEntries,
  returnSessions,
} from '../schema'
import { policy, require_ } from '@/lib/permissions/policy'
import type { QueryContext } from './_context'

/** Her HER profile: the patterns she has named. */
export async function listPatterns(
  { db, actor }: QueryContext,
  contactId: string,
) {
  require_(policy.herProfile.read(actor, contactId))
  return db
    .select()
    .from(herPatterns)
    .where(and(eq(herPatterns.contactId, contactId), isNull(herPatterns.retiredAt)))
    .orderBy(desc(herPatterns.createdAt))
}

/** Every time she chose HER, newest first. */
export async function listChoices(
  { db, actor }: QueryContext,
  contactId: string,
  limit = 100,
) {
  require_(policy.herProfile.read(actor, contactId))
  return db
    .select()
    .from(herChoices)
    .where(eq(herChoices.contactId, contactId))
    .orderBy(desc(herChoices.occurredAt))
    .limit(limit)
}

export async function choiceSummary(
  { db, actor }: QueryContext,
  contactId: string,
) {
  require_(policy.herProfile.read(actor, contactId))

  const [total] = await db
    .select({ n: sql<number>`count(*)` })
    .from(herChoices)
    .where(eq(herChoices.contactId, contactId))

  const byArea = await db
    .select({ area: herChoices.area, n: sql<number>`count(*)` })
    .from(herChoices)
    .where(eq(herChoices.contactId, contactId))
    .groupBy(herChoices.area)

  return {
    total: Number(total?.n ?? 0),
    byArea: byArea.map((r) => ({ area: r.area, count: Number(r.n) })),
  }
}

export async function listReturnSessions(
  { db, actor }: QueryContext,
  contactId: string,
  limit = 50,
) {
  require_(policy.herProfile.read(actor, contactId))
  return db
    .select()
    .from(returnSessions)
    .where(eq(returnSessions.contactId, contactId))
    .orderBy(desc(returnSessions.occurredAt))
    .limit(limit)
}

export async function getHerCode(
  { db, actor }: QueryContext,
  contactId: string,
) {
  require_(policy.herProfile.read(actor, contactId))
  const [row] = await db
    .select()
    .from(herCodes)
    .where(eq(herCodes.contactId, contactId))
    .orderBy(desc(herCodes.createdAt))
    .limit(1)
  return row ?? null
}

/**
 * A HER Code by its share token.
 *
 * No actor check, deliberately: this backs a public page she chose to share.
 * It returns ONLY the code itself and a first name - never her email, her
 * patterns, or anything else about her.
 */
export async function getSharedHerCode(
  db: QueryContext['db'],
  shareToken: string,
) {
  const [row] = await db
    .select({
      sections: herCodes.sections,
      finalizedAt: herCodes.finalizedAt,
      createdAt: herCodes.createdAt,
    })
    .from(herCodes)
    .where(eq(herCodes.shareToken, shareToken))
    .limit(1)
  return row ?? null
}

/** Journal engagement. Metadata only - bodies never come back from here. */
export async function journalSummary(
  { db, actor }: QueryContext,
  contactId: string,
) {
  require_(policy.journal.readMetadata(actor, contactId))
  const [row] = await db
    .select({
      entries: sql<number>`count(*)`,
      words: sql<number>`coalesce(sum(${journalEntries.wordCount}), 0)`,
    })
    .from(journalEntries)
    .where(eq(journalEntries.contactId, contactId))
  return {
    entries: Number(row?.entries ?? 0),
    words: Number(row?.words ?? 0),
  }
}
