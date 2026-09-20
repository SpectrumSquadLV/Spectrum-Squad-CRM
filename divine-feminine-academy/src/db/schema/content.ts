import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { areaEnum, primaryId, timestamps } from './_shared'

/**
 * WRITING.
 *
 * The top of the funnel that nothing else replaces. A quiz reaches the woman
 * who already found us; writing is how she finds us at all.
 *
 * An article and a podcast episode are the same row with a different `kind`.
 * They have the same title, the same slug, the same body, the same SEO, the
 * same opt-in — an episode just also has a file. Two tables would have meant
 * two admin screens, two templates and two sitemaps to keep in step, and the
 * first time they drifted apart nobody would notice for a month.
 */
export const articleKindEnum = pgEnum('article_kind', ['article', 'episode'])

export const articleStatusEnum = pgEnum('article_status', [
  'draft',
  'published',
  'archived',
])

export const articles = pgTable(
  'articles',
  {
    id: primaryId(),
    slug: text('slug').notNull(),
    kind: articleKindEnum('kind').notNull().default('article'),
    status: articleStatusEnum('status').notNull().default('draft'),

    title: text('title').notNull(),
    /** The standfirst. One or two sentences under the headline. */
    dek: text('dek'),
    /** Restricted Markdown. See src/features/writing/markdown.ts. */
    body: text('body').notNull().default(''),

    authorName: text('author_name'),
    heroImageUrl: text('hero_image_url'),
    heroImageAlt: text('hero_image_alt'),

    /** Which of the four rooms it is about, if any. */
    area: areaEnum('area'),
    /**
     * Which protective mode it speaks to, if any. Text rather than an enum for
     * the same reason the result is: the four are a content decision, and
     * renaming one should not need a migration.
     */
    archetype: text('archetype'),

    /** Episodes only. */
    audioUrl: text('audio_url'),
    audioDurationSeconds: integer('audio_duration_seconds'),
    audioSizeBytes: integer('audio_size_bytes'),

    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),

    /**
     * The content upgrade. The reason a piece of writing earns an email
     * address instead of just a visit.
     */
    upgradeHeadline: text('upgrade_headline'),
    upgradeBlurb: text('upgrade_blurb'),
    /** The tag she is given when she takes it, so the list is segmented. */
    upgradeTag: text('upgrade_tag'),

    /**
     * When it goes live.
     *
     * In the future means scheduled: every public query asks for published AND
     * `published_at <= now()`, so scheduling costs nothing extra and there is
     * no second mechanism that can disagree with this one.
     */
    /*
     * Podcast episodes that came from the show's own feed.
     *
     * RSS.com hosts Brown Girls Need Healing Too and that feed is what Apple
     * and Spotify already have, so it is the source of truth for anything it
     * carries: title, description, audio, artwork, publish date. A sync writes
     * those and nothing else.
     *
     * The columns below the guid are OURS. A feed has no idea which challenge
     * an episode should point a listener at, what the transcript says, or
     * which topics it belongs to - and a sync must never overwrite them.
     */
    feedGuid: text('feed_guid'),
    feedSyncedAt: timestamp('feed_synced_at', { withTimezone: true }),
    artworkUrl: text('artwork_url'),
    episodeNumber: integer('episode_number'),
    seasonNumber: integer('season_number'),
    /** Full text, when there is one. Rendered through the same safe parser. */
    transcript: text('transcript'),
    /**
     * Which door this episode sends a listener to.
     *
     * A programme slug, or 'the-divine-feminine'. Deliberately per-episode:
     * an episode about money should not push a challenge about identity, and
     * hard-coding one destination across a whole show is how a podcast stops
     * converting.
     */
    ctaProgramSlug: text('cta_program_slug'),
    /** Set to pin an episode to the top of the hub. Newest wins when null. */
    featuredAt: timestamp('featured_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),

    /**
     * When the "there is something new" email went out.
     *
     * A column rather than a derived check, because the question being asked
     * is "has this ever been announced", and the answer has to survive the
     * announcement job being re-run, the post being edited, and its date being
     * changed. Null means it has not gone out; it is never set twice.
     */
    announcedAt: timestamp('announced_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('articles_slug_key').on(t.slug),
    index('articles_published_idx').on(t.status, t.publishedAt),
    index('articles_kind_idx').on(t.kind, t.publishedAt),
  ],
)
