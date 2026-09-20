'use client'

import { useEffect, useState } from 'react'

/**
 * A countdown that cannot lie.
 *
 * Three rules, all of them learned from countdowns that do lie:
 *
 * 1. It never goes negative. When the moment passes it says so and offers a
 *    refresh, rather than cheerfully counting down to a deadline that has
 *    already gone.
 * 2. It is NOT the authority on anything. The server re-checks the window at
 *    the moment of payment, so a stale tab cannot buy a seat in a closed room.
 *    This is a picture of a fact, not the fact.
 * 3. It renders nothing at all until it has mounted, because the first paint
 *    on the server and the first paint in the browser would otherwise disagree
 *    by however long the request took.
 */
export function Countdown({
  to,
  label,
}: {
  /** ISO 8601, from the server. */
  to: string
  label: string
}) {
  const target = new Date(to).getTime()
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  if (now === null || !Number.isFinite(target)) {
    // Reserve the space so the page does not jump when it arrives.
    return <div className="h-[4.5rem]" aria-hidden="true" />
  }

  const remaining = target - now

  if (remaining <= 0) {
    return (
      <div role="status" className="text-sm text-ink-soft">
        That moment has passed.{' '}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="underline underline-offset-4"
        >
          Refresh for what happens next
        </button>
        .
      </div>
    )
  }

  const total = Math.floor(remaining / 1000)
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  const parts: Array<{ value: number; unit: string }> = [
    ...(days > 0 ? [{ value: days, unit: days === 1 ? 'day' : 'days' }] : []),
    { value: hours, unit: 'hr' },
    { value: minutes, unit: 'min' },
    ...(days === 0 ? [{ value: seconds, unit: 'sec' }] : []),
  ]

  return (
    <div>
      {/*
        aria-live is deliberately off. A countdown that announces itself every
        second to a screen reader is unusable — the sentence underneath carries
        the same information without the noise.
      */}
      <div className="flex items-end gap-4" aria-hidden="true">
        {parts.map((part) => (
          <div key={part.unit}>
            <div className="font-display text-4xl leading-none tabular-nums md:text-5xl">
              {String(part.value).padStart(2, '0')}
            </div>
            <div className="mt-1.5 text-2xs uppercase tracking-[0.15em] text-ink-muted">
              {part.unit}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-sm text-ink-muted">
        {days > 0
          ? `${days} day${days === 1 ? '' : 's'} and ${hours} hour${hours === 1 ? '' : 's'} ${label}.`
          : `${hours} hour${hours === 1 ? '' : 's'} and ${minutes} minute${minutes === 1 ? '' : 's'} ${label}.`}
      </p>
    </div>
  )
}
