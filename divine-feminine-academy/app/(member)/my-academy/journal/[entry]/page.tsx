import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Badge, Button } from '@/design-system/primitives'
import type { Area } from '@/design-system/primitives'
import { readBody } from '@/db/queries/journal'
import { CrisisResources } from '@/features/care/CrisisResources'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'

export const metadata = { title: 'Entry', robots: { index: false } }

const isArea = (v: string | null): v is Area =>
  v === 'self' || v === 'love' || v === 'life' || v === 'wealth'

/** One entry, decrypted for her and nobody else. */
export default async function JournalEntryPage({
  params,
}: {
  params: Promise<{ entry: string }>
}) {
  const { entry: entryId } = await params

  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) redirect('/login')

  const ctx = await getQueryContext()
  const entry = await readBody(ctx, entryId)
  if (!entry) notFound()

  return (
    <article className="mx-auto max-w-2xl px-5 py-12 md:px-8 md:py-16">
      <Link href="/my-academy/journal" className="text-2xs text-ink-muted">
        ← Journal
      </Link>

      <header className="mt-6">
        <h1 className="text-2xl">{entry.title ?? 'Untitled'}</h1>
        <div className="mt-3 flex items-center gap-3">
          {isArea(entry.area) && <Badge area={entry.area}>{entry.area}</Badge>}
          <time
            dateTime={entry.createdAt.toISOString()}
            className="text-2xs text-ink-faint"
          >
            {entry.createdAt.toLocaleDateString('en-US', {
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </time>
        </div>
      </header>

      <div className="measure mt-10 whitespace-pre-wrap text-base leading-relaxed text-ink-soft">
        {entry.body}
      </div>

      <CrisisResources className="mt-14" />

      <Button variant="quiet" className="mt-8" asChild>
        <Link href="/my-academy/journal">Back to your journal</Link>
      </Button>
    </article>
  )
}
