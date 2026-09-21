'use client'

import { useEffect, useRef } from 'react'
import { Button } from '@/design-system/primitives'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

/**
 * A sentence she finishes, not a form she fills in.
 *
 * The inputs are sized to their content and sit on the baseline of the text
 * around them, so what she is looking at is one continuous statement rather
 * than a paragraph with three boxes in it. That is the whole design: on Day 3
 * she is saying something to ME, and it has to read like speech.
 */
function joinTags(tags: string[]): string {
  // "prove yourself and overthink". Two at most - the sentence has to stay a
  // sentence, and she can edit it to whatever is true.
  const first = tags.slice(0, 2).filter((t) => t.trim() !== '')
  if (first.length === 0) return ''
  if (first.length === 1) return first[0]!
  return `${first[0]} and ${first[1]}`
}

export function StatementFillMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
  context,
}: BlockMemberProps<Config, Response>) {
  const blanks = value?.blanks ?? {}

  /*
   * Pre-fill once, from what she already told us, and never again.
   *
   * Only on first render with nothing saved: re-running this on every render
   * would overwrite her edits with the original tags every time she typed,
   * which is the single most infuriating bug this component could have.
   */
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current) return
    seeded.current = true
    if (Object.keys(blanks).length > 0) return

    const next: Record<string, string> = {}
    for (const segment of config.segments) {
      if (segment.kind !== 'blank' || !segment.prefillFrom) continue
      if (segment.prefillFrom === 'behaviorTags') {
        const filled = joinTags(context?.behaviorTags ?? [])
        if (filled) next[segment.name] = filled
      } else if (segment.prefillFrom === 'unmetNeed') {
        const filled = (context?.unmetNeed ?? '').trim()
        if (filled) next[segment.name] = filled
      }
    }
    if (Object.keys(next).length > 0) {
      onChange({ blanks: next, confirmedAt: value?.confirmedAt })
    }
  }, [config.segments, context, blanks, onChange, value?.confirmedAt])

  const set = (name: string, text: string) =>
    onChange({
      blanks: { ...blanks, [name]: text },
      confirmedAt: value?.confirmedAt,
    })

  return (
    <div className="measure">
      {config.heading && (
        <h2 className="mb-6 font-display text-2xl leading-snug">
          {config.heading}
        </h2>
      )}

      <p className="font-display text-xl leading-relaxed text-ink md:text-2xl">
        {config.segments.map((segment, i) =>
          segment.kind === 'text' ? (
            <span key={i} className="whitespace-pre-line">
              {segment.text}
            </span>
          ) : (
            <input
              key={i}
              id={`${blockId}-${segment.name}`}
              aria-label={segment.placeholder || segment.name}
              value={blanks[segment.name] ?? ''}
              placeholder={segment.placeholder}
              onChange={(e) => set(segment.name, e.target.value)}
              disabled={disabled}
              // Grows with what she writes rather than sitting at a fixed
              // width that makes a long answer scroll inside a small box.
              size={Math.max(
                12,
                (blanks[segment.name] ?? segment.placeholder).length + 2,
              )}
              className="mx-1 border-0 border-b border-clay/50 bg-transparent px-1 pb-0.5 font-display text-xl text-clay-deep placeholder:text-ink-muted/60 focus:border-clay focus:outline-none focus:ring-0 md:text-2xl"
            />
          ),
        )}
      </p>

      <div className="mt-10">
        <Button
          type="button"
          size="lg"
          disabled={disabled}
          onClick={() =>
            onChange({ blanks, confirmedAt: new Date().toISOString() })
          }
        >
          {config.confirmLabel}
        </Button>
        {value?.confirmedAt && (
          <p className="mt-3 text-2xs text-ink-muted">Saved. Only you can read this.</p>
        )}
      </div>
    </div>
  )
}
