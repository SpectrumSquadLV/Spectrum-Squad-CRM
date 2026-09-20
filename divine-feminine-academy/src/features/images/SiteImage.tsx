import { cn } from '@/lib/utils/cn'
import type { SiteImageMeta } from '@/db/queries/images'
import { aspectRatio, type SlotShape } from './slots'

/**
 * A photograph, rendered.
 *
 * Presentational and synchronous on purpose. The page fetches - one cached
 * query for all of them - and passes the result in, so a page can lay itself
 * out differently depending on whether the photograph is there. An async
 * component could not tell the page that, and every layout would have to hold
 * a gap open for a picture that may never arrive.
 *
 * Plain <img> rather than next/image: these are already resized and converted
 * to WebP on the way in, so the optimizer would have nothing left to do but
 * add a second cache and a second way to fail.
 */
export function SiteImage({
  image,
  shape,
  className,
  priority = false,
  rounded = 'xl',
}: {
  image: SiteImageMeta
  shape: SlotShape
  className?: string
  /** True for the one photograph above the fold. Never for the rest. */
  priority?: boolean
  rounded?: 'xl' | 'full' | 'none'
}) {
  return (
    <img
      src={`/api/images/${image.slot}?v=${image.version}`}
      alt={image.alt}
      width={image.width}
      height={image.height}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding={priority ? 'sync' : 'async'}
      style={{
        aspectRatio: aspectRatio[shape],
        objectPosition: `${image.focalX}% ${image.focalY}%`,
      }}
      className={cn(
        'w-full bg-linen object-cover',
        rounded === 'xl' && 'rounded-xl',
        rounded === 'full' && 'rounded-full',
        className,
      )}
    />
  )
}
