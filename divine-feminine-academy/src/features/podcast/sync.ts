import 'server-only'
import { and, eq } from 'drizzle-orm'
import type { Db } from '@/db/client'
import { articles } from '@/db/schema/content'
import { slugify } from '@/features/writing/markdown'
import { fetchFeed, type FeedEpisode, type ParsedFeed } from './feed'

/**
 * Bringing the show's episodes into the database.
 *
 * The division of ownership is the whole design, and it is strict.
 *
 * THE FEED OWNS: title, show notes, audio, artwork, duration, publish date,
 * episode and season numbers. A sync writes those every time, so correcting a
 * typo at RSS.com corrects it here.
 *
 * WE OWN: the transcript, which door the episode points at, whether it is
 * featured, the area it belongs to, and the opt-in copy. A sync never touches
 * any of them. Losing an hour of transcript work because somebody re-uploaded
 * an episode would be unforgivable and is the reason these are listed here
 * rather than left to whatever the update happens to include.
 *
 * Idempotent on the feed's guid. Running it every hour costs one request and
 * writes nothing when nothing changed.
 */

export interface SyncResult {
  show: string
  added: number
  updated: number
  unchanged: number
  skipped: number
  errors: string[]
}

/** A slug that reads like a URL and stays stable while the title does. */
function slugFor(episode: FeedEpisode): string {
  const base = slugify(episode.title).slice(0, 70)
  if (base) return base
  // A title of nothing but punctuation still needs somewhere to live.
  return `episode-${episode.episodeNumber ?? Math.abs(hash(episode.guid)) % 100000}`
}

function hash(value: string): number {
  let h = 0
  for (let i = 0; i < value.length; i++) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0
  return h
}

/** Unique per show, so two episodes with the same title do not collide. */
async function freeSlug(db: Db, wanted: string, guid: string): Promise<string> {
  const [taken] = await db
    .select({ id: articles.id, feedGuid: articles.feedGuid })
    .from(articles)
    .where(eq(articles.slug, wanted))
    .limit(1)

  if (!taken || taken.feedGuid === guid) return wanted
  return `${wanted}-${Math.abs(hash(guid)) % 9999}`
}

export async function syncFeed(
  db: Db,
  options: { feed?: ParsedFeed; url?: string } = {},
): Promise<SyncResult> {
  const feed = options.feed ?? (await fetchFeed(options.url))

  const result: SyncResult = {
    show: feed.show.title,
    added: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    errors: [],
  }

  for (const episode of feed.episodes) {
    try {
      if (!episode.audioUrl) {
        result.skipped++
        result.errors.push(`"${episode.title}" has no audio in the feed`)
        continue
      }

      const [existing] = await db
        .select({
          id: articles.id,
          slug: articles.slug,
          title: articles.title,
          body: articles.body,
          audioUrl: articles.audioUrl,
          publishedAt: articles.publishedAt,
          status: articles.status,
        })
        .from(articles)
        .where(and(eq(articles.feedGuid, episode.guid), eq(articles.kind, 'episode')))
        .limit(1)

      // Only what the feed owns.
      const fromFeed = {
        title: episode.title,
        body: episode.descriptionHtml,
        audioUrl: episode.audioUrl,
        audioDurationSeconds: episode.durationSeconds,
        audioSizeBytes: episode.audioBytes,
        artworkUrl: episode.artworkUrl ?? feed.show.artworkUrl,
        episodeNumber: episode.episodeNumber,
        seasonNumber: episode.seasonNumber,
        publishedAt: episode.publishedAt,
        feedSyncedAt: new Date(),
        updatedAt: new Date(),
      }

      if (!existing) {
        await db.insert(articles).values({
          ...fromFeed,
          kind: 'episode',
          /*
           * Published, because it already is.
           *
           * An episode in a public feed is public everywhere Apple and Spotify
           * reach. Importing it as a draft would hide on this site something
           * the world can already hear, and somebody would have to press
           * publish on every one of them to undo that.
           */
          status: 'published',
          slug: await freeSlug(db, slugFor(episode), episode.guid),
          feedGuid: episode.guid,
          authorName: feed.show.author,
        })
        result.added++
        continue
      }

      const changed =
        existing.title !== fromFeed.title ||
        existing.body !== fromFeed.body ||
        existing.audioUrl !== fromFeed.audioUrl ||
        existing.publishedAt?.getTime() !== fromFeed.publishedAt?.getTime()

      if (!changed) {
        await db
          .update(articles)
          .set({ feedSyncedAt: fromFeed.feedSyncedAt })
          .where(eq(articles.id, existing.id))
        result.unchanged++
        continue
      }

      /*
       * The slug is deliberately NOT updated.
       *
       * It is the episode's address. A title tightened six months after
       * publication would otherwise move the page, break every link anybody
       * shared, and drop whatever search ranking it had.
       */
      await db.update(articles).set(fromFeed).where(eq(articles.id, existing.id))
      result.updated++
    } catch (error) {
      result.skipped++
      result.errors.push(`"${episode.title}": ${String(error)}`)
    }
  }

  return result
}
