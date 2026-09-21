'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Field, Input } from '@/design-system/primitives'
import { type AuthFormState, signInWithLink } from '@/lib/auth/actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Sending…' : 'Email me a link'}
    </Button>
  )
}

export function SignInForm({
  className,
  next,
}: {
  className?: string
  next?: string
}) {
  const [state, formAction] = useActionState<AuthFormState, FormData>(
    signInWithLink,
    {},
  )

  return (
    <form action={formAction} className={className} noValidate>
      {next && <input type="hidden" name="next" value={next} />}
      <div className="flex flex-col gap-5">
        <Field label="Email" htmlFor="signin-email" error={state.fieldErrors?.email}>
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

        <Submit />
      </div>
    </form>
  )
}
