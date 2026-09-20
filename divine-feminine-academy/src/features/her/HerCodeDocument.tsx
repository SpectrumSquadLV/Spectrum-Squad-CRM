import { cn } from '@/lib/utils/cn'

export interface HerCodeSections {
  lines: string[]
  declaration: string
}

export function parseSections(raw: unknown): HerCodeSections {
  const value = (raw ?? {}) as Record<string, unknown>
  const lines = Array.isArray(value.lines)
    ? value.lines.filter(
        (l): l is string => typeof l === 'string' && l.trim() !== '',
      )
    : []
  const declaration =
    typeof value.declaration === 'string' ? value.declaration : ''
  return { lines, declaration }
}

/**
 * The HER Code.
 *
 * This is the growth loop, not the last screen of a challenge. If it is
 * beautiful enough that she screenshots it and posts it, acquisition gets much
 * cheaper - so it is built to a 9:16 phone screen first and treated as a
 * marketing asset with a design budget.
 *
 * Deliberately: no logo lockup competing with her words, one gilt hairline,
 * her sentences in display type at a size that survives a screenshot.
 */
export function HerCodeDocument({
  sections,
  name,
  dateLabel,
  className,
}: {
  sections: HerCodeSections
  name?: string | null
  dateLabel?: string
  className?: string
}) {
  return (
    <article
      className={cn(
        'relative overflow-hidden rounded-xl border border-rule bg-alabaster',
        'px-7 py-12 sm:px-12 sm:py-16',
        className,
      )}
    >
      {/* The only gold on the page: two hairlines. */}
      <div aria-hidden className="absolute inset-x-7 top-7 h-px bg-gilt/40 sm:inset-x-12" />
      <div aria-hidden className="absolute inset-x-7 bottom-7 h-px bg-gilt/40 sm:inset-x-12" />

      <header className="text-center">
        <p className="text-2xs uppercase tracking-[0.3em] text-clay-deep">
          HER Code
        </p>
        {name && (
          <p className="mt-3 font-display text-lg text-ink-soft">{name}</p>
        )}
      </header>

      <ol className="mt-12 space-y-7">
        {sections.lines.map((line, i) => (
          <li key={i} className="text-center">
            <p className="font-display text-xl leading-snug text-ink sm:text-2xl">
              {line}
            </p>
            {i < sections.lines.length - 1 && (
              <span
                aria-hidden
                className="mx-auto mt-7 block h-px w-8 bg-rule-strong"
              />
            )}
          </li>
        ))}
      </ol>

      {sections.declaration && (
        <>
          <span
            aria-hidden
            className="mx-auto mt-12 block h-px w-16 bg-gilt/50"
          />
          <p className="mt-10 text-center font-display text-2xl leading-snug text-plum sm:text-3xl">
            {sections.declaration}
          </p>
        </>
      )}

      {dateLabel && (
        <footer className="mt-14 text-center">
          <p className="text-2xs uppercase tracking-[0.2em] text-ink-faint">
            {dateLabel}
          </p>
        </footer>
      )}
    </article>
  )
}
