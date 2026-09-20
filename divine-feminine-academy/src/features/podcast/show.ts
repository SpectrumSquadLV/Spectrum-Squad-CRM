import { FEED_URL, SHOW_NAME } from './feed'

/**
 * Where the show can be subscribed to.
 *
 * The directory URLs are environment variables rather than constants because
 * they are assigned by Apple and Spotify when a show is submitted, and nobody
 * can know them from here. An unset one is simply not shown - a "Listen on
 * Apple Podcasts" button that 404s is worse than no button - and the admin
 * sees a note asking for it.
 *
 * The RSS link is always there. It is the only one that cannot be wrong,
 * because it is the feed everything else is built from.
 */
export interface ListenLink {
  label: string
  href: string
}

export const showName = SHOW_NAME

export function listenLinks(): ListenLink[] {
  const links: ListenLink[] = []

  const apple = process.env.PODCAST_APPLE_URL?.trim()
  const spotify = process.env.PODCAST_SPOTIFY_URL?.trim()
  const youtube = process.env.PODCAST_YOUTUBE_URL?.trim()

  if (apple) links.push({ label: 'Apple Podcasts', href: apple })
  if (spotify) links.push({ label: 'Spotify', href: spotify })
  if (youtube) links.push({ label: 'YouTube', href: youtube })

  links.push({ label: 'RSS', href: FEED_URL })
  return links
}

/** Which directories have no link yet, for the note only Quiana sees. */
export function missingListenLinks(): string[] {
  const missing: string[] = []
  if (!process.env.PODCAST_APPLE_URL?.trim()) missing.push('PODCAST_APPLE_URL')
  if (!process.env.PODCAST_SPOTIFY_URL?.trim()) missing.push('PODCAST_SPOTIFY_URL')
  if (!process.env.PODCAST_YOUTUBE_URL?.trim()) missing.push('PODCAST_YOUTUBE_URL')
  return missing
}
