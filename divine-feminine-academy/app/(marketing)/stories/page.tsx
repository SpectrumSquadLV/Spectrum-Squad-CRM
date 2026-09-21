import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Rule } from '@/design-system/primitives'
import { Eyebrow, Prose, Section, StaffNote } from '@/design-system/patterns'
import { getActor } from '@/lib/auth/actor-server'
import { isAdmin } from '@/lib/permissions/actor'

/** Reads the session to decide whether it exists at all. */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Stories',
  // Belt and braces alongside the 404 below: if this page is ever opened up
  // before there is anything on it, it still must not be indexed.
  robots: { index: false, follow: false },
}

/**
 * UNPUBLISHED, on purpose, and a 404 to everybody but an admin.
 *
 * It used to be a live page that said "Nothing here yet" with a dashed box
 * underneath explaining to any passing stranger that the testimonials had not
 * been collected. That is a page announcing the business is new, linked from
 * the footer, indexed, and reachable from a Google search for her name.
 *
 * So it is gone until there is something true to put on it. Not hidden behind
 * a redirect and not softened into a coming-soon - a 404, which is the honest
 * status code for a page that does not exist yet, and the only one that keeps
 * it out of an index.
 *
 * The architecture underneath stays exactly where it is. The `testimonials`
 * table has `is_placeholder` and `consented_at` columns precisely so that
 * invented social proof cannot ship by accident, and when real women have
 * said real things with their permission, this page turns on by deleting the
 * notFound() below.
 */
export default async function StoriesPage() {
  const actor = await getActor()
  if (!isAdmin(actor)) notFound()

  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>Stories</Eyebrow>
      <h1 className="mt-6 text-3xl md:text-4xl">
        Nobody else can see this page.
      </h1>

      <StaffNote what="real stories, with consent" className="mt-10">
        <p>
          This page returns a 404 to everybody who is not signed in as an
          admin, and it is in no sitemap and no navigation. That is deliberate:
          an empty testimonials page tells a visitor the business has no
          customers, which is worse than having no page at all.
        </p>
        <p>
          When women have been through this and have said something you are
          allowed to quote, add them in the admin — they are stored with a
          consent timestamp — and remove the notFound() at the top of this
          file. Nothing else needs changing.
        </p>
        <p>
          Never fill this with examples, composites or “representative”
          quotes. One invented testimonial undoes every honest thing on the
          rest of the site.
        </p>
      </StaffNote>

      <Rule tone="gilt" className="my-12" />

      <Prose>
        <p>
          The rest of the site is at{' '}
          <Link href="/" className="underline underline-offset-4">
            the home page
          </Link>
          .
        </p>
      </Prose>
    </Section>
  )
}
