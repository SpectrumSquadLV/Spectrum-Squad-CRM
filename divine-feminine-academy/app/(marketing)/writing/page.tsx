import type { Metadata } from 'next'
import Link from 'next/link'
import { db } from '@/db/client'
import { Eyebrow, Prose, Section } from '@/design-system/patterns'
import { listPublished } from '@/db/queries/writing'
import { ArticleCard } from '@/features/writing/ArticleCard'
import { WritingOptIn } from '@/features/writing/WritingOptIn'

export const metadata: Metadata = {
  title: 'Writing',
  description:
    'Essays and episodes on the four rooms — Self, Love, Life and Wealth — and the versions of you that show up in them.',
  alternates: { types: { 'application/rss+xml': '/writing/rss.xml' } },
}

export const dynamic = 'force-dynamic'

export default async function WritingIndex() {
  // Essays only. Episodes were listed here when the podcast had nowhere else
  // to live; it has /podcast now, and an episode appearing in both places
  // splits the one thing each page is for.
  const pieces = await listPublished(db, { kind: 'article', limit: 30 })

  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>Writing</Eyebrow>
      <h1 className="mt-6 text-3xl md:text-5xl">
        The long version of everything.
      </h1>
      <Prose className="mt-8 text-lg">
        <p>
          Essays and episodes about the four rooms, and about the versions of
          you that turn up in them.
        </p>
      </Prose>

      <p className="mt-6 flex flex-wrap gap-5 text-sm">
        <Link href="/listen" className="underline underline-offset-4 decoration-clay">
          Episodes only
        </Link>
        <Link
          href="/writing/rss.xml"
          className="underline underline-offset-4 decoration-clay"
        >
          RSS
        </Link>
      </p>

      {pieces.length === 0 ? (
        <div className="mt-16 rounded-xl border border-dashed border-rule-strong p-8">
          <h2 className="font-display text-xl">Nothing published yet.</h2>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-soft">
            Write the first one in the admin, under Writing. A draft stays
            invisible here until you publish it, and a date in the future means
            it goes live by itself when that day comes.
          </p>
        </div>
      ) : (
        <div className="mt-16 space-y-14">
          {pieces.map((piece) => (
            <ArticleCard key={piece.id} article={piece} />
          ))}
        </div>
      )}

      <div className="mt-24">
        <WritingOptIn
          slug=""
          headline="Get the next one"
          blurb="No schedule I am going to pretend to keep. When something is written, you get it."
          buttonLabel="Send me the next one"
        />
      </div>
    </Section>
  )
}
