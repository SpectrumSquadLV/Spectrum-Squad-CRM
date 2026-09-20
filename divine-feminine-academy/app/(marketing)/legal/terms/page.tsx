import type { Metadata } from 'next'
import Link from 'next/link'
import { Eyebrow, Placeholder, Prose, Section } from '@/design-system/patterns'

export const metadata: Metadata = {
  title: 'Terms',
  description: 'The terms you agree to by using the Divine Feminine.',
}

export default function TermsPage() {
  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>Terms</Eyebrow>
      <h1 className="mt-6 text-3xl">Terms of use</h1>

      <Prose className="mt-8">
        <h2 className="mt-8 font-display text-xl">Your account</h2>
        <p>
          Your account is yours alone. Programme access is for one person — the
          one who paid for it.
        </p>

        <h2 className="mt-12 font-display text-xl">Your words belong to you</h2>
        <p>
          Everything you write here stays yours. We claim no ownership of it and
          no right to publish it. If we ever want to quote you, we will ask, and
          the answer can be no.
        </p>

        <h2 className="mt-12 font-display text-xl">Our material belongs to us</h2>
        <p>
          The programmes, exercises and written material are ours. You are
          welcome to use them for your own life; you may not resell them or
          teach them as your own.
        </p>

        <h2 className="mt-12 font-display text-xl">Not therapy</h2>
        <p>
          This is education, not mental health treatment, and no outcome is
          guaranteed.{' '}
          <Link href="/legal/disclaimer" className="underline underline-offset-2">
            The full disclaimer is here
          </Link>{' '}
          and it is the most important page on this site.
        </p>
      </Prose>

      <Placeholder label="Needs a lawyer" note="not legal advice" className="mt-12">
        <Prose className="text-sm">
          <p>
            Missing and required before anyone is charged: refund and
            cancellation terms, payment plan terms including what happens on a
            missed instalment, limitation of liability, governing law, how terms
            change, and grounds for terminating an account.
          </p>
          <p>
            The refund window is also still an open product decision — the
            architecture document has it at fourteen days, unconfirmed.
          </p>
        </Prose>
      </Placeholder>
    </Section>
  )
}
