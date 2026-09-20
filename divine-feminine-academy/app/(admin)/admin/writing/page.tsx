import Link from 'next/link'
import { db } from '@/db/client'
import { listAllArticles } from '@/db/queries/writing'
import { Button } from '@/design-system/primitives'
import { StatusButton } from '@/features/admin/WritingForms'
import { articleDate, articleLength } from '@/features/writing/ArticleCard'

export const metadata = { title: 'Writing' }

const statusTone: Record<string, string> = {
  draft: 'border-rule-strong text-ink-muted',
  published: 'border-clay text-clay-deep',
  archived: 'border-rule text-ink-faint',
}

export default async function AdminWritingPage() {
  const pieces = await listAllArticles(db)
  const now = new Date()

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Writing</h1>
          <p className="mt-2 max-w-xl text-2xs text-ink-muted">
            Essays and episodes. A draft is invisible on the site. A published
            piece dated in the future goes live by itself when that day comes.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/admin/writing/new">Write something</Link>
        </Button>
      </div>

      {pieces.length === 0 ? (
        <p className="mt-10 text-2xs text-ink-muted">
          Nothing yet. The first one is the hard one.
        </p>
      ) : (
        <ul className="mt-10 divide-y divide-rule border-y border-rule">
          {pieces.map((piece) => {
            const scheduled =
              piece.status === 'published' &&
              piece.publishedAt !== null &&
              piece.publishedAt > now

            return (
              <li key={piece.id} className="flex flex-wrap items-center gap-4 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-2xs uppercase tracking-[0.12em] ${statusTone[piece.status] ?? ''}`}
                    >
                      {scheduled ? 'scheduled' : piece.status}
                    </span>
                    {piece.kind === 'episode' && (
                      <span className="text-2xs uppercase tracking-[0.12em] text-clay-deep">
                        episode
                      </span>
                    )}
                    {piece.announcedAt && (
                      <span className="text-2xs text-ink-faint">announced</span>
                    )}
                  </div>
                  <p className="mt-1.5 truncate text-sm">
                    <Link href={`/admin/writing/${piece.id}`} className="hover:underline">
                      {piece.title}
                    </Link>
                  </p>
                  <p className="mt-0.5 text-2xs text-ink-faint">
                    /writing/{piece.slug}
                    {piece.publishedAt ? ` · ${articleDate(piece.publishedAt)}` : ''}
                    {` · ${articleLength(piece)}`}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {piece.status !== 'published' ? (
                    <StatusButton articleId={piece.id} status="published" label="Publish" />
                  ) : (
                    <StatusButton articleId={piece.id} status="draft" label="Unpublish" />
                  )}
                  {piece.status === 'published' && !scheduled && (
                    <Link
                      href={`/writing/${piece.slug}`}
                      className="text-2xs underline underline-offset-4 text-ink-muted"
                    >
                      View
                    </Link>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
