import type { Metadata } from 'next'
import Link from 'next/link'
import { Card, CardBody, CardTitle } from '@/design-system/primitives'
import { Eyebrow, Prose, Section } from '@/design-system/patterns'

export const metadata: Metadata = {
  title: 'Programs',
  description: 'Everything on offer at the Divine Feminine.',
}

/**
 * Reads from a hard-coded list for now. Once the admin program builder exists
 * this queries `programs` where status = 'published' and this file barely
 * changes.
 */
const published = [
  {
    href: '/me-vs-her',
    title: 'ME VS HER',
    body: 'Seven days to name her, practise choosing her, and learn the way back. Start here.',
    meta: 'Seven days · Start any time',
  },
  {
    href: '/the-divine-feminine',
    title: 'The Divine Feminine',
    body: 'The deeper work across Self, Love, Life and Wealth, built on everything the seven days gave you.',
    meta: 'Details coming',
  },
]

export default function ProgramsPage() {
  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>Programs</Eyebrow>
      <h1 className="mt-6 text-3xl md:text-4xl">Where to begin</h1>
      <Prose className="mt-8">
        <p>
          There are two things right now, and the order matters. More will
          follow — DIVINE MONEY among them — built from the same practice.
        </p>
      </Prose>

      <div className="mt-12 grid gap-5 md:grid-cols-2">
        {published.map((p) => (
          <Card key={p.href} className="flex flex-col">
            <p className="text-2xs uppercase tracking-[0.16em] text-ink-muted">
              {p.meta}
            </p>
            <CardTitle className="mt-3">{p.title}</CardTitle>
            <CardBody className="flex-1">{p.body}</CardBody>
            <Link
              href={p.href}
              className="mt-6 inline-flex min-h-11 items-center text-xs text-clay-deep underline underline-offset-4"
            >
              Read more
            </Link>
          </Card>
        ))}
      </div>
    </Section>
  )
}
