'use client'

import { useEffect, useRef, useState } from 'react'
import { Button, Field, Textarea } from '@/design-system/primitives'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

/**
 * A real timer, and an honest one.
 *
 * It records how long she ACTUALLY stayed, not whether she pressed a button.
 * Stopping at forty seconds is not a failure to be hidden - it is the most
 * interesting thing she could tell us, and on a later day she gets to see it
 * change.
 *
 * No countdown numbers on screen while she looks. A woman watching a clock is
 * not looking at herself. The ring fills, and that is all.
 */
export function MirrorGazeMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const target = config.seconds
  const [elapsed, setElapsed] = useState(value?.secondsCompleted ?? 0)
  const [running, setRunning] = useState(false)
  const started = useRef<number | null>(null)

  const done = value?.completed ?? false

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => {
      if (started.current === null) return
      const next = Math.min(
        target,
        Math.round((Date.now() - started.current) / 1000),
      )
      setElapsed(next)
      if (next >= target) {
        setRunning(false)
        onChange({ secondsCompleted: next, completed: true, after: value?.after })
      }
    }, 200)
    return () => window.clearInterval(id)
  }, [running, target, onChange, value?.after])

  const stop = () => {
    setRunning(false)
    // Recorded even though she stopped early. Especially because she did.
    onChange({ secondsCompleted: elapsed, completed: elapsed >= target, after: value?.after })
  }

  const progress = target > 0 ? Math.min(1, elapsed / target) : 0

  return (
    <div className="measure">
      <p className="text-2xs uppercase tracking-[0.2em] text-clay-deep">
        The mirror
      </p>
      <h2 className="mt-4 font-display text-2xl leading-snug md:text-3xl">
        {config.intention}
      </h2>
      {config.helper && (
        <p className="mt-3 text-sm text-ink-muted">{config.helper}</p>
      )}

      <div className="mt-10 flex flex-col items-center">
        <div
          className="relative flex h-40 w-40 items-center justify-center rounded-full border border-rule"
          style={{
            background: `conic-gradient(var(--color-clay) ${progress * 360}deg, transparent 0deg)`,
          }}
          role="img"
          aria-label={
            done
              ? 'The practice is complete.'
              : running
                ? 'Looking. The ring fills as time passes.'
                : 'Not started.'
          }
        >
          <div className="flex h-[8.5rem] w-[8.5rem] items-center justify-center rounded-full bg-bone text-center">
            <span className="px-4 font-display text-sm leading-snug text-ink-soft">
              {done ? 'You stayed.' : running ? 'Keep looking.' : 'Find your eyes.'}
            </span>
          </div>
        </div>

        <div className="mt-8 flex gap-3">
          {!running && !done && (
            <Button
              type="button"
              size="lg"
              disabled={disabled}
              onClick={() => {
                started.current = Date.now() - elapsed * 1000
                setRunning(true)
              }}
            >
              {elapsed > 0 ? 'Go back to it' : 'Begin'}
            </Button>
          )}
          {running && (
            <Button type="button" variant="quiet" size="lg" onClick={stop}>
              Stop
            </Button>
          )}
        </div>

        {!done && elapsed > 0 && !running && (
          <p className="mt-4 text-2xs text-ink-muted">
            You stayed {elapsed} second{elapsed === 1 ? '' : 's'}. That is worth
            knowing, and it is not a failure.
          </p>
        )}
      </div>

      {config.askAfter && (done || elapsed > 0) && (
        <Field
          label={config.afterPrompt}
          htmlFor={`${blockId}-after`}
          className="mt-10"
        >
          <Textarea
            id={`${blockId}-after`}
            value={value?.after ?? ''}
            onChange={(e) =>
              onChange({
                secondsCompleted: elapsed,
                completed: done || elapsed >= target,
                after: e.target.value,
              })
            }
            disabled={disabled}
            rows={4}
          />
        </Field>
      )}
    </div>
  )
}
