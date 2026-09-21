import Link from 'next/link'
import { Badge } from '@/design-system/primitives'
import type { Area } from '@/design-system/primitives'
import type { ArticleRow } from '@/db/queries/writing'
import { excerpt, formatDuration, readingMinutes } from './markdown'

const isArea = (v: string | null): v is Area =>
  v === 'herself' || v === 'relationships' || v === 'success' || v === 'money'

export function articleDate(date: Date | null): string {
  if (!date) return ''
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

/** How long it takes, in the unit that suits the medium. */
export function articleLength(article: ArticleRow): string {
  if (article.kind === 'episode') {
    const duration = formatDuration(article.audioDurationSeconds)
    return duration ? `${duration} listen` : 'Episode'
  }
  const minutes = readingMinutes(article.body)
  return minutes > 0 ? `${minutes} min read` : ''
}

export function ArticleCard({ article }: { article: ArticleRow }) {
  const meta = [articleDate(article.publishedAt), articleLength(article)]
    .filter(Boolean)
    .join(' · ')

  return (
    <article className="border-t border-rule pt-8">
      <div className="flex flex-wrap items-center gap-3">
        {article.kind === 'episode' && (
          <span className="rounded-full border border-clay px-2.5 py-0.5 text-2xs uppercase tracking-[0.15em] text-clay-deep">
            Listen
          </span>
        )}
        {isArea(article.area) && <Badge area={article.area}>{article.area}</Badge>}
        {meta && <span className="text-2xs text-ink-muted">{meta}</span>}
      </div>

      <h2 className="mt-4 font-display text-2xl leading-snug md:text-3xl">
        <Link href={`/writing/${article.slug}`} className="hover:text-plum">
          {article.title}
        </Link>
      </h2>

      <p className="mt-3 max-w-2xl text-base leading-relaxed text-ink-soft">
        {article.dek?.trim() || excerpt(article.body)}
      </p>

      <p className="mt-4">
        <Link
          href={`/writing/${article.slug}`}
          className="text-sm underline underline-offset-4 decoration-clay hover:decoration-plum"
        >
          {article.kind === 'episode' ? 'Listen' : 'Read it'}
        </Link>
      </p>
    </article>
  )
}
