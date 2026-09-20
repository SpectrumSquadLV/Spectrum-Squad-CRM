'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Field, Input, Textarea } from '@/design-system/primitives'
import { Markdown } from '@/features/writing/Markdown'
import { readingMinutes, slugify } from '@/features/writing/markdown'
import {
  saveArticle,
  setArticleStatus,
  type WritingState,
} from './writing-actions'

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  )
}

const selectClass =
  'min-h-11 w-full rounded-md border border-rule-strong bg-alabaster px-3 text-sm text-ink'

export interface ArticleDefaults {
  id?: string
  kind: 'article' | 'episode'
  title: string
  slug: string
  dek: string
  body: string
  authorName: string
  heroImageUrl: string
  heroImageAlt: string
  area: string
  archetype: string
  audioUrl: string
  audioDurationSeconds: string
  audioSizeBytes: string
  seoTitle: string
  seoDescription: string
  upgradeHeadline: string
  upgradeBlurb: string
  upgradeTag: string
  publishedAt: string
}

/**
 * Writing a piece.
 *
 * The preview is live and it uses the SAME renderer the public page uses, not
 * an approximation of it. A preview that is merely similar is worse than none:
 * it teaches you to trust something that is not what your readers will get.
 */
export function ArticleForm({ defaults }: { defaults: ArticleDefaults }) {
  const [state, formAction] = useActionState<WritingState, FormData>(
    saveArticle,
    {},
  )
  const [kind, setKind] = useState(defaults.kind)
  const [title, setTitle] = useState(defaults.title)
  const [slug, setSlug] = useState(defaults.slug)
  const [body, setBody] = useState(defaults.body)
  const [preview, setPreview] = useState(false)

  const effectiveSlug = slugify(slug || title)

  return (
    <form action={formAction} className="mt-8 grid gap-8 lg:grid-cols-[1fr_320px]">
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}

      <div className="flex flex-col gap-5">
        <Field label="Title" htmlFor="title">
          <Input
            id="title"
            name="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </Field>

        <Field label="Standfirst — one or two sentences under the headline" htmlFor="dek">
          <Textarea id="dek" name="dek" rows={2} defaultValue={defaults.dek} />
        </Field>

        <div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-2xs uppercase tracking-[0.15em] text-ink-muted">
              Body
            </span>
            <div className="flex items-center gap-3 text-2xs text-ink-muted">
              <span>{readingMinutes(body)} min read</span>
              <button
                type="button"
                onClick={() => setPreview((p) => !p)}
                className="underline underline-offset-4"
              >
                {preview ? 'Write' : 'Preview'}
              </button>
            </div>
          </div>

          {preview ? (
            <div className="mt-2 min-h-[24rem] rounded-md border border-rule-strong bg-alabaster p-5">
              <Markdown source={body} />
            </div>
          ) : (
            <Textarea
              id="body"
              name="body"
              rows={26}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="mt-2 font-mono text-xs"
            />
          )}

          {preview && <input type="hidden" name="body" value={body} />}

          <p className="mt-2 text-2xs text-ink-faint">
            Markdown: <code>##</code> for a heading, <code>-</code> for a list,{' '}
            <code>&gt;</code> for a quote, <code>**bold**</code>,{' '}
            <code>[words](https://link)</code>. No raw HTML — it is ignored on
            purpose.
          </p>
        </div>
      </div>

      <aside className="flex flex-col gap-5">
        <Field label="Kind" htmlFor="kind">
          <select
            id="kind"
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as 'article' | 'episode')}
            className={selectClass}
          >
            <option value="article">Article</option>
            <option value="episode">Episode</option>
          </select>
        </Field>

        <Field label="Web address" htmlFor="slug">
          <Input
            id="slug"
            name="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder={slugify(title)}
          />
        </Field>
        <p className="-mt-3 text-2xs text-ink-faint">
          /writing/{effectiveSlug || '…'}
        </p>

        <Field label="By" htmlFor="authorName">
          <Input id="authorName" name="authorName" defaultValue={defaults.authorName} />
        </Field>

        <Field label="Publish date — a future date schedules it" htmlFor="publishedAt">
          <Input
            id="publishedAt"
            name="publishedAt"
            type="datetime-local"
            defaultValue={defaults.publishedAt}
          />
        </Field>

        <Field label="Area" htmlFor="area">
          <select id="area" name="area" defaultValue={defaults.area} className={selectClass}>
            <option value="">None</option>
            <option value="self">Self</option>
            <option value="love">Love</option>
            <option value="life">Life</option>
            <option value="wealth">Wealth</option>
          </select>
        </Field>

        <Field label="Archetype — subscribers get that sequence" htmlFor="archetype">
          <select
            id="archetype"
            name="archetype"
            defaultValue={defaults.archetype}
            className={selectClass}
          >
            <option value="">None</option>
            <option value="fight">The Commander (fight)</option>
            <option value="flight">The Escape Artist (flight)</option>
            <option value="freeze">The Watcher (freeze)</option>
            <option value="sulk">The Quiet Storm (sulk)</option>
          </select>
        </Field>

        {kind === 'episode' && (
          <>
            <Field label="Audio file URL" htmlFor="audioUrl">
              <Input id="audioUrl" name="audioUrl" defaultValue={defaults.audioUrl} />
            </Field>
            <Field label="Length in seconds" htmlFor="audioDurationSeconds">
              <Input
                id="audioDurationSeconds"
                name="audioDurationSeconds"
                inputMode="numeric"
                defaultValue={defaults.audioDurationSeconds}
              />
            </Field>
            <Field label="File size in bytes — podcast apps want it" htmlFor="audioSizeBytes">
              <Input
                id="audioSizeBytes"
                name="audioSizeBytes"
                inputMode="numeric"
                defaultValue={defaults.audioSizeBytes}
              />
            </Field>
          </>
        )}

        {kind !== 'episode' && (
          <>
            <input type="hidden" name="audioUrl" value="" />
            <input type="hidden" name="audioDurationSeconds" value="" />
            <input type="hidden" name="audioSizeBytes" value="" />
          </>
        )}

        <Field label="Hero image URL" htmlFor="heroImageUrl">
          <Input id="heroImageUrl" name="heroImageUrl" defaultValue={defaults.heroImageUrl} />
        </Field>
        <Field label="What the image shows" htmlFor="heroImageAlt">
          <Input id="heroImageAlt" name="heroImageAlt" defaultValue={defaults.heroImageAlt} />
        </Field>

        <div className="rounded-lg border border-rule bg-alabaster p-4">
          <p className="text-2xs uppercase tracking-[0.15em] text-clay-deep">
            The opt-in
          </p>
          <p className="mt-2 text-2xs text-ink-muted">
            What appears at the bottom. Leave it blank for the default.
          </p>
          <div className="mt-4 flex flex-col gap-4">
            <Field label="Headline" htmlFor="upgradeHeadline">
              <Input
                id="upgradeHeadline"
                name="upgradeHeadline"
                defaultValue={defaults.upgradeHeadline}
              />
            </Field>
            <Field label="The line under it" htmlFor="upgradeBlurb">
              <Textarea
                id="upgradeBlurb"
                name="upgradeBlurb"
                rows={3}
                defaultValue={defaults.upgradeBlurb}
              />
            </Field>
            <Field label="Tag her with" htmlFor="upgradeTag">
              <Input id="upgradeTag" name="upgradeTag" defaultValue={defaults.upgradeTag} />
            </Field>
          </div>
        </div>

        <details className="rounded-lg border border-rule bg-alabaster p-4">
          <summary className="cursor-pointer text-2xs uppercase tracking-[0.15em] text-clay-deep">
            Search engines
          </summary>
          <div className="mt-4 flex flex-col gap-4">
            <Field label="Title in search results" htmlFor="seoTitle">
              <Input id="seoTitle" name="seoTitle" defaultValue={defaults.seoTitle} />
            </Field>
            <Field label="Description in search results" htmlFor="seoDescription">
              <Textarea
                id="seoDescription"
                name="seoDescription"
                rows={3}
                defaultValue={defaults.seoDescription}
              />
            </Field>
          </div>
        </details>

        {state.error && (
          <p role="alert" className="text-2xs text-critical">
            {state.error}
          </p>
        )}
        {state.ok && <p className="text-2xs text-ink-muted">Saved.</p>}

        <div className="flex items-center gap-3">
          <Submit label="Save" />
          <span className="text-2xs text-ink-faint">Saving never publishes.</span>
        </div>
      </aside>
    </form>
  )
}

export function StatusButton({
  articleId,
  status,
  label,
}: {
  articleId: string
  status: 'draft' | 'published' | 'archived'
  label: string
}) {
  const [state, formAction] = useActionState<WritingState, FormData>(
    setArticleStatus,
    {},
  )

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="id" value={articleId} />
      <input type="hidden" name="status" value={status} />
      <Submit label={label} />
      {state.error && (
        <span role="alert" className="ml-2 text-2xs text-critical">
          {state.error}
        </span>
      )}
    </form>
  )
}
