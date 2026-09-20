'use client'

import { Field, Textarea } from '@/design-system/primitives'
import { CrisisResources } from '@/features/care/CrisisResources'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

export function EmotionTrailMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const merged: Response = { ...({ event: '', emotion: '', reaction: '', protecting: '', earlier: '', belief: '' }), ...(value ?? {}) }
  const set = (key: keyof Response, text: string) =>
    onChange({ ...merged, [key]: text })

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && (
        <p className="mb-8 text-sm text-ink-muted">{config.helper}</p>
      )}

      <div className="flex flex-col gap-6">
        <Field label={config.eventLabel} htmlFor={`${blockId}-event`}>
          <Textarea
            id={`${blockId}-event`}
            value={merged.event}
            onChange={(e) => set('event', e.target.value)}
            disabled={disabled}
            rows={3}
          />
        </Field>
        <Field label={config.emotionLabel} htmlFor={`${blockId}-emotion`}>
          <Textarea
            id={`${blockId}-emotion`}
            value={merged.emotion}
            onChange={(e) => set('emotion', e.target.value)}
            disabled={disabled}
            rows={2}
          />
        </Field>
        <Field label={config.reactionLabel} htmlFor={`${blockId}-reaction`}>
          <Textarea
            id={`${blockId}-reaction`}
            value={merged.reaction}
            onChange={(e) => set('reaction', e.target.value)}
            disabled={disabled}
            rows={3}
          />
        </Field>
        <Field label={config.protectingLabel} htmlFor={`${blockId}-protecting`}>
          <Textarea
            id={`${blockId}-protecting`}
            value={merged.protecting}
            onChange={(e) => set('protecting', e.target.value)}
            disabled={disabled}
            rows={3}
          />
        </Field>
        <Field label={config.earlierLabel} htmlFor={`${blockId}-earlier`}>
          <Textarea
            id={`${blockId}-earlier`}
            value={merged.earlier}
            onChange={(e) => set('earlier', e.target.value)}
            disabled={disabled}
            rows={5}
          />
        </Field>
        <Field label={config.beliefLabel} htmlFor={`${blockId}-belief`}>
          <Textarea
            id={`${blockId}-belief`}
            value={merged.belief}
            onChange={(e) => set('belief', e.target.value)}
            disabled={disabled}
            rows={3}
          />
        </Field>
      </div>

      <p className="mt-8 text-2xs text-ink-muted">Only you can read this.</p>
      <CrisisResources className="mt-10" />
    </div>
  )
}
