import type { Metadata } from 'next'
import Link from 'next/link'
import { Button } from '@/design-system/primitives'
import { Eyebrow, Placeholder, Prose, Section } from '@/design-system/patterns'

export const metadata: Metadata = {
  title: 'Stories',
  description: 'Words from women who have done the work.',
}

/**
 * NO INVENTED TESTIMONIALS. Ever.
 *
 * When real ones exist they come from the `testimonials` table, which has an
 * `is_placeholder` flag and a `consented_at` column precisely so that made-up
 * social proof cannot ship by accident. Until then this page says so out loud.
 */
export default function StoriesPage() {
  return (
    <Section className="pt-14 md:pt-24 pb-24">
      <Eyebrow>Stories</Eyebrow>
      <h1 className="mt-6 text-3xl md:text-4xl">Nothing here yet.</h1>
      <Prose className="mt-8 text-lg">
        <p>
          No women have been through this yet, so there is nothing honest to put
          on this page. When there is, it will be their words, with their
          permission, with their names on it.
        </p>
      </Prose>

      <Placeholder
        label="Deliberately empty"
        note="do not fill with examples"
        className="mt-12"
      >
        <Prose className="text-sm">
          <p>
            Real testimonials get added in the admin and are stored with a
            consent timestamp. Anything written to fill the space in the
            meantime must be flagged as a placeholder, or it becomes a false
            claim the moment the site goes live.
          </p>
        </Prose>
      </Placeholder>

      <div className="mt-14">
        <h2 className="text-xl">Be one of the first</h2>
        <Prose className="mt-3 text-sm">
          <p>ME VS HER is eleven dollars, and it starts whenever you do.</p>
        </Prose>
        <Button className="mt-6" asChild>
          <Link href="/me-vs-her">Start ME VS HER</Link>
        </Button>
      </div>
    </Section>
  )
}
