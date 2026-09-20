'use client'

import { useActionState, useMemo, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Badge, Button, Field, Input, Rule, Textarea } from '@/design-system/primitives'
import type { Area } from '@/design-system/primitives'
import { cn } from '@/lib/utils/cn'
import { submitAssessment, type SubmitState } from './actions'
import { scoreAssessment, type ScorableQuestion } from './scoring'

export interface FlowQuestion {
  id: string
  type: 'likert' | 'multiple_choice' | 'open'
  prompt: string
  area: Area | null
  config: {
    min?: number
    max?: number
    reverseScored?: boolean
    minLabel?: string
    maxLabel?: string
    options?: Array<{ value: string; label?: string; score?: number }>
  }
}

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Working…' : 'Show me the rest'}
    </Button>
  )
}

/**
 * The assessment.
 *
 * One question at a time, then a PARTIAL result, then the email gate. She sees
 * something true about herself before she is asked for anything.
 */
export function AssessmentFlow({
  slug,
  questions,
}: {
  slug: string
  questions: FlowQuestion[]
}) {
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string | number>>({})
  const [showGate, setShowGate] = useState(false)
  const [state, formAction] = useActionState<SubmitState, FormData>(
    submitAssessment,
    {},
  )

  const question = questions[index]
  const isLast = index === questions.length - 1

  // The partial result is computed in the browser from the same scorer the
  // server uses. It is a preview only; the stored score is the server's.
  const preview = useMemo(() => {
    const scorable: ScorableQuestion[] = questions.map((q) => ({
      id: q.id,
      type: q.type,
      area: q.area,
      config: q.config,
    }))
    return scoreAssessment(
      scorable,
      Object.entries(answers).map(([questionId, value]) => ({ questionId, value })),
    )
  }, [questions, answers])

  if (questions.length === 0) {
    return <p className="text-sm text-ink-muted">No questions yet.</p>
  }

  if (showGate) {
    const shown = preview.byArea.filter((a) => a.score !== null).slice(0, 2)

    return (
      <div className="measure">
        <h2 className="text-2xl">Here is part of it.</h2>
        <p className="mt-3 text-sm text-ink-muted">
          Two of the four areas. Put your email in and we will send you the whole
          picture, with what to do about it.
        </p>

        <ul className="mt-8 space-y-5">
          {shown.map((a) => (
            <li key={a.area}>
              <div className="flex items-baseline justify-between gap-4">
                <Badge area={a.area as Area}>{a.area}</Badge>
                <span className="font-display text-2xl">{a.score}</span>
              </div>
              <div className="mt-2 h-1 rounded-full bg-linen">
                <div
                  className="h-1 rounded-full bg-clay"
                  style={{ width: `${a.score ?? 0}%` }}
                />
              </div>
            </li>
          ))}
        </ul>

        <Rule tone="gilt" className="my-10" />

        <form action={formAction} className="flex flex-col gap-5">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="answers" value={JSON.stringify(answers)} />

          <Field label="First name" htmlFor="assessment-name">
            <Input name="firstName" autoComplete="given-name" required />
          </Field>

          <Field label="Email" htmlFor="assessment-email">
            <Input
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
            />
          </Field>

          {state.error && (
            <p role="alert" className="text-2xs text-critical">
              {state.error}
            </p>
          )}

          <Submit />

          <p className="text-2xs text-ink-muted">
            Your answers are already saved to your result. We will not sell your
            email to anybody.
          </p>
        </form>
      </div>
    )
  }

  const answer = question ? answers[question.id] : undefined
  const canAdvance = question?.type === 'open' || answer !== undefined

  function setAnswer(value: string | number) {
    if (!question) return
    setAnswers((prev) => ({ ...prev, [question.id]: value }))
  }

  return (
    <div className="measure">
      <ol className="flex gap-1.5" aria-label="Progress">
        {questions.map((q, i) => (
          <li
            key={q.id}
            aria-current={i === index ? 'step' : undefined}
            className={cn(
              'h-0.5 flex-1 rounded-full',
              i < index && 'bg-clay',
              i === index && 'bg-plum',
              i > index && 'bg-rule',
            )}
          />
        ))}
      </ol>

      <p className="mt-8 text-2xs uppercase tracking-[0.2em] text-clay-deep">
        {index + 1} of {questions.length}
      </p>

      {question && (
        <>
          <h2 className="mt-4 font-display text-2xl leading-snug">
            {question.prompt}
          </h2>

          <div className="mt-8">
            {question.type === 'likert' && (
              <>
                <div className="flex gap-2">
                  {Array.from(
                    {
                      length:
                        (question.config.max ?? 5) - (question.config.min ?? 1) + 1,
                    },
                    (_, i) => (question.config.min ?? 1) + i,
                  ).map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={answer === v}
                      onClick={() => setAnswer(v)}
                      className={cn(
                        'min-h-14 flex-1 rounded-md border text-sm transition-colors',
                        answer === v
                          ? 'border-plum bg-plum-wash text-plum'
                          : 'border-rule-strong bg-alabaster text-ink-soft hover:border-clay',
                      )}
                    >
                      {v}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex justify-between text-2xs text-ink-faint">
                  <span>{question.config.minLabel ?? 'Never'}</span>
                  <span>{question.config.maxLabel ?? 'Always'}</span>
                </div>
              </>
            )}

            {question.type === 'multiple_choice' && (
              <div className="flex flex-col gap-2">
                {(question.config.options ?? []).map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={answer === o.value}
                    onClick={() => setAnswer(o.value)}
                    className={cn(
                      'min-h-14 rounded-md border px-4 text-left text-sm transition-colors',
                      answer === o.value
                        ? 'border-plum bg-plum-wash text-plum'
                        : 'border-rule-strong bg-alabaster text-ink-soft hover:border-clay',
                    )}
                  >
                    {o.label ?? o.value}
                  </button>
                ))}
              </div>
            )}

            {question.type === 'open' && (
              <Field label="Your answer" htmlFor={`q-${question.id}`}>
                <Textarea
                  value={String(answer ?? '')}
                  onChange={(e) => setAnswer(e.target.value)}
                  rows={6}
                />
              </Field>
            )}
          </div>
        </>
      )}

      <div className="mt-10 flex items-center justify-between gap-4">
        <Button
          type="button"
          variant="quiet"
          disabled={index === 0}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          Back
        </Button>
        <Button
          type="button"
          size="lg"
          disabled={!canAdvance}
          onClick={() => {
            if (isLast) setShowGate(true)
            else setIndex((i) => i + 1)
          }}
        >
          {isLast ? 'See your result' : 'Next'}
        </Button>
      </div>
    </div>
  )
}
