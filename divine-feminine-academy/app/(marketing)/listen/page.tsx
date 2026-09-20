import type { Metadata } from 'next'
import Link from 'next/link'
import { db } from '@/db/client'
import { Eyebrow, Prose, Section } from '@/design-system/patterns'
import { listPublished } from '@/db/queries/writing'
import { ArticleCard } from '@/features/writing/ArticleCard'
import { WritingOptIn } from '@/features/writing/WritingOptIn'

export const metadata: Metadata = {
  title: 'Listen',
  description: 'Episodes on the four rooms and the versions of you in them.',
  alternates: { types: { 'application/rss+xml': '/writing/rss.xml' } },
}

export const dynamic = 'force-dynamic'

export default async function ListenIndex() {
  const episodes = await listPublished(db, { kind: 'episode', limit: 50 })

  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>Listen</Eyebrow>
      <h1 className="mt-6 text-3xl md:text-5xl">In your ears.</h1>
      <Prose className="mt-8 text-lg">
        <p>Same four rooms, for when reading is not what you have in you.</p>
      </Prose>

      <p className="mt-6 flex flex-wrap gap-5 text-sm">
        <Link href="/writing" className="underline underline-offset-4 decoration-clay">
          Everything
        </Link>
        <Link
          href="/writing/rss.xml"
          className="underline underline-offset-4 decoration-clay"
        >
          Subscribe by RSS
        </Link>
      </p>

      {episodes.length === 0 ? (
        <div className="mt-16 rounded-xl border border-dashed border-rule-strong p-8">
          <h2 className="font-display text-xl">No episodes yet.</h2>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-soft">
            An episode is a piece of writing with an audio file on it. Add one
            in the admin, under Writing, and set its kind to Episode — the feed
            at <code>/writing/rss.xml</code> carries it to podcast apps.
          </p>
        </div>
      ) : (
        <div className="mt-16 space-y-14">
          {episodes.map((episode) => (
            <ArticleCard key={episode.id} article={episode} />
          ))}
        </div>
      )}

      <div className="mt-24">
        <WritingOptIn
          slug=""
          headline="Told when a new one lands"
          blurb="One email when there is a new episode. Nothing else."
          buttonLabel="Tell me when there is a new one"
        />
      </div>
    </Section>
  )
}
