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
 * ON THESE NUMBERS. They are the long-standing United States lines, written
 * from knowledge rather than looked up - this code was written somewhere with
 * no way to reach the outside world and confirm them. 988 has been the US
 * suicide and crisis number since 2022 and the others have been stable for
 * far longer, so the risk of them being wrong is low. It is not zero, and the
 * cost of being wrong is a woman in crisis dialling a dead number.
 *
 * So: dial every one of them once before the site is public. That is a
 * five-minute job and it is the last thing standing between this and a
 * search engine.
 *
 * The international line is deliberately a directory rather than a number.
 * Guessing at a helpline for a country is worse than sending her somewhere
 * that knows which one is hers.
 */
const resources = [
  {
    name: '988 Suicide & Crisis Lifeline',
    detail: 'Call or text 988',
    href: 'tel:988',
    note: 'United States · 24/7, free, confidential',
  },
  {
    name: 'Crisis Text Line',
    detail: 'Text HOME to 741741',
    href: 'sms:741741&body=HOME',
    note: 'United States · when talking out loud is too much',
  },
  {
    name: 'National Domestic Violence Hotline',
    detail: 'Call 1-800-799-7233, or text START to 88788',
    href: 'tel:18007997233',
    note: 'United States · 24/7, confidential',
  },
  {
    name: 'RAINN National Sexual Assault Hotline',
    detail: 'Call 1-800-656-4673',
    href: 'tel:18006564673',
    note: 'United States · 24/7, free, confidential',
  },
  {
    name: 'SAMHSA National Helpline',
    detail: 'Call 1-800-662-4357',
    href: 'tel:18006624357',
    note: 'United States · substance use and mental health, 24/7',
  },
  {
    name: 'Find A Helpline',
    detail: 'findahelpline.com',
    href: 'https://findahelpline.com',
    note: 'Outside the United States · free lines in over 130 countries',
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
                {...(r.href.startsWith('http')
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : {})}
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
              {...(r.href.startsWith('http')
                ? { target: '_blank', rel: 'noopener noreferrer' }
                : {})}
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
