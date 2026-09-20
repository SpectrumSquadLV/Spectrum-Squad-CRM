import type { Metadata } from 'next'
import { Eyebrow, Placeholder, Prose, Section } from '@/design-system/patterns'
import { JoinForm } from '@/features/auth/JoinForm'

export const metadata: Metadata = {
  title: 'The assessment',
  description:
    'A short, free assessment across Self, Love, Life and Wealth — where you are now, in your own words.',
}

export default function AssessmentPage() {
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

      <Placeholder
        label="Questions not written"
        note="assessment engine is Phase 4"
        className="mt-10"
      >
        <Prose className="text-sm">
          <p>
            The database supports likert, multiple-choice and open questions
            with per-area scoring and a pre/post comparison. The questions
            themselves still need writing, and they are the whole value.
          </p>
          <p>
            The intended flow: she answers without an account, sees a partial
            result, then gives her email for the full one. Higher conversion
            than a hard gate.
          </p>
        </Prose>
      </Placeholder>

      <div className="mt-12 max-w-md rounded-xl border border-rule bg-alabaster p-6 md:p-8">
        <h2 className="font-display text-xl">Tell me when it is ready</h2>
        <p className="mt-2 text-xs text-ink-muted">
          We will email you when the assessment opens. In the meantime, the
          seven days are already here.
        </p>
        <JoinForm
          className="mt-6"
          source="assessment-waitlist"
          next="/my-academy"
          submitLabel="Keep me posted"
        />
      </div>
    </Section>
  )
}
