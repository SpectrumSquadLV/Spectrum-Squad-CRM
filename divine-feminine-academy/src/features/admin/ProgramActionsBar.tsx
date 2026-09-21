'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/design-system/primitives'
import { addDay, publishVersion } from './program-actions'

export function ProgramActionsBar({
  programId,
  locked,
}: {
  programId: string
  locked: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ error?: string; ok?: string } | null>(
    null,
  )

  return (
    <div>
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={locked || pending}
          onClick={() =>
            startTransition(async () => {
              const result = await addDay(programId)
              setMessage(result.error ? { error: result.error } : null)
            })
          }
        >
          Add a day
        </Button>

        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await publishVersion(programId)
              setMessage(
                result.error
                  ? { error: result.error }
                  : { ok: 'Published. Women already enrolled stay on their version.' },
              )
            })
          }
        >
          {pending ? 'Working…' : 'Publish'}
        </Button>
      </div>

      {message?.error && (
        <p role="alert" className="mt-3 text-2xs text-critical">
          {message.error}
        </p>
      )}
      {message?.ok && (
        <p role="status" className="mt-3 text-2xs text-positive">
          {message.ok}
        </p>
      )}
    </div>
  )
}
