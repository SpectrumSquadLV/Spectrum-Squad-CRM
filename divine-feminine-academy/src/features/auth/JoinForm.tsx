'use client'

import { useActionState, useEffect, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Field, Input } from '@/design-system/primitives'
import { type AuthFormState, join } from '@/lib/auth/actions'

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Sending…' : label}
    </Button>
  )
}

export function JoinForm({
  className,
  source,
  utmSource,
  utmMedium,
  utmCampaign,
  next,
  submitLabel = 'Send my link',
}: {
  className?: string
  source?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  next?: string
  submitLabel?: string
}) {
  const [state, formAction] = useActionState<AuthFormState, FormData>(join, {})
  const [timezone, setTimezone] = useState('America/Los_Angeles')

  // Her own timezone, so day unlocks and reminders land at her morning.
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (tz) setTimezone(tz)
    } catch {
      // Keep the default.
    }
  }, [])

  return (
    <form action={formAction} className={className} noValidate>
      <input type="hidden" name="timezone" value={timezone} />
      {source && <input type="hidden" name="source" value={source} />}
      {utmSource && <input type="hidden" name="utmSource" value={utmSource} />}
      {utmMedium && <input type="hidden" name="utmMedium" value={utmMedium} />}
      {utmCampaign && <input type="hidden" name="utmCampaign" value={utmCampaign} />}
      {next && <input type="hidden" name="next" value={next} />}

      <div className="flex flex-col gap-5">
        <Field
          label="First name"
          htmlFor="join-first-name"
          error={state.fieldErrors?.firstName}
        >
          <Input
            name="firstName"
            autoComplete="given-name"
            enterKeyHint="next"
            required
          />
        </Field>

        <Field label="Email" htmlFor="join-email" error={state.fieldErrors?.email}>
          <Input
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            enterKeyHint="go"
            required
          />
        </Field>

        {state.error && (
          <p role="alert" className="text-2xs text-critical">
            {state.error}
          </p>
        )}

        <Submit label={submitLabel} />
      </div>

      <p className="mt-4 text-2xs text-ink-muted">
        No password. We will email you a link that signs you in.
      </p>
    </form>
  )
}
