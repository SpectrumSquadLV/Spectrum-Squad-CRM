'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Field, Input, Label } from '@/design-system/primitives'
import { type AccountFormState, updateAccount } from './actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : 'Save'}
    </Button>
  )
}

const hours = Array.from({ length: 24 }, (_, h) => h)

function hourLabel(h: number) {
  if (h === 0) return '12am'
  if (h === 12) return '12pm'
  return h < 12 ? `${h}am` : `${h - 12}pm`
}

export function AccountForm({
  className,
  firstName,
  lastName,
  email,
  timezone,
  dailyEmail,
  reminderHour,
}: {
  className?: string
  firstName: string
  lastName: string
  email: string
  timezone: string
  dailyEmail: boolean
  reminderHour: number
}) {
  const [state, formAction] = useActionState<AccountFormState, FormData>(
    updateAccount,
    {},
  )

  return (
    <form action={formAction} className={className} noValidate>
      <div className="flex flex-col gap-6">
        <Field
          label="First name"
          htmlFor="account-first-name"
          error={state.fieldErrors?.firstName}
        >
          <Input name="firstName" defaultValue={firstName} autoComplete="given-name" />
        </Field>

        <Field label="Last name" htmlFor="account-last-name">
          <Input name="lastName" defaultValue={lastName} autoComplete="family-name" />
        </Field>

        <Field
          label="Email"
          htmlFor="account-email"
          hint="This is how you sign in, so it cannot be changed here yet."
        >
          <Input defaultValue={email} disabled readOnly />
        </Field>

        <Field
          label="Timezone"
          htmlFor="account-timezone"
          hint="Days unlock and reminders arrive in your own morning."
          error={state.fieldErrors?.timezone}
        >
          <Input name="timezone" defaultValue={timezone} />
        </Field>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-xs font-medium text-ink-soft">Reminders</legend>

          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input
              type="checkbox"
              name="dailyEmail"
              defaultChecked={dailyEmail}
              className="size-4 accent-[var(--color-plum)]"
            />
            Email me when a new day opens
          </label>

          <div className="flex items-center gap-3">
            <Label htmlFor="account-reminder-hour" className="shrink-0">
              At
            </Label>
            <select
              id="account-reminder-hour"
              name="reminderHour"
              defaultValue={reminderHour}
              className="min-h-11 rounded-md border border-rule-strong bg-alabaster px-3 text-sm"
            >
              {hours.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </div>
        </fieldset>

        {state.error && (
          <p role="alert" className="text-2xs text-critical">
            {state.error}
          </p>
        )}
        {state.ok && (
          <p role="status" className="text-2xs text-positive">
            Saved.
          </p>
        )}

        <div>
          <Submit />
        </div>
      </div>
    </form>
  )
}
