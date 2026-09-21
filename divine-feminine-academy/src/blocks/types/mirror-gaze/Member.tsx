'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { cn } from '@/lib/utils/cn'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

/**
 * Silence, and an honest clock.
 *
 * Nothing is on this screen while she looks. No intention held up, no
 * affirmation, no encouragement at ninety seconds. The setup copy is its own
 * screen before this one and it has already done its work; a woman looking
 * into her own eyes does not need a product talking to her at the same time.
 *
 * The countdown IS shown, which is a reversal of how this block used to work.
 * The earlier version hid the numbers on the theory that a woman watching a
 * clock is not looking at herself. In practice, not knowing how long is left
 * is its own kind of pressure - she keeps checking - and the curriculum asks
 * for a large, calm timer. So: large, calm, and quiet.
 *
 * What is recorded is how long she ACTUALLY stayed. Stopping at forty seconds
 * is not a failure to be hidden; it is the most interesting thing she could
 * tell us, and on a later day she gets to watch it change.
 */
function mmss(total: number): string {
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** A soft, short tone. Not a notification sound. */
function chime() {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 528
    // Fade in and out, so it arrives rather than interrupts.
    gain.gain.setValueAtTime(0, ctx.currentTime)
    gain.gain.linearRampToValueAtTime(0.09, ctx.currentTime + 0.12)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 2.2)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 2.3)
    osc.onended = () => void ctx.close()
  } catch {
    // No audio is not a broken mirror. The buttons appear either way.
  }
}

export function MirrorGazeMember({
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const [target, setTarget] = useState(config.seconds)
  const [elapsed, setElapsed] = useState(value?.secondsCompleted ?? 0)
  const [running, setRunning] = useState(false)
  /** True between the chime and whatever she chooses next. */
  const [atRest, setAtRest] = useState(value?.completed ?? false)
  const [extensions, setExtensions] = useState(value?.extensions ?? 0)

  const started = useRef<number | null>(null)
  const base = useRef(0)

  const save = useCallback(
    (seconds: number, completed: boolean, stoppedEarly: boolean, ext: number) =>
      onChange({
        secondsCompleted: seconds,
        completed,
        extensions: ext,
        stoppedEarly,
      }),
    [onChange],
  )

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => {
      if (started.current === null) return
      const next =
        base.current + Math.round((Date.now() - started.current) / 1000)
      if (next >= target) {
        setElapsed(target)
        setRunning(false)
        setAtRest(true)
        chime()
        save(target, true, false, extensions)
      } else {
        setElapsed(next)
      }
    }, 250)
    return () => window.clearInterval(id)
  }, [running, target, extensions, save])

  const begin = () => {
    base.current = 0
    started.current = Date.now()
    setElapsed(0)
    setAtRest(false)
    setRunning(true)
  }

  const stop = () => {
    setRunning(false)
    // Recorded even though she stopped early. Especially because she did.
    save(elapsed, false, true, extensions)
  }

  const oneMoreMinute = () => {
    const next = extensions + 1
    setExtensions(next)
    base.current = elapsed
    started.current = Date.now()
    setTarget(elapsed + config.extendSeconds)
    setAtRest(false)
    setRunning(true)
  }

  const remaining = Math.max(0, target - elapsed)
  const open = config.mood === 'open'

  return (
    <div
      className={cn(
        'measure flex min-h-[26rem] flex-col items-center justify-center text-center',
        open && 'min-h-[30rem]',
      )}
    >
      {!running && !atRest && (
        <>
          {config.intention && (
            <p className="mb-10 font-display text-xl leading-snug text-ink-soft">
              {config.intention}
            </p>
          )}
          <Button type="button" size="lg" disabled={disabled} onClick={begin}>
            {elapsed > 0 ? 'Go back to it' : 'Start'}
          </Button>
          {elapsed > 0 && (
            <p className="mt-5 text-2xs text-ink-muted">
              You stayed {mmss(elapsed)} last time. That is worth knowing, and
              it is not a failure.
            </p>
          )}
        </>
      )}

      {running && (
        <>
          {/*
            The only thing on the screen. Tabular figures so the digits do not
            shift as they count, which is its own small distraction.
          */}
          <p
            className={cn(
              'font-display tabular-nums leading-none tracking-tight',
              open ? 'text-7xl text-clay-deep md:text-8xl' : 'text-6xl md:text-7xl',
            )}
            role="timer"
            aria-live="off"
          >
            {mmss(remaining)}
          </p>

          {/*
            Always visible, never emphasised. A woman who needs to stop should
            not have to hunt for the way out, and should not feel watched
            taking it.
          */}
          <button
            type="button"
            onClick={stop}
            className="mt-16 min-h-11 px-4 text-2xs text-ink-muted underline underline-offset-4 hover:text-ink"
          >
            I need to stop
          </button>
        </>
      )}

      {atRest && (
        <>
          <p className="font-display text-2xl leading-snug">You stayed.</p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Button
              type="button"
              size="lg"
              disabled={disabled}
              onClick={() => save(elapsed, true, false, extensions)}
            >
              I&rsquo;M COMPLETE
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              disabled={disabled}
              onClick={oneMoreMinute}
            >
              ONE MORE MINUTE
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
