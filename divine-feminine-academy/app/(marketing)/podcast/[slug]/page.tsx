import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Rule } from '@/design-system/primitives'
import { Eyebrow, Prose, Section } from '@/design-system/patterns'
import { getEpisode, otherEpisodes } from '@/db/queries/podcast'
import { getChallenge } from '@/db/queries/challenges'
import { Markdown } from '@/features/writing/Markdown'
import { WritingOptIn } from '@/features/writing/WritingOptIn'
import { excerpt, formatDuration } from '@/features/writing/markdown'
import { showName } from '@/features/podcast/show'
import { siteUrl } from '@/lib/auth/env'
import { publicText } from '@/lib/utils/placeholder'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const episode = await getEpisode(slug)
  if (!episode) return { title: 'Not found' }

  const title = episode.seoTitle?.trim() || episode.title
  const description =
    episode.seoDescription?.trim() || episode.dek?.trim() || excerpt(episode.body)

  return {
    title,
    description,
    alternates: {
      canonical: `${siteUrl().replace(/\/$/, '')}/podcast/${episode.slug}`,
    },
    openGraph: {
      type: 'article',
      title,
      description,
      publishedTime: episode.publishedAt?.toISOString(),
      ...(episode.artworkUrl ? { images: [episode.artworkUrl] } : {}),
    },
    twitter: { card: 'summary_large_image', title, description },
  }
}

/**
 * One episode.
 *
 * Note what this page does NOT do: it does not let anybody edit the title,
 * the notes or the audio, because the feed owns those and a sync would
 * overwrite the edit within the hour. What it shows beyond the feed - the
 * transcript, and the one door at the bottom - is ours, and the sync is
 * forbidden from touching either.
 */
export default async function EpisodePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const episode = await getEpisode(slug)
  if (!episode) notFound()

  const [others, cta] = await Promise.all([
    otherEpisodes(episode),
    episode.ctaProgramSlug ? getChallenge(episode.ctaProgramSlug) : null,
  ])

  const base = siteUrl().replace(/\/$/, '')
  const transcript = publicText(episode.transcript)

  return (
    <>
      {/*
        Marked up as a PodcastEpisode so a search engine can show the player
        and the runtime rather than a blue link. The audio URL is the one from
        the feed, which is the same file the directories serve.
      */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'PodcastEpisode',
            name: episode.title,
            url: `${base}/podcast/${episode.slug}`,
            datePublished: episode.publishedAt?.toISOString(),
            ...(episode.episodeNumber
              ? { episodeNumber: episode.episodeNumber }
              : {}),
            partOfSeries: {
              '@type': 'PodcastSeries',
              name: showName,
              url: `${base}/podcast`,
            },
            ...(episode.audioUrl
              ? {
                  associatedMedia: {
                    '@type': 'MediaObject',
                    contentUrl: episode.audioUrl,
                  },
                }
              : {}),
          }),
        }}
      />

      <Section className="pt-14 md:pt-24">
        <Link
          href="/podcast"
          className="text-2xs uppercase tracking-[0.22em] text-clay-deep hover:text-plum"
        >
          {showName}
        </Link>

        <h1 className="mt-6 text-3xl md:text-4xl">{episode.title}</h1>

        <p className="mt-6 text-2xs uppercase tracking-[0.18em] text-ink-muted">
          {[
            episode.seasonNumber && episode.episodeNumber
              ? `Season ${episode.seasonNumber}, episode ${episode.episodeNumber}`
              : episode.episodeNumber
                ? `Episode ${episode.episodeNumber}`
                : null,
            formatDuration(episode.audioDurationSeconds),
            episode.publishedAt
              ? episode.publishedAt.toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>

        {episode.audioUrl ? (
          <>
            <audio
              controls
              preload="none"
              src={episode.audioUrl}
              className="mt-8 w-full"
            >
              Your browser cannot play audio.{' '}
              <a href={episode.audioUrl}>Download the episode</a> instead.
            </audio>
            <p className="mt-3 text-2xs text-ink-muted">
              <a
                href={episode.audioUrl}
                className="underline underline-offset-2"
                download
              >
                Download
              </a>{' '}
              · or find it in{' '}
              <Link href="/podcast" className="underline underline-offset-2">
                your podcast app
              </Link>
            </p>
          </>
        ) : (
          <p className="mt-8 text-sm text-ink-muted">
            The audio for this episode is not available here.{' '}
            <Link href="/podcast" className="underline underline-offset-4">
              Listen in your podcast app
            </Link>
            .
          </p>
        )}
      </Section>

      {episode.body.trim().length > 0 && (
        <Section>
          <Rule tone="gilt" />
          <h2 className="mt-12 text-xl">Show notes</h2>
          <div className="mt-6">
            <Markdown source={episode.body} />
          </div>
        </Section>
      )}

      {transcript && (
        <Section>
          <details className="rounded-lg border border-rule bg-alabaster p-6">
            <summary className="cursor-pointer list-none font-display text-xl">
              Read the transcript
            </summary>
            <div className="mt-6">
              <Markdown source={transcript} />
            </div>
          </details>
        </Section>
      )}

      {/*
        The one door.
        Chosen per episode by Quiana and stored on the row; the sync never
        touches it. An episode about money can send a listener somewhere
        different from an episode about her mother, which is the entire reason
        this column exists.
      */}
      <Section>
        <Rule tone="gilt" />
        <div className="mt-12">
          {cta ? (
            <>
              <Eyebrow>If this one was about you</Eyebrow>
              <h2 className="mt-5 text-2xl md:text-4xl">{cta.title}</h2>
              {cta.subtitle && (
                <Prose className="mt-6 text-lg">
                  <p>{cta.subtitle}</p>
                </Prose>
              )}
              <Link
                href={`/challenges/${cta.slug}`}
                className="mt-8 inline-flex min-h-11 items-center text-sm underline underline-offset-4 hover:text-clay-deep"
              >
                Start it
              </Link>
            </>
          ) : (
            <>
              <Eyebrow>If this one was about you</Eyebrow>
              <h2 className="mt-5 text-2xl md:text-4xl">
                Naming it is the first half.
              </h2>
              <Prose className="mt-6 text-lg">
                <p>
                  The Divine Feminine is the other half — the work of actually
                  changing what you just heard yourself recognise.
                </p>
              </Prose>
              <Link
                href="/the-divine-feminine"
                className="mt-8 inline-flex min-h-11 items-center text-sm underline underline-offset-4 hover:text-clay-deep"
              >
                The Divine Feminine
              </Link>
            </>
          )}
        </div>
      </Section>

      {others.length > 0 && (
        <Section>
          <h2 className="text-xl">More episodes</h2>
          <ul className="mt-6 divide-y divide-rule border-y border-rule">
            {others.map((other) => (
              <li key={other.id}>
                <Link
                  href={`/podcast/${other.slug}`}
                  className="flex min-h-11 flex-col gap-1 py-5 hover:text-clay-deep"
                >
                  <span className="font-display text-lg leading-snug">
                    {other.title}
                  </span>
                  <span className="text-2xs uppercase tracking-[0.18em] text-ink-muted">
                    {formatDuration(other.audioDurationSeconds) ?? 'Episode'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section className="pb-24">
        <WritingOptIn
          slug={episode.slug}
          headline={publicText(episode.upgradeHeadline) ?? 'Told when a new one lands'}
          blurb="One email when there is a new episode. Nothing else."
          buttonLabel="Tell me when there is a new one"
        />
      </Section>
    </>
  )
}
