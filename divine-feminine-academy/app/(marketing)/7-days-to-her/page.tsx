import type { Metadata } from 'next'
import { Rule } from '@/design-system/primitives'
import {
  Eyebrow,
  Placeholder,
  Prose,
  PullQuote,
  Section,
} from '@/design-system/patterns'
import { JoinForm } from '@/features/auth/JoinForm'

export const metadata: Metadata = {
  title: '7 Days to HER',
  description:
    'Seven days to name the woman you are becoming, practise choosing her, and learn the way back when you lose her.',
}

/**
 * The primary conversion page for social traffic.
 *
 * One promise, one proof, one button. It reads like a magazine, not a sales
 * letter, and it is written for a phone held one-handed.
 */

const days = [
  {
    n: 'Day 1',
    title: 'Meet her',
    body: 'Two columns. What sets you off, how you respond now, how she would respond instead. This becomes your profile, and it stays with you.',
  },
  {
    n: 'Day 2',
    title: 'Where it started',
    body: 'The belief underneath the pattern, and the moment you learned it. This one asks a lot. Only you will ever read what you write.',
  },
  {
    n: 'Day 3',
    title: 'Who you are performing for',
    body: 'An honest audit of whose approval you are still arranging your life around.',
  },
  {
    n: 'Day 4',
    title: 'The behaviour',
    body: 'One thing you keep doing that she would not. You commit to changing it, specifically.',
  },
  {
    n: 'Day 5',
    title: 'The way back',
    body: 'You will lose her. This is the practice for returning — six questions and one action. You keep it for life.',
  },
  {
    n: 'Day 6',
    title: 'I chose HER',
    body: 'You start logging it. Every time you choose her instead, in the moment, from your phone.',
  },
  {
    n: 'Day 7',
    title: 'Your HER Code',
    body: 'You read back your own week — the evidence, in your words — and write the code you are living by now.',
  },
]

export default function SevenDaysPage() {
  return (
    <>
      <Section className="pt-14 md:pt-24">
        <Eyebrow>Free · Seven days</Eyebrow>
        <h1 className="mt-6 text-3xl md:text-4xl">7 Days to HER</h1>
        <Prose className="mt-8 text-lg">
          <p>
            Seven days to name the woman you keep catching glimpses of, practise
            choosing her on purpose, and learn exactly how to come back when you
            lose her again.
          </p>
          <p>About twenty minutes a day. On your phone. Starting whenever you do.</p>
        </Prose>

        <Placeholder
          label="Confirm before launch"
          note="pricing not set"
          className="mt-8 max-w-md"
        >
          <p className="text-xs text-ink-soft">
            This page currently says the challenge is free. If it is paid, or
            priced as a tripwire, the eyebrow above and the form below both need
            changing — and it becomes an `offers` row rather than an open
            sign-up.
          </p>
        </Placeholder>

        <div className="mt-12 max-w-md rounded-xl border border-rule bg-alabaster p-6 md:p-8">
          <h2 className="font-display text-xl">Start Day 1</h2>
          <p className="mt-2 text-xs text-ink-muted">
            Your first name and your email. We will send you a link — there is
            no password to make up.
          </p>
          <JoinForm className="mt-6" source="7-days-to-her" next="/my-academy" submitLabel="Send my link" />
        </div>
      </Section>

      <Section>
        <Rule tone="gilt" />
        <h2 className="mt-12 text-2xl">The seven days</h2>
        <ol className="mt-10 divide-y divide-rule border-y border-rule">
          {days.map((day) => (
            <li key={day.n} className="py-6">
              <Eyebrow>{day.n}</Eyebrow>
              <h3 className="mt-2 font-display text-xl">{day.title}</h3>
              <p className="measure mt-2 text-sm text-ink-soft">{day.body}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section>
        <h2 className="text-2xl">What you leave with</h2>
        <Prose className="mt-4">
          <p>
            Not a certificate of attendance. A profile of your own patterns in
            your own words, a count of the times you chose differently, a
            practice for the bad days, and a written code you can hold yourself
            to.
          </p>
          <p>All of it stays in your account after the seven days end.</p>
        </Prose>

        <PullQuote className="mt-12">
          The practice is not staying. It is returning.
        </PullQuote>
      </Section>

      <Section className="pb-24">
        <Rule tone="gilt" />
        <div className="mt-12">
          <h2 className="text-2xl">Before you start</h2>
          <Prose className="mt-4 text-sm">
            <p>
              This is education, not therapy, and it is not a substitute for
              care from a professional. Some of these days ask you to look at
              painful things. If you are in crisis, please reach out to someone
              who can help you today.
            </p>
          </Prose>
        </div>
      </Section>
    </>
  )
}
