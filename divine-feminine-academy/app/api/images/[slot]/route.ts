import { siteImageBytes } from '@/db/queries/images'
import { imageSlot, isVariant } from '@/features/images/slots'

/** Bytes live in Postgres, so this is never static. */
export const dynamic = 'force-dynamic'

/**
 * Serving a photograph.
 *
 * The caching is the interesting part. Every source asks for ?v=<version>, and
 * the version changes on every upload — so a given URL can only ever return
 * one set of bytes, and it is safe to tell browsers and proxies to keep it for
 * a year. Replacing a photograph changes the URL, which means it appears at
 * once for everybody instead of some visitors seeing last month's picture
 * until their cache gives up.
 *
 * A request without ?v — somebody pasting the bare URL — gets a minute, since
 * that URL genuinely can change underneath them.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slot: string }> },
) {
  const { slot } = await params

  // Checked against the registry before touching the database: the slot comes
  // from the URL, and an unknown one is a 404 rather than a query.
  if (!imageSlot(slot)) {
    return new Response('Not found', { status: 404 })
  }

  const url = new URL(request.url)
  const asked = url.searchParams.get('variant') ?? 'desktop'
  if (!isVariant(asked)) return new Response('Not found', { status: 404 })

  const row = await siteImageBytes(slot, asked)
  if (!row) return new Response('Not found', { status: 404 })

  const etag = `"${row.version}"`
  const cacheControl =
    url.searchParams.get('v') === row.version
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=60'

  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': cacheControl },
    })
  }

  return new Response(new Uint8Array(row.bytes), {
    headers: {
      'Content-Type': row.contentType,
      'Content-Length': String(row.byteSize),
      'Cache-Control': cacheControl,
      ETag: etag,
      // Two different pictures live at this path. Without this a shared cache
      // can hand the phone crop to a desktop, or the reverse.
      Vary: 'Accept',
    },
  })
}
