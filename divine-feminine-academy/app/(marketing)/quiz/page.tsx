import type { Metadata } from 'next'
import { db } from '@/db/client'
import { Eyebrow, Prose, Section, StaffNote } from '@/design-system/patterns'
import { getPublishedAssessment } from '@/db/queries/assessments'
import { QuizFlow, type FlowQuestion } from '@/features/quiz/QuizFlow'
import { OracleCards } from '@/features/quiz/OracleCards'
import { JoinForm } from '@/features/auth/JoinForm'
import { siteImage } from '@/db/queries/images'
import { SiteImage, SiteImageFrame } from '@/features/images/SiteImage'
import { imageSlot } from '@/features/images/slots'

export const metadata: Metadata = {
  title: 'Which woman is running your life?',
  description:
    'A free 90-second quiz. Four Divine Feminine archetypes — and the one who takes the wheel when you are under pressure.',
  openGraph: {
    title: 'Which woman is running your life?',
    description:
      'Four of them. One has been running your life. Discover your Divine Feminine archetype.',
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
          {/*
            The question is the headline, and it is set as a question about a
            WOMAN rather than about a trait. "Which of these are you" invites
            her to answer from the outside, as a category. "Which woman is
            running your life" is answered from the inside, and it is the
            actual claim the instrument makes: there is someone in there doing
            this, she has a name, and she is not you.
          */}
          <h1 className="mt-6 text-3xl md:text-5xl">
            Which woman is running your life?
          </h1>
          {/*
            Her hand, once, on the promise rather than the question. The
            headline is the hook and stays in the serif; the subtitle is the
            thing she is being offered, and the script marks it as spoken
            rather than printed. Two script lines on one screen and neither
            means anything.
          */}
          <p className="mt-4 font-script text-2xl text-plum md:text-3xl">
            Discover your Divine Feminine archetype
          </p>
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

      {/*
        The four, shown and not named.

        The rule that they must not be listed here has not changed - naming
        them biases every answer that follows and spends the reveal. Face down
        satisfies it: she learns there are exactly four and that they are
        distinct, and learns nothing that could tell her which is hers.
      */}
      <OracleCards className="mt-14" />

      {questions.length > 0 ? (
        <div className="mt-14">
          <QuizFlow
            slug={QUIZ_SLUG}
            versionId={published!.version.id}
            questions={questions}
          />
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
              next="/my-academy"
              submitLabel="Keep me posted"
            />
          </div>
        </>
      )}
    </Section>
  )
}
