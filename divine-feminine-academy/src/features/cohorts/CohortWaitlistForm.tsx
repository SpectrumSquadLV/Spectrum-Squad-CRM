'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Field, Input } from '@/design-system/primitives'
import { joinWaitlist, type WaitlistState } from './waitlist-actions'

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Working…' : label}
    </Button>
  )
}

export function CohortWaitlistForm({
  cohortId,
  headline,
  blurb,
  buttonLabel = 'Tell me when the doors open',
}: {
  cohortId: string
  headline: string
  blurb: string
  buttonLabel?: string
}) {
  const [state, formAction] = useActionState<WaitlistState, FormData>(
    joinWaitlist,
    {},
  )

  if (state.done) {
    return (
      <div className="rounded-xl border border-clay bg-plum-wash p-6 md:p-8">
        <h2 className="font-display text-xl">
          {state.alreadyOn ? 'You were already on it.' : 'You are on the list.'}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          You will hear the moment the doors open — before anybody else does.
          Nothing else in between.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-clay bg-plum-wash p-6 md:p-8">
      <h2 className="font-display text-2xl leading-snug">{headline}</h2>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">{blurb}</p>

      <form action={formAction} className="mt-7 flex flex-col gap-5">
        <input type="hidden" name="cohortId" value={cohortId} />

        <Field label="First name" htmlFor={`waitlist-name-${cohortId}`}>
          <Input
            id={`waitlist-name-${cohortId}`}
            name="firstName"
            autoComplete="given-name"
            required
          />
        </Field>

        <Field label="Email" htmlFor={`waitlist-email-${cohortId}`}>
          <Input
            id={`waitlist-email-${cohortId}`}
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
          One email when the doors open. Unsubscribe in one click.
        </p>
      </form>
    </div>
  )
}
