import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { getArticleById } from '@/db/queries/writing'
import { ArticleForm, StatusButton } from '@/features/admin/WritingForms'
import { toDefaults } from '@/features/admin/article-defaults'

export const metadata = { title: 'Edit' }

export default async function EditArticlePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const article = await getArticleById(db, id)
  if (!article) notFound()

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <p className="text-2xs">
        <Link href="/admin/writing" className="underline underline-offset-4 text-ink-muted">
          Writing
        </Link>
      </p>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-lg font-semibold">{article.title}</h1>
        <div className="flex items-center gap-3">
          {article.status !== 'published' ? (
            <StatusButton articleId={article.id} status="published" label="Publish" />
          ) : (
            <StatusButton articleId={article.id} status="draft" label="Unpublish" />
          )}
          {article.status === 'published' && (
            <Link
              href={`/writing/${article.slug}`}
              className="text-2xs underline underline-offset-4 text-ink-muted"
            >
              View
            </Link>
          )}
        </div>
      </div>

      <ArticleForm defaults={toDefaults(article)} />
    </div>
  )
}
