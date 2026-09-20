'use client'

import { useActionState, useTransition } from 'react'
import { useFormStatus } from 'react-dom'
import { Badge, Button, Field, Input, Textarea } from '@/design-system/primitives'
import {
  addFollowUp,
  addNote,
  addTag,
  changeStage,
  completeFollowUp,
  deleteNote,
  removeTag,
  type CrmState,
} from './crm-actions'

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  )
}

export function StagePicker({
  contactId,
  stages,
  currentStageId,
}: {
  contactId: string
  stages: Array<{ id: string; name: string }>
  currentStageId: string | null
}) {
  const [pending, startTransition] = useTransition()

  return (
    <label className="flex items-center gap-2 text-2xs">
      <span className="text-ink-muted">Stage</span>
      <select
        defaultValue={currentStageId ?? ''}
        disabled={pending}
        onChange={(e) =>
          startTransition(async () => {
            if (e.target.value) await changeStage(contactId, e.target.value)
          })
        }
        className="min-h-10 rounded-md border border-rule-strong bg-alabaster px-2 text-xs"
      >
        <option value="">—</option>
        {stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  )
}

export function NotesPanel({
  contactId,
  notes,
}: {
  contactId: string
  notes: Array<{ id: string; body: string; pinned: boolean; createdAt: Date }>
}) {
  const [state, formAction] = useActionState<CrmState, FormData>(
    addNote.bind(null, contactId),
    {},
  )
  const [, startTransition] = useTransition()

  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
        Notes
      </h2>

      <form action={formAction} className="mt-4 flex flex-col gap-3">
        <Field label="Add a note" htmlFor={`note-${contactId}`}>
          <Textarea name="body" rows={3} />
        </Field>
        <label className="flex min-h-9 items-center gap-2 text-2xs">
          <input type="checkbox" name="pinned" className="size-3.5 accent-[var(--color-plum)]" />
          Pin it
        </label>
        {state.error && (
          <p role="alert" className="text-2xs text-critical">
            {state.error}
          </p>
        )}
        <div>
          <Submit label="Add note" />
        </div>
      </form>

      {notes.length > 0 && (
        <ul className="mt-6 divide-y divide-rule border-y border-rule">
          {notes.map((note) => (
            <li key={note.id} className="py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="whitespace-pre-wrap text-xs text-ink-soft">{note.body}</p>
                <button
                  type="button"
                  onClick={() =>
                    startTransition(async () => {
                      await deleteNote(contactId, note.id)
                    })
                  }
                  className="shrink-0 text-2xs text-ink-faint hover:text-critical"
                >
                  remove
                </button>
              </div>
              <p className="mt-1 flex items-center gap-2 text-2xs text-ink-faint">
                {note.pinned && <Badge>pinned</Badge>}
                {note.createdAt.toLocaleDateString('en-US')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function FollowUpsPanel({
  contactId,
  followUps,
}: {
  contactId: string
  followUps: Array<{
    id: string
    dueAt: Date
    note: string | null
    status: string
  }>
}) {
  const [state, formAction] = useActionState<CrmState, FormData>(
    addFollowUp.bind(null, contactId),
    {},
  )
  const [, startTransition] = useTransition()
  const open = followUps.filter((f) => f.status === 'open')

  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
        Follow-ups
      </h2>

      <form action={formAction} className="mt-4 flex flex-wrap items-end gap-3">
        <Field label="When" htmlFor={`due-${contactId}`}>
          <Input type="date" name="dueAt" />
        </Field>
        <Field label="About" htmlFor={`fnote-${contactId}`} className="min-w-48 flex-1">
          <Input name="note" />
        </Field>
        <Submit label="Add" />
      </form>

      {state.error && (
        <p role="alert" className="mt-3 text-2xs text-critical">
          {state.error}
        </p>
      )}

      {open.length > 0 && (
        <ul className="mt-5 divide-y divide-rule border-y border-rule">
          {open.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 py-3">
              <span className="text-2xs">
                {f.dueAt.toLocaleDateString('en-US')}
                {f.note ? ` · ${f.note}` : ''}
              </span>
              <button
                type="button"
                onClick={() =>
                  startTransition(async () => {
                    await completeFollowUp(contactId, f.id)
                  })
                }
                className="text-2xs text-clay-deep hover:text-plum"
              >
                done
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function TagsPanel({
  contactId,
  tags,
}: {
  contactId: string
  tags: Array<{ id: string; name: string }>
}) {
  const [state, formAction] = useActionState<CrmState, FormData>(
    addTag.bind(null, contactId),
    {},
  )
  const [, startTransition] = useTransition()

  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
        Tags
      </h2>

      <div className="mt-3 flex flex-wrap gap-2">
        {tags.map((tag) => (
          <span key={tag.id} className="inline-flex items-center gap-1">
            <Badge>{tag.name}</Badge>
            <button
              type="button"
              onClick={() =>
                startTransition(async () => {
                  await removeTag(contactId, tag.id)
                })
              }
              className="text-2xs text-ink-faint hover:text-critical"
              aria-label={`Remove ${tag.name}`}
            >
              ×
            </button>
          </span>
        ))}
        {tags.length === 0 && <span className="text-2xs text-ink-faint">None</span>}
      </div>

      <form action={formAction} className="mt-4 flex flex-wrap items-end gap-3">
        <Field label="Add a tag" htmlFor={`tag-${contactId}`}>
          <Input name="name" />
        </Field>
        <Submit label="Add" />
      </form>

      {state.error && (
        <p role="alert" className="mt-3 text-2xs text-critical">
          {state.error}
        </p>
      )}
    </section>
  )
}
