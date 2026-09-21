import 'server-only'

import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '@/db/client'
import {
  activityEvents,
  contactEncryptionKeys,
  herChoices,
  herCodes,
  herDesires,
  herPatterns,
  journalEntries,
  mirrorSessions,
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

type Area = 'herself' | 'relationships' | 'success' | 'money'

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
const asArea = (v: unknown): Area | null =>
  v === 'herself' || v === 'relationships' || v === 'success' || v === 'money' ? v : null

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

/**
 * The mirror, every day.
 *
 * Records the SECONDS, not the words — anything she wrote afterwards is
 * handled as a journal entry by the block's other target, encrypted like
 * everything else she writes.
 *
 * `secondsCompleted` is stored even when she stopped early. Especially then:
 * a woman who looked at her own face for eleven seconds and had to stop has
 * told us the most useful thing in the whole challenge, and on Day 7 she gets
 * to see that number change.
 */
async function writeMirrorSession(input: EffectInput) {
  const { db, contactId, enrollmentId, blockId, response } = input

  const secondsCompleted = Math.max(0, Math.round(Number(response.secondsCompleted) || 0))
  const completed = response.completed === true

  const values = {
    contactId,
    enrollmentId,
    sourceBlockId: blockId,
    intention: asString(response.intention) || null,
    // Never less than what she actually did, whatever the block reported.
    secondsAsked: Math.max(secondsCompleted, Number(response.secondsAsked) || secondsCompleted),
    secondsCompleted,
    completedAt: completed ? new Date() : null,
    updatedAt: new Date(),
  }

  await db
    .insert(mirrorSessions)
    .values(values)
    .onConflictDoUpdate({
      target: [mirrorSessions.enrollmentId, mirrorSessions.sourceBlockId],
      set: values,
    })
}

/**
 * Day 7 — ME retires.
 *
 * Not a deletion and not a new table. Every pattern she created during this
 * enrolment is marked `retiredAt`, which is a column that has existed since
 * the first migration for exactly this: a pattern she has finished with.
 *
 * Reversible on purpose. If she re-saves the block without confirming, the
 * retirement lifts — nothing about this methodology is meant to feel like a
 * door locking behind her.
 */
async function writeMeRetirement(input: EffectInput) {
  const { db, contactId, enrollmentId, response } = input
  const retiring = response.retire !== false

  await db
    .update(herPatterns)
    .set({ retiredAt: retiring ? new Date() : null, updatedAt: new Date() })
    .where(
      and(
        eq(herPatterns.contactId, contactId),
        eq(herPatterns.sourceEnrollmentId, enrollmentId),
      ),
    )

  await db.insert(activityEvents).values({
    contactId,
    eventType: retiring ? 'me.retired' : 'me.unretired',
    entity: 'her_patterns',
    metadata: { enrollmentId },
  })
}

/**
 * Day 5: what she allows herself to want, one row per area.
 *
 * The four answers arrive together from `her_reveal`, keyed by area. Each is
 * encrypted with her own key before it touches the table, exactly like a
 * journal body, because this is the most tender thing she writes all week.
 *
 * Idempotent on (contact, enrollment, area): re-reading Day 5 and changing a
 * sentence updates that area rather than leaving two versions of what she
 * wants.
 */
async function writeHerDesires(input: EffectInput) {
  const { db, contactId, enrollmentId, blockId, response } = input

  const desires = (response.desires ?? {}) as Record<string, unknown>
  const dataKey = await contactDataKey(db, contactId)

  for (const area of ['herself', 'relationships', 'money', 'success'] as const) {
    const text = asString(desires[area]).trim()
    // An area she left blank is not an answer to store, and clearing one she
    // wrote earlier should remove it rather than leave a stale sentence.
    if (!text) {
      await db
        .delete(herDesires)
        .where(
          and(
            eq(herDesires.contactId, contactId),
            eq(herDesires.sourceEnrollmentId, enrollmentId),
            eq(herDesires.area, area),
          ),
        )
      continue
    }

    await db
      .insert(herDesires)
      .values({
        contactId,
        area,
        textEncrypted: encryptEntry(text, dataKey),
        sourceEnrollmentId: enrollmentId,
        sourceBlockId: blockId,
      })
      .onConflictDoUpdate({
        target: [
          herDesires.contactId,
          herDesires.sourceEnrollmentId,
          herDesires.area,
        ],
        set: {
          textEncrypted: encryptEntry(text, dataKey),
          sourceBlockId: blockId,
          updatedAt: new Date(),
        },
      })
  }
}

const handlers = {
  her_patterns: writeHerPattern,
  mirror_sessions: writeMirrorSession,
  me_retirement: writeMeRetirement,
  her_choices: writeHerChoice,
  her_desires: writeHerDesires,
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
