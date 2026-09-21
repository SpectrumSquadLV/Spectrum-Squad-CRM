'use client'

import { useActionState, useRef } from 'react'
import { useFormStatus } from 'react-dom'
import { Badge, Button, Field, Input, Textarea } from '@/design-system/primitives'
import type { Area } from '@/design-system/primitives'
import { useState } from 'react'
import { type JournalState, writeEntry } from './actions'

const areas: Area[] = ['herself', 'relationships', 'success', 'money']

function Submit() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Saving…' : 'Save'}
    </Button>
  )
}

/**
 * The journal composer.
 *
 * Has to feel as good as a native notes app on a phone, because the whole
 * system depends on her actually using it.
 */
export function JournalComposer({ className }: { className?: string }) {
  const [state, formAction] = useActionState<JournalState, FormData>(
    writeEntry,
    {},
  )
  const [area, setArea] = useState<Area | ''>('')
  const formRef = useRef<HTMLFormElement>(null)

  return (
    <form
      ref={formRef}
      action={async (fd) => {
        await formAction(fd)
        formRef.current?.reset()
        setArea('')
      }}
      className={className}
    >
      <div className="flex flex-col gap-5">
        <Field label="Give it a name (optional)" htmlFor="journal-title">
          <Input name="title" autoComplete="off" />
        </Field>

        <Field label="Your words" htmlFor="journal-body">
          <Textarea name="body" rows={8} placeholder="However it comes out." />
        </Field>

        <fieldset>
          <legend className="text-xs font-medium text-ink-soft">
            Where does this belong? (optional)
          </legend>
          <input type="hidden" name="area" value={area} />
          <div className="mt-3 flex flex-wrap gap-2">
            {areas.map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={area === a}
                onClick={() => setArea(area === a ? '' : a)}
                className="min-h-11 rounded-sm"
              >
                <Badge area={a} className={area === a ? 'ring-1 ring-plum/40' : 'opacity-60'}>
                  {a}
                </Badge>
              </button>
            ))}
          </div>
        </fieldset>

        {state.error && (
          <p role="alert" className="text-2xs text-critical">
            {state.error}
          </p>
        )}
        {state.ok && (
          <p role="status" className="text-2xs text-positive">
            Saved, and encrypted.
          </p>
        )}

        <div>
          <Submit />
        </div>
      </div>
    </form>
  )
}
