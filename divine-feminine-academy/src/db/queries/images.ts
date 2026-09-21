import 'server-only'
import { cache } from 'react'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { siteImages } from '@/db/schema/media'
import type { Variant } from '@/features/images/slots'

export interface SiteImageMeta {
  slot: string
  variant: Variant
  alt: string
  width: number
  height: number
  focalX: number
  focalY: number
  version: string
  byteSize: number
  updatedAt: Date
}

/** Both compositions of one slot. `mobile` is optional; desktop stands in. */
export interface SlotImages {
  desktop: SiteImageMeta | null
  mobile: SiteImageMeta | null
}

/**
 * Every filled slot, without the bytes.
 *
 * Wrapped in React's cache so a page rendering six photographs still makes one
 * query, and so two sections cannot disagree about what is there.
 *
 * It swallows its own errors, which is not the house style and is deliberate
 * here. These are photographs on marketing pages. A database that is briefly
 * unreachable should cost the site its pictures, not its words.
 */
export const siteImageMap = cache(
  async (): Promise<ReadonlyMap<string, SlotImages>> => {
    try {
      const rows = await db
        .select({
          slot: siteImages.slot,
          variant: siteImages.variant,
          alt: siteImages.alt,
          width: siteImages.width,
          height: siteImages.height,
          focalX: siteImages.focalX,
          focalY: siteImages.focalY,
          version: siteImages.version,
          byteSize: siteImages.byteSize,
          updatedAt: siteImages.updatedAt,
        })
        .from(siteImages)

      const map = new Map<string, SlotImages>()
      for (const row of rows) {
        const entry = map.get(row.slot) ?? { desktop: null, mobile: null }
        const meta = { ...row, variant: row.variant as Variant }
        if (meta.variant === 'mobile') entry.mobile = meta
        else entry.desktop = meta
        map.set(row.slot, entry)
      }
      return map
    } catch (error) {
      console.error('[images] could not read site images', error)
      return new Map()
    }
  },
)

/**
 * One slot's photographs, or null when nothing is in it.
 *
 * Null when there is no DESKTOP crop specifically: a mobile crop on its own
 * would leave every wide screen with a hole, so it does not count as filled.
 */
export async function siteImage(slot: string): Promise<SlotImages | null> {
  const entry = (await siteImageMap()).get(slot)
  return entry?.desktop ? entry : null
}

/**
 * The bytes, for the serving route only.
 *
 * Separate from everything above so no page query can accidentally drag a
 * megabyte of image data through it.
 */
export async function siteImageBytes(
  slot: string,
  variant: Variant,
): Promise<{
  bytes: Uint8Array
  contentType: string
  byteSize: number
  version: string
} | null> {
  const [row] = await db
    .select({
      bytes: siteImages.bytes,
      contentType: siteImages.contentType,
      byteSize: siteImages.byteSize,
      version: siteImages.version,
    })
    .from(siteImages)
    .where(and(eq(siteImages.slot, slot), eq(siteImages.variant, variant)))
    .limit(1)

  return row ?? null
}
