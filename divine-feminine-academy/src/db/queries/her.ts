import 'server-only'

import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  herChoices,
  herCodes,
  herDesires,
  herPatterns,
  journalEntries,
} from '../schema'
import { contactDataKey } from '@/features/challenge/side-effects'
import { decryptEntry } from '@/lib/crypto/journal'
import { areas as allAreas, type Area } from '@/features/assessment/scoring'
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

/**
 * What she allowed herself to want, by area.
 *
 * Written on Day 5 and read back on Days 5, 6 and 7 - and after that by the
 * Academy. Decrypted here with her own key, which means this query only ever
 * runs for her: the policy check is the same one that guards her journal, and
 * there is no staff path to these sentences at all.
 *
 * Returns the areas in the curriculum's order, not the order she wrote them,
 * so THIS IS HER reads the same way every time she opens it.
 */
export async function listDesires(
  { db, actor }: QueryContext,
  contactId: string,
): Promise<Array<{ area: Area; text: string }>> {
  require_(policy.herProfile.read(actor, contactId))

  const rows = await db
    .select({ area: herDesires.area, textEncrypted: herDesires.textEncrypted })
    .from(herDesires)
    .where(eq(herDesires.contactId, contactId))

  if (rows.length === 0) return []

  const dataKey = await contactDataKey(db, contactId)
  const byArea = new Map<Area, string>()
  for (const row of rows) {
    if (!row.area) continue
    byArea.set(row.area, decryptEntry(row.textEncrypted, dataKey))
  }

  return allAreas
    .filter((area) => byArea.has(area))
    .map((area) => ({ area, text: byArea.get(area)! }))
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
