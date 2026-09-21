'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { quizInput, recordQuizSubmission } from './submit'

export type QuizState = { error?: string }

/**
 * The form action.
 *
 * A shell. Parsing the form and redirecting is all it does; the work is in
 * `recordQuizSubmission`, which can be tested without a request.
 */
export async function submitQuiz(
  _prev: QuizState,
  formData: FormData,
): Promise<QuizState> {
  const raw = {
    slug: formData.get('slug'),
    // Undefined rather than null when absent, so the optional field in
    // quizInput falls back instead of failing its uuid check.
    versionId: formData.get('versionId') ?? undefined,
    firstName: formData.get('firstName'),
    email: formData.get('email'),
    answers: formData.get('answers'),
  }

  let answers: Record<string, string>
  try {
    answers = z
      .record(z.string(), z.string())
      .parse(JSON.parse(String(raw.answers ?? '')))
  } catch {
    return { error: 'Your answers did not come through. Try again.' }
  }

  const parsed = quizInput.safeParse({ ...raw, answers })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the fields.' }
  }

  const outcome = await recordQuizSubmission(parsed.data)
  if (!outcome.ok) return { error: outcome.error }

  redirect(`/quiz/result/${outcome.token}`)
}
