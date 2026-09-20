'use client'

import { Field, Input } from '@/design-system/primitives'
import { cn } from '@/lib/utils/cn'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

const empty: Response = { action: '', when: '', done: false }

export function ActionCommitmentMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const current = value ?? empty
  const set = (patch: Partial<Response>) => onChange({ ...current, ...patch })

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && <p className="text-ink-muted text-sm mb-8">{config.helper}</p>}

      {config.suggestions.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">
          {config.suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={disabled}
              onClick={() => set({ action: s })}
              className={cn(
                'min-h-11 rounded-md border px-4 text-xs transition-colors',
                current.action === s
                  ? 'border-plum bg-plum-wash text-plum'
                  : 'border-rule-strong bg-alabaster text-ink-soft hover:border-clay',
              )}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-6">
        <Field label="What you will do" htmlFor={`${blockId}-action`}>
          <Input
            value={current.action}
            onChange={(e) => set({ action: e.target.value })}
            disabled={disabled}
          />
        </Field>

        <Field label="When" htmlFor={`${blockId}-when`} hint="Today, tonight, Thursday.">
          <Input
            value={current.when}
            onChange={(e) => set({ when: e.target.value })}
            disabled={disabled}
          />
        </Field>

        <label className="flex min-h-12 items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={current.done}
            disabled={disabled}
            onChange={(e) => set({ done: e.target.checked })}
            className="size-4 accent-[var(--color-plum)]"
          />
          I did it
        </label>
      </div>
    </div>
  )
}
