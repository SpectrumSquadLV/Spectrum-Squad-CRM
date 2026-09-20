import type { Metadata } from 'next'
import Link from 'next/link'
import { Eyebrow, Placeholder, Prose, Section } from '@/design-system/patterns'

export const metadata: Metadata = {
  title: 'Privacy',
  description:
    'What we collect, what we can see, and what we deliberately cannot.',
}

export default function PrivacyPage() {
  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>Privacy</Eyebrow>
      <h1 className="mt-6 text-3xl">What we can see, and what we cannot</h1>

      <Prose className="mt-8">
        <p>
          Most privacy policies describe who gets to look at your data. This one
          mostly describes what we built so that we cannot.
        </p>

        <h2 className="mt-12 font-display text-xl">Your journal is encrypted</h2>
        <p>
          Journal entries are encrypted in our application before they are
          written to the database, using a key belonging only to your account.
          Somebody with full access to the database sees unreadable text.
        </p>
        <p>
          That includes our developers, anyone doing support, and the founder of
          this business. It is not a policy that could be changed by someone
          deciding to look — the words are not there to read.
        </p>

        <h2 className="mt-12 font-display text-xl">What we can see</h2>
        <p>
          Engagement, not content: that you wrote an entry, when, roughly how
          long it was, and which area it belonged to. Enough to know whether the
          programme is working. Nothing about what you said.
        </p>
        <p>
          We also hold the things you would expect — your name and email, your
          timezone, which programmes you are in, how far through you are, and
          your purchases.
        </p>

        <h2 className="mt-12 font-display text-xl">Sharing, if you choose it</h2>
        <p>
          You can share a specific entry with a coach. That is the only way
          anyone else reads one. You can revoke it at any time, and every time a
          shared entry is opened we record who opened it and when.
        </p>

        <h2 className="mt-12 font-display text-xl">Deleting your account</h2>
        <p>
          When you delete your account we destroy your encryption key. Every
          entry you ever wrote becomes permanently unreadable — by us, by
          anyone, forever. There is no recovery, which is the point.
        </p>

        <h2 className="mt-12 font-display text-xl">Payments</h2>
        <p>
          Card details are handled by Stripe and never touch our servers. We
          keep a record of what you bought and what you paid.
        </p>

        <h2 className="mt-12 font-display text-xl">Email</h2>
        <p>
          We send you the emails the programme needs — your sign-in links, your
          daily prompts, and receipts. You can turn the non-essential ones off
          in your account. We do not sell your email address to anybody, ever.
        </p>
      </Prose>

      <Placeholder label="Needs a lawyer" note="not legal advice" className="mt-12">
        <Prose className="text-sm">
          <p>
            This describes what the system actually does, accurately. It is not
            yet a compliant privacy policy: before launch it needs a data
            controller named, a retention schedule, the legal bases and rights
            that apply in your jurisdiction, a sub-processor list, and a contact
            address for data requests.
          </p>
        </Prose>
      </Placeholder>

      <Prose className="mt-12 text-sm">
        <p>
          See also:{' '}
          <Link href="/legal/disclaimer" className="underline underline-offset-2">
            this is education, not therapy
          </Link>
          .
        </p>
      </Prose>
    </Section>
  )
}
