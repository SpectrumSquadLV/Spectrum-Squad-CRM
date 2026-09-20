import type { Metadata } from 'next'
import { db } from '@/db/client'
import { Eyebrow, Prose, Section, StaffNote } from '@/design-system/patterns'
import { getPublishedAssessment } from '@/db/queries/assessments'
import { QuizFlow, type FlowQuestion } from '@/features/quiz/QuizFlow'
import { JoinForm } from '@/features/auth/JoinForm'
import { siteImage } from '@/db/queries/images'
import { SiteImage, SiteImageFrame } from '@/features/images/SiteImage'
import { imageSlot } from '@/features/images/slots'

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
  const [published, portrait] = await Promise.all([
    getPublishedAssessment(db, QUIZ_SLUG),
    siteImage('quiz-intro'),
  ])
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
      <div className="flex items-start gap-6">
        {portrait && (
          <div className="hidden w-28 shrink-0 sm:block">
            <SiteImageFrame slot={imageSlot('quiz-intro')!} className="rounded-full">
              <SiteImage images={portrait} slot={imageSlot('quiz-intro')!} rounded="full" priority sizes="7rem" />
            </SiteImageFrame>
          </div>
        )}
        <div>
          <Eyebrow>Free · about 90 seconds</Eyebrow>
          <h1 className="mt-6 text-3xl md:text-5xl">
            Which version of ME is running the show?
          </h1>
        </div>
      </div>

      <Prose className="mt-8 text-lg">
        <p>
          There is a version of you whose whole job has been to make you feel
          good enough. Call her ME. She has been at it a long time, and she has
          been good at it.
        </p>
        <p>
          ME has four strategies: she <strong>fights</strong>, she{' '}
          <strong>runs</strong>, she <strong>freezes</strong>, or she{' '}
          <strong>goes quiet</strong>. One of them is usually driving.
        </p>
        <p>
          She is not the enemy, and this does not end with getting rid of her.
          It ends with her being understood, thanked, and finally allowed to
          put the job down.
        </p>
      </Prose>

      {questions.length > 0 ? (
        <div className="mt-14">
          <QuizFlow slug={QUIZ_SLUG} questions={questions} />
        </div>
      ) : (
        <>
          <StaffNote what="the quiz to be seeded" className="mt-10">
            <p>
              No published archetype quiz was found for “{QUIZ_SLUG}”. Run
              npm run seed:quiz. Until then this page collects emails rather
              than showing a stranger that something is missing.
            </p>
          </StaffNote>

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
