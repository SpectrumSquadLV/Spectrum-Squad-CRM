'use server'

import { eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { db } from '@/db/client'
import {
  activityEvents,
  assessmentAttempts,
  assessmentResponses,
  assessmentResults,
  contacts,
  crmStages,
} from '@/db/schema'
import { getPublishedAssessment, toScorable } from '@/db/queries/assessments'
import { newToken } from '@/lib/crypto/journal'
import { loudestArea, scoreAssessment } from './scoring'

export type SubmitState = { error?: string }

const answerSchema = z.record(z.string(), z.union([z.string(), z.number()]))

const schema = z.object({
  slug: z.string().trim().min(1),
  firstName: z.string().trim().min(1, 'Tell us what to call you.').max(80),
  email: z.string().trim().toLowerCase().email('That address does not look right.'),
  answers: z.string(),
})

/**
 * Submit an assessment.
 *
 * The flow is deliberate: she answers first, sees a partial result, and only
 * then gives an email for the full one. A hard gate before any result converts
 * worse, and it is also a worse thing to do to somebody.
 *
 * Scoring happens HERE, on the server, from the stored questions - never from
 * anything the browser sends. Otherwise a crafted request could write any
 * score it liked into her record.
 */
export async function submitAssessment(
  _prev: SubmitState,
  formData: FormData,
): Promise<SubmitState> {
  const parsed = schema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the fields.' }
  }
  const input = parsed.data

  let rawAnswers: Record<string, string | number>
  try {
    rawAnswers = answerSchema.parse(JSON.parse(input.answers))
  } catch {
    return { error: 'Your answers did not come through. Try again.' }
  }

  const published = await getPublishedAssessment(db, input.slug)
  if (!published) return { error: 'That assessment is not open.' }

  const questionIds = new Set(published.questions.map((q) => q.id))
  const answers = Object.entries(rawAnswers)
    .filter(([id]) => questionIds.has(id))
    .map(([questionId, value]) => ({ questionId, value }))

  if (answers.length === 0) return { error: 'Answer at least one question first.' }

  // One canonical person: find her by email, or create her as a lead.
  const [existing] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.email, input.email))
    .limit(1)

  let contactId = existing?.id
  if (!contactId) {
    const [defaultStage] = await db
      .select({ id: crmStages.id })
      .from(crmStages)
      .where(eq(crmStages.isDefault, true))
      .limit(1)

    const [created] = await db
      .insert(contacts)
      .values({
        email: input.email,
        firstName: input.firstName,
        acquisitionSource: `assessment:${input.slug}`,
        crmStageId: defaultStage?.id ?? null,
        lastActivityAt: new Date(),
      })
      .returning({ id: contacts.id })
    contactId = created?.id
  }

  if (!contactId) return { error: 'That did not save. Try again.' }

  // Pre before the challenge, post after - so the comparison means something.
  const [prior] = await db
    .select({ id: assessmentAttempts.id })
    .from(assessmentAttempts)
    .where(eq(assessmentAttempts.contactId, contactId))
    .limit(1)

  const token = newToken(24)

  const [attempt] = await db
    .insert(assessmentAttempts)
    .values({
      contactId,
      versionId: published.version.id,
      timing: prior ? 'post' : 'pre',
      resultToken: token,
      completedAt: new Date(),
    })
    .returning()

  if (!attempt) return { error: 'That did not save. Try again.' }

  for (const answer of answers) {
    await db.insert(assessmentResponses).values({
      attemptId: attempt.id,
      questionId: answer.questionId,
      value: answer.value,
    })
  }

  const score = scoreAssessment(toScorable(published.questions), answers)
  const area = loudestArea(score)

  await db.insert(assessmentResults).values({
    attemptId: attempt.id,
    overallScore: score.overall,
    categoryScores: Object.fromEntries(
      score.byArea.map((a) => [a.area, a.score]),
    ),
    narrative: area ? `Loudest right now: ${area}.` : null,
  })

  await db.insert(activityEvents).values({
    contactId,
    eventType: 'assessment.completed',
    entity: 'assessment_attempts',
    entityId: attempt.id,
    metadata: { slug: input.slug, timing: attempt.timing, overall: score.overall },
  })

  redirect(`/assessment/results/${token}`)
}
