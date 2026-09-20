import 'server-only'
import sharp, { type OutputInfo } from 'sharp'
import { randomUUID } from 'node:crypto'
import type { SlotShape } from './slots'

/**
 * Turning whatever came off a phone into something the site can serve.
 *
 * Three things happen here and all three matter.
 *
 * It strips metadata. A photograph taken on a phone carries EXIF, and EXIF
 * routinely carries GPS coordinates - so publishing an unprocessed picture of
 * yourself at home publishes where you live, to anyone who downloads it and
 * looks. Nobody would ever notice this had happened. sharp drops metadata
 * unless you ask it to keep it, and we never ask.
 *
 * It applies the orientation flag before dropping it. That flag is the reason
 * a photograph can look upright in the phone's gallery and land sideways on a
 * website: the pixels are rotated and the flag says how to turn them back.
 * rotate() with no argument bakes it into the pixels, which is the only way
 * stripping the metadata stays safe.
 *
 * It re-encodes. Whatever arrives leaves as WebP at a sane size, so the format
 * served is one thing rather than whatever the uploader happened to have, and
 * a nine megabyte camera original does not become a nine megabyte page.
 */

/** What the form will accept before we even look at the bytes. */
export const maxUploadBytes = 20 * 1024 * 1024

/** The long edge after resizing. Twice the largest slot, for sharp screens. */
const maxEdgePx = 1600

/** Refuse a decompression bomb rather than let libvips chew on it. */
const maxInputPixels = 80_000_000

export interface ProcessedImage {
  bytes: Buffer
  contentType: string
  width: number
  height: number
  byteSize: number
  version: string
}

export class ImageRejected extends Error {}

/**
 * The formats worth accepting.
 *
 * HEIC is on the list on purpose: it is what an iPhone produces by default,
 * and telling a woman to go and convert her own photograph is how this feature
 * goes unused. Whether libvips was built with HEIC support varies, so a HEIC
 * that cannot be decoded is caught below and explained rather than thrown.
 */
const acceptedFormats = new Set([
  'jpeg',
  'jpg',
  'png',
  'webp',
  'avif',
  'heif',
  'gif',
  'tiff',
])

/** Long edge, by shape, so a square slot does not store a 1600px original. */
const longEdge: Record<SlotShape, number> = {
  portrait: maxEdgePx,
  landscape: maxEdgePx,
  square: 900,
}

export async function processUpload(
  input: Buffer,
  shape: SlotShape,
): Promise<ProcessedImage> {
  if (input.byteLength === 0) {
    throw new ImageRejected('That file was empty.')
  }
  if (input.byteLength > maxUploadBytes) {
    throw new ImageRejected(
      'That photograph is over 20MB. Most phones can send a smaller copy.',
    )
  }

  const pipeline = sharp(input, { limitInputPixels: maxInputPixels })

  let format: string | undefined
  try {
    format = (await pipeline.metadata()).format
  } catch {
    throw new ImageRejected(
      'That does not look like a photograph the site can read. A JPEG or a PNG always works.',
    )
  }

  if (!format || !acceptedFormats.has(format)) {
    throw new ImageRejected(
      `That is a ${format ?? 'file'}, which the site cannot serve. Save it as a JPEG or a PNG and try again.`,
    )
  }

  let output: { data: Buffer; info: OutputInfo }
  try {
    output = await pipeline
      // Bake the EXIF orientation in, then let the metadata go.
      .rotate()
      .resize({
        width: longEdge[shape],
        height: longEdge[shape],
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true })
  } catch {
    throw new ImageRejected(
      'That photograph could not be opened. If it came from an iPhone, sending it as "Most Compatible" or saving it as a JPEG will fix it.',
    )
  }

  return {
    bytes: output.data,
    contentType: 'image/webp',
    width: output.info.width,
    height: output.info.height,
    byteSize: output.data.byteLength,
    version: randomUUID().replaceAll('-', '').slice(0, 16),
  }
}
