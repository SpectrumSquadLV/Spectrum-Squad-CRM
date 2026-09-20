import 'server-only'

import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db/client'
import { activityEvents } from '@/db/schema/activity'
import {
  assessmentAttempts,
  assessmentResponses,
  assessmentResults,
} from '@/db/schema/assessments'
import { getPublishedAssessment } from '@/db/queries/assessments'
import { findOrCreateLead, tagContact } from '@/db/queries/leads'
import { newToken } from '@/lib/crypto/journal'
import { archetypes, scoreArchetypes, type QuizQuestion } from './archetypes'

/**
 * Everything the quiz submission DOES, with none of the framework around it.
 *
 * Kept out of the server action deliberately. An action has to `redirect()`,
 * `redirect()` signals by throwing, and the module it lives in drags client
 * React in with it — so an action is close to untestable outside a request.
 * The part worth testing is this: the scoring, the one-person rule, the tag
 * and the event. The action is a four-line shell over it.
 */
export const quizInput = z.object({
  slug: z.string().trim().min(1),
  firstName: z.string().trim().min(1, 'Tell me what to call you.').max(80),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('That address does not look right.'),
  /** questionId -> chosen option value */
  answers: z.record(z.string(), z.string()),
})

export type QuizInput = z.infer<typeof quizInput>

export type QuizOutcome =
  | { ok: true; token: string; archetype: string }
  | { ok: false; error: string }

export async function recordQuizSubmission(
  input: QuizInput,
): Promise<QuizOutcome> {
  const published = await getPublishedAssessment(db, input.slug)
  if (!published) return { ok: false, error: 'That quiz is not open.' }
  if (published.assessment.kind !== 'archetype') {
    return { ok: false, error: 'That is not a quiz.' }
  }

  // Only answers to questions that are actually in this version count. An
  // answer to a question id she invented is not an answer.
  const questionIds = new Set(published.questions.map((q) => q.id))
  const answers = Object.entries(input.answers)
    .filter(([id]) => questionIds.has(id))
    .map(([questionId, value]) => ({ questionId, value }))

  if (answers.length === 0) {
    return { ok: false, error: 'Answer at least one question first.' }
  }

  const questions: QuizQuestion[] = published.questions.map((q) => ({
    id: q.id,
    type: q.type,
    config: (q.config ?? {}) as QuizQuestion['config'],
  }))

  // SCORED HERE, from the stored questions and their stored weights — never
  // from anything the browser sent. The browser computes the same thing for
  // the preview, but that number is decoration. If the client could name the
  // archetype, a crafted request could write any result it liked into her
  // record, and every email she got afterwards would be addressed to a woman
  // who does not exist.
  const result = scoreArchetypes(questions, answers)
  if (!result.primary) {
    return { ok: false, error: 'Those answers did not add up to anything. Try again.' }
  }

  const archetype = archetypes[result.primary]

  const contactId = await findOrCreateLead(db, {
    email: input.email,
    firstName: input.firstName,
    source: `quiz:${input.slug}`,
  })
  if (!contactId) return { ok: false, error: 'That did not save. Try again.' }

  // A retake is a second attempt, not an edit of the first. How her answers
  // move over months is the most interesting thing this quiz collects, and
  // overwriting would throw it away.
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

  if (!attempt) return { ok: false, error: 'That did not save. Try again.' }

  for (const answer of answers) {
    await db
      .insert(assessmentResponses)
      .values({
        attemptId: attempt.id,
        questionId: answer.questionId,
        value: answer.value,
      })
      .onConflictDoNothing()
  }

  await db.insert(assessmentResults).values({
    attemptId: attempt.id,
    overallScore: null,
    categoryScores: Object.fromEntries(
      result.tallies.map((t) => [t.mode, t.share]),
    ),
    archetype: result.primary,
    secondaryArchetype: result.secondary,
    narrative: archetype.tagline,
  })

  // Segmentation. This is what makes the quiz worth building rather than
  // merely fun: from here every email, offer and page can know which of the
  // four she is without asking her again.
  //
  // An older archetype tag is left in place on a retake. Which version she
  // used to lead with is history worth keeping, and removing it would make
  // taking it again pointless.
  await tagContact(db, contactId, {
    slug: `archetype-${archetype.slug}`,
    name: archetype.name,
  })

  // The automation engine matches on this metadata, so `equals: { archetype:
  // 'sulk' }` is all a per-archetype email sequence needs.
  await db.insert(activityEvents).values({
    contactId,
    eventType: 'quiz.completed',
    entity: 'assessment_attempts',
    entityId: attempt.id,
    metadata: {
      slug: input.slug,
      archetype: result.primary,
      secondary: result.secondary,
      isBlend: result.isBlend,
      timing: attempt.timing,
    },
  })

  return { ok: true, token, archetype: result.primary }
}
