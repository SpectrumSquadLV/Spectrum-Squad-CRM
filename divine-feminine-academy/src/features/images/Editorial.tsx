import * as React from 'react'
import { cn } from '@/lib/utils/cn'
import type { SlotImages } from '@/db/queries/images'
import { SiteImage } from './SiteImage'
import { cropFor, type ImageSlot } from './slots'

/**
 * A photograph at full width with words on it.
 *
 * Two rules hold this together, and both come from the photography rather
 * than from a layout idea.
 *
 * Her face and body are a protected zone. Type is placed into the empty
 * ground a frame was composed to leave — the plaster above her head, the wall
 * beside her — and never over her. That is why `place` names a region of the
 * picture instead of an alignment: the caller is pointing at part of the
 * photograph, not nudging text around a box.
 *
 * And the phone gets its own arrangement. The desktop composition puts words
 * in a field that only exists in the desktop crop; on a phone the crop is
 * different and the words go somewhere else. Forcing one to behave like the
 * other is how type ends up across somebody's face.
 *
 * No scrim, no dark overlay, no gradient. These photographs are lit against
 * pale plaster and near-black type on them clears WCAG AA several times over —
 * a scrim would only mute the photograph to solve a problem it does not have.
 * A darker or busier frame would need one, and that is a decision for the
 * frame that needs it.
 */
export function PhotoBand({
  images,
  slot,
  eyebrow,
  headline,
  sub,
  children,
  place = 'top-left',
  mobilePlace = 'top',
  mobileOverlay = false,
  overlay = true,
  priority = false,
  className,
}: {
  images: SlotImages | null
  slot: ImageSlot
  eyebrow?: string
  headline: React.ReactNode
  sub?: React.ReactNode
  /** Buttons, links — whatever follows the words. */
  children?: React.ReactNode
  /** Which empty region of the DESKTOP crop the words sit in. */
  place?: 'top-left' | 'top' | 'left' | 'bottom-left'
  /** And of the phone crop, when the words sit on the photograph at all. */
  mobilePlace?: 'top' | 'bottom'
  /**
   * Whether the words sit ON the photograph at wide widths.
   *
   * Off by default, and that default is the lesson. A phone crop is taller and
   * tighter than a wide one, so the empty ground a desktop composition puts
   * its headline in often does not survive the crop - and the first build of
   * this ran "You don't need to find her" straight across her face, which is
   * the one thing the photography brief says never to do. Turning it on is a
   * claim about a specific crop, made after looking at it.
   */
  mobileOverlay?: boolean
  /**
   * Whether the words ever sit on the photograph at all.
   *
   * False for a frame with no flat ground in it. A studio portrait against
   * plaster has an empty half to put a headline in; a terrace above a vineyard
   * has hedges, palms and a mountain range, and type lands on all of them at
   * every width — the eyebrow on that frame measured 3.43:1, which is not a
   * contrast failure to tune away but a photograph saying it is not that kind
   * of picture. It becomes a plate with the line beneath it instead, which is
   * the stronger composition anyway.
   */
  overlay?: boolean
  priority?: boolean
  className?: string
}) {
  const words = (
    <>
      {eyebrow && (
        <p className="text-2xs uppercase tracking-[0.28em] text-ink-soft">
          {eyebrow}
        </p>
      )}
      <h2
        className={cn(
          'mt-5 font-display leading-[0.95] tracking-[-0.03em] text-ink',
          // A column pinned beside her cannot carry the same size as one with
          // the whole width to itself.
          place === 'left'
            ? 'text-[2.6rem] sm:text-5xl xl:text-6xl 2xl:text-7xl'
            : 'text-[2.6rem] sm:text-6xl md:text-7xl xl:text-8xl',
        )}
      >
        {headline}
      </h2>
      {sub && (
        <p
          className={cn(
            'measure mt-6 font-display leading-snug text-ink',
            place === 'left' ? 'text-lg xl:text-xl' : 'text-lg md:text-2xl',
          )}
        >
          {sub}
        </p>
      )}
      {children && <div className="mt-8">{children}</div>}
    </>
  )

  // No photograph: the words still carry the section at full size, on the
  // page's own ground. A band this loud must not depend on an upload.
  if (!images?.desktop) {
    return (
      <section className={cn('border-y border-rule bg-linen/60', className)}>
        <div className="mx-auto max-w-6xl px-5 py-24 md:px-8 md:py-32">
          <div className="max-w-3xl">{words}</div>
        </div>
      </section>
    )
  }

  /*
   * How much of the frame the words may occupy.
   *
   * `left` is the tight one and it is tight on purpose. The empty plaster in
   * that composition runs out around a third of the way across, so a half-width
   * column overruns it and the second line ends up on her leg — which is what
   * the first build did at 1280px, in a band that measured perfectly at 1440.
   * The region has to be narrower than the emptiness it sits in, at every
   * width, not just the one it was designed at.
   */
  const desktopRegion = !overlay
    ? 'hidden'
    : {
    'top-left': 'xl:inset-x-0 xl:top-0 xl:h-1/2 xl:items-start xl:justify-start',
    top: 'xl:inset-x-0 xl:top-0 xl:h-1/2 xl:items-start xl:justify-center xl:text-center',
    left: 'xl:inset-y-0 xl:left-0 xl:w-[42%] xl:items-center xl:justify-start',
    'bottom-left': 'xl:inset-x-0 xl:bottom-0 xl:h-1/2 xl:items-end xl:justify-start',
      }[place]

  const mobileRegion = !overlay
    ? 'hidden'
    : mobileOverlay
    ? mobilePlace === 'bottom'
      ? 'inset-x-0 bottom-0 h-1/2 items-end'
      : 'inset-x-0 top-0 h-1/2 items-start'
    : // Off the photograph entirely below xl, and back on it above.
      'hidden xl:flex'

  return (
    <section className={cn('relative', className)}>
      <div
        className="art-frame relative w-full overflow-hidden"
        style={
          {
            '--ratio-mobile': cropFor(slot, 'mobile').ratio,
            '--ratio-desktop': cropFor(slot, 'desktop').ratio,
          } as React.CSSProperties
        }
      >
        <SiteImage images={images} slot={slot} priority={priority} sizes="100vw" />

        <div
          className={cn(
            'absolute flex px-5 py-8 xl:px-16 xl:py-12 2xl:px-24',
            mobileRegion,
            desktopRegion,
          )}
        >
          <div className="max-w-2xl">{words}</div>
        </div>
      </div>

      {/*
        The phone composition, when the words cannot safely sit on the crop.
        A plate and then the line under it - which is how a magazine would set
        this anyway, and never how a squeezed desktop layout looks.
      */}
      {(!mobileOverlay || !overlay) && (
        <div className={cn('px-5 pb-4 pt-10 md:px-8', overlay && 'xl:hidden')}>
          <div className="max-w-2xl">{words}</div>
        </div>
      )}
    </section>
  )
}
