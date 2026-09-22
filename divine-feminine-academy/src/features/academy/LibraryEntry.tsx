'use client'

import Link from 'next/link'
import { useState } from 'react'
import { cn } from '@/lib/utils/cn'
import { Aperture } from './Aperture'
import { numeral, type LibraryEntry as Entry } from './library'

export interface EntryProgress {
  /** Seven, for ME VS. HER. Read from the programme, never assumed. */
  total: number
  completed: number
  unlockedThrough: number
  current: number
  isComplete: boolean
}

/**
 * One thing in the library, given the room a thing in a library deserves.
 *
 * Not a card. A card has a border, a thumbnail, a title, a 60% progress bar
 * and a CONTINUE button, and six of them in a grid is every course platform
 * ever built. The difference between that and this is mostly restraint:
 * hairlines instead of boxes, the title at display scale, and a great deal of
 * air.
 *
 * It says ENTER, never Start or Continue or Resume. Those three words all
 * describe a task being managed. ENTER describes a place, and the place is
 * the entire point: she is not being marched through a curriculum, she is
 * going somewhere that is already hers.
 *
 * The seven days are numerals rather than a bar, for the reason in
 * library.ts, and they are NOT links. A day that is not open cannot be
 * opened, and a numeral that looks clickable and is not would be a small
 * daily lie. The one that is open is marked; the rest are quiet.
 */
export function LibraryEntry({
  entry,
  progress,
  href,
  action,
}: {
  entry: Entry
  /** Null when she has not entered it yet. */
  progress: EntryProgress | null
  href: string
  action: string
}) {
  const [hover, setHover] = useState(false)

  return (
    <article
      className="group relative"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Link
        href={href}
        className="block rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-plum focus-visible:ring-offset-4 focus-visible:ring-offset-bone"
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
      >
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-2xs uppercase tracking-[0.22em] text-ink-muted">
              {entry.measure}
            </p>

            {/*
              Display scale, tight leading. This is the largest type in the
              member area and it should be - it is the name of the thing she
              came for.
            */}
            <h3 className="mt-3 font-display text-3xl leading-[1.05] text-ink md:text-4xl">
              {entry.title}
            </h3>
          </div>

          <Aperture open={hover} size={44} className="mt-1" />
        </div>

        <p className="measure mt-5 text-base leading-relaxed text-ink-soft">
          {entry.line}
        </p>

        {progress && (
          <Numerals
            total={progress.total}
            completed={progress.completed}
            current={progress.current}
            unlockedThrough={progress.unlockedThrough}
          />
        )}

        <p className="mt-8 inline-flex items-center gap-2 text-2xs uppercase tracking-[0.22em] text-clay-deep">
          {action}
          <span
            aria-hidden
            className={cn(
              'transition-transform duration-500 ease-out motion-reduce:transition-none',
              hover && 'translate-x-1',
            )}
          >
            &rarr;
          </span>
        </p>
      </Link>
    </article>
  )
}

function Numerals({
  total,
  completed,
  current,
  unlockedThrough,
}: {
  total: number
  completed: number
  current: number
  unlockedThrough: number
}) {
  const days = Array.from({ length: total }, (_, i) => i + 1)

  return (
    <div className="mt-8">
      {/*
        One row, always. Wrapping put VII alone on a second line on a phone,
        where it sat directly on top of ENTER and read as a seventh item in a
        different list. justify-between spreads the seven edge to edge, which
        also stops the row from looking like a ragged left-aligned list.
      */}
      <ol
        className="flex items-baseline justify-between"
        aria-label={`${completed} of ${total} finished`}
      >
        {days.map((day) => {
          const done = day <= completed
          const open = !done && day <= unlockedThrough
          const here = day === current && open
          return (
            <li
              key={day}
              className={cn(
                'font-display text-sm tracking-[0.12em] transition-colors duration-500 motion-reduce:transition-none',
                done && 'text-clay-deep',
                here && 'text-plum',
                !done && !here && 'text-rule-strong',
              )}
            >
              <span aria-hidden>{numeral(day)}</span>
              <span className="sr-only">
                {numeral(day)}
                {done ? ' finished' : open ? ' open' : ' not open yet'}
              </span>
              {/*
                The one mark on the whole row. A hairline under the numeral
                that is open now - enough to find at a glance, and nothing
                like a badge.
              */}
              {here && (
                <span
                  aria-hidden
                  className="mt-1 block h-px w-full bg-plum/50"
                />
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
