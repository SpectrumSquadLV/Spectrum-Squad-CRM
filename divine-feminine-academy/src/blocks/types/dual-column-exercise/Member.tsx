'use client'

import { Field, Textarea } from '@/design-system/primitives'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

export function DualColumnMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const current: Response = value ?? {
    trigger: '',
    currentResponse: '',
    herResponse: '',
  }

  const set = (patch: Partial<Response>) => onChange({ ...current, ...patch })

  return (
    <div className="measure-wide">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && <p className="text-ink-muted text-sm mb-8">{config.helper}</p>}

      <Field label={config.triggerLabel} htmlFor={`${blockId}-trigger`} className="mb-8">
        <Textarea
          value={current.trigger}
          onChange={(e) => set({ trigger: e.target.value })}
          disabled={disabled}
          rows={3}
        />
      </Field>

      {/* Stacks on a phone. The two columns are a desktop affordance only. */}
      <div className="grid gap-8 md:grid-cols-2">
        <Field label={config.currentLabel} htmlFor={`${blockId}-current`}>
          <Textarea
            value={current.currentResponse}
            onChange={(e) => set({ currentResponse: e.target.value })}
            disabled={disabled}
          />
        </Field>
        <Field label={config.herLabel} htmlFor={`${blockId}-her`}>
          <Textarea
            value={current.herResponse}
            onChange={(e) => set({ herResponse: e.target.value })}
            disabled={disabled}
            className="border-plum/30 focus:border-plum"
          />
        </Field>
      </div>
    </div>
  )
}
