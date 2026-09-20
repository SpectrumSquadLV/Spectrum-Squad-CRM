import type { Metadata } from 'next'
import { db } from '@/db/client'
import { Eyebrow, Placeholder, Prose, Section } from '@/design-system/patterns'
import { getPublishedAssessment } from '@/db/queries/assessments'
import { AssessmentFlow, type FlowQuestion } from '@/features/assessment/AssessmentFlow'
import { JoinForm } from '@/features/auth/JoinForm'

export const metadata: Metadata = {
  title: 'The assessment',
  description:
    'A short, free assessment across Self, Love, Life and Wealth — where you are now, in your own words.',
}

export const dynamic = 'force-dynamic'

const SLUG = 'where-are-you'

export default async function AssessmentPage() {
  const published = await getPublishedAssessment(db, SLUG)

  const questions: FlowQuestion[] = (published?.questions ?? []).map((q) => ({
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    area: q.area,
    config: (q.config ?? {}) as FlowQuestion['config'],
  }))

  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>Free</Eyebrow>
      <h1 className="mt-6 text-3xl md:text-4xl">Where are you, honestly?</h1>
      <Prose className="mt-8 text-lg">
        <p>
          A short set of questions across Self, Love, Life and Wealth. No score
          to feel bad about — a picture of which room the pattern is loudest in
          right now.
        </p>
      </Prose>

      {questions.length > 0 ? (
        <>
          <Placeholder
            label="Placeholder questions"
            note="the real instrument is not written"
            className="mt-10"
          >
            <p className="text-xs text-ink-soft">
              The engine, the scoring and the pre/post comparison are finished
              and tested. These particular questions are stand-ins so the flow
              can be used — they are not a validated instrument and should be
              replaced before launch.
            </p>
          </Placeholder>

          <div className="mt-12">
            <AssessmentFlow slug={SLUG} questions={questions} />
          </div>
        </>
      ) : (
        <>
          <Placeholder
            label="Not seeded"
            note="run npm run seed:assessment"
            className="mt-10"
          >
            <p className="text-xs text-ink-soft">
              No published assessment was found for “{SLUG}”.
            </p>
          </Placeholder>

          <div className="mt-12 max-w-md rounded-xl border border-rule bg-alabaster p-6 md:p-8">
            <h2 className="font-display text-xl">Tell me when it is ready</h2>
            <JoinForm
              className="mt-6"
              source="assessment-waitlist"
              next="/my-academy"
              submitLabel="Keep me posted"
            />
          </div>
        </>
      )}
    </Section>
  )
}
