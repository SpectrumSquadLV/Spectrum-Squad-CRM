import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Badge, Card, CardBody, CardTitle, Rule } from '@/design-system/primitives'
import type { Area } from '@/design-system/primitives'
import { Eyebrow, Prose } from '@/design-system/patterns'
import { listMetadata } from '@/db/queries/journal'
import { journalSummary } from '@/db/queries/her'
import { JournalComposer } from '@/features/journal/JournalComposer'
import { getActor, getQueryContext } from '@/lib/auth/actor-server'

export const metadata: Metadata = { title: 'Journal' }

const isArea = (v: string | null): v is Area =>
  v === 'self' || v === 'love' || v === 'life' || v === 'wealth'

/**
 * Her journal.
 *
 * The list shows titles and dates only - the bodies are ciphertext and are
 * decrypted one at a time, for her, when she opens one. Nothing on this page
 * asks the database for words it does not need.
 */
export default async function JournalPage() {
  const actor = await getActor()
  if (actor.kind !== 'user' || !actor.contactId) redirect('/login')

  const ctx = await getQueryContext()
  const [entries, summary] = await Promise.all([
    listMetadata(ctx, actor.contactId),
    journalSummary(ctx, actor.contactId),
  ])

  return (
    <div className="mx-auto max-w-3xl px-5 py-12 md:px-8 md:py-16">
      <Eyebrow>Journal</Eyebrow>
      <h1 className="mt-4 text-3xl">Your words</h1>
      <Prose className="mt-4 text-sm">
        <p>
          Encrypted before they reach our database. Nobody who works here can
          read them — that includes the woman who built this.
        </p>
      </Prose>

      <JournalComposer className="mt-10" />

      <Rule tone="gilt" className="my-14" />

      {entries.length === 0 ? (
        <Card tone="sunken">
          <CardTitle className="text-lg">Nothing written yet</CardTitle>
          <CardBody className="text-xs">
            Anything you write in the challenge lands here too.
          </CardBody>
        </Card>
      ) : (
        <>
          <p className="text-xs text-ink-muted">
            {summary.entries} entr{summary.entries === 1 ? 'y' : 'ies'} ·{' '}
            {summary.words.toLocaleString()} words
          </p>
          <ul className="mt-6 divide-y divide-rule border-y border-rule">
            {entries.map((e) => (
              <li key={e.id}>
                <a
                  href={`/my-practice/journal/${e.id}`}
                  className="flex min-h-16 flex-col justify-center gap-1 py-4"
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="text-sm text-ink">
                      {e.title ?? 'Untitled'}
                    </span>
                    <time
                      dateTime={e.createdAt.toISOString()}
                      className="shrink-0 text-2xs text-ink-faint"
                    >
                      {e.createdAt.toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </time>
                  </div>
                  <div className="flex items-center gap-3">
                    {isArea(e.area) && <Badge area={e.area}>{e.area}</Badge>}
                    <span className="text-2xs text-ink-muted">
                      {e.wordCount} words
                    </span>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
