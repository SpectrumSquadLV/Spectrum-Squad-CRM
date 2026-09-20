'use client'

import { Field, Textarea } from '@/design-system/primitives'
import { CrisisResources } from '@/features/care/CrisisResources'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

export function ProtectorProfileMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const current = { protecting: '', fear: '', first: '', cost: '' } as Response
  const merged: Response = { ...current, ...(value ?? {}) }

  const set = (key: keyof Response, text: string) =>
    onChange({ ...merged, [key]: text })

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && (
        <p className="mb-8 text-sm text-ink-muted">{config.helper}</p>
      )}

      <div className="flex flex-col gap-6">
        <Field label={config.protectingLabel} htmlFor={`${blockId}-protecting`}>
          <Textarea
            id={`${blockId}-protecting`}
            value={merged.protecting}
            onChange={(e) => set('protecting', e.target.value)}
            disabled={disabled}
            rows={4}
          />
        </Field>
        <Field label={config.fearLabel} htmlFor={`${blockId}-fear`}>
          <Textarea
            id={`${blockId}-fear`}
            value={merged.fear}
            onChange={(e) => set('fear', e.target.value)}
            disabled={disabled}
            rows={4}
          />
        </Field>
        <Field label={config.firstLabel} htmlFor={`${blockId}-first`}>
          <Textarea
            id={`${blockId}-first`}
            value={merged.first}
            onChange={(e) => set('first', e.target.value)}
            disabled={disabled}
            rows={5}
          />
        </Field>
        <Field label={config.costLabel} htmlFor={`${blockId}-cost`}>
          <Textarea
            id={`${blockId}-cost`}
            value={merged.cost}
            onChange={(e) => set('cost', e.target.value)}
            disabled={disabled}
            rows={4}
          />
        </Field>
      </div>

      <p className="mt-8 text-2xs text-ink-muted">Only you can read this.</p>

      <CrisisResources className="mt-10" />

    </div>
  )
}
