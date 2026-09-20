import 'server-only'

import { and, asc, desc, eq } from 'drizzle-orm'
import {
  assessmentAttempts,
  assessmentQuestions,
  assessmentResponses,
  assessmentResults,
  assessmentVersions,
  assessments,
  contacts,
} from '../schema'
import type { ScorableQuestion } from '@/features/assessment/scoring'
import type { QueryContext } from './_context'

/** The published version of an assessment, with its questions in order. */
export async function getPublishedAssessment(
  db: QueryContext['db'],
  slug: string,
) {
  const [row] = await db
    .select({ assessment: assessments, version: assessmentVersions })
    .from(assessments)
    .innerJoin(
      assessmentVersions,
      eq(assessmentVersions.assessmentId, assessments.id),
    )
    .where(eq(assessments.slug, slug))
    .orderBy(desc(assessmentVersions.version))
    .limit(1)

  if (!row) return null

  const questions = await db
    .select()
    .from(assessmentQuestions)
    .where(eq(assessmentQuestions.versionId, row.version.id))
    .orderBy(asc(assessmentQuestions.position))

  return { ...row, questions }
}

/** Shape the stored questions into what the scorer expects. */
export function toScorable(
  questions: (typeof assessmentQuestions.$inferSelect)[],
): ScorableQuestion[] {
  return questions.map((q) => ({
    id: q.id,
    type: q.type,
    area: q.area,
    config: (q.config ?? {}) as ScorableQuestion['config'],
  }))
}

/**
 * An attempt by its emailed token.
 *
 * No actor check: results open from a link in her inbox without a login,
 * because asking a woman to make an account before she sees her own result is
 * where the funnel dies. The token is the credential, so it is long and random.
 */
export async function getAttemptByToken(
  db: QueryContext['db'],
  token: string,
) {
  const [attempt] = await db
    .select()
    .from(assessmentAttempts)
    .where(eq(assessmentAttempts.resultToken, token))
    .limit(1)

  if (!attempt) return null

  const [result] = await db
    .select()
    .from(assessmentResults)
    .where(eq(assessmentResults.attemptId, attempt.id))
    .limit(1)

  const [contact] = await db
    .select({ firstName: contacts.firstName })
    .from(contacts)
    .where(eq(contacts.id, attempt.contactId))
    .limit(1)

  const responses = await db
    .select()
    .from(assessmentResponses)
    .where(eq(assessmentResponses.attemptId, attempt.id))

  const questions = await db
    .select()
    .from(assessmentQuestions)
    .where(eq(assessmentQuestions.versionId, attempt.versionId))
    .orderBy(asc(assessmentQuestions.position))

  return { attempt, result, contact, responses, questions }
}

/** Her earlier attempt at the same assessment, for a pre/post comparison. */
export async function getPriorAttempt(
  db: QueryContext['db'],
  contactId: string,
  versionId: string,
  excludeAttemptId: string,
) {
  const [attempt] = await db
    .select()
    .from(assessmentAttempts)
    .where(
      and(
        eq(assessmentAttempts.contactId, contactId),
        eq(assessmentAttempts.versionId, versionId),
      ),
    )
    .orderBy(asc(assessmentAttempts.completedAt))
    .limit(2)

  if (!attempt || attempt.id === excludeAttemptId) return null

  const [result] = await db
    .select()
    .from(assessmentResults)
    .where(eq(assessmentResults.attemptId, attempt.id))
    .limit(1)

  return result ? { attempt, result } : null
}

export async function listAssessments(db: QueryContext['db']) {
  return db.select().from(assessments).orderBy(asc(assessments.title))
}
