import 'server-only'
import { cache } from 'react'
import { eq } from 'drizzle-orm'
import { db } from '@/db/client'
import { siteImages } from '@/db/schema/media'

export interface SiteImageMeta {
  slot: string
  alt: string
  width: number
  height: number
  focalX: number
  focalY: number
  version: string
  byteSize: number
  updatedAt: Date
}

/**
 * Every filled slot, without the bytes.
 *
 * Wrapped in React's cache so a page rendering three photographs still makes
 * one query, and so the footer and the hero cannot disagree about what is
 * there.
 *
 * It swallows its own errors, which is not the house style and is deliberate
 * here. These are decorations on marketing pages. A database that is briefly
 * unreachable should cost the site its photographs, not its home page - the
 * words are the part that has to survive.
 */
export const siteImageMap = cache(
  async (): Promise<ReadonlyMap<string, SiteImageMeta>> => {
    try {
      const rows = await db
        .select({
          slot: siteImages.slot,
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

      return new Map(rows.map((row) => [row.slot, row]))
    } catch (error) {
      console.error('[images] could not read site images', error)
      return new Map()
    }
  },
)

/** One slot, or null. Pages call this; it costs nothing after the first. */
export async function siteImage(slot: string): Promise<SiteImageMeta | null> {
  return (await siteImageMap()).get(slot) ?? null
}

/**
 * The bytes, for the serving route only.
 *
 * Separate from everything above so that no page query can ever accidentally
 * drag a megabyte of image data through it.
 */
export async function siteImageBytes(slot: string): Promise<{
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
    .where(eq(siteImages.slot, slot))
    .limit(1)

  return row ?? null
}
