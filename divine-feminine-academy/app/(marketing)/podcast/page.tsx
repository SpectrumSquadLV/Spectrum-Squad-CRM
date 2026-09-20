import type { Metadata } from 'next'
import Link from 'next/link'
import { Rule } from '@/design-system/primitives'
import { Eyebrow, Prose, Section, StaffNote } from '@/design-system/patterns'
import { featuredEpisode, listEpisodes } from '@/db/queries/podcast'
import { formatDuration } from '@/features/writing/markdown'
import { WritingOptIn } from '@/features/writing/WritingOptIn'
import { listenLinks, missingListenLinks, showName } from '@/features/podcast/show'
import { FEED_URL } from '@/features/podcast/feed'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Brown Girls Need Healing Too',
  description:
    'The podcast. Conversations about what we carry, what it costs, and what it takes to put it down.',
  alternates: { types: { 'application/rss+xml': FEED_URL } },
  openGraph: {
    title: 'Brown Girls Need Healing Too',
    type: 'website',
  },
}

/**
 * The podcast, as its own front door.
 *
 * It is not a section of the writing index and it is not a marketing page for
 * a programme. It is the media arm of the whole thing - the way most women
 * meet Quiana before they ever see a challenge - so it gets a hub of its own
 * and the episodes get canonical URLs under /podcast.
 *
 * Episodes are never authored here. They are synced from the RSS feed the show
 * is already hosted on, which is what Apple and Spotify read, so this page can
 * never disagree with what a listener hears in their app.
 */
export default async function PodcastPage() {
  const [featured, episodes] = await Promise.all([
    featuredEpisode(),
    listEpisodes({ limit: 100 }),
  ])

  const rest = featured ? episodes.filter((e) => e.id !== featured.id) : episodes
  const links = listenLinks()
  const missing = missingListenLinks()

  return (
    <>
      <Section className="pt-14 md:pt-24">
        <Eyebrow>The podcast</Eyebrow>
        <h1 className="mt-6 text-3xl md:text-5xl">{showName}</h1>
        <Prose className="mt-8 text-lg">
          <p>
            Conversations about what we carry — where it came from, what it has
            been costing, and what it actually takes to put it down.
          </p>
        </Prose>

        <ul className="mt-10 flex flex-wrap gap-x-6 gap-y-3">
          {links.map((link) => (
            <li key={link.label}>
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center text-sm underline underline-offset-4 decoration-clay hover:text-clay-deep"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        {missing.length > 0 && (
          <StaffNote what="the directory links" className="mt-8">
            <p>
              The show is listed in places this site cannot discover on its
              own. Set {missing.join(', ')} in the environment and the buttons
              appear. Until then only the RSS link shows, because a Listen on
              Apple Podcasts button that goes nowhere is worse than none.
            </p>
          </StaffNote>
        )}
      </Section>

      {featured && (
        <Section>
          <Rule tone="gilt" />
          <Eyebrow className="mt-12">
            {featured.featuredAt ? 'Start here' : 'Latest episode'}
          </Eyebrow>
          <h2 className="mt-5 text-2xl md:text-4xl">
            <Link
              href={`/podcast/${featured.slug}`}
              className="hover:text-clay-deep"
            >
              {featured.title}
            </Link>
          </h2>
          <p className="mt-4 text-2xs uppercase tracking-[0.18em] text-ink-muted">
            {[
              featured.episodeNumber ? `Episode ${featured.episodeNumber}` : null,
              formatDuration(featured.audioDurationSeconds),
              featured.publishedAt
                ? featured.publishedAt.toLocaleDateString('en-US', {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                  })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>

          {featured.audioUrl && (
            <audio
              controls
              preload="none"
              src={featured.audioUrl}
              className="mt-8 w-full"
            >
              Your browser cannot play audio.{' '}
              <a href={featured.audioUrl}>Download the episode</a> instead.
            </audio>
          )}

          <Link
            href={`/podcast/${featured.slug}`}
            className="mt-6 inline-flex min-h-11 items-center text-sm underline underline-offset-4 hover:text-clay-deep"
          >
            Show notes
          </Link>
        </Section>
      )}

      <Section>
        <Rule tone="gilt" />
        <h2 className="mt-12 text-2xl">
          {rest.length > 0 ? 'Every episode' : 'Episodes'}
        </h2>

        {episodes.length === 0 ? (
          <>
            <Prose className="mt-6">
              <p>
                The episodes are on their way here. In the meantime the show is
                live wherever you already listen.
              </p>
            </Prose>
            <StaffNote what="the first sync" className="mt-8">
              <p>
                No episodes are in the database yet. Run the sync from
                /admin/writing, or POST to /api/podcast/sync with the cron
                secret. It reads {FEED_URL} and imports everything on it.
              </p>
              <p>
                If the sync reports nothing, check that the feed URL is right —
                it can be overridden with PODCAST_FEED_URL.
              </p>
            </StaffNote>
          </>
        ) : (
          <ol className="mt-10 divide-y divide-rule border-y border-rule">
            {rest.map((episode) => (
              <li key={episode.id}>
                <Link
                  href={`/podcast/${episode.slug}`}
                  className="group flex flex-col gap-2 py-7 md:flex-row md:items-baseline md:gap-8"
                >
                  <p className="text-2xs uppercase tracking-[0.18em] text-ink-muted md:w-44 md:shrink-0">
                    {[
                      episode.episodeNumber ? `Ep. ${episode.episodeNumber}` : null,
                      formatDuration(episode.audioDurationSeconds),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <h3 className="font-display text-xl leading-snug transition-colors group-hover:text-clay-deep md:text-2xl">
                    {episode.title}
                  </h3>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section className="pb-24">
        <Rule tone="gilt" />
        <div className="mt-12">
          <h2 className="text-2xl md:text-4xl">
            If an episode landed somewhere real
          </h2>
          <Prose className="mt-6 text-lg">
            <p>
              The podcast is where it gets named. The Divine Feminine is where
              it gets changed.
            </p>
          </Prose>
          <Link
            href="/the-divine-feminine"
            className="mt-8 inline-flex min-h-11 items-center text-sm underline underline-offset-4 hover:text-clay-deep"
          >
            The Divine Feminine
          </Link>
        </div>

        <div className="mt-20">
          <WritingOptIn
            slug=""
            headline="Told when a new one lands"
            blurb="One email when there is a new episode. Nothing else."
            buttonLabel="Tell me when there is a new one"
          />
        </div>
      </Section>
    </>
  )
}
