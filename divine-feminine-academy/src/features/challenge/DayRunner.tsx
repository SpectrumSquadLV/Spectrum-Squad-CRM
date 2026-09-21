'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { Button, Rule } from '@/design-system/primitives'
import type { HerEvidence } from '@/blocks/contract'
import { cn } from '@/lib/utils/cn'
import { completeDay, saveBlockResponse } from './actions'
import { BlockRenderer } from './BlockRenderer'

export interface RunnerBlock {
  id: string
  type: string
  config: unknown
  isRequired: boolean
  /** Null for display-only blocks, which cannot be answered. */
  takesAnswer: boolean
}

/**
 * The day experience.
 *
 * One screen at a time, with a quiet sense of progress. Not a progress bar
 * with a percentage: the point is the next step, not the completion rate.
 *
 * Answers save when she moves on rather than on every keystroke - a woman
 * writing about her childhood does not need a network request per character.
 */
export function DayRunner({
  programSlug,
  dayNumber,
  dayTitle,
  daySubtitle,
  totalDays,
  blocks,
  initialResponses,
  evidence,
  alreadyComplete,
}: {
  programSlug: string
  dayNumber: number
  dayTitle: string
  daySubtitle: string | null
  totalDays: number
  blocks: RunnerBlock[]
  initialResponses: Record<string, unknown>
  evidence?: HerEvidence
  alreadyComplete: boolean
}) {
  const router = useRouter()
  const [index, setIndex] = useState(0)
  const [responses, setResponses] = useState<Record<string, unknown>>(initialResponses)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pending, startTransition] = useTransition()

  const dirty = useRef<Set<string>>(new Set())
  const block = blocks[index]
  const isLast = index === blocks.length - 1

  const setValue = useCallback((blockId: string, value: unknown) => {
    setResponses((prev) => ({ ...prev, [blockId]: value }))
    dirty.current.add(blockId)
  }, [])

  // Warn before losing unsaved writing to a closed tab.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty.current.size > 0) e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  const saveDirty = useCallback(async () => {
    const ids = [...dirty.current]
    if (ids.length === 0) return true
    setSaving(true)
    try {
      for (const id of ids) {
        const result = await saveBlockResponse(id, responses[id])
        if (result.error) {
          setError(result.error)
          return false
        }
        dirty.current.delete(id)
      }
      return true
    } finally {
      setSaving(false)
    }
  }, [responses])

  async function goNext() {
    setError(null)

    if (block?.isRequired && block.takesAnswer && !responses[block.id]) {
      setError('This one is worth doing before you move on.')
      return
    }

    if (!(await saveDirty())) return

    if (!isLast) {
      setIndex((i) => i + 1)
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }

    startTransition(async () => {
      const result = await completeDay(programSlug, dayNumber)
      if (result.error) {
        setError(result.error)
        return
      }
      router.push(`/my-practice/${programSlug}/day/${dayNumber}/done`)
    })
  }

  async function goBack() {
    setError(null)
    await saveDirty()
    setIndex((i) => Math.max(0, i - 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (!block) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-16 md:px-8">
        <p className="text-sm text-ink-muted">This day has no content yet.</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-5 py-8 md:px-8 md:py-14">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <p className="text-2xs uppercase tracking-[0.22em] text-clay-deep">
            Day {dayNumber} of {totalDays}
          </p>
          <h1 className="mt-2 font-display text-2xl">{dayTitle}</h1>
          {daySubtitle && (
            <p className="mt-1 text-xs text-ink-muted">{daySubtitle}</p>
          )}
        </div>
        <Link
          href="/my-practice"
          className="shrink-0 text-2xs text-ink-muted hover:text-ink"
        >
          Save and leave
        </Link>
      </div>

      {/* A sense of progress, not a percentage. */}
      <ol className="mt-6 flex gap-1.5" aria-label="Steps in this day">
        {blocks.map((b, i) => (
          <li
            key={b.id}
            aria-current={i === index ? 'step' : undefined}
            className={cn(
              'h-0.5 flex-1 rounded-full transition-colors',
              i < index && 'bg-clay',
              i === index && 'bg-plum',
              i > index && 'bg-rule',
            )}
          />
        ))}
      </ol>

      <div className="mt-12">
        <BlockRenderer
          key={block.id}
          blockId={block.id}
          type={block.type}
          config={block.config}
          value={responses[block.id]}
          onChange={(v) => setValue(block.id, v)}
          disabled={saving || pending}
          context={evidence}
        />
      </div>

      {error && (
        <p role="alert" className="mt-8 text-xs text-critical">
          {error}
        </p>
      )}

      <Rule className="mt-12" />

      <div className="mt-6 flex items-center justify-between gap-4">
        <Button
          type="button"
          variant="quiet"
          onClick={goBack}
          disabled={index === 0 || saving || pending}
        >
          Back
        </Button>

        <Button type="button" size="lg" onClick={goNext} disabled={saving || pending}>
          {saving || pending
            ? 'Saving…'
            : isLast
              ? alreadyComplete
                ? 'Done'
                : 'Finish the day'
              : 'Next'}
        </Button>
      </div>

      <p className="mt-6 text-center text-2xs text-ink-faint">
        Your answers save as you move through.
      </p>
    </div>
  )
}
