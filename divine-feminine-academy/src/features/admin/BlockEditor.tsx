'use client'

import { useState, useTransition } from 'react'
import { Badge, Button, Field, Input, Textarea } from '@/design-system/primitives'
import { cn } from '@/lib/utils/cn'
import {
  deleteBlock,
  moveBlock,
  updateBlockConfig,
  type BuilderState,
} from './program-actions'

export interface EditableBlock {
  id: string
  type: string
  config: Record<string, unknown>
  isRequired: boolean
  position: number
  label: string
  description: string
  isSensitive: boolean
  takesAnswer: boolean
  known: boolean
}

/**
 * Edits a block's config as typed fields.
 *
 * Fields are inferred from the config's own shape rather than hand-written per
 * type: strings get a text field, long strings a textarea, booleans a checkbox,
 * numbers a number field, string arrays a line-per-item box.
 *
 * Whatever is entered is validated on the SERVER against that block type's own
 * Zod schema, so a config the day runner cannot render is rejected before it is
 * ever saved. This editor is a convenience; the schema is the contract.
 */
function fieldKind(value: unknown): 'text' | 'long' | 'bool' | 'number' | 'list' {
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return 'list'
  if (typeof value === 'string' && (value.length > 80 || value.includes('\n'))) {
    return 'long'
  }
  return 'text'
}

const humanise = (key: string) =>
  key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())

export function BlockEditor({
  programId,
  block,
  isFirst,
  isLast,
  locked,
}: {
  programId: string
  block: EditableBlock
  isFirst: boolean
  isLast: boolean
  locked: boolean
}) {
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<Record<string, unknown>>(block.config)
  const [isRequired, setIsRequired] = useState(block.isRequired)
  const [state, setState] = useState<BuilderState>({})
  const [pending, startTransition] = useTransition()

  const keys = Object.keys(config)

  function save() {
    startTransition(async () => {
      setState(await updateBlockConfig(programId, block.id, config, isRequired))
    })
  }

  return (
    <li className="border border-rule bg-alabaster">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
        <span className="text-2xs tabular-nums text-ink-faint">
          {block.position}
        </span>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-9 items-center gap-2 text-left"
          aria-expanded={open}
        >
          <span className="text-xs font-medium">{block.label}</span>
          <code className="text-2xs text-clay-deep">{block.type}</code>
        </button>

        {block.isSensitive && (
          <Badge className="border-plum/40 text-plum">encrypted</Badge>
        )}
        {block.isRequired && <Badge>required</Badge>}
        {!block.known && (
          <Badge className="border-critical/40 text-critical">unknown type</Badge>
        )}

        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="quiet"
            size="sm"
            disabled={isFirst || pending}
            onClick={() =>
              startTransition(async () => {
                await moveBlock(programId, block.id, 'up')
              })
            }
            aria-label="Move up"
          >
            ↑
          </Button>
          <Button
            type="button"
            variant="quiet"
            size="sm"
            disabled={isLast || pending}
            onClick={() =>
              startTransition(async () => {
                await moveBlock(programId, block.id, 'down')
              })
            }
            aria-label="Move down"
          >
            ↓
          </Button>
          <Button
            type="button"
            variant="quiet"
            size="sm"
            disabled={locked || pending}
            onClick={() =>
              startTransition(async () => {
                setState(await deleteBlock(programId, block.id))
              })
            }
          >
            Remove
          </Button>
        </div>
      </div>

      {open && (
        <div className="border-t border-rule p-4">
          <p className="mb-4 text-2xs text-ink-muted">{block.description}</p>

          <div className={cn('flex flex-col gap-4', !block.known && 'opacity-60')}>
            {keys.length === 0 && (
              <p className="text-2xs text-ink-muted">
                This block takes no configuration.
              </p>
            )}

            {keys.map((key) => {
              const value = config[key]
              const kind = fieldKind(value)
              const id = `block-${block.id}-${key}`

              if (kind === 'bool') {
                return (
                  <label key={key} className="flex min-h-11 items-center gap-3 text-xs">
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      onChange={(e) =>
                        setConfig({ ...config, [key]: e.target.checked })
                      }
                      className="size-4 accent-[var(--color-plum)]"
                    />
                    {humanise(key)}
                  </label>
                )
              }

              if (kind === 'number') {
                return (
                  <Field key={key} label={humanise(key)} htmlFor={id}>
                    <Input
                      type="number"
                      value={String(value ?? '')}
                      onChange={(e) =>
                        setConfig({ ...config, [key]: Number(e.target.value) })
                      }
                    />
                  </Field>
                )
              }

              if (kind === 'list') {
                return (
                  <Field
                    key={key}
                    label={humanise(key)}
                    htmlFor={id}
                    hint="One per line."
                  >
                    <Textarea
                      value={(value as string[]).join('\n')}
                      rows={4}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          [key]: e.target.value.split('\n').filter((l) => l !== ''),
                        })
                      }
                    />
                  </Field>
                )
              }

              return (
                <Field key={key} label={humanise(key)} htmlFor={id}>
                  {kind === 'long' ? (
                    <Textarea
                      value={String(value ?? '')}
                      rows={6}
                      onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
                    />
                  ) : (
                    <Input
                      value={String(value ?? '')}
                      onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
                    />
                  )}
                </Field>
              )
            })}

            {block.takesAnswer && (
              <label className="flex min-h-11 items-center gap-3 text-xs">
                <input
                  type="checkbox"
                  checked={isRequired}
                  onChange={(e) => setIsRequired(e.target.checked)}
                  className="size-4 accent-[var(--color-plum)]"
                />
                She must answer this before moving on
              </label>
            )}
          </div>

          {state.error && (
            <p role="alert" className="mt-4 text-2xs text-critical">
              {state.error}
            </p>
          )}
          {state.ok && (
            <p role="status" className="mt-4 text-2xs text-positive">
              Saved.
            </p>
          )}

          <div className="mt-5">
            <Button type="button" size="sm" onClick={save} disabled={pending}>
              {pending ? 'Saving…' : 'Save block'}
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}
