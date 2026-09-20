'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Field, Input } from '@/design-system/primitives'
import { optInToArchetype, type OptInState } from './optin-actions'

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Working…' : label}
    </Button>
  )
}

/**
 * Join one of the four sequences without taking the quiz.
 *
 * She landed here because somebody shared it, read three lines and recognised
 * herself. Sending her back through twelve questions to confirm what she
 * already knows is friction for its own sake — and she is the warmest lead on
 * the site, because she identified herself.
 */
export function ArchetypeOptIn({
  slug,
  name,
}: {
  slug: string
  name: string
}) {
  const [state, formAction] = useActionState<OptInState, FormData>(
    optInToArchetype,
    {},
  )

  if (state.done) {
    return (
      <div className="rounded-xl border border-clay bg-plum-wash p-6 md:p-8">
        <h2 className="font-display text-xl">Check your inbox.</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          The first one is on its way now. Four more over the next week — where
          she came from, what she costs you, and the one move that puts her
          down.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          There is nothing to buy in any of them, and every one has an
          unsubscribe link that works in one click.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-clay bg-plum-wash p-6 md:p-8">
      <h2 className="font-display text-2xl leading-snug">
        Is this you? Get the five emails.
      </h2>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">
        Five emails over nine days, written for {name} specifically: where she
        came from, what she is costing you, and the one move that puts her down.
        Free, and nothing to buy in any of them.
      </p>

      <form action={formAction} className="mt-7 flex flex-col gap-5">
        <input type="hidden" name="archetype" value={slug} />

        <Field label="First name" htmlFor={`optin-name-${slug}`}>
          <Input
            id={`optin-name-${slug}`}
            name="firstName"
            autoComplete="given-name"
            required
          />
        </Field>

        <Field label="Email" htmlFor={`optin-email-${slug}`}>
          <Input
            id={`optin-email-${slug}`}
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

        <Submit label="Send me the five emails" />

        <p className="text-2xs text-ink-muted">
          Not sure this is you? Take the quiz instead — it is ninety seconds and
          it will tell you.
        </p>
      </form>
    </div>
  )
}
