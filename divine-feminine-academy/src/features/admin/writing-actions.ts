'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { db } from '@/db/client'
import { auditLog } from '@/db/schema/activity'
import { articles } from '@/db/schema/content'
import { slugTaken } from '@/db/queries/writing'
import { getActor } from '@/lib/auth/actor-server'
import { isAdmin, type Actor } from '@/lib/permissions/actor'
import { slugify } from '@/features/writing/markdown'
import { modes } from '@/features/quiz/archetypes'

export type WritingState = { ok?: boolean; error?: string }

/**
 * Every action here checks the role itself.
 *
 * The admin layout returning 404 protects the PAGE. A server action is its own
 * endpoint and can be called without ever loading that page, so a layout check
 * would be no protection at all for anything below.
 */
async function requireAdmin(): Promise<Actor | null> {
  const actor = await getActor()
  return isAdmin(actor) ? actor : null
}

async function audit(
  actor: Actor,
  action: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await db.insert(auditLog).values({
    actorUserId: actor.kind === 'user' ? actor.userId : null,
    action,
    entity: 'articles',
    entityId,
    metadata,
  })
}

const optionalText = z
  .string()
  .trim()
  .transform((v) => (v.length > 0 ? v : null))
  .nullable()

const schema = z.object({
  id: z.string().uuid().optional(),
  kind: z.enum(['article', 'episode']),
  title: z.string().trim().min(1, 'It needs a title.').max(200),
  slug: z.string().trim().max(80).optional(),
  dek: optionalText,
  body: z.string().default(''),
  authorName: optionalText,
  heroImageUrl: optionalText,
  heroImageAlt: optionalText,
  area: z
    .string()
    .trim()
    .transform((v) => (v.length > 0 ? v : null))
    .nullable(),
  archetype: z
    .string()
    .trim()
    .transform((v) => (v.length > 0 ? v : null))
    .nullable(),
  audioUrl: optionalText,
  audioDurationSeconds: z
    .string()
    .trim()
    .transform((v) => (v ? Number(v) : null))
    .nullable(),
  audioSizeBytes: z
    .string()
    .trim()
    .transform((v) => (v ? Number(v) : null))
    .nullable(),
  seoTitle: optionalText,
  seoDescription: optionalText,
  upgradeHeadline: optionalText,
  upgradeBlurb: optionalText,
  upgradeTag: optionalText,
  publishedAt: z.string().trim().optional(),
})

const AREAS = new Set(['herself', 'relationships', 'success', 'money'])

function readForm(formData: FormData) {
  return schema.safeParse({
    id: formData.get('id') || undefined,
    kind: formData.get('kind') ?? 'article',
    title: formData.get('title') ?? '',
    slug: formData.get('slug') ?? '',
    dek: formData.get('dek') ?? '',
    body: formData.get('body') ?? '',
    authorName: formData.get('authorName') ?? '',
    heroImageUrl: formData.get('heroImageUrl') ?? '',
    heroImageAlt: formData.get('heroImageAlt') ?? '',
    area: formData.get('area') ?? '',
    archetype: formData.get('archetype') ?? '',
    audioUrl: formData.get('audioUrl') ?? '',
    audioDurationSeconds: formData.get('audioDurationSeconds') ?? '',
    audioSizeBytes: formData.get('audioSizeBytes') ?? '',
    seoTitle: formData.get('seoTitle') ?? '',
    seoDescription: formData.get('seoDescription') ?? '',
    upgradeHeadline: formData.get('upgradeHeadline') ?? '',
    upgradeBlurb: formData.get('upgradeBlurb') ?? '',
    upgradeTag: formData.get('upgradeTag') ?? '',
    publishedAt: formData.get('publishedAt') ?? '',
  })
}

/**
 * Create or update a piece.
 *
 * Saving NEVER publishes. Status is moved only by `setArticleStatus`, so there
 * is no way to accidentally put a half-written draft in front of the world by
 * pressing the wrong button while editing it.
 */
export async function saveArticle(
  _prev: WritingState,
  formData: FormData,
): Promise<WritingState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access.' }

  const parsed = readForm(formData)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the fields.' }
  }
  const input = parsed.data

  const slug = slugify(input.slug?.trim() || input.title)
  if (!slug) return { error: 'That title does not make a usable web address.' }

  if (await slugTaken(db, slug, input.id)) {
    return { error: `The address /writing/${slug} is already taken.` }
  }

  if (input.area && !AREAS.has(input.area)) {
    return { error: 'That is not one of the four areas.' }
  }
  if (input.archetype && !(modes as readonly string[]).includes(input.archetype)) {
    return { error: 'That is not one of the four archetypes.' }
  }
  if (input.kind === 'episode' && !input.audioUrl) {
    return { error: 'An episode needs an audio file to play.' }
  }

  // An explicit date wins; otherwise whatever it already had is kept. A blank
  // box on an already-scheduled piece must not silently unschedule it.
  const publishedAt = input.publishedAt ? new Date(input.publishedAt) : undefined
  if (publishedAt && Number.isNaN(publishedAt.getTime())) {
    return { error: 'That date did not make sense.' }
  }

  const values = {
    kind: input.kind,
    title: input.title,
    slug,
    dek: input.dek,
    body: input.body,
    authorName: input.authorName,
    heroImageUrl: input.heroImageUrl,
    heroImageAlt: input.heroImageAlt,
    area: (input.area ?? null) as 'herself' | 'relationships' | 'success' | 'money' | null,
    archetype: input.archetype,
    audioUrl: input.audioUrl,
    audioDurationSeconds: input.audioDurationSeconds,
    audioSizeBytes: input.audioSizeBytes,
    seoTitle: input.seoTitle,
    seoDescription: input.seoDescription,
    upgradeHeadline: input.upgradeHeadline,
    upgradeBlurb: input.upgradeBlurb,
    upgradeTag: input.upgradeTag,
    ...(publishedAt ? { publishedAt } : {}),
    updatedAt: new Date(),
  }

  let id = input.id ?? null

  if (id) {
    await db.update(articles).set(values).where(eq(articles.id, id))
    await audit(actor, 'article.updated', id, { slug })
  } else {
    const [created] = await db.insert(articles).values(values).returning({ id: articles.id })
    id = created?.id ?? null
    await audit(actor, 'article.created', id, { slug })
  }

  revalidatePath('/writing')
  revalidatePath(`/writing/${slug}`)
  revalidatePath('/admin/writing')

  if (!input.id && id) redirect(`/admin/writing/${id}`)
  return { ok: true }
}

const statusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['draft', 'published', 'archived']),
})

/**
 * Publish, unpublish or archive.
 *
 * Publishing with no date sets it to now. Publishing something that already
 * has a FUTURE date keeps that date, which is what makes scheduling work:
 * "publish" on a piece dated next Tuesday means "let it out on Tuesday", not
 * "let it out this second".
 */
export async function setArticleStatus(
  _prev: WritingState,
  formData: FormData,
): Promise<WritingState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access.' }

  const parsed = statusSchema.safeParse({
    id: formData.get('id'),
    status: formData.get('status'),
  })
  if (!parsed.success) return { error: 'That did not make sense.' }

  const [existing] = await db
    .select({ publishedAt: articles.publishedAt, slug: articles.slug })
    .from(articles)
    .where(eq(articles.id, parsed.data.id))
    .limit(1)
  if (!existing) return { error: 'That piece no longer exists.' }

  const publishedAt =
    parsed.data.status === 'published' && !existing.publishedAt
      ? new Date()
      : existing.publishedAt

  await db
    .update(articles)
    .set({ status: parsed.data.status, publishedAt, updatedAt: new Date() })
    .where(eq(articles.id, parsed.data.id))

  await audit(actor, `article.${parsed.data.status}`, parsed.data.id, {
    slug: existing.slug,
  })

  revalidatePath('/writing')
  revalidatePath(`/writing/${existing.slug}`)
  revalidatePath('/admin/writing')
  return { ok: true }
}
