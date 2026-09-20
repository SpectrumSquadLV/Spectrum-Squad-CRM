import Link from 'next/link'
import { Button } from '@/design-system/primitives'
import { Eyebrow, Prose, Section } from '@/design-system/patterns'

export const metadata = {
  title: 'Nothing was charged',
  robots: { index: false, follow: false },
}

export default function CheckoutCancelledPage() {
  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>Cancelled</Eyebrow>
      <h1 className="mt-6 text-3xl">Nothing was charged.</h1>
      <Prose className="mt-6 text-lg">
        <p>
          You stopped before paying, which is completely fine. Nothing left your
          account and nothing changed.
        </p>
        <p>The door stays open.</p>
      </Prose>
      <div className="mt-10 flex flex-wrap gap-4">
        <Button size="lg" variant="secondary" asChild>
          <Link href="/academy">Back to the Academy</Link>
        </Button>
        <Button size="lg" asChild>
          <Link href="/7-days-to-her">Start the free seven days</Link>
        </Button>
      </div>
    </Section>
  )
}
