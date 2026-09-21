import 'server-only'

import { and, desc, eq, lte, ne, or, sql } from 'drizzle-orm'
import { articles } from '../schema/content'
import type { QueryContext } from './_context'

/**
 * Published means published.
 *
 * Status alone is not enough: a row marked published with a date in the future
 * is SCHEDULED, and must not appear anywhere public until that moment. Every
 * public read goes through this one predicate so there is no second definition
 * that can disagree with it — the bug where a post shows on the index a week
 * before its own page works is exactly what two definitions produce.
 */
const isLive = (now: Date) =>
  and(eq(articles.status, 'published'), lte(articles.publishedAt, now))

export type ArticleRow = typeof articles.$inferSelect

export async function listPublished(
  db: QueryContext['db'],
  options: { kind?: 'article' | 'episode'; limit?: number; offset?: number; now?: Date } = {},
): Promise<ArticleRow[]> {
  const now = options.now ?? new Date()
  const where = options.kind
    ? and(isLive(now), eq(articles.kind, options.kind))
    : isLive(now)

  return db
    .select()
    .from(articles)
    .where(where)
    .orderBy(desc(articles.publishedAt))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0)
}

export async function countPublished(
  db: QueryContext['db'],
  options: { kind?: 'article' | 'episode'; now?: Date } = {},
): Promise<number> {
  const now = options.now ?? new Date()
  const where = options.kind
    ? and(isLive(now), eq(articles.kind, options.kind))
    : isLive(now)

  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(articles)
    .where(where)
  return row?.n ?? 0
}

export async function getPublishedArticle(
  db: QueryContext['db'],
  slug: string,
  now = new Date(),
): Promise<ArticleRow | null> {
  const [row] = await db
    .select()
    .from(articles)
    .where(and(eq(articles.slug, slug), isLive(now)))
    .limit(1)
  return row ?? null
}

/**
 * What to read next.
 *
 * Same area first, because a woman who just read about money is most likely to
 * want the other one about money. Falls back to whatever is newest, so this
 * never returns nothing on a site with two posts.
 */
export async function relatedArticles(
  db: QueryContext['db'],
  to: ArticleRow,
  limit = 3,
  now = new Date(),
): Promise<ArticleRow[]> {
  const sameArea = to.area
    ? await db
        .select()
        .from(articles)
        .where(and(isLive(now), ne(articles.id, to.id), eq(articles.area, to.area)))
        .orderBy(desc(articles.publishedAt))
        .limit(limit)
    : []

  if (sameArea.length >= limit) return sameArea

  const seen = new Set([to.id, ...sameArea.map((a) => a.id)])
  const rest = await db
    .select()
    .from(articles)
    .where(and(isLive(now), ne(articles.id, to.id)))
    .orderBy(desc(articles.publishedAt))
    .limit(limit + seen.size)

  return [...sameArea, ...rest.filter((a) => !seen.has(a.id))].slice(0, limit)
}

/** Everything, drafts included. For the admin only. */
export async function listAllArticles(
  db: QueryContext['db'],
): Promise<ArticleRow[]> {
  return db
    .select()
    .from(articles)
    .orderBy(desc(sql`coalesce(${articles.publishedAt}, ${articles.createdAt})`))
}

export async function getArticleById(
  db: QueryContext['db'],
  id: string,
): Promise<ArticleRow | null> {
  const [row] = await db.select().from(articles).where(eq(articles.id, id)).limit(1)
  return row ?? null
}

/** Slugs for the sitemap. Published only — never a draft, never a future post. */
export async function listPublishedSlugs(
  db: QueryContext['db'],
  now = new Date(),
  kind?: 'article' | 'episode',
): Promise<{ slug: string; updatedAt: Date }[]> {
  const rows = await db
    .select({ slug: articles.slug, updatedAt: articles.updatedAt })
    .from(articles)
    .where(kind ? and(isLive(now), eq(articles.kind, kind)) : isLive(now))
    .orderBy(desc(articles.publishedAt))
  return rows
}

/** True when a slug is taken by somebody other than `exceptId`. */
export async function slugTaken(
  db: QueryContext['db'],
  slug: string,
  exceptId?: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: articles.id })
    .from(articles)
    .where(
      exceptId
        ? and(eq(articles.slug, slug), ne(articles.id, exceptId))
        : eq(articles.slug, slug),
    )
    .limit(1)
  return Boolean(row)
}

export { isLive as publishedPredicate, or }
