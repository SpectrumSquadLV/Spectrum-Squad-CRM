import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { Button } from '@/design-system/primitives'
import { getSharedHerCode } from '@/db/queries/her'
import { HerCodeDocument, parseSections } from '@/features/her/HerCodeDocument'

export const metadata: Metadata = {
  title: 'A HER Code',
  description: 'Written at the Divine Feminine.',
}

/**
 * A shared HER Code.
 *
 * Public by design - this is the growth loop. The query behind it returns only
 * the card's own contents: no name unless she put one there, no email, no
 * journal, nothing else about her.
 */
export default async function SharedHerCodePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const code = await getSharedHerCode(db, token)
  if (!code) notFound()

  const sections = parseSections(code.sections)

  return (
    <main className="mx-auto min-h-screen max-w-xl px-5 py-14 md:py-20">
      <HerCodeDocument
        sections={sections}
        dateLabel={(code.finalizedAt ?? code.createdAt).toLocaleDateString('en-US', {
          month: 'long',
          year: 'numeric',
        })}
      />

      <div className="mt-12 text-center">
        <p className="text-xs text-ink-muted">
          Written in seven days at the Divine Feminine.
        </p>
        <Button className="mt-5" asChild>
          <Link href="/me-vs-her">Write your own</Link>
        </Button>
      </div>
    </main>
  )
}
