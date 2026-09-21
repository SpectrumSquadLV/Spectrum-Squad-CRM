import 'server-only'

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  blockResponses,
  cohorts,
  contacts,
  enrollments,
  herChoices,
  herDesires,
  herPatterns,
  journalEntries,
  lessonBlocks,
  lessonProgress,
  lessons,
  modules,
  programVersions,
  programs,
} from '../schema'
import type { HerEvidence } from '@/blocks/contract'
import { isSensitiveType } from '@/blocks/registry'
import { unwrapContactKey, decryptEntry } from '@/lib/crypto/journal'
import { contactEncryptionKeys } from '../schema'
import { areas as allAreas, type Area } from '@/features/assessment/scoring'
import { computeUnlockState, type Pacing } from '@/features/challenge/pacing'
import { policy, require_ } from '@/lib/permissions/policy'
import type { QueryContext } from './_context'

/** The enrollment a woman is currently working, with its program. */
export async function getActiveEnrollment(
  { db, actor }: QueryContext,
  contactId: string,
  programSlug: string,
) {
  require_(policy.herProfile.read(actor, contactId))

  const [row] = await db
    .select({
      enrollment: enrollments,
      program: programs,
      cohort: cohorts,
    })
    .from(enrollments)
    .innerJoin(programs, eq(programs.id, enrollments.programId))
    .leftJoin(cohorts, eq(cohorts.id, enrollments.cohortId))
    .where(
      and(
        eq(enrollments.contactId, contactId),
        eq(programs.slug, programSlug),
      ),
    )
    .orderBy(desc(enrollments.startedAt))
    .limit(1)

  return row ?? null
}

/** Highest day number she has finished, 0 if none. */
export async function highestCompletedDay(
  db: QueryContext['db'],
  enrollmentId: string,
  versionId: string,
): Promise<number> {
  const [row] = await db
    .select({ day: sql<number>`coalesce(max(${modules.position}), 0)` })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(
      and(
        eq(lessonProgress.enrollmentId, enrollmentId),
        eq(lessonProgress.status, 'completed'),
        eq(modules.versionId, versionId),
      ),
    )

  return Number(row?.day ?? 0)
}

/**
 * Unlock state for an enrollment that has already been loaded.
 *
 * Kept separate from the slug lookup so callers that reached an enrollment by
 * another route - saving a block, for instance - can still check the drip
 * without having to know the programme's slug.
 */
export async function getStateForEnrollment(
  ctx: QueryContext,
  enrollment: typeof enrollments.$inferSelect,
  program: typeof programs.$inferSelect,
  cohort: typeof cohorts.$inferSelect | null,
  now = new Date(),
) {
  const completed = await highestCompletedDay(
    ctx.db,
    enrollment.id,
    enrollment.versionId,
  )

  const [dayCount] = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(modules)
    .where(eq(modules.versionId, enrollment.versionId))

  const durationDays = Number(dayCount?.n ?? program.durationDays ?? 0)

  const unlock = computeUnlockState({
    pacing: program.pacing as Pacing,
    startedAt: enrollment.startedAt,
    now,
    timeZone: pacingTimeZone(
      program.pacing as Pacing,
      enrollment.timezoneAtStart,
      cohort?.timezone,
    ),
    durationDays,
    allowEarlyUnlock: program.allowEarlyUnlock,
    highestCompletedDay: completed,
    cohortStartsAt: cohort?.startsAt ?? null,
  })

  return { enrollment, program, cohort, durationDays, completed, unlock }
}

/**
 * Whose clock decides which day is open.
 *
 * Under cohort pacing it is the COHORT's, not hers. Everybody in a live run
 * has to be on the same day — otherwise a woman in Auckland is opening Day 3
 * while the host is running the Day 2 call, and the whole point of doing it
 * together is gone.
 *
 * Under drip pacing it is hers, which is the opposite and equally deliberate:
 * a solo practice should arrive in her morning, wherever she is.
 */
export function pacingTimeZone(
  pacing: Pacing,
  enrollmentTimeZone: string,
  cohortTimeZone: string | null | undefined,
): string {
  if ((pacing === 'cohort' || pacing === 'date_based') && cohortTimeZone) {
    return cohortTimeZone
  }
  return enrollmentTimeZone
}

/** Everything the member home and the day runner need about where she is. */
export async function getChallengeState(
  ctx: QueryContext,
  contactId: string,
  programSlug: string,
  now = new Date(),
) {
  const active = await getActiveEnrollment(ctx, contactId, programSlug)
  if (!active) return null

  const { enrollment, program, cohort } = active

  const completed = await highestCompletedDay(
    ctx.db,
    enrollment.id,
    enrollment.versionId,
  )

  const [dayCount] = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(modules)
    .where(eq(modules.versionId, enrollment.versionId))

  const durationDays = Number(dayCount?.n ?? program.durationDays ?? 0)

  const unlock = computeUnlockState({
    pacing: program.pacing as Pacing,
    startedAt: enrollment.startedAt,
    now,
    timeZone: pacingTimeZone(
      program.pacing as Pacing,
      enrollment.timezoneAtStart,
      cohort?.timezone,
    ),
    durationDays,
    allowEarlyUnlock: program.allowEarlyUnlock,
    highestCompletedDay: completed,
    cohortStartsAt: cohort?.startsAt ?? null,
  })

  return { enrollment, program, cohort, durationDays, completed, unlock }
}

/** One day: its module, lessons and blocks, in order. */
export async function getDay(
  { db }: QueryContext,
  versionId: string,
  dayNumber: number,
) {
  const [dayModule] = await db
    .select()
    .from(modules)
    .where(
      and(eq(modules.versionId, versionId), eq(modules.position, dayNumber)),
    )
    .limit(1)

  if (!dayModule) return null

  const dayLessons = await db
    .select()
    .from(lessons)
    .where(eq(lessons.moduleId, dayModule.id))
    .orderBy(asc(lessons.position))

  const lessonIds = dayLessons.map((l) => l.id)
  const blocks = lessonIds.length
    ? await db
        .select()
        .from(lessonBlocks)
        .where(inArray(lessonBlocks.lessonId, lessonIds))
        .orderBy(asc(lessonBlocks.position))
    : []

  return { module: dayModule, lessons: dayLessons, blocks }
}

/**
 * Her answers so far for a set of blocks.
 *
 * Sensitive responses come back decrypted here because this runs for HER, in
 * her own session. There is deliberately no variant of this that a staff actor
 * can call.
 */
export async function getResponses(
  { db, actor }: QueryContext,
  enrollmentId: string,
  contactId: string,
  blockIds: string[],
) {
  require_(policy.herProfile.read(actor, contactId))
  if (blockIds.length === 0) return new Map<string, unknown>()

  const rows = await db
    .select({
      blockId: blockResponses.blockId,
      response: blockResponses.response,
      responseEncrypted: blockResponses.responseEncrypted,
      isSensitive: blockResponses.isSensitive,
    })
    .from(blockResponses)
    .where(
      and(
        eq(blockResponses.enrollmentId, enrollmentId),
        inArray(blockResponses.blockId, blockIds),
      ),
    )

  const needsKey = rows.some((r) => r.isSensitive && r.responseEncrypted)
  let dataKey: Buffer | undefined
  if (needsKey) {
    const [keyRow] = await db
      .select()
      .from(contactEncryptionKeys)
      .where(eq(contactEncryptionKeys.contactId, contactId))
      .limit(1)
    if (keyRow) dataKey = unwrapContactKey(keyRow.wrappedKey)
  }

  const out = new Map<string, unknown>()
  for (const row of rows) {
    if (row.isSensitive && row.responseEncrypted) {
      if (!dataKey) continue
      try {
        out.set(row.blockId, JSON.parse(decryptEntry(row.responseEncrypted, dataKey)))
      } catch {
        // A key that cannot open it means the entry is gone for good, which is
        // what deleting an account does on purpose. Skip rather than fail.
      }
    } else if (row.response !== null) {
      out.set(row.blockId, row.response)
    }
  }
  return out
}

/** Day 7 reads her own week back to her. */
export async function getHerEvidence(
  { db, actor }: QueryContext,
  contactId: string,
): Promise<HerEvidence> {
  require_(policy.herProfile.read(actor, contactId))

  const patterns = await db
    .select({
      triggerText: herPatterns.triggerText,
      currentResponse: herPatterns.currentResponse,
      herResponse: herPatterns.herResponse,
    })
    .from(herPatterns)
    .where(eq(herPatterns.contactId, contactId))
    .orderBy(asc(herPatterns.createdAt))

  const choices = await db
    .select({
      situation: herChoices.situation,
      herResponse: herChoices.herResponse,
      area: herChoices.area,
    })
    .from(herChoices)
    .where(eq(herChoices.contactId, contactId))
    .orderBy(desc(herChoices.occurredAt))
    .limit(20)

  const [choiceAgg] = await db
    .select({ n: sql<number>`count(*)` })
    .from(herChoices)
    .where(eq(herChoices.contactId, contactId))

  const [journalAgg] = await db
    .select({
      n: sql<number>`count(*)`,
      words: sql<number>`coalesce(sum(${journalEntries.wordCount}), 0)`,
    })
    .from(journalEntries)
    .where(eq(journalEntries.contactId, contactId))

  const [completedAgg] = await db
    .select({ n: sql<number>`count(distinct ${modules.id})` })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(enrollments, eq(enrollments.id, lessonProgress.enrollmentId))
    .where(
      and(
        eq(enrollments.contactId, contactId),
        eq(lessonProgress.status, 'completed'),
      ),
    )

  /*
   * What she wants, and what she learned about ME - the two things the back
   * half of the challenge keeps handing back to her.
   *
   * Decrypted with her own key, which is only ever available on her own
   * request: the policy check above is the same one that guards her journal,
   * and nothing here is reachable from a staff surface.
   */
  const desireRows = await db
    .select({ area: herDesires.area, textEncrypted: herDesires.textEncrypted })
    .from(herDesires)
    .where(eq(herDesires.contactId, contactId))

  let desires: Array<{ area: Area; text: string }> = []
  let behaviorTags: string[] = []
  let unmetNeed: string | null = null

  if (desireRows.length > 0) {
    const [keyRow] = await db
      .select({ wrappedKey: contactEncryptionKeys.wrappedKey })
      .from(contactEncryptionKeys)
      .where(eq(contactEncryptionKeys.contactId, contactId))
      .limit(1)

    if (keyRow) {
      const dataKey = unwrapContactKey(keyRow.wrappedKey)
      const byArea = new Map<Area, string>()
      for (const row of desireRows) {
        if (!row.area) continue
        try {
          byArea.set(row.area, decryptEntry(row.textEncrypted, dataKey))
        } catch {
          // A desire that will not open is gone for good, which is what
          // deleting an account does on purpose. Skip rather than fail the
          // whole day.
        }
      }
      desires = allAreas
        .filter((area) => byArea.has(area))
        .map((area) => ({ area, text: byArea.get(area)! }))
    }
  }

  // Day 1's tags in "you" form, and Day 2's unmet need. Both hang off the
  // pattern row Day 1 created, so one query serves both.
  const [firstPattern] = await db
    .select({
      herTags: herPatterns.herTags,
      currentTags: herPatterns.currentTags,
      unmetNeedEncrypted: herPatterns.unmetNeedEncrypted,
    })
    .from(herPatterns)
    .where(eq(herPatterns.contactId, contactId))
    .orderBy(asc(herPatterns.createdAt))
    .limit(1)

  behaviorTags = firstPattern?.herTags ?? firstPattern?.currentTags ?? []

  if (firstPattern?.unmetNeedEncrypted) {
    const [keyRow] = await db
      .select({ wrappedKey: contactEncryptionKeys.wrappedKey })
      .from(contactEncryptionKeys)
      .where(eq(contactEncryptionKeys.contactId, contactId))
      .limit(1)
    if (keyRow) {
      try {
        unmetNeed = decryptEntry(
          firstPattern.unmetNeedEncrypted,
          unwrapContactKey(keyRow.wrappedKey),
        )
      } catch {
        // Same posture as everywhere else her key is used: a value that will
        // not open is skipped, and Day 3's statement falls back to a blank she
        // fills herself rather than the day failing to render.
      }
    }
  }

  return {
    patterns,
    choiceCount: Number(choiceAgg?.n ?? 0),
    choices,
    daysCompleted: Number(completedAgg?.n ?? 0),
    journalEntryCount: Number(journalAgg?.n ?? 0),
    journalWordCount: Number(journalAgg?.words ?? 0),
    desires,
    behaviorTags,
    unmetNeed,
  }
}

/** The published version a new enrollment should pin. */
export async function getPublishedVersion(
  { db }: QueryContext,
  programSlug: string,
) {
  const [row] = await db
    .select({ program: programs, version: programVersions })
    .from(programs)
    .innerJoin(programVersions, eq(programVersions.programId, programs.id))
    .where(eq(programs.slug, programSlug))
    .orderBy(desc(programVersions.version))
    .limit(1)

  return row ?? null
}

export { contacts }
