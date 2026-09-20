'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Field, Input } from '@/design-system/primitives'
import { subscribeFromWriting, type UpgradeState } from './upgrade-actions'

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Working…' : label}
    </Button>
  )
}

/**
 * The thing at the bottom of a piece of writing that earns an email address.
 *
 * A visit is worth almost nothing on its own — she reads, she leaves, and
 * whether she ever comes back is up to an algorithm. This is the only part of
 * a published article that compounds.
 *
 * What she is told afterwards depends on what actually happens next, which is
 * the whole point: an article tied to an archetype starts sending now, so she
 * is told to check her inbox. One that is not puts her on the list, so she is
 * told she will get the next one. Saying "check your inbox" when nothing is
 * coming is how a list stops being opened.
 */
export function WritingOptIn({
  slug,
  headline,
  blurb,
  buttonLabel = 'Send it to me',
}: {
  slug: string
  headline: string
  blurb: string
  buttonLabel?: string
}) {
  const [state, formAction] = useActionState<UpgradeState, FormData>(
    subscribeFromWriting,
    {},
  )

  if (state.done) {
    return (
      <div className="rounded-xl border border-clay bg-plum-wash p-6 md:p-8">
        <h2 className="font-display text-xl">
          {state.sequence ? 'Check your inbox.' : 'You are on the list.'}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          {state.sequence
            ? 'The first one is on its way now, and four more over the next week.'
            : 'Nothing is arriving right this second — you will get the next piece when it is written. That is the whole arrangement.'}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Every email has an unsubscribe link that works in one click.
        </p>
      </div>
    )
  }

  return (
    <aside className="rounded-xl border border-clay bg-plum-wash p-6 md:p-8">
      <h2 className="font-display text-2xl leading-snug">{headline}</h2>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{blurb}</p>

      <form action={formAction} className="mt-7 flex flex-col gap-5">
        <input type="hidden" name="slug" value={slug} />

        <Field label="First name" htmlFor={`writing-name-${slug}`}>
          <Input
            id={`writing-name-${slug}`}
            name="firstName"
            autoComplete="given-name"
            required
          />
        </Field>

        <Field label="Email" htmlFor={`writing-email-${slug}`}>
          <Input
            id={`writing-email-${slug}`}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
          />
        </Field>

        {state.error && (
          <p role="alert" className="text-2xs text-critical">
            {state.error}
          </p>
        )}

        <Submit label={buttonLabel} />

        <p className="text-2xs text-ink-muted">
          No spam, and your email is never sold. Unsubscribe in one click.
        </p>
      </form>
    </aside>
  )
}
