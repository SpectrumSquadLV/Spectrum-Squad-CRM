'use client'

import { useEffect, useState } from 'react'
import { Button, Textarea } from '@/design-system/primitives'
import type { BlockMemberProps } from '../../contract'
import { suggestStatements, type Config, type Response } from './schema'

/**
 * Two modes: editing, then declaring.
 *
 * Declaration mode is deliberately stark — one statement, very large, nothing
 * else on the screen. She is holding a phone up to a mirror and speaking out
 * loud. Anything else in view is something for her eyes to go to instead of
 * her own.
 */
export function MirrorDeclarationMember({
  config,
  value,
  onChange,
  disabled,
  context,
}: BlockMemberProps<Config, Response>) {
  const [statements, setStatements] = useState<string[]>(
    value?.statements?.length ? value.statements : [],
  )
  const [declaring, setDeclaring] = useState(false)
  const [index, setIndex] = useState(0)

  // Seed from her own week the first time, and never overwrite her edits.
  useEffect(() => {
    if (statements.length > 0) return
    const seeded = suggestStatements(context, config.fallbacks)
    if (seeded.length > 0) setStatements(seeded)
  }, [context, config.fallbacks, statements.length])

  const commit = (next: string[], completed = value?.completed ?? false) => {
    setStatements(next)
    onChange({
      statements: next.filter((s) => s.trim() !== ''),
      completed,
      spokenAt: completed ? new Date().toISOString() : value?.spokenAt,
    })
  }

  if (declaring) {
    const current = statements[index] ?? ''
    const isLast = index >= statements.length - 1

    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bone px-6">
        <p className="absolute top-8 text-2xs uppercase tracking-[0.2em] text-clay-deep">
          {index + 1} of {statements.length} · say it out loud
        </p>

        <p className="max-w-3xl text-center font-display text-3xl leading-tight md:text-5xl">
          {current}
        </p>

        <div className="absolute bottom-10 flex items-center gap-3">
          <Button
            type="button"
            variant="quiet"
            onClick={() => (index === 0 ? setDeclaring(false) : setIndex((i) => i - 1))}
          >
            {index === 0 ? 'Stop' : 'Back'}
          </Button>
          <Button
            type="button"
            size="lg"
            onClick={() => {
              if (!isLast) {
                setIndex((i) => i + 1)
                return
              }
              commit(statements, true)
              setDeclaring(false)
            }}
          >
            {isLast ? 'HER LEADS NOW' : 'Said it'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && (
        <p className="mb-6 text-sm text-ink-muted">{config.helper}</p>
      )}

      <p className="mb-8 rounded-lg border border-clay bg-plum-wash px-5 py-4 text-sm leading-relaxed text-ink-soft">
        These came from your own six days. Change any of them until they sound
        like you — you are the one who has to say them out loud.
      </p>

      <ol className="flex flex-col gap-4">
        {statements.map((s, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="mt-4 w-5 shrink-0 text-2xs tabular-nums text-ink-faint">
              {i + 1}
            </span>
            <Textarea
              value={s}
              aria-label={`Statement ${i + 1}`}
              onChange={(e) => {
                const next = [...statements]
                next[i] = e.target.value
                commit(next)
              }}
              disabled={disabled}
              rows={2}
            />
            <button
              type="button"
              aria-label={`Remove statement ${i + 1}`}
              disabled={disabled}
              onClick={() => commit(statements.filter((_, j) => j !== i))}
              className="mt-4 text-2xs text-ink-faint underline underline-offset-4"
            >
              Remove
            </button>
          </li>
        ))}
      </ol>

      <div className="mt-6 flex flex-wrap gap-3">
        <Button
          type="button"
          variant="quiet"
          disabled={disabled}
          onClick={() => commit([...statements, ''])}
        >
          Add one of your own
        </Button>
      </div>

      {statements.filter((s) => s.trim()).length > 0 && (
        <div className="mt-12 rounded-xl border border-clay bg-plum-wash p-6 md:p-8">
          <h3 className="font-display text-xl">Take it to the mirror.</h3>
          <p className="mt-3 text-sm leading-relaxed text-ink-soft">
            One at a time, on a big screen, out loud, looking at yourself. Not
            read — said.
          </p>
          <div className="mt-6">
            <Button
              type="button"
              size="lg"
              disabled={disabled}
              onClick={() => {
                setIndex(0)
                setDeclaring(true)
              }}
            >
              {config.beginLabel}
            </Button>
          </div>
        </div>
      )}

      {value?.completed && (
        <p className="mt-8 text-sm text-clay-deep">You said them. Out loud.</p>
      )}
    </div>
  )
}
