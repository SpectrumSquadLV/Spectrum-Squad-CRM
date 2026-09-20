import 'server-only'

import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '@/db/client'
import {
  activityEvents,
  contactEncryptionKeys,
  herChoices,
  herCodes,
  herPatterns,
  journalEntries,
  returnSessions,
} from '@/db/schema'
import {
  countWords,
  createContactKey,
  encryptEntry,
  newToken,
  unwrapContactKey,
} from '@/lib/crypto/journal'
import type { AnyBlockDefinition } from '@/blocks/contract'

/**
 * What a block writes BEYOND its own response row.
 *
 * Day 1 does not just record an answer - it creates her HER profile, which
 * every later programme reads from. Day 6 increments the metric the whole
 * platform is built around. Those writes live here, driven by the block
 * definition's `writesTo`, so a new block type declares its effects rather
 * than a switch statement growing forever somewhere else.
 *
 * Every function here is idempotent on (enrollment, block): re-saving a block
 * updates what it wrote the first time instead of duplicating it.
 */

type Area = 'self' | 'love' | 'life' | 'wealth'

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
const asArea = (v: unknown): Area | null =>
  v === 'self' || v === 'love' || v === 'life' || v === 'wealth' ? v : null

export async function contactDataKey(db: Db, contactId: string) {
  const [row] = await db
    .select()
    .from(contactEncryptionKeys)
    .where(eq(contactEncryptionKeys.contactId, contactId))
    .limit(1)

  if (row) return unwrapContactKey(row.wrappedKey)

  const { dataKey, wrappedKey } = createContactKey()
  await db.insert(contactEncryptionKeys).values({ contactId, wrappedKey })
  return dataKey
}

export interface EffectInput {
  db: Db
  contactId: string
  enrollmentId: string
  programId: string
  lessonId: string
  blockId: string
  definition: AnyBlockDefinition
  response: Record<string, unknown>
}

/** Day 1 and Day 4: her HER profile. */
async function writeHerPattern(input: EffectInput) {
  const { db, contactId, enrollmentId, blockId, response } = input

  // Day 1 names a trigger; Day 4 names a behaviour. Both are patterns.
  const triggerText =
    asString(response.trigger) || asString(response.behaviour)
  if (!triggerText) return

  const values = {
    contactId,
    triggerText,
    currentResponse: asString(response.currentResponse) || null,
    herResponse:
      asString(response.herResponse) || asString(response.instead) || null,
    area: asArea(response.area),
    sourceEnrollmentId: enrollmentId,
    sourceBlockId: blockId,
    updatedAt: new Date(),
  }

  // Upsert on (enrollment, block): re-saving the block edits the pattern it
  // created rather than adding another. The unique index is what makes this
  // safe against two saves racing.
  await db
    .insert(herPatterns)
    .values(values)
    .onConflictDoUpdate({
      target: [herPatterns.sourceEnrollmentId, herPatterns.sourceBlockId],
      set: {
        triggerText: values.triggerText,
        currentResponse: values.currentResponse,
        herResponse: values.herResponse,
        area: values.area,
        updatedAt: values.updatedAt,
      },
    })
}

/** Day 6: I CHOSE HER. The core metric. */
async function writeHerChoice(input: EffectInput) {
  const { db, contactId, programId, blockId, response } = input
  const herResponse = asString(response.herResponse)
  if (!herResponse) return

  const values = {
    contactId,
    programId,
    sourceBlockId: blockId,
    situation: asString(response.situation) || null,
    oldResponse: asString(response.oldResponse) || null,
    herResponse,
    reflection: asString(response.reflection) || null,
    area: asArea(response.area),
    updatedAt: new Date(),
  }

  await db
    .insert(herChoices)
    .values(values)
    .onConflictDoUpdate({
      target: [herChoices.contactId, herChoices.sourceBlockId],
      set: {
        situation: values.situation,
        oldResponse: values.oldResponse,
        herResponse: values.herResponse,
        reflection: values.reflection,
        area: values.area,
        updatedAt: values.updatedAt,
      },
    })
}

/** Day 5, and every bad day after it. */
async function writeReturnSession(input: EffectInput) {
  const { db, contactId, response } = input
  if (!asString(response.whatHappened) && !asString(response.feeling)) return

  const action = asString(response.actionChosen)
  const allowed = [
    'dance', 'create', 'move', 'music', 'nature',
    'play', 'rest', 'connect', 'journal', 'custom',
  ] as const
  type Action = (typeof allowed)[number]
  const actionChosen = (allowed as readonly string[]).includes(action)
    ? (action as Action)
    : null

  // A RETURN session is a log entry, not a record to edit. But re-saving the
  // same block within one day is her still writing, not a second bad moment,
  // so the most recent session from this enrollment is updated instead.
  const [recent] = await db
    .select({ id: returnSessions.id, occurredAt: returnSessions.occurredAt })
    .from(returnSessions)
    .where(eq(returnSessions.contactId, contactId))
    .orderBy(desc(returnSessions.occurredAt))
    .limit(1)

  const withinSameSitting =
    recent && Date.now() - recent.occurredAt.getTime() < 6 * 60 * 60 * 1000

  const fields = {
    contactId,
    whatHappened: asString(response.whatHappened) || null,
    feeling: asString(response.feeling) || null,
    meaningMade: asString(response.meaningMade) || null,
    isItTrue: asString(response.isItTrue) || null,
    whatINeed: asString(response.whatINeed) || null,
    actionChosen,
    customAction: asString(response.customAction) || null,
  }

  if (withinSameSitting && recent) {
    await db
      .update(returnSessions)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(returnSessions.id, recent.id))
  } else {
    await db.insert(returnSessions).values(fields)
  }
}

/** Day 7: the HER Code, and the share token behind the growth loop. */
async function writeHerCode(input: EffectInput) {
  const { db, contactId, programId, response } = input

  const lines = Array.isArray(response.lines)
    ? response.lines.filter((l): l is string => typeof l === 'string' && l.trim() !== '')
    : []
  const declaration = asString(response.declaration)
  if (lines.length === 0 && !declaration) return

  const sections = { lines, declaration }

  const [existing] = await db
    .select({ id: herCodes.id, shareToken: herCodes.shareToken })
    .from(herCodes)
    .where(and(eq(herCodes.contactId, contactId), eq(herCodes.programId, programId)))
    .limit(1)

  if (existing) {
    await db
      .update(herCodes)
      .set({ sections, updatedAt: new Date() })
      .where(eq(herCodes.id, existing.id))
  } else {
    await db.insert(herCodes).values({
      contactId,
      programId,
      sections,
      shareToken: newToken(12),
    })
  }
}

/**
 * Blocks that also land in her journal.
 *
 * The body is encrypted here exactly as a free-written entry is; the word
 * count is stored in the clear so admin screens see engagement and never
 * words.
 */
async function writeJournalEntry(input: EffectInput) {
  const { db, contactId, programId, lessonId, blockId, definition, response } = input

  // Flatten whatever shape the block used into readable prose.
  const body = Object.entries(response)
    .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
    .map(([k, v]) => `${k}: ${String(v).trim()}`)
    .join('\n\n')

  if (!body) return

  const title =
    asString(response.title) || definition.label || 'From the challenge'

  const dataKey = await contactDataKey(db, contactId)

  const [existing] = await db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.contactId, contactId),
        eq(journalEntries.lessonId, lessonId),
        eq(journalEntries.title, title),
      ),
    )
    .limit(1)

  const values = {
    contactId,
    title,
    bodyEncrypted: encryptEntry(body, dataKey),
    wordCount: countWords(body),
    source: 'lesson_prompt' as const,
    programId,
    lessonId,
    area: asArea(response.area),
    updatedAt: new Date(),
  }

  if (existing) {
    await db
      .update(journalEntries)
      .set(values)
      .where(eq(journalEntries.id, existing.id))
  } else {
    await db.insert(journalEntries).values(values)
  }

  void blockId
}

const handlers = {
  her_patterns: writeHerPattern,
  her_choices: writeHerChoice,
  return_sessions: writeReturnSession,
  her_codes: writeHerCode,
  journal_entries: writeJournalEntry,
} as const

/** Run everything a block declared it writes to. */
export async function runSideEffects(input: EffectInput) {
  for (const target of input.definition.writesTo ?? []) {
    const handler = handlers[target]
    if (handler) await handler(input)
  }

  await input.db.insert(activityEvents).values({
    contactId: input.contactId,
    eventType: 'block.answered',
    entity: 'lesson_blocks',
    entityId: input.blockId,
    metadata: { type: input.definition.type },
  })
}
