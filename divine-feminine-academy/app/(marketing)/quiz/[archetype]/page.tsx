import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Button, Rule } from '@/design-system/primitives'
import { Eyebrow, Prose, Section } from '@/design-system/patterns'
import { archetypeBySlug, archetypeList } from '@/features/quiz/archetypes'

/**
 * The public page for one of the four.
 *
 * This is the growth loop, so it is a real page rather than a redirect into
 * the quiz: statically prerendered, indexable, and readable by somebody who
 * has never heard of us and arrived because a friend sent it. It touches no
 * database and knows nothing about the woman who shared it.
 */
export function generateStaticParams() {
  return archetypeList.map((a) => ({ archetype: a.slug }))
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ archetype: string }>
}): Promise<Metadata> {
  const { archetype: slug } = await params
  const archetype = archetypeBySlug(slug)
  if (!archetype) return { title: 'Not found' }

  const title = `${archetype.name} — ${archetype.tagline}`
  return {
    title,
    description: archetype.oneLiner,
    openGraph: { title, description: archetype.shareLine },
    twitter: { card: 'summary_large_image', title, description: archetype.shareLine },
  }
}

export default async function ArchetypePage({
  params,
}: {
  params: Promise<{ archetype: string }>
}) {
  const { archetype: slug } = await params
  const archetype = archetypeBySlug(slug)
  if (!archetype) notFound()

  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>One of the four</Eyebrow>
      <h1 className="mt-6 text-4xl md:text-6xl">{archetype.name}</h1>
      <p className="mt-4 font-display text-xl text-clay-deep md:text-2xl">
        {archetype.tagline}
      </p>

      <Prose className="mt-8 text-lg">
        <p>{archetype.oneLiner}</p>
      </Prose>

      <Rule tone="gilt" className="my-12" />

      <div className="grid gap-12 md:grid-cols-2">
        <section>
          <h2 className="font-display text-xl">What it sounds like</h2>
          <ul className="mt-5 space-y-3">
            {archetype.soundsLike.map((line) => (
              <li
                key={line}
                className="border-l-2 border-gilt pl-4 font-display text-lg leading-snug"
              >
                “{line}”
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="font-display text-xl">What it looks like</h2>
          <ul className="mt-5 space-y-3 text-sm leading-relaxed text-ink-soft">
            {archetype.looksLike.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </div>

      <section className="mt-14 rounded-xl border border-rule bg-alabaster p-6 md:p-8">
        <h2 className="font-display text-xl">What she is protecting</h2>
        <Prose className="mt-4">
          <p>{archetype.protecting}</p>
        </Prose>
      </section>

      <section className="mt-14 rounded-xl border border-clay bg-plum-wash p-6 md:p-8">
        <p className="text-2xs uppercase tracking-[0.2em] text-plum">
          The return
        </p>
        <p className="mt-4 font-display text-2xl leading-snug">
          {archetype.theReturn}
        </p>
      </section>

      <Rule tone="gilt" className="my-14" />

      <section>
        <h2 className="text-2xl md:text-3xl">
          Is she actually the one running yours?
        </h2>
        <Prose className="mt-5 text-lg">
          <p>
            There are four, and most women recognise themselves in more than
            one. Twelve questions, about ninety seconds, and you get the whole
            read — including the one line that usually lands hardest.
          </p>
        </Prose>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/quiz">Take the quiz — free</Link>
          </Button>
        </div>
      </section>

      <section className="mt-20 border-t border-rule pt-10">
        <h2 className="font-display text-lg">The other three</h2>
        <ul className="mt-5 grid gap-3 sm:grid-cols-3">
          {archetypeList
            .filter((a) => a.slug !== archetype.slug)
            .map((a) => (
              <li key={a.slug}>
                <Link
                  href={`/quiz/${a.slug}`}
                  className="block h-full rounded-lg border border-rule bg-alabaster p-5 transition-colors hover:border-clay"
                >
                  <h3 className="font-display text-base">{a.name}</h3>
                  <p className="mt-1.5 text-2xs text-ink-muted">{a.tagline}</p>
                </Link>
              </li>
            ))}
        </ul>
      </section>
    </Section>
  )
}
