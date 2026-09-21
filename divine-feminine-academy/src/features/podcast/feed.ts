import { XMLParser } from 'fast-xml-parser'

/**
 * Reading the show's feed.
 *
 * Brown Girls Need Healing Too is hosted at RSS.com, and that feed is the one
 * Apple and Spotify already have. It is therefore the source of truth for
 * everything it carries, and this file's whole job is to read it faithfully -
 * never to decide anything.
 *
 * Parsed with a real XML parser rather than regular expressions. A podcast
 * description is arbitrary HTML inside CDATA, titles contain ampersands, and
 * hosts differ on namespaces; a pattern that works against the first twenty
 * episodes fails on the one with a quotation mark in it, at which point the
 * page is empty and nothing says why.
 */

export interface FeedShow {
  title: string
  description: string
  artworkUrl: string | null
  link: string | null
  author: string | null
}

export interface FeedEpisode {
  /** The feed's own identifier. Our idempotency key, and never generated here. */
  guid: string
  title: string
  /** Show notes, as the host wrote them. HTML. */
  descriptionHtml: string
  audioUrl: string | null
  audioType: string | null
  audioBytes: number | null
  durationSeconds: number | null
  publishedAt: Date | null
  artworkUrl: string | null
  episodeNumber: number | null
  seasonNumber: number | null
  explicit: boolean
}

export interface ParsedFeed {
  show: FeedShow
  episodes: FeedEpisode[]
}

export class FeedError extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // Show notes arrive as CDATA full of markup; keep it whole and let the
  // renderer decide what is safe rather than letting the parser mangle it.
  cdataPropName: '__cdata',
  trimValues: true,
})

/** A tag that may be absent, a string, an object, or an array of either. */
function one(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value
}

function text(value: unknown): string | null {
  const v = one(value)
  if (v == null) return null
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object') {
    const record = v as Record<string, unknown>
    const cdata = record.__cdata
    if (typeof cdata === 'string') return cdata.trim() || null
    const inner = record['#text']
    if (typeof inner === 'string') return inner.trim() || null
  }
  return null
}

function attr(value: unknown, name: string): string | null {
  const v = one(value)
  if (v && typeof v === 'object') {
    const found = (v as Record<string, unknown>)[`@${name}`]
    if (typeof found === 'string') return found.trim() || null
    if (typeof found === 'number') return String(found)
  }
  return null
}

function integer(value: unknown): number | null {
  const raw = text(value)
  if (raw == null) return null
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * iTunes durations come as seconds, or mm:ss, or hh:mm:ss, depending on the
 * host and sometimes on the episode.
 */
export function parseDuration(raw: string | null): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)

  const parts = trimmed.split(':').map((p) => Number.parseInt(p, 10))
  if (parts.some((p) => !Number.isFinite(p))) return null
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
  return null
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

export function parseFeed(xml: string): ParsedFeed {
  let doc: Record<string, unknown>
  try {
    doc = parser.parse(xml) as Record<string, unknown>
  } catch (error) {
    throw new FeedError(`That feed is not valid XML: ${String(error)}`)
  }

  const rss = one(doc.rss) as Record<string, unknown> | undefined
  const channel = one(rss?.channel) as Record<string, unknown> | undefined
  if (!channel) throw new FeedError('No <channel> in that feed — is it an RSS feed?')

  const show: FeedShow = {
    title: text(channel.title) ?? 'Untitled show',
    description: text(channel['itunes:summary']) ?? text(channel.description) ?? '',
    artworkUrl:
      attr(channel['itunes:image'], 'href') ??
      text((one(channel.image) as Record<string, unknown> | undefined)?.url) ??
      null,
    link: text(channel.link),
    author: text(channel['itunes:author']),
  }

  const rawItems = channel.item
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : []

  const episodes: FeedEpisode[] = []
  for (const raw of items) {
    const item = raw as Record<string, unknown>

    /*
     * No guid, no episode.
     *
     * The guid is the only thing that makes a sync idempotent. Inventing one
     * from the title would mean an episode renamed at the host arrives as a
     * second copy, and the archive quietly fills with duplicates.
     */
    const guid = text(item.guid)
    if (!guid) continue

    const enclosure = one(item.enclosure)
    const durationRaw = text(item['itunes:duration'])

    episodes.push({
      guid,
      title: text(item.title) ?? 'Untitled episode',
      descriptionHtml:
        text(item['content:encoded']) ??
        text(item.description) ??
        text(item['itunes:summary']) ??
        '',
      audioUrl: attr(enclosure, 'url'),
      audioType: attr(enclosure, 'type'),
      audioBytes: (() => {
        const length = attr(enclosure, 'length')
        if (!length) return null
        const n = Number.parseInt(length, 10)
        return Number.isFinite(n) && n > 0 ? n : null
      })(),
      durationSeconds: parseDuration(durationRaw),
      publishedAt: parseDate(text(item.pubDate)),
      artworkUrl: attr(item['itunes:image'], 'href'),
      episodeNumber: integer(item['itunes:episode']),
      seasonNumber: integer(item['itunes:season']),
      explicit: (text(item['itunes:explicit']) ?? '').toLowerCase() === 'true' ||
        (text(item['itunes:explicit']) ?? '').toLowerCase() === 'yes',
    })
  }

  return { show, episodes }
}

/** Where the show lives. One place, so nothing hard-codes it twice. */
export const FEED_URL =
  process.env.PODCAST_FEED_URL ??
  'https://media.rss.com/brown-girls-need-healing-too/feed.xml'

export const SHOW_NAME = 'Brown Girls Need Healing Too'

export async function fetchFeed(url: string = FEED_URL): Promise<ParsedFeed> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'DivineFeminine/1.0 (+podcast sync)' },
      cache: 'no-store',
    })
  } catch (error) {
    throw new FeedError(`Could not reach the feed at ${url}: ${String(error)}`)
  }

  if (!response.ok) {
    throw new FeedError(`The feed at ${url} answered ${response.status}.`)
  }

  return parseFeed(await response.text())
}
