import type { ArticleRow } from '@/db/queries/writing'
import type { ArticleDefaults } from './WritingForms'

/** A `datetime-local` input wants `YYYY-MM-DDTHH:mm` and nothing else. */
function forDateInput(date: Date | null): string {
  if (!date) return ''
  return date.toISOString().slice(0, 16)
}

export const emptyArticle: ArticleDefaults = {
  kind: 'article',
  title: '',
  slug: '',
  dek: '',
  body: '',
  authorName: '',
  heroImageUrl: '',
  heroImageAlt: '',
  area: '',
  archetype: '',
  audioUrl: '',
  audioDurationSeconds: '',
  audioSizeBytes: '',
  seoTitle: '',
  seoDescription: '',
  upgradeHeadline: '',
  upgradeBlurb: '',
  upgradeTag: '',
  publishedAt: '',
}

export function toDefaults(article: ArticleRow): ArticleDefaults {
  return {
    id: article.id,
    kind: article.kind,
    title: article.title,
    slug: article.slug,
    dek: article.dek ?? '',
    body: article.body,
    authorName: article.authorName ?? '',
    heroImageUrl: article.heroImageUrl ?? '',
    heroImageAlt: article.heroImageAlt ?? '',
    area: article.area ?? '',
    archetype: article.archetype ?? '',
    audioUrl: article.audioUrl ?? '',
    audioDurationSeconds: article.audioDurationSeconds?.toString() ?? '',
    audioSizeBytes: article.audioSizeBytes?.toString() ?? '',
    seoTitle: article.seoTitle ?? '',
    seoDescription: article.seoDescription ?? '',
    upgradeHeadline: article.upgradeHeadline ?? '',
    upgradeBlurb: article.upgradeBlurb ?? '',
    upgradeTag: article.upgradeTag ?? '',
    publishedAt: forDateInput(article.publishedAt),
  }
}
