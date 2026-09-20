import type { Metadata } from 'next'
import { Eyebrow, Placeholder, Prose, Section } from '@/design-system/patterns'
import { CrisisResources } from '@/features/care/CrisisResources'

export const metadata: Metadata = {
  title: 'This is education, not therapy',
  description:
    'What the Divine Feminine is, what it is not, and where to go if you need real help today.',
}

export default function DisclaimerPage() {
  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>Please read this</Eyebrow>
      <h1 className="mt-6 text-3xl">This is education, not therapy.</h1>

      <Prose className="mt-8">
        <p>
          The Divine Feminine is a personal development programme. It is
          not mental health treatment, not counselling, and not a substitute for
          care from a licensed professional.
        </p>
        <p>
          Nothing here is a diagnosis. Nobody who works here is your clinician.
          The exercises ask you to look honestly at your own patterns, and for
          some women that surfaces things that need more than a journal and a
          practice — things that deserve a trained person in the room.
        </p>
        <p>
          If that is you, that is not a failure of the work. It means you need a
          different kind of help first, and we would rather say so than take
          your money.
        </p>

        <h2 className="mt-12 font-display text-xl">Nobody is reading your journal</h2>
        <p>
          Your journal entries are encrypted before they reach our database.
          That means genuine privacy — and it also means there is no one
          watching for warning signs in what you write. Nothing you put here
          reaches a human unless you deliberately share it.
        </p>
        <p>
          So please do not use this platform to ask for help in an emergency. It
          cannot hear you.
        </p>

        <h2 className="mt-12 font-display text-xl">No outcome is promised</h2>
        <p>
          Nothing on this site is a guarantee of any particular result —
          emotional, relational or financial. What you get out of it depends on
          what you bring to it, and on a great many things neither of us
          controls.
        </p>
      </Prose>

      <CrisisResources tone="full" className="mt-12" />

      <Placeholder
        label="Needs a lawyer"
        note="not legal advice"
        className="mt-12"
      >
        <Prose className="text-sm">
          <p>
            This page was written to be honest and readable, not to be legally
            sufficient. Before launch it needs review by someone qualified in
            your jurisdiction — particularly the limitation of liability, and
            what your obligations are if concerning content ever does reach a
            human here.
          </p>
          <p>
            The related operational gap: there is no written policy yet for what
            happens when a member shares something alarming with a coach. That
            policy should exist before the first woman signs up.
          </p>
        </Prose>
      </Placeholder>
    </Section>
  )
}
