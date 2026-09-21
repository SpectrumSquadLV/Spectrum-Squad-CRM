import { cn } from '@/lib/utils/cn'
import type { SlotImages } from '@/db/queries/images'
import { cropFor, type ImageSlot } from './slots'

/**
 * A photograph, in whichever composition the screen calls for.
 *
 * A <picture> with the phone crop first, because art direction is not
 * resizing: the two files are different photographs of the same moment, framed
 * for different shapes, and the browser must choose between them rather than
 * scale one. Where no phone crop has been uploaded the desktop one is used
 * everywhere, which is a worse picture but never a broken page.
 *
 * Presentational and synchronous on purpose. The page fetches - one cached
 * query for all of them - and passes the result in, so the page can lay itself
 * out differently depending on whether a photograph is there at all. An async
 * component could not tell the page that, and every layout would have to hold
 * a gap open for a picture that may never arrive.
 *
 * Plain <img> rather than next/image: these are resized and converted to WebP
 * on the way in, so the optimizer would have nothing to do but add a second
 * cache and a second way to fail.
 */
export function SiteImage({
  images,
  slot,
  className,
  priority = false,
  rounded = 'none',
  sizes = '100vw',
}: {
  images: SlotImages
  slot: ImageSlot
  className?: string
  /** True for the one photograph above the fold. Never for the rest. */
  priority?: boolean
  rounded?: 'xl' | 'full' | 'none'
  sizes?: string
}) {
  const desktop = images.desktop
  if (!desktop) return null

  const mobile = images.mobile
  const src = (slot: string, variant: string, version: string) =>
    `/api/images/${slot}?variant=${variant}&v=${version}`

  return (
    <picture>
      {mobile && (
        <source
          media="(max-width: 767px)"
          srcSet={src(mobile.slot, 'mobile', mobile.version)}
          width={mobile.width}
          height={mobile.height}
        />
      )}
      <img
        src={src(desktop.slot, 'desktop', desktop.version)}
        alt={desktop.alt}
        width={desktop.width}
        height={desktop.height}
        sizes={sizes}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding={priority ? 'sync' : 'async'}
        style={{ objectPosition: `${desktop.focalX}% ${desktop.focalY}%` }}
        className={cn(
          'h-full w-full bg-linen object-cover',
          rounded === 'xl' && 'rounded-xl',
          rounded === 'full' && 'rounded-full',
          className,
        )}
      />
    </picture>
  )
}

/**
 * The frame a photograph sits in.
 *
 * The aspect ratio lives here rather than on the <img> because the two crops
 * have different ones, and a ratio on the image would fight the source the
 * browser picked. A wrapper that changes shape at the same breakpoint the
 * <picture> switches at is the only arrangement where both agree - and that
 * breakpoint has to be a real media query, which is why .art-frame is a rule
 * in globals.css fed by two custom properties rather than an inline style.
 */
export function SiteImageFrame({
  slot,
  children,
  className,
}: {
  slot: ImageSlot
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn('art-frame relative w-full overflow-hidden', className)}
      style={
        {
          '--ratio-mobile': cropFor(slot, 'mobile').ratio,
          '--ratio-desktop': cropFor(slot, 'desktop').ratio,
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  )
}
