'use client'

import { Field, Textarea } from '@/design-system/primitives'
import { CrisisResources } from '@/features/care/CrisisResources'
import type { BlockMemberProps } from '../../contract'
import type { Config, Response } from './schema'

const EMPTY: Response = { notMine: '', mine: '', reach: '' }

export function MyPartMember({
  blockId,
  config,
  value,
  onChange,
  disabled,
}: BlockMemberProps<Config, Response>) {
  const merged: Response = { ...EMPTY, ...(value ?? {}) }
  const set = (key: keyof Response, text: string) =>
    onChange({ ...merged, [key]: text })

  return (
    <div className="measure">
      <h2 className="text-2xl mb-3">{config.prompt}</h2>
      {config.helper && (
        <p className="mb-6 text-sm text-ink-muted">{config.helper}</p>
      )}

      {/*
        FIXED FRAMING, as on Day 4, and for the same reason. This day is called
        THE PROBLEM IS YOU. Without this paragraph immediately under it, that
        title can land as blame for things she did not cause - and the women
        most likely to read it that way are the ones it would hurt most.
      */}
      <p className="mb-10 rounded-lg border border-clay bg-plum-wash px-5 py-4 text-sm leading-relaxed text-ink-soft">
        Read this first. You did not cause what was done to you. Nothing on
        this page is asking you to take responsibility for somebody else&rsquo;s
        behaviour, or for an illness, or for what you were born into. The
        opposite: you are going to name what was never yours, and only then look
        at the part that is — because the part that is yours is the part you can
        actually do something about. That is the whole reason this day is good
        news.
      </p>

      <div className="flex flex-col gap-8">
        {/* Order matters. What is not hers comes first, always. */}
        <Field label={config.notMineLabel} htmlFor={`${blockId}-notMine`}>
          <Textarea
            id={`${blockId}-notMine`}
            value={merged.notMine}
            onChange={(e) => set('notMine', e.target.value)}
            disabled={disabled}
            rows={5}
          />
        </Field>

        <Field label={config.mineLabel} htmlFor={`${blockId}-mine`}>
          <Textarea
            id={`${blockId}-mine`}
            value={merged.mine}
            onChange={(e) => set('mine', e.target.value)}
            disabled={disabled}
            rows={5}
          />
        </Field>

        <Field label={config.reachLabel} htmlFor={`${blockId}-reach`}>
          <Textarea
            id={`${blockId}-reach`}
            value={merged.reach}
            onChange={(e) => set('reach', e.target.value)}
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
