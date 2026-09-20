'use client'

import { useState, useTransition } from 'react'
import { Button, Field, Input, Rule } from '@/design-system/primitives'
import { BlockEditor, type EditableBlock } from './BlockEditor'
import { addBlock, deleteDay, updateDay } from './program-actions'

export interface PaletteEntry {
  type: string
  label: string
  description: string
  isSensitive: boolean
}

export function DayBuilder({
  programId,
  moduleId,
  lessonId,
  position,
  title,
  subtitle,
  blocks,
  palette,
  locked,
}: {
  programId: string
  moduleId: string
  lessonId: string | null
  position: number
  title: string
  subtitle: string | null
  blocks: EditableBlock[]
  palette: PaletteEntry[]
  locked: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  return (
    <section className="border border-rule-strong bg-bone p-4">
      <form
        action={(formData) => {
          startTransition(async () => {
            const result = await updateDay(programId, moduleId, formData)
            setError(result.error ?? null)
          })
        }}
        className="flex flex-wrap items-end gap-4"
      >
        <span className="text-2xs uppercase tracking-[0.18em] text-clay-deep">
          Day {position}
        </span>
        <Field label="Title" htmlFor={`day-${moduleId}-title`} className="min-w-48 flex-1">
          <Input name="title" defaultValue={title} />
        </Field>
        <Field
          label="Subtitle"
          htmlFor={`day-${moduleId}-subtitle`}
          className="min-w-48 flex-1"
        >
          <Input name="subtitle" defaultValue={subtitle ?? ''} />
        </Field>
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          Save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="quiet"
          disabled={locked || pending}
          onClick={() =>
            startTransition(async () => {
              const result = await deleteDay(programId, moduleId)
              setError(result.error ?? null)
            })
          }
        >
          Delete day
        </Button>
      </form>

      <Rule className="my-4" />

      {blocks.length === 0 ? (
        <p className="text-2xs text-ink-muted">No blocks yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {blocks.map((b, i) => (
            <BlockEditor
              key={b.id}
              programId={programId}
              block={b}
              isFirst={i === 0}
              isLast={i === blocks.length - 1}
              locked={locked}
            />
          ))}
        </ul>
      )}

      {lessonId && (
        <div className="mt-4">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={locked}
            onClick={() => setAdding((v) => !v)}
            aria-expanded={adding}
          >
            Add a block
          </Button>

          {adding && (
            <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {palette.map((p) => (
                <li key={p.type}>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const result = await addBlock(programId, lessonId, p.type)
                        setError(result.error ?? null)
                        if (!result.error) setAdding(false)
                      })
                    }
                    className="w-full rounded-md border border-rule bg-alabaster p-3 text-left hover:border-clay"
                  >
                    <span className="block text-xs font-medium">{p.label}</span>
                    <code className="block text-2xs text-clay-deep">{p.type}</code>
                    <span className="mt-1 block text-2xs text-ink-muted">
                      {p.description}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 text-2xs text-critical">
          {error}
        </p>
      )}
    </section>
  )
}
