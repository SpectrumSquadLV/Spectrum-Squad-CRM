import 'server-only'

import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '@/db/client'
import {
  activityEvents,
  assessmentAttempts,
  blockResponses,
  certificateRequirements,
  certificates,
  contacts,
  enrollments,
  herChoices,
  herCodes,
  lessonBlocks,
  lessonProgress,
  lessons,
  modules,
} from '@/db/schema'
import { newToken } from '@/lib/crypto/journal'
import {
  certificateNumber,
  evaluateEligibility,
  type Progress,
  type Requirement,
} from './requirements'

/** Gather what she has actually done, for one enrollment. */
export async function gatherProgress(
  db: Db,
  enrollmentId: string,
): Promise<Progress | null> {
  const [enrollment] = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.id, enrollmentId))
    .limit(1)
  if (!enrollment) return null

  const [lessonCounts] = await db
    .select({
      total: sql<number>`count(*)`,
      completed: sql<number>`count(*) FILTER (WHERE ${lessonProgress.status} = 'completed')`,
    })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .leftJoin(
      lessonProgress,
      and(
        eq(lessonProgress.lessonId, lessons.id),
        eq(lessonProgress.enrollmentId, enrollmentId),
      ),
    )
    .where(eq(modules.versionId, enrollment.versionId))

  const [blockCounts] = await db
    .select({
      total: sql<number>`count(*)`,
      answered: sql<number>`count(${blockResponses.id})`,
    })
    .from(lessonBlocks)
    .innerJoin(lessons, eq(lessons.id, lessonBlocks.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .leftJoin(
      blockResponses,
      and(
        eq(blockResponses.blockId, lessonBlocks.id),
        eq(blockResponses.enrollmentId, enrollmentId),
      ),
    )
    .where(
      and(
        eq(modules.versionId, enrollment.versionId),
        eq(lessonBlocks.isRequired, true),
      ),
    )

  const [choices] = await db
    .select({ n: sql<number>`count(*)` })
    .from(herChoices)
    .where(eq(herChoices.contactId, enrollment.contactId))

  const [code] = await db
    .select({ id: herCodes.id })
    .from(herCodes)
    .where(
      and(
        eq(herCodes.contactId, enrollment.contactId),
        eq(herCodes.programId, enrollment.programId),
      ),
    )
    .limit(1)

  const [post] = await db
    .select({ id: assessmentAttempts.id })
    .from(assessmentAttempts)
    .where(
      and(
        eq(assessmentAttempts.contactId, enrollment.contactId),
        eq(assessmentAttempts.timing, 'post'),
      ),
    )
    .limit(1)

  return {
    lessonsTotal: Number(lessonCounts?.total ?? 0),
    lessonsCompleted: Number(lessonCounts?.completed ?? 0),
    requiredBlocksTotal: Number(blockCounts?.total ?? 0),
    requiredBlocksAnswered: Number(blockCounts?.answered ?? 0),
    postAssessmentSubmitted: Boolean(post),
    herChoicesLogged: Number(choices?.n ?? 0),
    herCodeFinalized: Boolean(code),
  }
}

export async function loadRequirements(
  db: Db,
  programId: string,
): Promise<Requirement[]> {
  const rows = await db
    .select()
    .from(certificateRequirements)
    .where(eq(certificateRequirements.programId, programId))

  return rows.map((r) => ({
    requirementType: r.requirementType,
    threshold: r.threshold,
  }))
}

/**
 * Issue a certificate if she has earned one.
 *
 * Idempotent: a woman who finishes, then edits a Day 6 answer, must not end up
 * with two certificates. Returns the existing one if there is one.
 */
export async function issueIfEarned(db: Db, enrollmentId: string) {
  const [enrollment] = await db
    .select()
    .from(enrollments)
    .where(eq(enrollments.id, enrollmentId))
    .limit(1)
  if (!enrollment) return { issued: false as const, reason: 'no-enrollment' }

  const [existing] = await db
    .select()
    .from(certificates)
    .where(
      and(
        eq(certificates.contactId, enrollment.contactId),
        eq(certificates.programId, enrollment.programId),
      ),
    )
    .limit(1)

  if (existing) return { issued: true as const, certificate: existing }

  const [requirements, progress] = await Promise.all([
    loadRequirements(db, enrollment.programId),
    gatherProgress(db, enrollmentId),
  ])
  if (!progress) return { issued: false as const, reason: 'no-progress' }

  const eligibility = evaluateEligibility(requirements, progress)
  if (!eligibility.eligible) {
    return { issued: false as const, reason: 'not-eligible', eligibility }
  }

  const [contact] = await db
    .select({ firstName: contacts.firstName, lastName: contacts.lastName })
    .from(contacts)
    .where(eq(contacts.id, enrollment.contactId))
    .limit(1)

  const [count] = await db
    .select({ n: sql<number>`count(*)` })
    .from(certificates)

  const year = new Date().getFullYear()
  const recipientName =
    [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || 'A woman'

  const [certificate] = await db
    .insert(certificates)
    .values({
      contactId: enrollment.contactId,
      programId: enrollment.programId,
      certificateNumber: certificateNumber(Number(count?.n ?? 0) + 1, year),
      verificationToken: newToken(18),
      recipientName,
    })
    .onConflictDoNothing({
      target: [certificates.contactId, certificates.programId],
    })
    .returning()

  if (!certificate) {
    // Lost a race with a concurrent completion; the other one stands.
    const [now] = await db
      .select()
      .from(certificates)
      .where(
        and(
          eq(certificates.contactId, enrollment.contactId),
          eq(certificates.programId, enrollment.programId),
        ),
      )
      .limit(1)
    return now
      ? { issued: true as const, certificate: now }
      : { issued: false as const, reason: 'race' }
  }

  await db.insert(activityEvents).values({
    contactId: enrollment.contactId,
    eventType: 'certificate.issued',
    entity: 'certificates',
    entityId: certificate.id,
    metadata: { number: certificate.certificateNumber },
  })

  return { issued: true as const, certificate }
}
