'use server'

import { db } from '@/db/client'
import { getPublishedArticle } from '@/db/queries/writing'
import { subscribeFromArticle, upgradeInput } from './subscribe'

export type UpgradeState = { error?: string; done?: boolean; sequence?: boolean }

export async function subscribeFromWriting(
  _prev: UpgradeState,
  formData: FormData,
): Promise<UpgradeState> {
  const parsed = upgradeInput.safeParse({
    slug: formData.get('slug'),
    firstName: formData.get('firstName'),
    email: formData.get('email'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the fields.' }
  }

  /*
   * The article is re-read here rather than trusted from the form.
   *
   * Its tag and its archetype decide what she is signed up for, and a hidden
   * field naming either of those would let a crafted request put anybody into
   * any sequence.
   *
   * No slug means she subscribed from the index, which is a plain letters
   * subscription with no article behind it.
   */
  const article = parsed.data.slug
    ? await getPublishedArticle(db, parsed.data.slug)
    : null

  if (parsed.data.slug && !article) {
    return { error: 'That piece is not published.' }
  }

  const outcome = await subscribeFromArticle({
    data: parsed.data,
    articleId: article?.id ?? null,
    upgradeTag: article?.upgradeTag ?? null,
    archetype: article?.archetype ?? null,
  })

  if (!outcome.ok) return { error: outcome.error }
  return { done: true, sequence: outcome.joinedSequence }
}
