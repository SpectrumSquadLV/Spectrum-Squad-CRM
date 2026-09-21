import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, permanentRedirect } from 'next/navigation'
import { db } from '@/db/client'
import { Badge, Rule } from '@/design-system/primitives'
import type { Area } from '@/design-system/primitives'
import { Section } from '@/design-system/patterns'
import { getPublishedArticle, relatedArticles } from '@/db/queries/writing'
import { ArticleCard, articleDate, articleLength } from '@/features/writing/ArticleCard'
import { Markdown } from '@/features/writing/Markdown'
import { WritingOptIn } from '@/features/writing/WritingOptIn'
import { excerpt } from '@/features/writing/markdown'
import { siteUrl } from '@/lib/auth/env'

export const dynamic = 'force-dynamic'

const isArea = (v: string | null): v is Area =>
  v === 'herself' || v === 'relationships' || v === 'success' || v === 'money'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const article = await getPublishedArticle(db, slug)
  if (!article) return { title: 'Not found' }

  const title = article.seoTitle?.trim() || article.title
  const description =
    article.seoDescription?.trim() || article.dek?.trim() || excerpt(article.body)

  return {
    title,
    description,
    alternates: { canonical: `${siteUrl().replace(/\/$/, '')}/writing/${article.slug}` },
    openGraph: {
      type: 'article',
      title,
      description,
      publishedTime: article.publishedAt?.toISOString(),
      ...(article.heroImageUrl ? { images: [article.heroImageUrl] } : {}),
    },
    twitter: { card: 'summary_large_image', title, description },
  }
}

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const article = await getPublishedArticle(db, slug)
  if (!article) notFound()

  /*
   * An episode has ONE canonical URL, and it is under /podcast.
   *
   * Episodes lived here before the podcast had a section of its own, so links
   * to /writing/<slug> are already out in the world - in show notes, in the
   * archive, in somebody's saved tabs. A permanent redirect keeps every one of
   * them working and tells a search engine which of the two addresses counts,
   * rather than leaving the same episode indexed twice.
   */
  if (article.kind === 'episode') permanentRedirect(`/podcast/${article.slug}`)

  const related = await relatedArticles(db, article)
  const base = siteUrl().replace(/\/$/, '')
  const description =
    article.seoDescription?.trim() || article.dek?.trim() || excerpt(article.body)

  /*
   * Structured data.
   *
   * This is what makes a search result show a date and an author instead of a
   * grey line of text, and it is the cheapest thing on this page. It is built
   * from the same fields the page renders, so it cannot describe something the
   * reader is not actually being shown.
   */
  const jsonLd = {
    '@context': 'https://schema.org',
    // Always an Article: an episode never renders here any more, it is
    // permanently redirected to /podcast/<slug> above, which marks itself up
    // as a PodcastEpisode.
    '@type': 'Article',
    headline: article.title,
    description,
    datePublished: article.publishedAt?.toISOString(),
    dateModified: article.updatedAt.toISOString(),
    author: article.authorName
      ? { '@type': 'Person', name: article.authorName }
      : undefined,
    publisher: { '@type': 'Organization', name: 'Divine Feminine' },
    mainEntityOfPage: `${base}/writing/${article.slug}`,
    ...(article.heroImageUrl ? { image: article.heroImageUrl } : {}),
  }

  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <script
        type="application/ld+json"
        // Serialised JSON, not markup: the only values in it come from the
        // fields above, and `<` is escaped so a title can never close the tag.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
        }}
      />

      <p className="text-2xs">
        <Link
          href="/writing"
          className="uppercase tracking-[0.2em] text-clay-deep underline underline-offset-4"
        >
          Writing
        </Link>
      </p>

      <h1 className="mt-6 text-3xl md:text-5xl">{article.title}</h1>

      {article.dek && (
        <p className="mt-5 max-w-2xl font-display text-xl leading-snug text-clay-deep">
          {article.dek}
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3 text-2xs text-ink-muted">
        {isArea(article.area) && <Badge area={article.area}>{article.area}</Badge>}
        {article.authorName && <span>{article.authorName}</span>}
        <span>{articleDate(article.publishedAt)}</span>
        <span>{articleLength(article)}</span>
      </div>

      {article.heroImageUrl && (
        <figure className="mt-10">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={article.heroImageUrl}
            alt={article.heroImageAlt ?? ''}
            className="w-full rounded-xl border border-rule"
          />
        </figure>
      )}

      <Rule tone="gilt" className="my-12" />

      <Markdown source={article.body} />

      <div className="mt-20">
        <WritingOptIn
          slug={article.slug}
          headline={article.upgradeHeadline?.trim() || 'Get the next one'}
          blurb={
            article.upgradeBlurb?.trim() ||
            'No schedule I am going to pretend to keep. When something is written, you get it.'
          }
        />
      </div>

      {related.length > 0 && (
        <section className="mt-24">
          <h2 className="font-display text-xl">Next</h2>
          <div className="mt-8 space-y-12">
            {related.map((piece) => (
              <ArticleCard key={piece.id} article={piece} />
            ))}
          </div>
        </section>
      )}
    </Section>
  )
}
