'use client'

import { useFormStatus } from 'react-dom'
import { Button } from '@/design-system/primitives'
import { signOut } from '@/lib/auth/actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="quiet" size="sm" disabled={pending}>
      {pending ? 'Signing out…' : 'Sign out'}
    </Button>
  )
}

export function SignOutButton() {
  return (
    <form action={signOut}>
      <Submit />
    </form>
  )
}
