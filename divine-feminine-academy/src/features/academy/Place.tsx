import Link from 'next/link'

/**
 * HER, and the private pages.
 *
 * These are not features listed under the library; they are the two places in
 * the world that are hers rather than made for her. So they get the same
 * editorial treatment as a library entry at a smaller scale - a hairline
 * above, a display title, one line, and a way in - rather than being demoted
 * to cards at the bottom of the page.
 *
 * `standing` is the one place real data appears, and only when there IS real
 * data. An empty state that invents a number ("0 truths named") turns a place
 * she has not been yet into a scoreboard she is losing. Nothing is better.
 */
export function Place({
  title,
  line,
  action,
  href,
  standing,
}: {
  title: string
  line: string
  action: string
  href: string
  /** A true count of her own, or null. Never a zero dressed as progress. */
  standing?: string | null
}) {
  return (
    <div className="border-t border-rule pt-7">
      <Link
        href={href}
        className="group block rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-plum focus-visible:ring-offset-4 focus-visible:ring-offset-bone"
      >
        <h3 className="font-display text-2xl leading-tight text-ink">{title}</h3>

        <p className="measure mt-3 text-sm leading-relaxed text-ink-soft">
          {line}
        </p>

        {standing && (
          <p className="mt-3 text-2xs uppercase tracking-[0.18em] text-clay-deep">
            {standing}
          </p>
        )}

        <p className="mt-6 inline-flex items-center gap-2 text-2xs uppercase tracking-[0.22em] text-clay-deep">
          {action}
          <span
            aria-hidden
            className="transition-transform duration-500 ease-out group-hover:translate-x-1 motion-reduce:transition-none"
          >
            &rarr;
          </span>
        </p>
      </Link>
    </div>
  )
}
