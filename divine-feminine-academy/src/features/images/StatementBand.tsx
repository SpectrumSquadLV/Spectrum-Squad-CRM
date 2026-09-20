import * as React from 'react'
import { cn } from '@/lib/utils/cn'
import type { SiteImageMeta } from '@/db/queries/images'
import { SiteImage } from './SiteImage'

/**
 * A full-width band: one line that stops you, and one photograph.
 *
 * Built around the shape of the photograph rather than the other way round.
 * The portrait it was designed for has the subject to one side and a wall of
 * empty space beside her, so the words go where the space already is and the
 * two halves read as one picture instead of a caption next to a headshot.
 *
 * It degrades to the words alone. If the slot is empty the band still says
 * what it says, at full width, and nothing about the page looks broken -
 * which is the only reason it is safe to have a section this loud depend on
 * a photograph somebody has to remember to upload.
 */
export function StatementBand({
  image,
  eyebrow,
  headline,
  answer,
  footnote,
  className,
}: {
  image: SiteImageMeta | null
  eyebrow?: string
  headline: React.ReactNode
  /** The turn. Set apart from the headline because it is the whole point. */
  answer: React.ReactNode
  footnote?: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('bg-linen/70 border-y border-rule', className)}>
      <div
        className={cn(
          'mx-auto max-w-6xl gap-10 px-5 py-16 md:gap-14 md:px-8 md:py-20',
          image && 'grid items-center md:grid-cols-[1.1fr_minmax(0,24rem)]',
        )}
      >
        <div>
          {eyebrow && (
            <p className="text-2xs uppercase tracking-[0.22em] text-clay-deep">
              {eyebrow}
            </p>
          )}
          <p className="mt-5 font-display text-4xl leading-[1.05] text-plum md:text-6xl">
            {headline}
          </p>
          <p className="measure mt-6 font-display text-xl leading-snug text-ink md:text-2xl">
            {answer}
          </p>
          {footnote && (
            <p className="measure mt-6 text-sm text-ink-soft">{footnote}</p>
          )}
        </div>

        {/*
          * Eagerly, not lazily. This band is the loudest thing on the page and
          * it sits near the top of it, so on a phone the photograph is in view
          * almost immediately - lazy loading would buy nothing and show an
          * empty frame at the exact moment the line is meant to land.
          */}
        {image && <SiteImage image={image} shape="portrait" priority />}
      </div>
    </section>
  )
}
