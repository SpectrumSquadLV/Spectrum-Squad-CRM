import Link from 'next/link'
import { ArticleForm } from '@/features/admin/WritingForms'
import { emptyArticle } from '@/features/admin/article-defaults'

export const metadata = { title: 'Write something' }

export default function NewArticlePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <p className="text-2xs">
        <Link href="/admin/writing" className="underline underline-offset-4 text-ink-muted">
          Writing
        </Link>
      </p>
      <h1 className="mt-4 text-lg font-semibold">Write something</h1>
      <p className="mt-2 max-w-xl text-2xs text-ink-muted">
        It saves as a draft. Nothing is public until you press Publish on the
        list.
      </p>
      <ArticleForm defaults={emptyArticle} />
    </div>
  )
}
