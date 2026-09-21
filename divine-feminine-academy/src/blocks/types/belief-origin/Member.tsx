'use client'

import { Field, Textarea } from '@/design-system/primitives'
import { CrisisResources } from '@/features/care/CrisisResources'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

const empty: Response = { belief: '', origin: '', cost: '', rewrite: '' }

export function BeliefOriginMember({
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

      <div className="flex flex-col gap-8">
        <Field label={config.beliefLabel} htmlFor={`${blockId}-belief`}>
          <Textarea
            value={current.belief}
            onChange={(e) => set({ belief: e.target.value })}
            disabled={disabled}
            rows={3}
          />
        </Field>

        <Field
          label={config.originLabel}
          htmlFor={`${blockId}-origin`}
          hint="However far back it goes. Only you will ever read this."
        >
          <Textarea
            value={current.origin}
            onChange={(e) => set({ origin: e.target.value })}
            disabled={disabled}
            rows={6}
          />
        </Field>

        <Field label={config.costLabel} htmlFor={`${blockId}-cost`}>
          <Textarea
            value={current.cost}
            onChange={(e) => set({ cost: e.target.value })}
            disabled={disabled}
            rows={4}
          />
        </Field>

        <Field label={config.rewriteLabel} htmlFor={`${blockId}-rewrite`}>
          <Textarea
            value={current.rewrite}
            onChange={(e) => set({ rewrite: e.target.value })}
            disabled={disabled}
            rows={4}
            className="border-plum/30 focus:border-plum"
          />
        </Field>
      </div>

      <CrisisResources className="mt-10" />
    </div>
  )
}
