'use client'

import { useActionState, useEffect, useMemo, useRef, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Field, Input, Rule } from '@/design-system/primitives'
import { cn } from '@/lib/utils/cn'
import { submitQuiz, type QuizState } from './actions'
import { archetypes, scoreArchetypes, type QuizQuestion } from './archetypes'

export interface FlowQuestion {
  id: string
  type: 'likert' | 'multiple_choice' | 'open'
  prompt: string
  config: {
    options?: Array<{ value: string; label?: string }>
  }
}

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Working…' : 'Show me who she is'}
    </Button>
  )
}

/**
 * The quiz.
 *
 * One question a screen, tap to answer, advances itself. Every decision here
 * is about finishing: a woman who arrived from a reel gives this about ninety
 * seconds, and a Next button she has to find after every tap is a place to
 * leave.
 *
 * She sees something TRUE about herself before the email box appears. The
 * preview below is computed in the browser with the same scorer the server
 * uses, but it deliberately does not name her archetype - the name is what the
 * email is for, and the line it shows instead is one of her own sentences read
 * back to her, which is more persuasive than a name anyway.
 */
export function QuizFlow({
  slug,
  versionId,
  questions,
}: {
  slug: string
  /**
   * The version these questions came from, sent back on submit.
   *
   * Her answers are keyed to THESE question IDs. If a new version publishes
   * while she is part-way through, the server has to score against the
   * version she actually saw or every answer she gave is discarded - which
   * is how a finished quiz used to end in "Answer at least one question
   * first". It is a version ID, not an answer, so it cannot be used to
   * change her result: the weights are read from the database either way.
   */
  versionId: string
  questions: FlowQuestion[]
}) {
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [showGate, setShowGate] = useState(false)
  const [state, formAction] = useActionState<QuizState, FormData>(submitQuiz, {})
  const top = useRef<HTMLDivElement>(null)

  /*
   * Put the new question back at the top of the screen.
   *
   * The quiz advances itself when she taps, and without this the page keeps
   * whatever scroll position the last answer left it at — so on a phone, after
   * tapping the fourth option, the next question's heading sits behind the
   * sticky header and she is looking at four answers to a question she cannot
   * see.
   *
   * Only on a real move, never on first paint: scrolling somebody to the top
   * of a page they just arrived at is its own small rudeness.
   */
  const firstPaint = useRef(true)
  useEffect(() => {
    if (firstPaint.current) {
      firstPaint.current = false
      return
    }
    // Instant, not smooth. The quiz already pauses 220ms on each tap so she
    // sees her own choice register; adding a half-second glide on top means
    // she spends a meaningful part of a ninety-second quiz watching the page
    // move. Smooth scrolling is for pages somebody chose to scroll.
    top.current?.scrollIntoView({ behavior: 'auto', block: 'start' })
  }, [index, showGate])

  const preview = useMemo(() => {
    const scorable: QuizQuestion[] = questions.map((q) => ({
      id: q.id,
      type: q.type,
      config: q.config as QuizQuestion['config'],
    }))
    return scoreArchetypes(
      scorable,
      Object.entries(answers).map(([questionId, value]) => ({
        questionId,
        value,
      })),
    )
  }, [questions, answers])

  if (questions.length === 0) {
    return <p className="text-sm text-ink-muted">No questions yet.</p>
  }

  if (showGate) {
    // One of her own sentences, read back. Not the archetype's name.
    const teaser = preview.primary
      ? archetypes[preview.primary].soundsLike[0]
      : null

    return (
      <div className="measure scroll-mt-28" ref={top}>
        <p className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
          Done
        </p>
        <h2 className="mt-4 font-display text-3xl leading-snug">
          One of the four came out clearly on top.
        </h2>

        {teaser && (
          <figure className="mt-8 border-l-2 border-gilt pl-5">
            <blockquote className="font-display text-xl leading-snug text-ink">
              “{teaser}”
            </blockquote>
            <figcaption className="mt-3 text-sm text-ink-muted">
              She is the one who said that. You will recognise the rest.
            </figcaption>
          </figure>
        )}

        {/* The shape of the result, without the labels that would give it away. */}
        <ul className="mt-10 flex items-end gap-2" aria-hidden="true">
          {preview.tallies.map((t) => (
            <li
              key={t.mode}
              className={cn(
                'h-2 flex-1 rounded-full',
                t.mode === preview.primary ? 'bg-plum' : 'bg-linen',
              )}
            />
          ))}
        </ul>

        <Rule tone="gilt" className="my-10" />

        <form action={formAction} className="flex flex-col gap-5">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="versionId" value={versionId} />
          <input type="hidden" name="answers" value={JSON.stringify(answers)} />

          <Field label="First name" htmlFor="quiz-name">
            <Input id="quiz-name" name="firstName" autoComplete="given-name" required />
          </Field>

          <Field label="Email" htmlFor="quiz-email">
            <Input
              id="quiz-email"
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
            Your result opens on the next screen and a copy goes to your inbox,
            so you can come back to it. No spam, and your email is never sold.
          </p>
        </form>

        <button
          type="button"
          onClick={() => setShowGate(false)}
          className="mt-6 text-2xs text-ink-faint underline underline-offset-4"
        >
          Go back and change an answer
        </button>
      </div>
    )
  }

  const question = questions[index]
  const isLast = index === questions.length - 1
  const chosen = question ? answers[question.id] : undefined

  function choose(value: string) {
    if (!question) return
    setAnswers((prev) => ({ ...prev, [question.id]: value }))

    // A beat, so she sees her own choice register before the screen moves.
    // Without it the quiz feels like it is answering for her.
    window.setTimeout(() => {
      if (isLast) setShowGate(true)
      else setIndex((i) => i + 1)
    }, 220)
  }

  return (
    <div className="measure scroll-mt-28" ref={top}>
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
          <h2 className="mt-4 font-display text-2xl leading-snug md:text-3xl">
            {question.prompt}
          </h2>

          <div className="mt-8 flex flex-col gap-2.5">
            {(question.config.options ?? []).map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={chosen === o.value}
                onClick={() => choose(o.value)}
                className={cn(
                  'min-h-16 rounded-lg border px-5 py-4 text-left text-sm leading-relaxed transition-colors',
                  chosen === o.value
                    ? 'border-plum bg-plum-wash text-plum'
                    : 'border-rule-strong bg-alabaster text-ink-soft hover:border-clay',
                )}
              >
                {o.label ?? o.value}
              </button>
            ))}
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
        <p className="text-2xs text-ink-faint">
          There is no right answer. Pick the one you would actually do.
        </p>
      </div>
    </div>
  )
}
