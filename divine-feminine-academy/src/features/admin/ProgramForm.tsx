'use client'

import { useActionState } from 'react'
import { useRouter } from 'next/navigation'
import { useFormStatus } from 'react-dom'
import { Button, Field, Input, Textarea } from '@/design-system/primitives'
import { type BuilderState, createProgram, updateProgram } from './program-actions'

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  )
}

const kinds = ['challenge', 'course', 'program', 'membership'] as const
const pacings = ['immediate', 'drip', 'cohort', 'date_based'] as const

export function ProgramForm({
  programId,
  defaults,
}: {
  programId?: string
  defaults?: {
    title: string
    subtitle: string
    description: string
    kind: string
    pacing: string
    allowEarlyUnlock: boolean
  }
}) {
  const router = useRouter()

  const [state, formAction] = useActionState<BuilderState, FormData>(
    async (_prev, formData) => {
      if (programId) return updateProgram(programId, formData)
      const result = await createProgram(_prev, formData)
      if (result.id) router.push(`/admin/programs/${result.id}`)
      return result
    },
    {},
  )

  return (
    <form action={formAction} className="max-w-xl">
      <div className="flex flex-col gap-5">
        <Field label="Title" htmlFor="program-title">
          <Input name="title" defaultValue={defaults?.title} required />
        </Field>

        <Field label="Subtitle" htmlFor="program-subtitle">
          <Input name="subtitle" defaultValue={defaults?.subtitle} />
        </Field>

        <Field label="Description" htmlFor="program-description">
          <Textarea name="description" defaultValue={defaults?.description} rows={4} />
        </Field>

        <Field label="Kind" htmlFor="program-kind">
          <select
            name="kind"
            defaultValue={defaults?.kind ?? 'challenge'}
            className="min-h-12 w-full rounded-md border border-rule-strong bg-alabaster px-3 text-sm"
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Pacing"
          htmlFor="program-pacing"
          hint="Drip opens one day per calendar day in her own timezone."
        >
          <select
            name="pacing"
            defaultValue={defaults?.pacing ?? 'drip'}
            className="min-h-12 w-full rounded-md border border-rule-strong bg-alabaster px-3 text-sm"
          >
            {pacings.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>

        <label className="flex min-h-11 items-center gap-3 text-xs">
          <input
            type="checkbox"
            name="allowEarlyUnlock"
            defaultChecked={defaults?.allowEarlyUnlock}
            className="size-4 accent-[var(--color-plum)]"
          />
          Let her unlock the next day early
        </label>

        {state.error && (
          <p role="alert" className="text-2xs text-critical">
            {state.error}
          </p>
        )}
        {state.ok && !programId && (
          <p role="status" className="text-2xs text-positive">
            Created.
          </p>
        )}
        {state.ok && programId && (
          <p role="status" className="text-2xs text-positive">
            Saved.
          </p>
        )}

        <div>
          <Submit label={programId ? 'Save' : 'Create program'} />
        </div>
      </div>
    </form>
  )
}
