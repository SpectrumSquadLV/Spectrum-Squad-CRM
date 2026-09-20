'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Button, Field, Input, Textarea } from '@/design-system/primitives'
import { CrisisResources } from '@/features/care/CrisisResources'
import { cn } from '@/lib/utils/cn'
import { returnActions } from '@/blocks/types/return-practice/schema'
import {
  markReturnActionDone,
  recordReturn,
  type ReturnState,
} from './return-actions'

const labels: Record<string, string> = {
  dance: 'Dance', create: 'Create', move: 'Move', music: 'Music',
  nature: 'Nature', play: 'Play', rest: 'Rest', connect: 'Connect',
  journal: 'Journal', custom: 'Something else',
}

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? 'Saving…' : 'Save this'}
    </Button>
  )
}

export function ReturnFlow({
  className,
  sessions,
}: {
  className?: string
  sessions: Array<{
    id: string
    actionChosen: string | null
    customAction: string | null
    actionCompletedAt: Date | null
  }>
}) {
  const [state, formAction] = useActionState<ReturnState, FormData>(
    recordReturn,
    {},
  )
  const [action, setAction] = useState<string | null>(null)

  const latest = sessions[0]
  const canMarkDone = latest && latest.actionChosen && !latest.actionCompletedAt

  return (
    <div className={className}>
      {canMarkDone && (
        <div className="mb-10 rounded-lg border border-plum/30 bg-plum-wash/50 p-5">
          <p className="text-sm text-plum">
            You said you would {latest.customAction ?? latest.actionChosen}.
          </p>
          <form
            action={async () => {
              await markReturnActionDone(latest.id)
            }}
            className="mt-4"
          >
            <Button type="submit" size="sm">
              I did it
            </Button>
          </form>
          <p className="mt-3 text-2xs text-ink-muted">
            That counts as choosing her.
          </p>
        </div>
      )}

      <form action={formAction} className="flex flex-col gap-7">
        <Field label="What happened" htmlFor="return-what">
          <Textarea name="whatHappened" rows={4} />
        </Field>

        <Field label="What you are feeling" htmlFor="return-feeling">
          <Input name="feeling" />
        </Field>

        <Field label="What you are making it mean" htmlFor="return-meaning">
          <Textarea name="meaningMade" rows={3} />
        </Field>

        <Field
          label="Is that necessarily true?"
          htmlFor="return-true"
          hint="Not whether it feels true. Whether it is."
        >
          <Textarea name="isItTrue" rows={3} />
        </Field>

        <Field label="What you need right now" htmlFor="return-need">
          <Textarea name="whatINeed" rows={3} />
        </Field>

        <fieldset>
          <legend className="text-xs font-medium text-ink-soft">
            What would help you return
          </legend>
          <input type="hidden" name="actionChosen" value={action ?? ''} />
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {returnActions.map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={action === a}
                onClick={() => setAction(a)}
                className={cn(
                  'min-h-14 rounded-md border px-3 text-sm transition-colors',
                  action === a
                    ? 'border-plum bg-plum-wash text-plum'
                    : 'border-rule-strong bg-alabaster text-ink-soft hover:border-clay',
                )}
              >
                {labels[a] ?? a}
              </button>
            ))}
          </div>
        </fieldset>

        {action === 'custom' && (
          <Field label="Name it" htmlFor="return-custom">
            <Input name="customAction" />
          </Field>
        )}

        {state.error && (
          <p role="alert" className="text-2xs text-critical">
            {state.error}
          </p>
        )}
        {state.ok && (
          <p role="status" className="text-2xs text-positive">
            Saved. Go and do the thing.
          </p>
        )}

        <Submit />
      </form>

      <CrisisResources className="mt-10" />
    </div>
  )
}
