'use server'

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/db/client'
import {
  activityEvents,
  blockResponses,
  cohorts,
  contacts,
  enrollments,
  lessonBlocks,
  lessonProgress,
  lessons,
  modules,
  programs,
} from '@/db/schema'
import { getBlock } from '@/blocks/registry'
import {
  getChallengeState,
  getPublishedVersion,
  getStateForEnrollment,
} from '@/db/queries/challenge'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'
import { encryptEntry } from '@/lib/crypto/journal'
import { isDayUnlocked } from './pacing'
import { issueIfEarned } from '@/features/certificates/issue'
import { contactDataKey, runSideEffects } from './side-effects'

export type SaveState = { ok?: boolean; error?: string }

/**
 * Save one block's answer.
 *
 * Everything hangs off the BLOCK'S OWN TYPE, read from the registry:
 *   - whether the response is encrypted (`isSensitive`)
 *   - what else it writes (`writesTo`)
 *
 * The client never says which of those apply. If it could, a crafted request
 * could store a Day 2 answer in the clear.
 */
export async function saveBlockResponse(
  blockId: string,
  raw: unknown,
): Promise<SaveState> {
  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) {
    return { error: 'Sign in again to save your work.' }
  }
  const contactId = actor.contactId

  // Resolve the block, its lesson, its day and its programme from the id
  // alone, so nothing about where it lives is taken from the request.
  const [located] = await db
    .select({
      block: lessonBlocks,
      lesson: lessons,
      module: modules,
    })
    .from(lessonBlocks)
    .innerJoin(lessons, eq(lessons.id, lessonBlocks.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(lessonBlocks.id, blockId))
    .limit(1)

  if (!located) return { error: 'That exercise no longer exists.' }

  const definition = getBlock(located.block.type)
  if (!definition) return { error: 'That exercise is unavailable.' }
  if (!definition.responseSchema) return { error: 'That block takes no answer.' }

  const parsed = definition.responseSchema.safeParse(raw)
  if (!parsed.success) return { error: 'Some of that did not save. Check the fields.' }
  const response = parsed.data as Record<string, unknown>

  // Her enrollment must actually cover this block's version, and the
  // programme is read from the block rather than taken from the request.
  const [enrolled] = await db
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
        eq(enrollments.versionId, located.module.versionId),
      ),
    )
    .limit(1)

  if (!enrolled) return { error: 'You are not enrolled in that programme.' }
  const enrollment = enrolled.enrollment

  // The day must be open to her. Without this, guessing a block id would let
  // somebody skip the drip entirely.
  const ctx = await getQueryContext()
  const state = await getStateForEnrollment(
    ctx,
    enrollment,
    enrolled.program,
    enrolled.cohort,
  )
  if (!isDayUnlocked(located.module.position, state.unlock)) {
    return { error: 'That day has not opened yet.' }
  }

  const isSensitive = definition.isSensitive

  const values = {
    enrollmentId: enrollment.id,
    blockId,
    isSensitive,
    response: isSensitive ? null : response,
    responseEncrypted: isSensitive
      ? encryptEntry(JSON.stringify(response), await contactDataKey(db, contactId))
      : null,
    answeredAt: new Date(),
    updatedAt: new Date(),
  }

  await db
    .insert(blockResponses)
    .values(values)
    .onConflictDoUpdate({
      target: [blockResponses.enrollmentId, blockResponses.blockId],
      set: {
        response: values.response,
        responseEncrypted: values.responseEncrypted,
        isSensitive: values.isSensitive,
        answeredAt: values.answeredAt,
        updatedAt: values.updatedAt,
      },
    })

  await runSideEffects({
    db,
    contactId,
    enrollmentId: enrollment.id,
    programId: enrollment.programId,
    lessonId: located.lesson.id,
    blockId,
    definition,
    response,
  })

  await db
    .update(contacts)
    .set({ lastActivityAt: new Date() })
    .where(eq(contacts.id, contactId))

  return { ok: true }
}

/** Mark a day finished and move her forward. */
export async function completeDay(
  programSlug: string,
  dayNumber: number,
): Promise<SaveState> {
  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) {
    return { error: 'Sign in again to save your work.' }
  }
  const contactId = actor.contactId

  const ctx = await getQueryContext()
  const state = await getChallengeState(ctx, contactId, programSlug)
  if (!state) return { error: 'You are not enrolled in that programme.' }

  if (!isDayUnlocked(dayNumber, state.unlock)) {
    return { error: 'That day has not opened yet.' }
  }

  const dayLessons = await db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(
      and(
        eq(modules.versionId, state.enrollment.versionId),
        eq(modules.position, dayNumber),
      ),
    )

  for (const lesson of dayLessons) {
    await db
      .insert(lessonProgress)
      .values({
        enrollmentId: state.enrollment.id,
        lessonId: lesson.id,
        status: 'completed',
        completedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [lessonProgress.enrollmentId, lessonProgress.lessonId],
        set: { status: 'completed', completedAt: new Date(), updatedAt: new Date() },
      })
  }

  const isFinalDay = dayNumber >= state.durationDays

  await db
    .update(enrollments)
    .set({
      currentDay: Math.min(dayNumber + 1, state.durationDays),
      ...(isFinalDay
        ? { status: 'completed' as const, completedAt: new Date() }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(enrollments.id, state.enrollment.id))

  await db.insert(activityEvents).values({
    contactId,
    eventType: isFinalDay ? 'challenge.completed' : 'day.completed',
    entity: 'enrollments',
    entityId: state.enrollment.id,
    metadata: { day: dayNumber, programSlug },
  })

  // Finishing the last day is when a certificate becomes possible. Issuing is
  // idempotent and refuses unless every configured requirement is met, so this
  // is safe to call on a re-completion and cannot award one by accident.
  if (isFinalDay) {
    try {
      await issueIfEarned(db, state.enrollment.id)
    } catch {
      // Never fail her day completion over a certificate. It can be issued
      // later from the admin, and her progress is already saved.
    }
  }

  revalidatePath('/my-practice', 'layout')
  return { ok: true }
}

/** Enrol her, pinning the published version so later edits never shift under her. */
export async function enroll(programSlug: string): Promise<SaveState> {
  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) {
    return { error: 'Sign in again to begin.' }
  }
  const contactId = actor.contactId

  const ctx = await getQueryContext()
  const published = await getPublishedVersion(ctx, programSlug)
  if (!published) return { error: 'That programme is not open yet.' }

  const [existing] = await db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.contactId, contactId),
        eq(enrollments.programId, published.program.id),
      ),
    )
    .limit(1)

  if (existing) return { ok: true }

  const [contact] = await db
    .select({ timezone: contacts.timezone })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1)

  const [dayCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(modules)
    .where(eq(modules.versionId, published.version.id))

  await db.insert(enrollments).values({
    contactId,
    programId: published.program.id,
    versionId: published.version.id,
    timezoneAtStart: contact?.timezone ?? 'UTC',
    currentDay: 1,
  })

  await db.insert(activityEvents).values({
    contactId,
    eventType: 'challenge.started',
    entity: 'programs',
    entityId: published.program.id,
    metadata: { programSlug, days: Number(dayCount?.n ?? 0) },
  })

  revalidatePath('/my-practice', 'layout')
  return { ok: true }
}
