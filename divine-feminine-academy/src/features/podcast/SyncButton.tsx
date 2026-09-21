'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button } from '@/design-system/primitives'
import { syncPodcast, type SyncState } from './actions'

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="sm" variant="secondary" disabled={pending}>
      {pending ? 'Pulling the feed…' : 'Sync the podcast'}
    </Button>
  )
}

/** The manual pull, with whatever the sync actually did said out loud. */
export function SyncButton() {
  const [state, action] = useActionState<SyncState, FormData>(syncPodcast, {})

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <Submit />
      {state.message && (
        <p role="status" className="text-2xs text-ink-muted">
          {state.message}
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-2xs text-critical">
          {state.error}
        </p>
      )}
    </form>
  )
}
