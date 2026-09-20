import type { Metadata } from 'next'
import { db } from '@/db/client'
import { Eyebrow, Prose, Section } from '@/design-system/patterns'
import { Placeholder } from '@/design-system/patterns'
import { getPublishedAssessment } from '@/db/queries/assessments'
import { QuizFlow, type FlowQuestion } from '@/features/quiz/QuizFlow'
import { JoinForm } from '@/features/auth/JoinForm'

export const metadata: Metadata = {
  title: 'Which version of you is running the show?',
  description:
    'A free 90-second quiz. Four versions of you — fight, flight, freeze and sulk — and the one that takes over when you are under pressure.',
  openGraph: {
    title: 'Which version of you is running the show?',
    description:
      'Four versions of you. One of them takes the wheel when you are under pressure. Find out which.',
  },
}

export const dynamic = 'force-dynamic'

export const QUIZ_SLUG = 'which-version'

export default async function QuizPage() {
  const published = await getPublishedAssessment(db, QUIZ_SLUG)
  const isQuiz = published?.assessment.kind === 'archetype'

  const questions: FlowQuestion[] = isQuiz
    ? (published?.questions ?? []).map((q) => ({
        id: q.id,
        type: q.type,
        prompt: q.prompt,
        config: (q.config ?? {}) as FlowQuestion['config'],
      }))
    : []

  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>Free · about 90 seconds</Eyebrow>
      <h1 className="mt-6 text-3xl md:text-5xl">
        Which version of you is running the show?
      </h1>

      <Prose className="mt-8 text-lg">
        <p>
          When something threatens you, you do not think your way through it.
          Something older than thinking takes the wheel, and it has been driving
          since long before you could have stopped it.
        </p>
        <p>
          There are four of her: the one who <strong>fights</strong>, the one
          who <strong>runs</strong>, the one who <strong>freezes</strong>, and
          the one who <strong>goes quiet</strong>. Every one of them is
          protecting something. Only one of them is usually driving.
        </p>
      </Prose>

      {questions.length > 0 ? (
        <div className="mt-14">
          <QuizFlow slug={QUIZ_SLUG} questions={questions} />
        </div>
      ) : (
        <>
          <Placeholder
            label="Not seeded"
            note="run npm run seed:quiz"
            className="mt-10"
          >
            <p className="text-xs text-ink-soft">
              No published archetype quiz was found for “{QUIZ_SLUG}”.
            </p>
          </Placeholder>

          <div className="mt-12 max-w-md rounded-xl border border-rule bg-alabaster p-6 md:p-8">
            <h2 className="font-display text-xl">Tell me when it is ready</h2>
            <JoinForm
              className="mt-6"
              source="quiz-waitlist"
              next="/my-practice"
              submitLabel="Keep me posted"
            />
          </div>
        </>
      )}

      {/*
        The four are deliberately NOT listed here.

        Naming them on this page does two bad things at once: it tells her the
        answer before she has answered, which biases every question that
        follows, and it spends the reveal that the email box is asking her to
        pay for. They are linked from the homepage and they rank on their own,
        which is where strangers should find them.
      */}
    </Section>
  )
}
