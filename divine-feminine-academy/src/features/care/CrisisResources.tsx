import { Rule } from '@/design-system/primitives'
import { cn } from '@/lib/utils/cn'

/**
 * Duty of care.
 *
 * Day 2 asks a woman where she first learned she was not worthy of love.
 * Some will write about abuse, and a few will be in crisis when they do.
 *
 * This component belongs anywhere she writes something heavy: the journal, the
 * RETURN flow, and the reflection blocks on Days 2 and 3. It is quiet by
 * default so it does not intrude, and always reachable.
 *
 * REVIEW BEFORE LAUNCH: these are United States resources. They must be
 * confirmed current, and the list needs a plan for women outside the US.
 */
const resources = [
  {
    name: '988 Suicide & Crisis Lifeline',
    detail: 'Call or text 988',
    href: 'tel:988',
    note: '24/7, free, confidential',
  },
  {
    name: 'Crisis Text Line',
    detail: 'Text HOME to 741741',
    href: 'sms:741741&body=HOME',
    note: 'If talking is too much',
  },
  {
    name: 'National Domestic Violence Hotline',
    detail: '1-800-799-7233',
    href: 'tel:18007997233',
    note: '24/7, confidential',
  },
]

export function CrisisResources({
  className,
  tone = 'quiet',
}: {
  className?: string
  tone?: 'quiet' | 'full'
}) {
  if (tone === 'quiet') {
    return (
      <details
        className={cn(
          'rounded-md border border-rule bg-linen/40 px-4 py-3',
          className,
        )}
      >
        <summary className="cursor-pointer list-none text-2xs text-ink-muted">
          If this is heavier than a journal can hold →
        </summary>
        <ul className="mt-4 space-y-3">
          {resources.map((r) => (
            <li key={r.name}>
              <a
                href={r.href}
                className="inline-flex min-h-9 flex-col text-xs text-ink hover:text-clay-deep"
              >
                <span className="font-medium">{r.detail}</span>
                <span className="text-2xs text-ink-muted">
                  {r.name} — {r.note}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </details>
    )
  }

  return (
    <section
      className={cn('rounded-lg border border-rule bg-alabaster p-6', className)}
      aria-labelledby="crisis-heading"
    >
      <h2 id="crisis-heading" className="font-display text-xl">
        If you need someone today
      </h2>
      <p className="mt-2 text-xs text-ink-muted">
        This platform is not a crisis service and nobody here is monitoring what
        you write. These people are, and they are free.
      </p>
      <Rule className="my-5" />
      <ul className="space-y-4">
        {resources.map((r) => (
          <li key={r.name}>
            <a
              href={r.href}
              className="inline-flex min-h-11 flex-col text-sm text-ink hover:text-clay-deep"
            >
              <span className="font-medium">{r.detail}</span>
              <span className="text-2xs text-ink-muted">
                {r.name} — {r.note}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}
